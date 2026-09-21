import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import InvariantStateStore from "../../src/sync2/invariant-state";

// Own-file storage for the managed-gitignore freshness markers
// (DOT-FILES §3.1.2). The consumer-side behavior is pinned by
// gitignore-invariants.test.ts; this file pins the STORAGE contract:
// a map keyed by vault-relative path, a fingerprint per managed
// section, plain write-through, and the degraded mode (corrupt/missing
// → empty → the next enforce() re-derives from the real files, losing
// one pass and nothing else).

const PLUGIN_ID = "git-easy-sync";
const ROOT = ".gitignore";
const CONFIG = ".obsidian/.gitignore";

describe("InvariantStateStore", () => {
  let dir: string;
  let vault: Vault;
  let store: InvariantStateStore;

  const file = (): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "gitignore-invariants.json",
    );
  const onDisk = () => JSON.parse(fs.readFileSync(file(), "utf8"));
  const fresh = async (): Promise<InvariantStateStore> => {
    const s = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await s.load();
    return s;
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "invariant-state-test-"));
    vault = new Vault(dir);
    store = await fresh();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts empty; set persists immediately (write-through, no explicit save)", async () => {
    expect(store.get()).toEqual({});
    await store.set(ROOT, {
      mtime: 5,
      size: 120,
      invariants: { sha: "s1", len: 40 },
    });
    expect(onDisk()[ROOT]).toEqual({
      mtime: 5,
      size: 120,
      invariants: { sha: "s1", len: 40 },
    });
    expect((await fresh()).getFor(ROOT)).toEqual({
      mtime: 5,
      size: 120,
      invariants: { sha: "s1", len: 40 },
    });
  });

  it("keyed by PATH, so the file set can grow and shrink", async () => {
    // The whole reason this stopped being three fixed slots: third-party
    // `plugins/*/.gitignore` come and go with their plugins, and the pass
    // has to be able to hold a record for each one that exists.
    const foreign = ".obsidian/plugins/brat/.gitignore";
    await store.set(ROOT, { mtime: 1, size: 10 });
    await store.set(foreign, { mtime: 2, size: 20 });
    expect(Object.keys((await fresh()).get()).sort()).toEqual(
      [ROOT, foreign].sort(),
    );
  });

  it("remove() drops a vanished file's record; unknown paths are a no-op", async () => {
    const foreign = ".obsidian/plugins/brat/.gitignore";
    await store.set(ROOT, { mtime: 1, size: 10 });
    await store.set(foreign, { mtime: 2, size: 20 });

    await store.remove(foreign);
    expect(store.getFor(foreign)).toBeUndefined();
    expect(store.getFor(ROOT)).toBeDefined();
    expect(Object.keys(onDisk())).toEqual([ROOT]); // persisted, not just in RAM

    await store.remove("never/seen/.gitignore"); // must not throw
    expect(Object.keys(onDisk())).toEqual([ROOT]);
  });

  it("holds a fingerprint PER SECTION, and an absent section stays absent", async () => {
    // A file can legitimately carry one section, both, or neither:
    // configDir has no `invariants`, a foreign plugin at syncConfigDir=ON
    // has no `final`. "Absent" has to survive the round-trip as absent,
    // not as an empty object the repair path would then try to match.
    await store.set(ROOT, {
      mtime: 1,
      size: 10,
      invariants: { sha: "a", len: 1 },
      final: { sha: "b", len: 2 },
    });
    await store.set(CONFIG, { mtime: 2, size: 20, final: { sha: "c", len: 3 } });

    const reloaded = await fresh();
    expect(reloaded.getFor(ROOT)?.invariants).toEqual({ sha: "a", len: 1 });
    expect(reloaded.getFor(ROOT)?.final).toEqual({ sha: "b", len: 2 });
    expect(reloaded.getFor(CONFIG)?.final).toEqual({ sha: "c", len: 3 });
    expect(reloaded.getFor(CONFIG)).not.toHaveProperty("invariants");
  });

  it("corrupt file reads as empty (degraded mode) and heals on the next set", async () => {
    await store.set(CONFIG, { mtime: 1, size: 1 });
    fs.writeFileSync(file(), '{".obsidian/.gitignore": {"mtim'); // torn

    const healed = await fresh();
    expect(healed.get()).toEqual({});
    await healed.set(CONFIG, { mtime: 2, size: 2 });
    expect(onDisk()[CONFIG]).toEqual({ mtime: 2, size: 2 });
  });

  it("malformed records are dropped on load; valid ones survive", async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        [ROOT]: { mtime: 3, size: 30 },
        "a/.gitignore": { mtime: "bad", size: 1 }, // wrong type
        "b/.gitignore": { mtime: 1 }, // size missing
        "c/.gitignore": { mtime: 1, size: 1, final: { sha: "x" } }, // len missing
      }),
    );
    const loaded = await fresh();
    expect(loaded.get()).toEqual({
      [ROOT]: { mtime: 3, size: 30 },
      // A bad fingerprint drops the FINGERPRINT, not the record: mtime and
      // size are still true, and a missing fingerprint just means the next
      // pass does the full read+splice — the safe direction.
      "c/.gitignore": { mtime: 1, size: 1 },
    });
  });

  it("a state file in the OLD three-slot shape reads as empty (no migration, by design)", async () => {
    // The pre-2026-09-21 form. There is deliberately no migration branch:
    // the store's contract is already "unreadable → empty → one extra
    // pass", and an old record's `hash` answers a question the new pass
    // does not ask.
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(
      file(),
      JSON.stringify({
        rootGitignore: { mtime: 7, hash: "deadbeef" },
        configDirGitignore: { mtime: 9, hash: "cafe" },
      }),
    );
    expect((await fresh()).get()).toEqual({});
  });
});
