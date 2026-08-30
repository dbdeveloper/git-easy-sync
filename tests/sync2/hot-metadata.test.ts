import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import HotMetadataStore from "../../src/sync2/hot-metadata";

// Hot-pair ping-pong (METAFILE-REFACTOR §2.1). The load-bearing test is
// the crash-safety invariant: the max-seq slot is NEVER the write
// target — same contract cursor-store.test.ts pins for the cursor pair.
// The rest carries the behavior contracts the old snapshot-store tests
// pinned for these fields (round-trips, lenient reads), so the Phase 1
// swap commit only has fixture-level test edits left.

const PLUGIN_ID = "git-easy-sync";

describe("HotMetadataStore", () => {
  let dir: string;
  let vault: Vault;
  let store: HotMetadataStore;

  const slotFile = (slot: "a" | "b"): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      `metadata-${slot}.json`,
    );

  const readRawSlot = (slot: "a" | "b"): Record<string, unknown> | null => {
    const p = slotFile(slot);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  const seqOf = (slot: "a" | "b"): number => {
    const raw = readRawSlot(slot);
    return raw === null || typeof raw.seq !== "number" ? -1 : raw.seq;
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "hot-metadata-test-"));
    vault = new Vault(dir);
    store = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await store.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts with all-null fields when no slot files exist", () => {
    expect(store.getLastSyncCommitSha()).toBeNull();
    expect(store.getLastSyncTreeSha()).toBeNull();
    expect(store.getLastCommitMtime()).toBeNull();
    expect(store.getRemoteIdentity()).toBeNull();
    expect(store.getConflictBranch()).toBeNull();
  });

  it("first update writes slot a with seq 0", async () => {
    await store.update({ lastSyncCommitSha: "sha-1" });
    expect(seqOf("a")).toBe(0);
    expect(readRawSlot("b")).toBeNull();
    expect(store.getLastSyncCommitSha()).toBe("sha-1");
  });

  it("round-trips every field through a fresh instance", async () => {
    await store.update({
      lastSyncCommitSha: "commit-sha",
      lastSyncTreeSha: "tree-sha",
      lastCommitMtime: 12345,
      remoteIdentity: { owner: "o", repo: "r", branch: "main" },
      conflictBranch: { name: "conf-branch", head: "head-sha" },
    });

    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBe("commit-sha");
    expect(fresh.getLastSyncTreeSha()).toBe("tree-sha");
    expect(fresh.getLastCommitMtime()).toBe(12345);
    expect(fresh.getRemoteIdentity()).toEqual({
      owner: "o",
      repo: "r",
      branch: "main",
    });
    expect(fresh.getConflictBranch()).toEqual({
      name: "conf-branch",
      head: "head-sha",
    });
  });

  it("update merges: untouched fields survive a partial update", async () => {
    await store.update({
      lastSyncCommitSha: "sha-1",
      remoteIdentity: { owner: "o", repo: "r", branch: "b" },
    });
    await store.update({ lastCommitMtime: 777 });

    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBe("sha-1");
    expect(fresh.getRemoteIdentity()).toEqual({
      owner: "o",
      repo: "r",
      branch: "b",
    });
    expect(fresh.getLastCommitMtime()).toBe(777);
  });

  it("setting a field back to null persists the null", async () => {
    await store.update({
      conflictBranch: { name: "cb", head: "h" },
    });
    await store.update({ conflictBranch: null });
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getConflictBranch()).toBeNull();
  });

  it("INVARIANT: always writes the lower-seq slot — the max-seq slot is never touched", async () => {
    // update #1 → a(seq 0). update #2: max is a → must write b.
    await store.update({ lastSyncCommitSha: "s1" });
    const aBytesBefore = fs.readFileSync(slotFile("a"), "utf8");
    await store.update({ lastSyncCommitSha: "s2" });
    expect(seqOf("b")).toBe(1);
    expect(fs.readFileSync(slotFile("a"), "utf8")).toBe(aBytesBefore); // untouched

    // update #3: max is b(1) → must write a, seq 2; b untouched.
    const bBytesBefore = fs.readFileSync(slotFile("b"), "utf8");
    await store.update({ lastSyncCommitSha: "s3" });
    expect(seqOf("a")).toBe(2);
    expect(fs.readFileSync(slotFile("b"), "utf8")).toBe(bBytesBefore);

    // update #4: max is a(2) → b, seq 3.
    await store.update({ lastSyncCommitSha: "s4" });
    expect(seqOf("b")).toBe(3);
    expect(seqOf("a")).toBe(2);
  });

  it("a torn slot reads as seq −1: load falls back to the intact slot, the next write heals the torn one", async () => {
    await store.update({ lastSyncCommitSha: "s1" }); // a seq 0
    await store.update({ lastSyncCommitSha: "s2" }); // b seq 1
    // Tear the max-seq slot b — recovery must fall back to a ("s1").
    fs.writeFileSync(slotFile("b"), '{"seq": 1, "lastSyncCom'); // torn write
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBe("s1");

    // The torn slot reads as −1 → it is the smaller one → next write
    // targets it (self-healing, §2.1: the broken slot needs no separate
    // repair or deletion).
    await fresh.update({ lastSyncCommitSha: "s3" });
    expect(seqOf("b")).toBe(1); // 0 (valid a) + 1
    expect(readRawSlot("b")!.lastSyncCommitSha).toBe("s3");
    expect(seqOf("a")).toBe(0); // untouched fallback
  });

  it("both slots invalid → next write is seq 0 into a", async () => {
    fs.mkdirSync(path.dirname(slotFile("a")), { recursive: true });
    fs.writeFileSync(slotFile("a"), "garbage");
    fs.writeFileSync(slotFile("b"), '{"noSeq": true}');
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBeNull();
    await fresh.update({ lastSyncCommitSha: "s1" });
    expect(seqOf("a")).toBe(0);
  });

  it("seq and target come from DISK, not memory: an external write between updates is respected", async () => {
    await store.update({ lastSyncCommitSha: "s1" }); // a seq 0
    // Another instance (same device, e.g. plugin restart) writes b seq 1.
    const other = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await other.load();
    await other.update({ lastSyncCommitSha: "other" }); // b seq 1

    // The FIRST instance's memory thinks the max is a(0); disk says the
    // max is b(1). Its next write must target a (the on-disk smaller
    // slot) with seq 2 — never clobber b, the freshest completed state.
    await store.update({ lastCommitMtime: 5 });
    expect(seqOf("a")).toBe(2);
    expect(seqOf("b")).toBe(1);
    expect(readRawSlot("b")!.lastSyncCommitSha).toBe("other");
  });

  it("a grouped update lands as ONE slot write carrying all fields (the merge-base anchor stays consistent)", async () => {
    await store.update({ lastSyncCommitSha: "seed" }); // a seq 0
    await store.update({
      lastSyncCommitSha: "c2",
      lastSyncTreeSha: "t2",
      lastCommitMtime: 22,
    });
    // Everything landed in the single b write; a untouched.
    const b = readRawSlot("b")!;
    expect(b.seq).toBe(1);
    expect(b.lastSyncCommitSha).toBe("c2");
    expect(b.lastSyncTreeSha).toBe("t2");
    expect(b.lastCommitMtime).toBe(22);
    expect(seqOf("a")).toBe(0);
  });

  it("lenient reads: malformed field values degrade to null without disqualifying the slot", async () => {
    fs.mkdirSync(path.dirname(slotFile("a")), { recursive: true });
    fs.writeFileSync(
      slotFile("a"),
      JSON.stringify({
        seq: 4,
        lastSyncCommitSha: "good-sha",
        lastCommitMtime: "not-a-number",
        remoteIdentity: { owner: "o" }, // missing repo/branch
        conflictBranch: "garbage",
      }),
    );
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBe("good-sha");
    expect(fresh.getLastCommitMtime()).toBeNull();
    expect(fresh.getRemoteIdentity()).toBeNull();
    expect(fresh.getConflictBranch()).toBeNull();
  });

  it("a failed write propagates AND leaves memory unchanged (nothing to roll back)", async () => {
    await store.update({ lastSyncCommitSha: "s1" });
    // The mock Vault's `adapter` getter builds a fresh object per
    // access, so the failure is injected by spying the getter itself.
    const realAdapter = vault.adapter;
    const spy = vi.spyOn(vault, "adapter", "get").mockReturnValue({
      ...realAdapter,
      write: async () => {
        throw new Error("disk full");
      },
    } as never);
    await expect(
      store.update({ lastSyncCommitSha: "s2" }),
    ).rejects.toThrow("disk full");
    expect(store.getLastSyncCommitSha()).toBe("s1"); // memory untouched
    spy.mockRestore();

    // Next attempt re-reads the disk and succeeds normally.
    await store.update({ lastSyncCommitSha: "s2" });
    expect(store.getLastSyncCommitSha()).toBe("s2");
    expect(seqOf("b")).toBe(1);
  });

  it("seq tie (externally seeded identical slots) → target is a", async () => {
    // The only legitimate tie: both slots carry identical bytes (§2.1
    // NOTE 1) — rewriting either loses nothing.
    fs.mkdirSync(path.dirname(slotFile("a")), { recursive: true });
    const blob = JSON.stringify({ seq: 0, lastSyncCommitSha: "seeded" });
    fs.writeFileSync(slotFile("a"), blob);
    fs.writeFileSync(slotFile("b"), blob);
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    await fresh.update({ lastCommitMtime: 9 });
    expect(seqOf("a")).toBe(1);
    expect(seqOf("b")).toBe(0);
  });
});
