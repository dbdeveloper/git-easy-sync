import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import DrainJournal, {
  emptyDrainState,
} from "../../src/sync2/drain-journal";
import { DELETED, emptyFileInfo } from "../../src/sync2/diff3";

// NEW-DRAIN §V — the drain journal: 2-slot ping-pong
// tracked-files-{a,b}.json, same protocol as the hot pair. Also the
// §12.5 source-3 schema requirement: collectReferencedShas() must
// return every sha the persisted drain still leans on.

const PLUGIN_ID = "git-easy-sync";

describe("DrainJournal (§V)", () => {
  let dir: string;
  let vault: Vault;
  let journal: DrainJournal;

  const slotAbs = (slot: "a" | "b"): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      `tracked-files-${slot}.json`,
    );

  const sampleState = () => {
    const state = emptyDrainState();
    state.conflictBranchName = "git-easy-sync-conflict-laptop-x";
    state.trackedFiles.set("note.md", {
      base: { ...emptyFileInfo(), path: "note.md", sha: "base-sha", size: 3, mtime: 10 },
      remote: {
        ...emptyFileInfo(),
        path: "note.md",
        sha: "remote-sha",
        size: 5,
        mtime: 20,
        mode: "",
        deviceLabel: "phone",
        // A blob in memory must NEVER reach the disk — sync_store owns bytes.
        blob: new TextEncoder().encode("bytes").buffer as ArrayBuffer,
      },
      isManualConflict: false,
    });
    state.conflicts.set("clash.md", {
      conflictBase: { ...emptyFileInfo(), path: "clash.md", sha: "cb-sha" },
      siblings: [
        { ...emptyFileInfo(), path: "clash.conflict-from-x.md", sha: "sib-sha" },
      ],
    });
    return state;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "drain-journal-test-"));
    vault = new Vault(dir);
    journal = new DrainJournal({ vault: vault as never, selfPluginId: PLUGIN_ID });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no journal on disk → load() is null (fresh drain, not resumed)", async () => {
    expect(await journal.load()).toBeNull();
  });

  it("round-trip: trackedFiles + conflicts + conflictBranchName come back mutually consistent; blobs are NEVER serialized", async () => {
    await journal.persist(sampleState());
    const loaded = await journal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.conflictBranchName).toBe("git-easy-sync-conflict-laptop-x");
    const t = loaded!.trackedFiles.get("note.md")!;
    expect(t.base.sha).toBe("base-sha");
    expect(t.remote).toMatchObject({
      sha: "remote-sha",
      size: 5,
      mtime: 20,
      deviceLabel: "phone",
    });
    expect(t.remote.blob).toBeNull(); // bytes live in sync_store only
    expect(fs.readFileSync(slotAbs("a"), "utf8")).not.toContain("bytes");
    const c = loaded!.conflicts.get("clash.md")!;
    expect(c.conflictBase.sha).toBe("cb-sha");
    expect(c.siblings[0].sha).toBe("sib-sha");
  });

  it("ping-pong invariant: the max-seq slot is never written; targets alternate", async () => {
    await journal.persist(sampleState()); // → a (seq 0)
    await journal.persist(sampleState()); // → b (seq 1)
    const a1 = fs.statSync(slotAbs("a")).mtimeMs;
    await journal.persist(sampleState()); // → a (seq 2)
    expect(fs.statSync(slotAbs("a")).mtimeMs).toBeGreaterThanOrEqual(a1);
    const seqA = (JSON.parse(fs.readFileSync(slotAbs("a"), "utf8")) as { seq: number }).seq;
    const seqB = (JSON.parse(fs.readFileSync(slotAbs("b"), "utf8")) as { seq: number }).seq;
    expect([seqA, seqB].sort()).toEqual([1, 2]);
  });

  it("torn slot: the corrupt slot loses, the intact one is the recovery fallback AND the next write target heals it", async () => {
    const s1 = sampleState();
    await journal.persist(s1); // a seq 0
    const s2 = emptyDrainState();
    s2.conflictBranchName = "newer";
    await journal.persist(s2); // b seq 1
    fs.writeFileSync(slotAbs("b"), "{ torn"); // newest slot dies
    const loaded = await journal.load();
    expect(loaded!.conflictBranchName).toBe(
      "git-easy-sync-conflict-laptop-x", // the older intact slot
    );
    await journal.persist(s2); // heals the torn slot (it reads as seq −1)
    expect(
      (JSON.parse(fs.readFileSync(slotAbs("b"), "utf8")) as { seq: number })
        .seq,
    ).toBe(1); // max(0, −1) + 1
  });

  it("collectReferencedShas (§12.5 source 3): bases, remotes, conflict bases and sibling shas — deletions/nulls excluded", async () => {
    const state = sampleState();
    state.trackedFiles.set("gone.md", {
      base: { ...emptyFileInfo(), path: "gone.md", sha: "old-base" },
      remote: { ...emptyFileInfo(), path: "gone.md", sha: null, mode: DELETED },
      isManualConflict: false,
    });
    await journal.persist(state);
    const shas = await journal.collectReferencedShas();
    expect([...shas].sort()).toEqual(
      ["base-sha", "cb-sha", "old-base", "remote-sha", "sib-sha"].sort(),
    );
  });

  it("clear(): both slots removed → next load() is null", async () => {
    await journal.persist(sampleState());
    await journal.persist(sampleState());
    await journal.clear();
    expect(fs.existsSync(slotAbs("a"))).toBe(false);
    expect(fs.existsSync(slotAbs("b"))).toBe(false);
    expect(await journal.load()).toBeNull();
  });
});
