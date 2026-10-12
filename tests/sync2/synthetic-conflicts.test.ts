// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import ConflictStoreV2, {
  emptyConflictsState,
  type ConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { emptyFileInfo } from "../../src/sync2/diff3";
import { cleanSyntheticConflicts } from "../../src/sync2/synthetic-conflicts";
import { calculateGitBlobSHA } from "../../src/utils";

// Cleaning up SYNTHETIC conflict copies (owner, 2026-10-12). The drain is
// about tracked conflicts: it touches a synthetic copy only next to a tracked
// one. Everywhere else a synthetic copy that has nothing left to say — byte-
// equal to its file, or the same bytes as another copy — is removed by this
// one function, run when the Diff Panel opens, on Ctrl/Cmd+R in the panel and
// at plugin start. Same verdicts as everywhere: the conflict model. Copies are
// never synced (the *.conflict-from-* rule), so a removal stays on this device.

const CONFIG_DIR = ".obsidian";
const T1 = 1_700_000_000_000;
const T2 = 1_700_000_100_000;

describe("cleanSyntheticConflicts", () => {
  let root: string;
  let vault: Vault;
  let store: ConflictStoreV2;
  let state: ConflictsState;
  const logs: { message: string; data?: unknown }[] = [];

  const put = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  const copy = (base: string, device: string, when: number) =>
    buildSiblingFilePath(base, when, device);
  const track = async (base: string, device: string, when: number, content: string) => {
    let entry = state.entries.get(base);
    if (!entry) {
      entry = { conflictBase: { ...emptyFileInfo(), path: base, sha: "cb" }, siblings: [] };
      state.entries.set(base, entry);
    }
    entry.siblings.push({ ...emptyFileInfo(), path: base, timeLabel: when, deviceLabel: device });
    put(copy(base, device, when), content);
    await store.save(state);
  };
  const cleanDeps = () => ({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    scope: { configDir: CONFIG_DIR, syncConfigDir: () => true },
    logger: { info: (message: string, data?: unknown) => logs.push({ message, data }) },
  });
  const clean = () => cleanSyntheticConflicts(cleanDeps());

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `synthetic-clean-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    vault = new Vault(root);
    store = new ConflictStoreV2({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: "git-easy-sync",
    });
    await store.load();
    state = emptyConflictsState();
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("🔑 a synthetic copy equal to its file is removed, and the removal says why", async () => {
    put("notes/a.md", "same\n");
    put(copy("notes/a.md", "Phone", T1), "same\n");
    const r = await clean();
    expect(exists(copy("notes/a.md", "Phone", T1))).toBe(false);
    expect(r.removed).toEqual([copy("notes/a.md", "Phone", T1)]);
    expect(logs.map((l) => l.message)).toContain(
      "Conflict copy removed: identical to the file — the conflict is resolved",
    );
  });

  it("a synthetic copy that still differs stays, and is returned as a survivor", async () => {
    put("a.md", "ours\n");
    put(copy("a.md", "Phone", T1), "theirs\n");
    const r = await clean();
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
    expect(r.removed).toEqual([]);
    expect(r.survivors.map((c) => c.path)).toEqual([copy("a.md", "Phone", T1)]);
  });

  it("two synthetic copies with the same bytes → the older goes, the newer stays", async () => {
    put("a.md", "ours\n");
    put(copy("a.md", "Phone", T1), "theirs\n");
    put(copy("a.md", "Laptop", T2), "theirs\n");
    await clean();
    expect(exists(copy("a.md", "Phone", T1))).toBe(false);
    expect(exists(copy("a.md", "Laptop", T2))).toBe(true);
    expect(logs.map((l) => l.message)).toContain("Conflict copy removed: identical to another copy");
  });

  it("a synthetic copy with the same bytes as a TRACKED one goes; the tracked one stays", async () => {
    put("a.md", "ours\n");
    await track("a.md", "Phone", T1, "theirs\n");
    put(copy("a.md", "Laptop", T2), "theirs\n"); // newer, but synthetic
    await clean();
    expect(exists(copy("a.md", "Laptop", T2))).toBe(false);
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
  });

  it("🔑 a TRACKED copy equal to its file is NOT touched — that is the drain's", async () => {
    put("a.md", "same\n");
    await track("a.md", "Phone", T1, "same\n");
    const r = await clean();
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
    expect(r.removed).toEqual([]);
  });

  it("a copy whose file is gone stays (delete-vs-modify: the user decides)", async () => {
    put(copy("gone.md", "Phone", T1), "theirs\n");
    await clean();
    expect(exists(copy("gone.md", "Phone", T1))).toBe(true);
  });

  it("🔑 reaches dot-space: a copy of the root .gitignore equal to it is removed", async () => {
    put(".gitignore", ".*\n!/.gitignore\n");
    put(copy(".gitignore", "Old gitignore files", T1), ".*\n!/.gitignore\n");
    await clean();
    expect(exists(copy(".gitignore", "Old gitignore files", T1))).toBe(false);
  });

  it("…and inside an opted-in dot-directory", async () => {
    put(".gitignore", "!/.myconfig/\n");
    put(".myconfig/n.md", "same\n");
    put(copy(".myconfig/n.md", "Phone", T1), "same\n");
    await clean();
    expect(exists(copy(".myconfig/n.md", "Phone", T1))).toBe(false);
  });

  it("🔑 a copy the drain ANNOUNCED (about to write / not saved yet) is never removed", async () => {
    put("a.md", "same\n");
    put(copy("a.md", "Phone", T1), "same\n");
    await store.announceCopy(copy("a.md", "Phone", T1));
    const r = await clean();
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
    expect(r.removed).toEqual([]);
  });

  it("🔑 a copy the drain recorded in memory (conflicts.json not saved yet) is never removed", async () => {
    put("a.md", "same\n");
    put(copy("a.md", "Phone", T1), "same\n");
    store.getCachedState().entries.set("a.md", {
      conflictBase: { ...emptyFileInfo(), path: "a.md" },
      siblings: [{ ...emptyFileInfo(), path: "a.md", timeLabel: T1, deviceLabel: "Phone" }],
    });
    await clean();
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
  });

  it("🔑 the file changed after the verdict, before the removal → re-checked, kept", async () => {
    put("a.md", "same\n");
    put(copy("a.md", "Phone", T1), "same\n");
    let calls = 0;
    await cleanSyntheticConflicts({
      ...cleanDeps(),
      // The model hashes the copy, then the base; right after that the
      // user edits the base (same size, so only the bytes can tell).
      computeSha: async (b) => {
        const r = await calculateGitBlobSHA(b);
        if (++calls === 2) put("a.md", "SAME\n");
        return r;
      },
    });
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
  });

  it("🔑 the surviving twin changed after the verdict → the duplicate is re-checked, kept", async () => {
    put("a.md", "ours\n");
    put(copy("a.md", "Phone", T1), "theirs\n");
    put(copy("a.md", "Laptop", T2), "theirs\n");
    let calls = 0;
    await cleanSyntheticConflicts({
      ...cleanDeps(),
      computeSha: async (b) => {
        const r = await calculateGitBlobSHA(b);
        if (++calls === 2) put(copy("a.md", "Laptop", T2), "THEIRS\n"); // the user edits the survivor
        return r;
      },
    });
    expect(exists(copy("a.md", "Phone", T1))).toBe(true);
  });

  it("a staging file of an atomic write (…ges-tmp / …ges-bak) is never a candidate", async () => {
    put("a.md", "same\n");
    const tmp = copy("a.md", "Phone", T1).replace(/\.md$/, ".ges-tmp.md");
    put(tmp, "same\n");
    const r = await clean();
    expect(exists(tmp)).toBe(true);
    expect(r.survivors.map((c) => c.path)).not.toContain(tmp);
  });

  it("a copy removed by someone else meanwhile ([←]) does not break the cleanup", async () => {
    put("a.md", "same\n");
    put(copy("a.md", "Phone", T1), "same\n");
    const v = vault as unknown as { adapter: { remove(p: string): Promise<void> } };
    const adapter = v.adapter;
    Object.defineProperty(vault, "adapter", { get: () => adapter, configurable: true });
    const orig = adapter.remove.bind(adapter);
    adapter.remove = async (p: string) => {
      await orig(p);
      throw new Error("already gone"); // as if [←] removed it first
    };
    const r = await clean();
    expect(r.removed).toEqual([]);
  });

  it("logs how long the search took and what it did", async () => {
    put("a.md", "same\n");
    put(copy("a.md", "Phone", T1), "same\n");
    put("b.md", "ours\n");
    put(copy("b.md", "Phone", T1), "theirs\n");
    await clean();
    const summary = logs.find((l) => l.message === "Looked for leftover conflict copies");
    expect(summary?.data).toMatchObject({ found: 2, removed: 1 });
    expect(typeof (summary?.data as { ms: number }).ms).toBe("number");
  });
});

// ── The ledger's "is this copy tracked?" — the one predicate every deletion
// of a synthetic copy asks (advisor review, 2026-10-12). It must see a copy
// the drain is about to write (announced), one recorded in memory but not yet
// saved, and a name written in another Unicode form (Obsidian's normalizePath
// is NFC); and the check and the removal must be one step, or a drain can
// write a tracked copy at that name between them.
describe("ConflictStoreV2 — the tracked-copy predicate and the removal handshake", () => {
  let root: string;
  let store: ConflictStoreV2;
  beforeEach(async () => {
    root = path.join(os.tmpdir(), `tracked-pred-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    const vault = new Vault(root);
    store = new ConflictStoreV2({ vault: vault as unknown as import("obsidian").Vault, selfPluginId: "git-easy-sync" });
    await store.load();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = (label = "Phone") => buildSiblingFilePath("a.md", T1, label);

  it("an ANNOUNCED copy (file not written yet) is tracked", async () => {
    expect(store.isTrackedCopy(name())).toBe(false);
    await store.announceCopy(name());
    expect(store.isTrackedCopy(name())).toBe(true);
  });

  it("a copy recorded in the ledger in memory but not saved yet is tracked", () => {
    store.getCachedState().entries.set("a.md", {
      conflictBase: { ...emptyFileInfo(), path: "a.md" },
      siblings: [{ ...emptyFileInfo(), path: "a.md", timeLabel: T1, deviceLabel: "Phone" }],
    });
    expect(store.isTrackedCopy(name())).toBe(true);
  });

  it("🔑 a Cyrillic label in another Unicode form is still the same copy", async () => {
    const nfd = "Телефон й".normalize("NFD");
    const s = emptyConflictsState();
    s.entries.set("a.md", {
      conflictBase: { ...emptyFileInfo(), path: "a.md" },
      siblings: [{ ...emptyFileInfo(), path: "a.md", timeLabel: T1, deviceLabel: nfd }],
    });
    await store.save(s);
    expect(store.isTrackedCopy(name(nfd).normalize("NFC"))).toBe(true);
  });

  it("an announcement outlives an unrelated save, and ends once its copy is recorded and saved", async () => {
    await store.announceCopy(name());
    await store.save(emptyConflictsState());
    expect(store.isTrackedCopy(name())).toBe(true);
    const s = emptyConflictsState();
    s.entries.set("a.md", {
      conflictBase: { ...emptyFileInfo(), path: "a.md" },
      siblings: [{ ...emptyFileInfo(), path: "a.md", timeLabel: T1, deviceLabel: "Phone" }],
    });
    await store.save(s);
    await store.save(emptyConflictsState()); // the record pruned later
    expect(store.isTrackedCopy(name())).toBe(false);
  });

  it("removeIfUntracked never removes a tracked copy", async () => {
    await store.announceCopy(name());
    const remove = vi.fn(async () => {});
    expect(await store.removeIfUntracked(name(), remove)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("🔑 a drain announcing a name whose removal is in flight WAITS for it before writing", async () => {
    let finish!: () => void;
    const removal = store.removeIfUntracked(name(), () => new Promise<void>((r) => (finish = r)));
    let announced = false;
    const announce = store.announceCopy(name()).then(() => (announced = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(announced).toBe(false); // the drain would write now — it must not
    finish();
    await removal;
    await announce;
    expect(announced).toBe(true);
  });
});
