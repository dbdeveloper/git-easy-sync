import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import {
  entryFromSibling,
  findAllConflicts,
  groupByBasePath,
  pendingConflictSummary,
  syntheticFromDotSpace,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";

// Phase 1 — Conflicts list detection module, ported to conflict store
// v2 (Phase 5.5 step 3b). Tests the pure detection logic: tracked vs
// synthetic categorisation, absent-base listing (delete-vs-modify),
// multi-sibling grouping, ordering.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `synthetic-detector-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const state: ConflictsState = emptyConflictsState();
  return { root, vault, store, state };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// The derived sibling disk name for a (base, device, moment) triple —
// same canonical iso shape the v2 helpers produce.
function siblingPathFor(
  vaultPath: string,
  device: string,
  whenMs: number,
): string {
  return buildSiblingFilePath(vaultPath, whenMs, device);
}

function writeFile(root: string, rel: string, content = "x"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Register a TRACKED sibling the v2 way: append it to the entry's
// siblings list, write the sibling file at the derived name, save
// (save rebuilds the store's cached indexes). Returns the disk name.
async function track(
  fx: ReturnType<typeof fixture>,
  basePath: string,
  device: string,
  whenMs: number,
  content = "theirs",
): Promise<string> {
  let entry = fx.state.entries.get(basePath);
  if (!entry) {
    entry = {
      conflictBase: { ...emptyFileInfo(), path: basePath, sha: "cb-sha" },
      siblings: [],
    };
    fx.state.entries.set(basePath, entry);
  }
  entry.siblings.push({
    ...emptyFileInfo(),
    path: basePath,
    mtime: whenMs,
    deviceLabel: device,
    sha: `sha-${device}-${whenMs}`,
  });
  const sibPath = siblingPathFor(basePath, device, whenMs);
  writeFile(fx.root, sibPath, content);
  await fx.store.save(fx.state);
  return sibPath;
}

describe("findAllConflicts", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("returns empty result when vault has no sibling files", async () => {
    writeFile(fx.root, "note.md", "regular content");

    const { entries, byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toEqual([]);
    expect(byBasePath.size).toBe(0);
  });

  it("classifies a sibling with a matching conflicts.json entry as tracked", async () => {
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = await track(
      fx,
      "note.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 30, 0),
    );

    const { entries, byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tracked");
    expect(entries[0].basePath).toBe("note.md");
    expect(entries[0].siblingPath).toBe(sibPath);
    expect(entries[0].deviceLabel).toBe("Phone");
    expect(entries[0].isoTimestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/,
    );
    expect(byBasePath.get("note.md")).toHaveLength(1);
  });

  it("classifies a sibling WITHOUT an entry but WITH base in vault as synthetic", async () => {
    // Synthetic conflict per R3.3 rule 3: base + sibling co-exist in
    // vault, but no conflicts.json entry.
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "theirs bytes");

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("synthetic");
    expect(entries[0].basePath).toBe("note.md");
  });

  it("LISTS an absent-base sibling as a synthetic delete-vs-modify conflict (2026-06-18)", async () => {
    // A sibling whose base file is absent is a delete-vs-modify conflict (base
    // deleted, sibling holds the other side) — now LISTED (reverses the old R3.3
    // rule-3 "orphan without base → skip") so it's resolvable via the panel; the
    // diff editor renders the ours side empty (mountDiffPane reads "" for an absent
    // base). Applies to synthetic (no entry) AND tracked (R2.5) alike.
    const sibPath = siblingPathFor("missing.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "orphan");

    const { entries, byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => `${e.basePath}:${e.kind}`)).toEqual([
      "missing.md:synthetic",
    ]);
    expect(byBasePath.size).toBe(1);
  });

  it("returns mixed tracked + synthetic + absent-base-orphan in one pass", async () => {
    writeFile(fx.root, "regular.md", "ignore me");

    writeFile(fx.root, "tracked.md", "ours");
    await track(fx, "tracked.md", "Phone", Date.UTC(2026, 4, 26, 10, 30, 0));

    writeFile(fx.root, "synthetic.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("synthetic.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "theirs2",
    );

    writeFile(
      fx.root,
      siblingPathFor("orphan.md", "Phone", Date.UTC(2026, 4, 26, 12, 0, 0)),
      "theirs3",
    );

    const { entries, byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => `${e.basePath}:${e.kind}`).sort()).toEqual([
      "orphan.md:synthetic", // absent base → now listed (was skipped)
      "synthetic.md:synthetic",
      "tracked.md:tracked",
    ]);
    expect(byBasePath.size).toBe(3);
  });

  it("EXCLUDES a resolved conflict whose sibling was deleted while its conflicts.json entry lingers (pre-sync-gate parity)", async () => {
    // REGRESSION: after the user resolves a conflict in diff2, the sibling file is
    // removed (merge → base rewritten, sibling gone) but the store entry is NOT
    // dropped until the next process_conflicts pass prunes it. The pre-sync gate
    // used to read the raw records, so it re-surfaced this already-resolved
    // conflict in the "you still have conflicts" modal even though the diff-panel
    // no longer showed it. The panel/badge/gate all source from findAllConflicts
    // (live vault siblings) — a record whose sibling is gone must NOT appear,
    // while a genuinely-live conflict still does.
    writeFile(fx.root, "resolved.md", "merged bytes");
    const resolvedSib = await track(
      fx,
      "resolved.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 0, 0),
    );
    writeFile(fx.root, "live.md", "ours");
    await track(fx, "live.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    // Simulate the diff2 resolution: sibling gone from the vault, entry lingers.
    fs.rmSync(path.join(fx.root, resolvedSib));
    // Raw entries (the OLD gate source): BOTH still there — reading them would
    // put the resolved "resolved.md" back into the pre-sync modal (the bug).
    expect([...fx.store.getCachedState().entries.keys()].sort()).toEqual([
      "live.md",
      "resolved.md",
    ]);

    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).not.toBeNull();
    expect(summary!.trackedPaths).toEqual(["live.md"]);
  });

  // §24 — the gate/modal is TRACKED-only. A synthetic conflict (a *.conflict-from-*
  // sibling with NO conflicts.json entry — a local leftover) carries no cross-device
  // consequence, so pendingConflictSummary excludes it.
  it("§24 synthetic-only vault → summary is null (gate lets sync proceed, no modal)", async () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
      "theirs",
    );
    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).toBeNull();
  });

  it("§24 mixed tracked + synthetic → summary lists ONLY the tracked base", async () => {
    writeFile(fx.root, "leftover.md", "ours");
    writeFile(
      fx.root,
      "leftover.conflict-from-OldPhone-2026-05-26T10-30-00Z.md",
      "theirs",
    );
    writeFile(fx.root, "real.md", "ours");
    await track(fx, "real.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).not.toBeNull();
    expect(summary!.trackedPaths).toEqual(["real.md"]); // synthetic excluded
    expect(summary!.trackedConflictCount).toBe(1);
  });

  it("§24 one file with MULTIPLE tracked siblings → one path, trackedConflictCount counts all", async () => {
    writeFile(fx.root, "busy.md", "ours");
    await track(fx, "busy.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0));
    await track(fx, "busy.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary!.trackedPaths).toEqual(["busy.md"]); // one file
    expect(summary!.trackedConflictCount).toBe(2); // two tracked conflicts
  });

  it("§24 a base with BOTH a tracked and a synthetic sibling counts as tracked", async () => {
    writeFile(fx.root, "mix.md", "ours");
    writeFile(
      fx.root,
      "mix.conflict-from-Ghost-2026-05-20T08-00-00Z.md",
      "ghost",
    );
    await track(fx, "mix.md", "Tablet", Date.UTC(2026, 4, 26, 12, 0, 0));

    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary!.trackedPaths).toEqual(["mix.md"]); // listed once, as tracked
  });

  it("groups multi-sibling-per-path into one bucket each", async () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "from phone",
    );
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "from laptop",
    );

    const { entries, byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(2);
    expect(byBasePath.get("note.md")).toHaveLength(2);
    expect(
      byBasePath.get("note.md")!.every((e) => e.kind === "synthetic"),
    ).toBe(true);
  });

  it("sorts entries newest-first by isoTimestamp", async () => {
    writeFile(fx.root, "a.md", "x");
    writeFile(fx.root, "b.md", "x");
    writeFile(fx.root, "c.md", "x");
    writeFile(
      fx.root,
      siblingPathFor("a.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "t1",
    );
    writeFile(
      fx.root,
      siblingPathFor("b.md", "Phone", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "t2",
    );
    writeFile(
      fx.root,
      siblingPathFor("c.md", "Phone", Date.UTC(2026, 4, 26, 12, 0, 0)),
      "t3",
    );

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => e.basePath)).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("preserves newest-first order within each group", async () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "older",
    );
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "newer",
    );

    const { byBasePath } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    const bucket = byBasePath.get("note.md")!;
    expect(bucket).toHaveLength(2);
    expect(bucket[0].deviceLabel).toBe("Laptop");
    expect(bucket[1].deviceLabel).toBe("Phone");
  });

  it("ignores files in nested folders that are not siblings", async () => {
    writeFile(fx.root, "Folder/regular.md", "x");
    writeFile(fx.root, "Folder/Sub/other.md", "x");

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toEqual([]);
  });

  it("handles nested-folder siblings correctly", async () => {
    writeFile(fx.root, "Folder/Sub/note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor(
        "Folder/Sub/note.md",
        "Phone",
        Date.UTC(2026, 4, 26, 10, 0, 0),
      ),
      "theirs",
    );

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].basePath).toBe("Folder/Sub/note.md");
    expect(entries[0].kind).toBe("synthetic");
  });
});

describe("groupByBasePath", () => {
  it("groups entries by basePath, preserving input order within group", async () => {
    const make = (basePath: string, ts: string): ConflictEntry => ({
      basePath,
      siblingPath: `${basePath}.conflict-from-X-${ts}`,
      deviceLabel: "X",
      isoTimestamp: ts,
      kind: "synthetic",
    });

    const a1 = make("a.md", "2026-05-26T10-00-00Z");
    const a2 = make("a.md", "2026-05-26T11-00-00Z");
    const b1 = make("b.md", "2026-05-26T10-30-00Z");

    const grouped = groupByBasePath([a1, a2, b1]);
    expect(grouped.get("a.md")).toEqual([a1, a2]);
    expect(grouped.get("b.md")).toEqual([b1]);
  });

  it("returns empty map on empty input", async () => {
    expect(groupByBasePath([]).size).toBe(0);
  });
});

// entryFromSibling — the lifted loop body of findAllConflicts (S1 of the split,
// SPLIT-PANEL-EDITOR-FEASIBILITY.md §12). The findAllConflicts suite above is its
// parity net; these pin the single-entry contract the split's S4 row-click +
// Phase-1B setState restore depend on.
describe("entryFromSibling", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("returns null for a path that is not a *.conflict-from-* sibling", async () => {
    expect(entryFromSibling(fx.store, "note.md")).toBeNull();
    expect(entryFromSibling(fx.store, "Folder/regular.md")).toBeNull();
  });

  it("classifies a registered sibling as tracked (fields parsed)", async () => {
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = await track(
      fx,
      "note.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 30, 0),
    );

    const entry = entryFromSibling(fx.store, sibPath);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("tracked");
    expect(entry!.basePath).toBe("note.md");
    expect(entry!.siblingPath).toBe(sibPath);
    expect(entry!.deviceLabel).toBe("Phone");
    expect(entry!.isoTimestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/,
    );
  });

  it("classifies an unregistered sibling as synthetic (no vault walk needed)", async () => {
    // No entry + no base file on disk: entryFromSibling only parses the path +
    // checks the store's cached index, so an absent base is irrelevant here
    // (matches the absent-base-is-listed rule).
    const sibPath = siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26));
    const entry = entryFromSibling(fx.store, sibPath);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("synthetic");
    expect(entry!.basePath).toBe("note.md");
    expect(entry!.deviceLabel).toBe("Laptop");
  });
});

describe("§4.3.1 п.2 — tracked comes from the STORE, not from the index scan", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });
  afterEach(() => cleanup(fx.root));

  it("a TRACKED conflict in dot-space is listed — the whole point of the inversion", async () => {
    // THE headline case. Obsidian's file index contains no dot-paths,
    // so while tracked entries were derived from `vault.getFiles()` a
    // real conflict on `.myconfig/note.md` was invisible to the panel
    // even with a live record in conflicts.json: the engine knew, the
    // user could not see it, and nothing explained why.
    writeFile(fx.root, ".myconfig/note.md", "ours");
    const sib = await track(fx, ".myconfig/note.md", "Phone", 1_700_000_000_000);

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => e.siblingPath)).toEqual([sib]);
    expect(entries[0].kind).toBe("tracked");
    expect(entries[0].basePath).toBe(".myconfig/note.md");
  });

  it("a tracked record whose sibling file is gone is NOT listed", async () => {
    // The standing guarantee: a conflict the user already resolved, whose
    // record lingers until the next reconcile, must not reappear. The
    // store branch keeps it by asking the disk one question per sibling.
    writeFile(fx.root, "note.md", "ours");
    const sib = await track(fx, "note.md", "Phone", 1_700_000_000_000);
    fs.rmSync(path.join(fx.root, sib));

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toEqual([]);
  });

  it("a tracked sibling is listed ONCE, not twice", async () => {
    // Both branches can see a non-dot tracked sibling: the store lists
    // it, and the index scan would too. The fast branch drops tracked
    // hits so the row does not double up.
    writeFile(fx.root, "note.md", "ours");
    // The sibling is a non-dot root file, so Obsidian's index returns
    // it too — both branches really do see this one.
    const sib = await track(fx, "note.md", "Phone", 1_700_000_000_000);
    expect(fx.vault.getFiles().map((f) => f.path)).toContain(sib);

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.filter((e) => e.siblingPath === sib)).toHaveLength(1);
  });

  it("tracked rows sort beside synthetic ones, not at the wrong end", async () => {
    // The timestamp of a tracked row is derived from the SAME mtime its
    // filename is derived from. Take it from anywhere else and tracked
    // rows drift away from their synthetic twins in the list.
    writeFile(fx.root, "note.md", "ours");
    const older = await track(fx, "note.md", "Phone", 1_600_000_000_000);
    const newer = await track(fx, "note.md", "Tablet", 1_700_000_000_000);

    const { entries } = await findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => e.siblingPath)).toEqual([newer, older]);
  });
});

describe("§24 + §4.3 — the gate and the badge are TRACKED-only", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });
  afterEach(() => cleanup(fx.root));

  it("a synthetic-only vault does not open the gate", async () => {
    // A synthetic conflict is a purely local echo of something already
    // resolved — GitHub knows nothing about it, so it carries no
    // cross-device consequence and must not block a sync.
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Phone", 1_700_000_000_000),
      "theirs",
    );
    expect(
      await pendingConflictSummary(
        fx.vault as unknown as import("obsidian").Vault,
        fx.store,
      ),
    ).toBeNull();
  });

  it("a tracked conflict in DOT-SPACE now opens it — the scan-derived gate could not see one", async () => {
    writeFile(fx.root, ".myconfig/note.md", "ours");
    await track(fx, ".myconfig/note.md", "Phone", 1_700_000_000_000);
    const summary = await pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary?.trackedPaths).toEqual([".myconfig/note.md"]);
    expect(summary?.trackedConflictCount).toBe(1);
  });
});

describe("§4.3.1 п.1 — the SLOW branch reaches dot-space the index cannot see", () => {
  let fx: ReturnType<typeof fixture>;
  const opts = { configDir: CONFIG_DIR, syncConfigDir: () => true };

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });
  afterEach(() => cleanup(fx.root));

  const scan = () =>
    syntheticFromDotSpace(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
      opts,
    );

  it("an orphan sibling inside an opted-in dot-dir is found", async () => {
    // Obsidian's index has no dot-paths, so the fast branch is blind
    // here — without this pass the user could never clear the leftover.
    writeFile(fx.root, ".gitignore", "!/.myconfig/\n");
    writeFile(fx.root, ".myconfig/note.md", "ours");
    const sib = siblingPathFor(".myconfig/note.md", "Phone", 1_700_000_000_000);
    writeFile(fx.root, sib, "theirs");

    // Confirm the premise rather than assuming it.
    expect(fx.vault.getFiles().map((f) => f.path)).not.toContain(sib);

    expect((await scan()).map((e) => e.siblingPath)).toEqual([sib]);
  });

  it("a dot-dir NOBODY opted into is not scanned", async () => {
    // Listing it would invite the user to act on something they cannot
    // resolve through sync anyway: the same walk boundaries as the
    // push side, deliberately.
    writeFile(fx.root, ".gitignore", "");
    writeFile(fx.root, ".secret/note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor(".secret/note.md", "Phone", 1_700_000_000_000),
      "theirs",
    );
    expect(await scan()).toEqual([]);
  });

  it("a TRACKED sibling in dot-space is left to the store branch", async () => {
    // It is listed either way; returning it from both would double the
    // row once the panel concatenates them.
    writeFile(fx.root, ".gitignore", "!/.myconfig/\n");
    writeFile(fx.root, ".myconfig/note.md", "ours");
    await track(fx, ".myconfig/note.md", "Phone", 1_700_000_000_000);
    expect(await scan()).toEqual([]);
  });

  it("configDir is scanned when the toggle is on, and not when it is off", async () => {
    writeFile(fx.root, ".gitignore", "");
    writeFile(fx.root, `${CONFIG_DIR}/app.json`, "{}");
    const sib = siblingPathFor(
      `${CONFIG_DIR}/app.json`,
      "Phone",
      1_700_000_000_000,
    );
    writeFile(fx.root, sib, "theirs");

    expect((await scan()).map((e) => e.siblingPath)).toEqual([sib]);
    expect(
      await syntheticFromDotSpace(
        fx.vault as unknown as import("obsidian").Vault,
        fx.store,
        { configDir: CONFIG_DIR, syncConfigDir: () => false },
      ),
    ).toEqual([]);
  });
});
