import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import {
  drainOnce,
  DrainDeps,
  DrainClient,
  DrainProgress,
} from "../../src/sync2/drain";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import { ClaimedBatch } from "../../src/sync2/get-batch";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import {
  RemoteFileChange,
  DiscoveryResult,
  DELETED_SHA_HASH,
} from "../../src/sync2/discovery";
import { NetworkError, ValidationError } from "../../src/errors";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII B (rolling base / chaining, §II.3-II.5) + P.1-12/27-29
// (Layer 2 + the lying-discovery model) + L (sequential per-file,
// stat short-circuit read counts) + E п.1-5 (one wrapper test) —
// drainOnce() against a fake GitHub WORLD with real trees/commits/422
// semantics and the REAL SyncStore / DrainJournal / NetworkRetry.
//
// The world has TWO independent eyes (§VIII P prologue): `truth` —
// what really sits at head (Layer 2 / blobs read it), and
// `discoveryAnswer` — what discovery claims changed. Splitting them
// is the model of a Layer-1 blindspot (P.8-13).

const PLUGIN_ID = "git-easy-sync";

import {
  FakeWorld,
  FakeVaultFiles,
  RepoFiles,
  enc,
  dec,
  sha,
} from "./drain-harness";

describe("drainOnce (§VIII B + P + L + E)", () => {
  let dir: string;
  let vault: Vault;
  let world: FakeWorld;
  let syncStore: SyncStore;
  let journal: DrainJournal;
  let vaultFiles: FakeVaultFiles;
  let baselines: Map<
    string,
    { baselineSha: string; mtime: number; size: number }
  >;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let removedDirs: string[];
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let baseCommit: string | null;
  let discoveryOverride:
    ((base: string | null, head: string) => Promise<DiscoveryResult>) | null;
  let progressLog: Array<[number, number]>;
  let batchSeq: number;
  let hotUpdates: Array<{
    lastSyncCommitSha: string | null;
    lastSyncTreeSha: string | null;
    conflictBranchName: string | null;
  }>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "drain-test-"));
    vault = new Vault(dir);
    world = new FakeWorld();
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    journal = new DrainJournal({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
      generateGuid: () => `guid-${Math.random().toString(36).slice(2)}`,
    });
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    batches = [];
    removedDirs = [];
    baseCommit = null;
    discoveryOverride = null;
    progressLog = [];
    batchSeq = 0;
    hotUpdates = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Default discovery: an honest tree-diff of the fake world against
  // the recorded base commit — the same semantics discovery.ts
  // provides in production.
  const honestDiscovery = async (
    base: string | null,
    head: string,
  ): Promise<DiscoveryResult> => {
    const headFiles = world.filesAt(head);
    const baseFiles: RepoFiles =
      base === null ? new Map() : world.filesAt(base);
    const out: RemoteFileChange[] = [];
    const all = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const p of all) {
      const h = headFiles.get(p) ?? null;
      const b = baseFiles.get(p) ?? null;
      if (h?.sha === b?.sha) continue;
      out.push({
        path: p,
        sha: h?.sha ?? DELETED_SHA_HASH,
        size: h?.bytes.byteLength ?? null,
        mtime: null,
        deleted: h === null,
      });
    }
    // tree: null → Layer 2 keeps using the per-path transport,
    // so every pre-existing assertion here still covers THAT path.
    return { changes: out, tree: null };
  };

  // Stage a batch the way BatchWriter would: entries + blobs in the
  // sync_store.
  const stageBatch = async (
    files: Record<string, string | null>,
    mtime = 100,
    createdAt = 0,
  ): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      if (content === null) {
        entries.push({ path: p, sha: null, size: null, mtime: null, deletedSha: null });
        continue;
      }
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({
        path: p,
        sha: s,
        size: enc(content).byteLength,
        mtime,
        deletedSha: null,
      });
    }
    const id = `b${++batchSeq}`;
    batches.push({
      claimed: {
        id,
        dir: `queue/${id}`,
        meta: { v: 1, id, createdAt, entries },
      },
      removed: false,
    });
  };

  const makeDeps = (over?: Partial<DrainDeps>): DrainDeps => ({
    vault: vault as never,
    selfPluginId: PLUGIN_ID,
    client: world.makeClient(),
    syncStore,
    journal,
    retry: new NetworkRetry({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      sleep: async () => {},
    }),
    claimBatch: async () => {
      const next = batches.find((b) => !b.removed);
      return next ? next.claimed : null;
    },
    removeBatchDir: async (d) => {
      removedDirs.push(d);
      const b = batches.find((x) => x.claimed.dir === d);
      if (b) b.removed = true;
    },
    baselines: {
      get: async (p) => baselines.get(p),
      setMany: async (entries) => {
        for (const e of entries) {
          baselines.set(e.path, {
            baselineSha: e.baselineSha,
            mtime: e.mtime,
            size: e.size,
          });
        }
      },
      removeMany: async (paths) => {
        for (const p of paths) baselines.delete(p);
      },
    },
    discoverChangedFiles: (base, head) =>
      (discoveryOverride ?? honestDiscovery)(base, head),
    hot: {
      getLastSyncCommitSha: () => baseCommit,
      getLastSyncTreeSha: () => null,
      getConflictBranch: () => null,
      update: async (f) => {
        hotUpdates.push(f);
      },
    },
    conflictStore,
    siblingTx,
    tokenExpired: async () => false,
    vaultFiles,
    mergeBlobs: mergeBlobsWithMainThreadDiff3,
    computeSha: calculateGitBlobSHA,
    maxAutoMergeFileSize: () => 10_000_000,
    deviceLabel: () => "test-device",
    commitMessage: () => "Sync at test (test-device)",
    mergeMessage: () => "Merge conflict branch (test-device)",
    now: () => 1_700_000_500_000,
    onProgress: (p) => progressLog.push([p.pushDone, p.pushTotal]),
    ...over,
  });

  // Common setup: repo at C0 with note.md, vault + baselines aligned.
  const V0 = "one\ntwo\nthree\n";
  const setupAligned = async (): Promise<void> => {
    baseCommit = await world.commitFiles({ "note.md": V0 });
    const s = await sha(V0);
    baselines.set("note.md", {
      baselineSha: s,
      mtime: 50,
      size: enc(V0).byteLength,
    });
    vaultFiles.files.set("note.md", { content: V0, mtime: 50 });
  };

  // ── B: rolling base / chaining ───────────────────────────────────

  it("B.1 + B.7: chain C1..C3 with no remote changes → each D_i = C_i, three commits, base rolls, vault untouched", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    await stageBatch({ "note.md": "C2\n" });
    await stageBatch({ "note.md": "C3\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(3);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C3\n");
    // B.7: vault-step — base == remote (only local pushes) → untouched.
    expect(vaultFiles.writes).toEqual([]);
    expect(vaultFiles.files.get("note.md")!.content).toBe(V0); // as the user left it
    expect(removedDirs).toHaveLength(3);
    expect(r.layer2Corrections).toEqual([]); // P.28 happy-path sentinel
  });

  it("B.2: ONE remote change mid-chain → every step diff3s against the previous D; both sides' edits survive", async () => {
    await setupAligned();
    // Remote edits line 3; local batches edit line 1 twice.
    await world.commitFiles({ "note.md": "one\ntwo\nTHREE-remote\n" });
    await stageBatch({ "note.md": "C1-one\ntwo\nthree\n" });
    await stageBatch({ "note.md": "C2-one\ntwo\nthree\n" });
    // The batches were snapshotted FROM the vault — it holds C2 now.
    vaultFiles.files.set("note.md", {
      content: "C2-one\ntwo\nthree\n",
      mtime: 100,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(2);
    const final = dec(world.headFiles().get("note.md")!.bytes);
    expect(final).toBe("C2-one\ntwo\nTHREE-remote\n"); // last local + remote edit
    // Vault-step (II.3 ending): C_n != D_n → the vault receives the merge.
    expect(vaultFiles.files.get("note.md")!.content).toBe(
      "C2-one\ntwo\nTHREE-remote\n",
    );
  });

  it("B.3 + transaction rule: 422 mid-chain → restart re-pulls, journal re-load discards the failed batch's mutations, chain completes", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1-one\ntwo\nthree\n" });
    await stageBatch({ "note.md": "C2-one\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "C2-one\ntwo\nthree\n",
      mtime: 100,
    });

    // An external commit lands between batch 1's push and batch 2's:
    // trigger it from the SECOND pushCommitFromTree attempt.
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let pushes = 0;
    let injected = false;
    client.pushCommitFromTree = async (args) => {
      pushes += 1;
      if (pushes === 2 && !injected) {
        injected = true;
        // The external device edits line 3 of the CURRENT head (which
        // already carries C1's line-1 edit) — a mergeable divergence.
        await world.commitFiles({ "note.md": "C1-one\ntwo\nEXTERNAL\n" });
        // parent is now stale → the real push below throws 422.
      }
      return origPush(args);
    };

    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    // C1 push + failed attempt + successful merged C2 push.
    const final = dec(world.headFiles().get("note.md")!.bytes);
    expect(final).toBe("C2-one\ntwo\nEXTERNAL\n");
    expect(r.pushedCommits).toHaveLength(2); // failed attempt didn't count
    expect(removedDirs).toHaveLength(2);
  });

  it("B.4: crash after push, before persist → the restart sees its own push as remote, byte-identical drop, NO duplicate commit", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    vaultFiles.files.set("note.md", { content: "C1\n", mtime: 100 });

    // Crash: journal.persist throws right after the push. Since
    // §II.7.1 the branch-name mint is lazy, so a run with no conflict
    // never persists for it — the batch-completion persist is the
    // FIRST call, not the second. (Before that fix this was `=== 2`,
    // and the extra write it counted happened on every sync.)
    const origPersist = journal.persist.bind(journal);
    let persists = 0;
    journal.persist = async (state) => {
      persists += 1;
      if (persists === 1) {
        throw new Error("power loss before persist");
      }
      return origPersist(state);
    };
    await expect(drainOnce(makeDeps())).rejects.toThrow("power loss");
    expect(world.commits.length).toBe(2); // C0 + the pushed C1
    expect(batches[0].removed).toBe(false); // batch survived the crash

    // Restart: discovery reports our own C1 as the remote change →
    // pull-folding → short-circuit → no second push.
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0);
    expect(world.commits.length).toBe(2);
    expect(batches[0].removed).toBe(true);
  });

  // ── A1 п.22-25: the drain's half of the .obsidian/ mtime tiebreak ──
  //
  // The pure half lives in diff3.test.ts (the exhaustive sensitivity
  // matrix). This is the SEAM the field defect of 2026-09-23 lived in:
  // _diff3 decides 3.b.e internally and cannot fetch a mtime, Layer 2
  // (§II.13) nulls the remote one by design, and for plain .obsidian/
  // paths nothing put it back — so "newest wins" silently became
  // "remote always wins". Three tests: it works both ways, and it does
  // not start paying for paths that never compare mtimes.

  const obsidianTiebreakSetup = async (opts: {
    localMtime: number;
  }): Promise<{ deps: DrainDeps; infoCalls: string[] }> => {
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    // BOTH sides move away from base → the real collision, 3.b.e.
    world.committedAt += 5000;
    await world.commitFiles({ [OBS]: "REMOTE\n" });
    await stageBatch({ [OBS]: "LOCAL\n" }, opts.localMtime);
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: opts.localMtime });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    return { deps: makeDeps({ client }), infoCalls };
  };

  it("A1 п.22 🔑: LOCAL is newer → local wins, and the drain PAID for the mtime that proves it", async () => {
    // Before the fix this assertion was unreachable: remote.mtime was
    // null at the tiebreak, the null guard sent every such path to
    // remote, and the local edit was overwritten — exactly what the
    // owner's device log showed happening to a freshly-enforced
    // `.obsidian/.gitignore`.
    const { deps, infoCalls } = await obsidianTiebreakSetup({
      localMtime: 1_700_000_900_000, // after the remote commit
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([".obsidian/app.json"]); // fetched ONCE
    expect(vaultFiles.files.get(".obsidian/app.json")!.content).toBe("LOCAL\n");
    expect(dec(world.headFiles().get(".obsidian/app.json")!.bytes)).toBe(
      "LOCAL\n",
    );
  });

  it("A1 п.23: REMOTE is newer → remote wins — the fetch decides the winner, it does not hand it to local", async () => {
    const { deps, infoCalls } = await obsidianTiebreakSetup({
      localMtime: 1_700_000_001_000, // before the remote commit
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([".obsidian/app.json"]);
    expect(vaultFiles.files.get(".obsidian/app.json")!.content).toBe(
      "REMOTE\n",
    );
  });

  it("A1 п.24 (cost): a one-sided .obsidian change pays NOTHING — the fill is gated on the tiebreak, not on the folder", async () => {
    // The lazy fill must not become "fetch a commit for every
    // .obsidian file": enabling `Sync config` puts dozens of them in a
    // single batch, and each fetch is a full round trip. Only a
    // genuine two-sided collision compares mtimes, so only it pays.
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    // Remote stays at base; only the local side moved.
    await stageBatch({ [OBS]: "LOCAL\n" });
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: 100 });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([]); // 3.b.1.a — local wins outright
    expect(dec(world.headFiles().get(OBS)!.bytes)).toBe("LOCAL\n");
  });

  it("A1 п.24b (cost): a remote mtime the journal already carries is NOT re-fetched", async () => {
    // fillRemoteMtime is deliberately callable by any site that might
    // need a mtime, which only stays cheap while it no-ops on a known
    // one. Without that guard every caller becomes a round trip, and a
    // 422 restart re-pays for the whole batch.
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    world.committedAt += 5000;
    await world.commitFiles({ [OBS]: "REMOTE\n" });
    await stageBatch({ [OBS]: "LOCAL\n" }, 1_700_000_900_000);
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: 1_700_000_900_000 });

    // A journal from an interrupted run that already learned the
    // remote half — sha matching head, so Layer 2 finds nothing to
    // correct and the mtime it carries survives into the tiebreak.
    const { emptyDrainState } = await import("../../src/sync2/drain-journal");
    const js = (await journal.load()) ?? emptyDrainState();
    js.trackedFiles.set(OBS, {
      base: { path: OBS, sha: await sha("base\n"), size: 5, mtime: 50, blob: null, mode: "", deviceLabel: null },
      remote: { path: OBS, sha: await sha("REMOTE\n"), size: 7, mtime: 1_700_000_005_000, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(js);

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([]); // the answer was already in hand
    // …and it was actually USED: local is newer, so local wins.
    expect(dec(world.headFiles().get(OBS)!.bytes)).toBe("LOCAL\n");
  });

  it("A1 п.25: the PLUGIN-CORE seam pays for its mtime too — E4's own fix, which had no test until now", async () => {
    // Found by probe while pinning the 3.b.e fix (2026-09-23): deleting
    // the lazy fill from the plugin-dispatch branch left the entire
    // suite green. That fill IS the gate finding E4, whose comment
    // spells out the degeneration it prevents — and nothing was holding
    // it. Same shape as the defect it was written to fix, one branch
    // over. The two sites now share one fillRemoteMtime; this pins the
    // second caller so a future consolidation cannot quietly drop it.
    const CORE = ".obsidian/plugins/somePlugin/main.js";
    baseCommit = await world.commitFiles({ [CORE]: "base\n" });
    baselines.set(CORE, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    world.committedAt += 5000;
    await world.commitFiles({ [CORE]: "REMOTE\n" });
    await stageBatch({ [CORE]: "LOCAL\n" }, 1_700_000_900_000);
    vaultFiles.files.set(CORE, {
      content: "LOCAL\n",
      mtime: 1_700_000_900_000,
    });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([CORE]);
    // Local is the newer edit, so it must survive — with a null mtime
    // the tiebreak would have handed this to remote.
    expect(dec(world.headFiles().get(CORE)!.bytes)).toBe("LOCAL\n");
    expect(vaultFiles.files.get(CORE)!.content).toBe("LOCAL\n");
  });

  it("§II.7.1: an EMPTY drain costs exactly ONE request — the head read, and nothing else", async () => {
    // Field measurement 2026-09-23 (the reason §II.7.1 exists): on a
    // clean vault with an unmoved remote the drain was spending FIVE
    // sequential round trips, ~400 ms each, where the 2.x engine spent
    // one. Four carried no information this run could not already have:
    //
    //   2. getBranchHeadSha(<name minted THIS run>)  — cannot exist
    //   3. getGuardedHead() again, in FINALIZE       — unlocked by #2
    //   4. getBranchHeadSha(<the same phantom>)      — unlocked by #2
    //   5. getCommit(head) for a tree the hot pair already stored
    //
    // This is a COST test, so it counts calls rather than asserting on
    // the end state: every regression here is invisible to correctness
    // tests by construction, and a latency-bound path is exactly where
    // "one more little read" accumulates unnoticed.
    await setupAligned();
    baseCommit = world.head;
    const calls: string[] = [];
    const client = world.makeClient();
    for (const m of [
      "getGuardedHead",
      "getBranchHeadSha",
      "getCommit",
      "compareStatus",
      "getBlobFromRepo",
      "getContentsMetadataAtRef",
      "createBlob",
    ] as const) {
      const orig = (client[m] as (...a: unknown[]) => unknown).bind(client);
      (client as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        calls.push(m);
        return orig(...a);
      };
    }
    // The stored anchor already describes this very head, which is what
    // lets the epilogue skip request 5.
    const r = await drainOnce(
      makeDeps({
        client,
        hot: {
          getLastSyncCommitSha: () => baseCommit,
          getLastSyncTreeSha: () => world.commitTrees.get(world.head!)!,
          getConflictBranch: () => null,
          update: async (f) => {
            hotUpdates.push(f);
          },
        },
      }),
    );
    expect(r.status).toBe("ok");
    expect(calls).toEqual(["getGuardedHead"]);
    // …and the anchor it writes is still the honest (commit, tree)
    // pair — the saving must not come from writing a skewed one.
    const last = hotUpdates[hotUpdates.length - 1];
    expect(last.lastSyncCommitSha).toBe(world.head);
    expect(last.lastSyncTreeSha).toBe(world.commitTrees.get(world.head!)!);
  });

  it("B.5: remote-only (no batches) → zero pushes, the vault receives R_n, honest read short-circuit", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0);
    expect(vaultFiles.files.get("note.md")!.content).toBe("one\ntwo\nR1\n");
    // L/stat short-circuit: the vault copy matched the baseline pair —
    // resolving this pull required ZERO full vault reads.
    expect(vaultFiles.reads).toBe(0);
  });

  it("B.6/II.3 ending: remote change + local batch in ONE drain → merged push AND the vault gets the merged result", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nREMOTE\n" });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "LOCAL\ntwo\nthree\n",
      mtime: 100,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(1);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nREMOTE\n",
    );
    expect(vaultFiles.files.get("note.md")!.content).toBe(
      "LOCAL\ntwo\nREMOTE\n",
    );
  });

  it("B.8: vault edited DURING the drain (differs from base) + remote change → vault-step diff3 merges into the vault", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });
    // The user edits line 1 while the drain runs (stat differs → full read).
    vaultFiles.files.set("note.md", {
      content: "USER\ntwo\nthree\n",
      mtime: 77,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get("note.md")!.content).toBe("USER\ntwo\nR1\n");
    expect(vaultFiles.reads).toBe(1); // the touched file paid for its read
  });

  it("B.9: file DELETED from the vault during the drain + remote EDITED → MANUAL_CONFLICT verdict, no resurrection, base not advanced", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });
    vaultFiles.files.delete("note.md");

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([
      { path: "note.md", site: "vault-step" },
    ]);
    expect(vaultFiles.files.has("note.md")).toBe(false); // NOT resurrected
    expect(vaultFiles.writes).toEqual([]);
  });

  it("cold start (base=null) + empty repo (head=null): the SEED births the branch; a batch bigger than the seed adds ONE sync commit", async () => {
    // No setupAligned: bare repo, no baselines, fresh vault.
    // ⚠️ RE-DERIVED at THE SWITCH gate (2026-08-31, empirically):
    // Git Data API answers 409 on a repo with no ref, so the FIRST
    // commit can only come from the Contents API seed (drain.ts
    // seedBareRepoWithFile). The seed carries one of our own batch
    // files; the sync commit follows only if the batch holds more.
    await stageBatch({ "hello.md": "first\n", "second.md": "two\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(world.head).not.toBeNull(); // branch born by the seed
    expect(r.pushedCommits).toHaveLength(1); // the remainder
    expect(dec(world.headFiles().get("hello.md")!.bytes)).toBe("first\n");
    expect(dec(world.headFiles().get("second.md")!.bytes)).toBe("two\n");
  });

  it("cold start with a SINGLE-file batch: the seed carries everything → NO redundant sync commit", async () => {
    await stageBatch({ "only.md": "solo\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toEqual([]); // empty-tree check held
    expect(dec(world.headFiles().get("only.md")!.bytes)).toBe("solo\n");
    expect(world.commits).toHaveLength(1); // the seed alone
  });

  // ── P: Layer 2 + lying discovery ─────────────────────────────────

  it("P.2/P.9/P.27: discovery omits a remotely-changed path with a local edit → Layer 2 corrects EXACTLY once, then the normal path (merge)", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // the lie: "nothing changed"
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].path).toBe("note.md");
    // No silent loss: the hidden remote edit survived the push.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nHIDDEN\n",
    );
  });

  it("P.3: the WRONG tracked sha coincides with local.sha → the correction lands BEFORE the short-circuit", async () => {
    await setupAligned();
    const localContent = "LOCAL\ntwo\nthree\n";
    const localSha = await sha(localContent);
    // Poisoned journal from a previous run: remote allegedly == local.
    const state =
      (await journal.load()) ??
      (await import("../../src/sync2/drain-journal")).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: {
        path: "note.md",
        sha: await sha(V0),
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      remote: {
        path: "note.md",
        sha: localSha,
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      isManualConflict: false,
    });
    await journal.persist(state);
    // Truth: remote actually moved to something else entirely.
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // and discovery misses it
    await stageBatch({ "note.md": localContent });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    // Without Layer 2 the short-circuit would record "synced" and the
    // TRUTH content would be clobbered on the next cycle. With it:
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nTRUTH\n",
    );
  });

  it("P.4: path deleted on the server behind discovery's back → corrected to DELETED, local edit wins (4.6.a), file restored by push", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": null }); // deleted remotely
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].actual).toBe(DELETED_SHA_HASH);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nthree\n",
    );
  });

  it("P.6: a Layer-2 correction that turns into MANUAL_CONFLICT → STEP1 verdict, remote content NOT clobbered", async () => {
    await setupAligned();
    // Remote rewrote the SAME line the local batch touches → conflict.
    await world.commitFiles({ "note.md": "CLASH\ntwo\nthree\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts.some((v) => v.site === "step1")).toBe(true);
    // The conflicted path was NOT pushed — remote keeps its content.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "CLASH\ntwo\nthree\n",
    );
  });

  it("P.7: NETWORK_ERROR during the Layer-2 call → propagates as a drain-level network-error, never swallowed", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    client.getContentsMetadataAtRef = async () => {
      throw new NetworkError("net down");
    };
    const r = await drainOnce(
      makeDeps({
        client,
        retry: new NetworkRetry({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          maxAttempts: 2,
          sleep: async () => {},
        }),
      }),
    );
    expect(r.status).toBe("network-error");
    expect(world.commits.length).toBe(1); // nothing pushed
  });

  it("P.10 (parameterized): N paths, N runs each omitting ONE from discovery → no remote content is ever lost silently", async () => {
    for (const victim of ["a.md", "b.md", "c.md"]) {
      const w = new FakeWorld();
      const store = new SyncStore({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
      });
      const j = new DrainJournal({
        vault: vault as never,
        selfPluginId: `${PLUGIN_ID}-${victim}`,
      });
      const vf = new FakeVaultFiles();
      const bl = new Map<
        string,
        { baselineSha: string; mtime: number; size: number }
      >();
      const base: Record<string, string> = {};
      for (const p of ["a.md", "b.md", "c.md"]) {
        base[p] = `${p}: one\ntwo\nthree\n`;
      }
      const c0 = await w.commitFiles(base);
      for (const p of Object.keys(base)) {
        bl.set(p, {
          baselineSha: (await sha(base[p]))!,
          mtime: 50,
          size: enc(base[p]).byteLength,
        });
        vf.files.set(p, { content: base[p], mtime: 50 });
      }
      // Remote edits ALL THREE; discovery omits the victim.
      const remote: Record<string, string> = {};
      for (const p of Object.keys(base)) {
        remote[p] = `${p}: one\ntwo\nREMOTE\n`;
      }
      await w.commitFiles(remote);
      // Local batch edits all three too (line 1).
      const localBatchEntries: BatchEntry[] = [];
      for (const p of Object.keys(base)) {
        const content = `${p}: LOCAL\ntwo\nthree\n`;
        const s = await sha(content);
        await store.saveBlobToSyncStore(s, enc(content));
        localBatchEntries.push({
          path: p,
          sha: s,
          size: enc(content).byteLength,
          mtime: 100, deletedSha: null
        });
      }
      let removed = false;
      const r = await drainOnce(
        makeDeps({
          client: w.makeClient(),
          syncStore: store,
          journal: j,
          vaultFiles: vf,
          baselines: {
            get: async (p) => bl.get(p),
            setMany: async (entries) => {
              for (const e of entries) {
                bl.set(e.path, {
                  baselineSha: e.baselineSha,
                  mtime: e.mtime,
                  size: e.size,
                });
              }
            },
            removeMany: async (paths) => {
              for (const p of paths) bl.delete(p);
            },
          },
          hot: {
            getLastSyncCommitSha: () => c0,
            getLastSyncTreeSha: () => null,
            getConflictBranch: () => null,
            update: async () => {},
          },
          conflictStore: new ConflictStoreV2({
            vault: vault as never,
            selfPluginId: `${PLUGIN_ID}-${victim}`,
          }),
          siblingTx: new SiblingTx({
            vault: vault as never,
            selfPluginId: `${PLUGIN_ID}-${victim}`,
            store: new ConflictStoreV2({
              vault: vault as never,
              selfPluginId: `${PLUGIN_ID}-${victim}`,
            }),
            computeSha: calculateGitBlobSHA,
          }),
          claimBatch: async () =>
            removed
              ? null
              : {
                  id: "b1",
                  dir: "queue/b1",
                  meta: {
                    v: 1,
                    id: "b1",
                    createdAt: 0,
                    entries: localBatchEntries,
                  },
                },
          removeBatchDir: async () => {
            removed = true;
          },
          discoverChangedFiles: async (b, h) => {
            const honest = await (async () => {
              const out: RemoteFileChange[] = [];
              for (const [p, f] of w.filesAt(h)) {
                const bf = b === null ? null : (w.filesAt(b).get(p) ?? null);
                if (bf?.sha === f.sha) continue;
                out.push({
                  path: p,
                  sha: f.sha,
                  size: f.bytes.byteLength,
                  mtime: null,
                  deleted: false,
                });
              }
              return out;
            })();
            return {
              changes: honest.filter((c) => c.path !== victim),
              tree: null,
            };
          },
        }),
      );
      expect(r.status).toBe("ok");
      expect(r.layer2Corrections.map((c) => c.path)).toEqual([victim]);
      for (const p of Object.keys(base)) {
        expect(dec(w.headFiles().get(p)!.bytes)).toBe(
          `${p}: LOCAL\ntwo\nREMOTE\n`,
        );
      }
    }
  });

  it("P.11 (subtlest, two drains): omission + sha coincidence → the SECOND drain must not clobber the truth", async () => {
    await setupAligned();
    const localContent = "LOCAL\ntwo\nthree\n";
    const localSha = await sha(localContent);
    const state = (
      await import("../../src/sync2/drain-journal")
    ).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: {
        path: "note.md",
        sha: await sha(V0),
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      remote: {
        path: "note.md",
        sha: localSha,
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      isManualConflict: false,
    });
    await journal.persist(state);
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": localContent });

    const r1 = await drainOnce(makeDeps());
    expect(r1.status).toBe("ok");
    // Drain 2 with an honest discovery: whatever drain 1 recorded must
    // not lead to a clobber now.
    discoveryOverride = null;
    baseCommit = world.commits[0];
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toContain("TRUTH");
  });

  it("P.12 (coverage boundary, EXPECTED): a remote-only change omitted by discovery — no batch entry → Layer 2 never sees it", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nUNSEEN\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // omitted, and no local batch
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toEqual([]); // documented limit, not a bug:
    expect(vaultFiles.files.get("note.md")!.content).toBe(V0); // pull lost until Layer 1 is honest
  });

  it("P.28/P.29: happy path → layer2Corrections EMPTY; the counter is run-scoped (fresh per drain)", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const r1 = await drainOnce(makeDeps());
    expect(r1.layer2Corrections).toEqual([]);
    baseCommit = world.head;
    const r2 = await drainOnce(makeDeps());
    expect(r2.layer2Corrections).toEqual([]);
    expect(r1).not.toBe(r2);
  });

  // ── L: sequential per-file + read counts ─────────────────────────

  it("L.1: files inside a batch are processed strictly sequentially, progress counts by file", async () => {
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });
    await drainOnce(makeDeps());
    expect(progressLog).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  // ── §II.16: the two progress counters ────────────────────────────

  it("§II.16: the push total GROWS batch by batch — 3, then 3+5 — because the run learns of work as it goes", async () => {
    // The user's own reading of the design, pinned: a thousand files in
    // ten batches counts 100/100 → 101/200 → … and that is correct.
    // The drain cannot know the queue's depth in files, and inventing a
    // total would be a guess dressed as knowledge. The status bar's
    // falling "↑ N" is what tells the user more batches are coming.
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });
    await stageBatch({
      "d.md": "D\n",
      "e.md": "E\n",
      "f.md": "F\n",
      "g.md": "G\n",
      "h.md": "H\n",
    });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    expect(snaps.map((p) => [p.pushDone, p.pushTotal])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 8], // the second batch arrives — the total grows, done keeps going
      [5, 8],
      [6, 8],
      [7, 8],
      [8, 8],
    ]);
  });

  it("§II.16 🔑: a 422 restart ROLLS the push counters BACK — it never inflates them", async () => {
    // Owner decision 2026-09-25, and the argument is about fear, not
    // arithmetic: someone who changed three files and sees six will
    // conclude the plugin is sending something they did not ask for.
    // A count that visibly restarts is less alarming than one that
    // doubles.
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });

    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let failures = 0;
    client.pushCommitFromTree = async (args) => {
      if (failures === 0) {
        failures += 1;
        await world.commitFiles({ "other.md": "raced\n" });
        throw new ValidationError("422: head moved");
      }
      return origPush(args);
    };

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ client, onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    const pushes = snaps.map((p) => [p.pushDone, p.pushTotal]);
    // Three files, one restart: the count runs 1..3, goes back to the
    // pre-batch values, and runs 1..3 again. It NEVER reaches 4 or a
    // total of 6.
    expect(pushes).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [1, 3], // ← the restart put them back; it did NOT continue to 4
      [2, 3],
      [3, 3],
      [3, 3], // the Vault-step's PULL tick for the raced file, below
    ]);
    // Never inflated: neither number ever exceeded the three files the
    // user actually changed.
    expect(Math.max(...snaps.map((p) => p.pushDone))).toBe(3);
    expect(Math.max(...snaps.map((p) => p.pushTotal))).toBe(3);
    // The seventh snapshot is the other side reporting: the commit this
    // test raced in is a remote change, so it counts as one pull.
    expect(snaps[snaps.length - 1].pullDone).toBe(1);
  });

  it("§II.16: one remote change is ONE pull unit, even when the path is also in the batch", async () => {
    // _diff3 runs for ordinary paths in TWO places (the batch loop and
    // the Vault-step), and a path present in both would be counted
    // twice without the guard — the counter would overshoot its own
    // total, which is the one thing a progress display must never do.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nREMOTE\n" });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "LOCAL\ntwo\nthree\n",
      mtime: 100,
    });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    const last = snaps[snaps.length - 1];
    expect([last.pullDone, last.pullTotal]).toEqual([1, 1]);
  });

  it("L/stat short-circuit: only files with a REAL divergence pay for a vault read (advisor 2026-08-30 — no O(vault) re-hash)", async () => {
    // 5 aligned files; remote changes ONE; the user touches NONE.
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.md`] = `content ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    await world.commitFiles({ "f3.md": "content 3 CHANGED\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get("f3.md")!.content).toBe("content 3 CHANGED\n");
    // The four untouched files resolved via stat alone.
    expect(vaultFiles.reads).toBe(0);
  });

  // ── E п.1-5: one wrapper test ────────────────────────────────────

  it("E: transient NetworkError on the head read is retried by the injected NetworkRetry and the drain succeeds", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    const origHead = client.getGuardedHead.bind(client);
    let failures = 0;
    client.getGuardedHead = async () => {
      if (failures < 2) {
        failures += 1;
        throw new NetworkError("flaky");
      }
      return origHead();
    };
    let sleeps = 0;
    const r = await drainOnce(
      makeDeps({
        client,
        retry: new NetworkRetry({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          sleep: async () => {
            sleeps += 1;
          },
        }),
      }),
    );
    expect(r.status).toBe("ok");
    expect(sleeps).toBe(2); // retried, not failed through
    expect(r.pushedCommits).toHaveLength(1);
  });

  it("422-CAP (I6): five consecutive 422s with no success → clean too-many-concurrent-pushes exit, queue intact", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    client.pushCommitFromTree = async () => {
      // Every push races an external commit.
      await world.commitFiles({ "other.md": `x${world.commits.length}\n` });
      throw new ValidationError("422: head moved");
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("too-many-concurrent-pushes");
    expect(batches[0].removed).toBe(false); // the batch survives for the next run
    // D.16 extended to the durable conflicts (W1 fix, 2026-09-20): the
    // CAP exit persists none of the FAILED ATTEMPT's state. The new
    // store-then-journal pair sits at the batch END, which a CAP exit
    // never reaches — pinned here so a future "just save it
    // defensively" cannot poison the store. Since §II.7.1 the journal
    // is ABSENT entirely: the CLEAN early write this used to assert on
    // was the branch-name mint's, and a run with no conflict no longer
    // mints. Absence is the stronger form of the same invariant, so
    // the assertion reads "nothing of the failed attempt persisted",
    // whether or not a file exists.
    expect((await journal.load())?.trackedFiles.size ?? 0).toBe(0);
    expect((await conflictStore.load()).entries.size).toBe(0);
  });

  // ── DOT-FILES §8.0 — the seeded .gitignore as its own ancestor ────
  //
  // The engine half of the fix. `enforce()` writes the managed
  // .gitignore files BEFORE any sync, so on a cold start our own write
  // would meet the repo's version with no common base and rule 4.2
  // would call it a manual conflict the user never caused. A file that
  // is byte-identical to what we seed is marked, and the marker lets
  // that content serve as the path's own base.

  it("§8.0: a MARKED local file adopts the remote version instead of conflicting", async () => {
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", {
      baselineSha: await sha("n\n"),
      mtime: 1,
      size: 2,
    });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    // The repo already carries its own .gitignore…
    await world.commitFiles({ ".gitignore": "# repo\n*.tmp\n" });
    // …and enforce() has just seeded ours, which the commit pass
    // queued. No baseline for it: this is the first meeting.
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });
    const oursSha = await sha(OURS);

    const r = await drainOnce(
      makeDeps({
        gitignoreSeeds: { matches: (p, s2) => p === ".gitignore" && s2 === oursSha },
      }),
    );

    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([]); // the whole point
    // Clean pull: the repo's version wins and lands in the vault.
    expect(vaultFiles.files.get(".gitignore")!.content).toBe("# repo\n*.tmp\n");
  });

  it("§8.0: the SAME state without a marker conflicts — the marker is what changes the answer", async () => {
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", { baselineSha: await sha("n\n"), mtime: 1, size: 2 });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    await world.commitFiles({ ".gitignore": "# repo\n*.tmp\n" });
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });

    const r = await drainOnce(makeDeps()); // no seeds view at all

    expect(r.status).toBe("ok");
    // Recorded at more than one site (STEP1 + the Vault-step) — the
    // point is that the path conflicts at all.
    expect([...new Set(r.conflictVerdicts.map((v) => v.path))]).toEqual([
      ".gitignore",
    ]);
  });

  it("§8.0: a marked file with NO remote counterpart is still PUSHED — the ancestor must not fire", async () => {
    // The trap: base := local with remote == null is handled by no
    // rule (2.a/2.b need matching nullness, 4.3-4.6 need
    // local.sha !== base.sha), so it would fall into the merge path
    // with a null remote. The right answer stays base == null →
    // 4.1.a → push ours.
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", { baselineSha: await sha("n\n"), mtime: 1, size: 2 });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });
    const oursSha = await sha(OURS);

    const r = await drainOnce(
      makeDeps({
        gitignoreSeeds: { matches: (p, s2) => p === ".gitignore" && s2 === oursSha },
      }),
    );

    expect(r.status).toBe("ok");
    expect(dec(world.headFiles().get(".gitignore")!.bytes)).toBe(OURS);
  });

  // ── D: the epilogue (§III steps 1-4) ─────────────────────────────

  it("D.13: baseline transfer — final remote sha with the mtime:0 sentinel; deleted paths LEAVE the baselines; journal dies", async () => {
    await setupAligned();
    // Real mtimes in the batch — they must NOT leak into the baseline.
    await stageBatch({ "new.md": "N\n", "note.md": null }, 1234);

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // mtime:0 on purpose: a user edit DURING the drain with an equal
    // size must not short-circuit invisibly forever; the detector
    // self-heals with exactly one re-hash.
    expect(baselines.get("new.md")).toEqual({
      baselineSha: await sha("N\n"),
      mtime: 0,
      size: enc("N\n").byteLength,
    });
    expect(baselines.has("note.md")).toBe(false); // pushed deletion → removed
    // The journal's absence is the 'previous drain finished' signal.
    expect(await journal.load()).toBeNull();
  });

  it("D.14: placeholder guard — an idle lingering conflict (remote.sha null) transfers NOTHING; the real previous baseline survives", async () => {
    await setupAligned();
    const lockedSha = await sha("L\n");
    const durable = await conflictStore.load();
    durable.entries.set("locked.md", {
      conflictBase: {
        path: "locked.md",
        sha: lockedSha,
        size: 2,
        mtime: 10,
        blob: null,
        mode: "" as const,
        deviceLabel: "other-device",
      },
      siblings: [], // I.7: an empty siblings list is still a conflict
    });
    await conflictStore.save(durable);
    baselines.set("locked.md", { baselineSha: lockedSha, mtime: 10, size: 2 });
    await stageBatch({ "other.md": "O\n" }); // unrelated work

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // The conflict path was seeded as a placeholder tracked record
    // ({sha:null}); writing its nulls would ERASE the real baseline.
    expect(baselines.get("locked.md")).toEqual({
      baselineSha: lockedSha,
      mtime: 10,
      size: 2,
    });
  });

  it("D.15: pull-only drain → the hot anchor (commit, tree) pair is aligned via one getCommit, never a stale-tree skew", async () => {
    await setupAligned();
    const c1 = await world.commitFiles({ "note.md": "R\n" }); // remote-only

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0); // nothing pushed → tree unknown in-run
    const last = hotUpdates[hotUpdates.length - 1];
    expect(last.lastSyncCommitSha).toBe(c1);
    expect(last.lastSyncTreeSha).toBe(world.commitTrees.get(c1)!);
    expect(last.conflictBranchName).toBeNull();
    expect(await journal.load()).toBeNull();
  });

  it("D.16: a CAP exit runs NO epilogue and never persists the failed attempt's state; the redo lands the batch", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let sabotage = true;
    client.pushCommitFromTree = async (args) => {
      if (sabotage) {
        await world.commitFiles({ "other.md": `x${world.commits.length}\n` });
        throw new ValidationError("422: head moved");
      }
      return origPush(args);
    };

    const r1 = await drainOnce(makeDeps({ client }));
    expect(r1.status).toBe("too-many-concurrent-pushes");
    // The CAP exit must look exactly like a crash BEFORE the failed
    // batch: no persist of the dirty in-memory state. Here nothing
    // completed, so no journal exists at all. (RED without the fix:
    // the poisoned journal claims base==remote==C1 → the redo
    // short-circuits the batch and C1 is silently lost.)
    const j1 = await journal.load();
    expect(j1?.trackedFiles.get("note.md")?.remote.sha ?? null).not.toBe(
      await sha("C1\n"),
    );
    expect(hotUpdates).toEqual([]); // no CONFIRMED anchor from an abort
    expect(baselines.get("note.md")!.mtime).toBe(50); // untouched

    sabotage = false;
    const r2 = await drainOnce(makeDeps({ client }));
    expect(r2.status).toBe("ok");
    expect(r2.pushedCommits).toHaveLength(1); // the redo actually lands C1
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
    expect(baselines.get("note.md")).toEqual({
      baselineSha: await sha("C1\n"),
      mtime: 0,
      size: enc("C1\n").byteLength,
    });
    expect(hotUpdates[hotUpdates.length - 1].lastSyncCommitSha).toBe(
      world.head,
    );
    expect(await journal.load()).toBeNull();
  });

  // ── S1 (Phase 5.5 step 4 prep): cancel / per-batch identity /
  //    vault-step reporting / confirmDeleted / forbidden-name port ──

  it("S1 cancel: a batch-boundary cancel exits with 'cancelled' and persists NOTHING (D.16 rule) — the redo lands the batch", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    let cancelled = true;
    const deps = makeDeps({ cancelRequested: () => cancelled });

    const r1 = await drainOnce(deps);
    expect(r1.status).toBe("cancelled");
    expect(batches[0].removed).toBe(false); // queue intact
    expect(await journal.load()).toBeNull(); // nothing persisted
    expect(hotUpdates).toEqual([]); // no anchor from a cancel
    expect(baselines.get("note.md")!.mtime).toBe(50); // untouched

    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  it("S1 cancel 🔑 (Vault-step): a pull-heavy drain stops mid-loop, keeps the journal, and the NEXT drain finishes the job", async () => {
    // The gap found 2026-09-26: the Vault-step had no cancel check, and
    // it is the phase where the user actually waits on a big pull —
    // every pulled file is written here. [Cancel sync] did nothing
    // until the whole loop drained.
    //
    // The point of this test is NOT that it exits. It is that exiting
    // COSTS NOTHING: the journal survives, and a second drain lands
    // every file. If that were false, cancellation would be a way to
    // corrupt a sync, and the button would have to go.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    // Remote moves every one of them — a pure pull, so ALL the work is
    // in the Vault-step and none of it in a batch.
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);

    // Cancel once the Vault-step has written its first file.
    let cancelled = false;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => cancelled,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                cancelled = true; // the user clicks [Cancel sync] now
                return (
                  t as unknown as Record<string, (...a: unknown[]) => unknown>
                ).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    // Partial by construction — that is what makes the resume the
    // interesting half.
    expect(r1.vaultStepWrites.length).toBeLessThan(4);
    // 🔑 THE invariant that makes cancelling safe here. A pure pull
    // writes no journal at all (only a completed batch does), so the
    // resume does not come from stored state — it comes from the next
    // drain REDISCOVERING the same remote changes. That only works
    // while the anchor still points at the old commit. Had the
    // epilogue run and advanced it, the next drain would believe it
    // was up to date and the unwritten files would be lost silently.
    expect(hotUpdates).toEqual([]);
    expect(await journal.load()).toBeNull(); // nothing to persist, by design

    // The resume: every file lands, and the run completes normally.
    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    for (let i = 0; i < 4; i++) {
      expect(vaultFiles.files.get(`p${i}.md`)!.content).toBe(`REMOTE ${i}\n`);
    }
    // …and THIS run did confirm itself: the anchor finally moved.
    expect(hotUpdates.length).toBeGreaterThan(0);
    expect(hotUpdates[hotUpdates.length - 1].lastSyncCommitSha).toBe(
      world.head,
    );
  });

  it("S1 cancel 🔑 (push boundary): a click during the 4-second push stretch is NOT lost", async () => {
    // Field report 2026-09-26: [Cancel sync] appeared to do nothing.
    // The per-file loop is LOCAL and finishes in milliseconds; the
    // stretch the user actually waits through is flush → commit → ref
    // move (~3-4 s on the owner's device), and it had no checkpoint at
    // all. A click landing there was silently dropped and the drain ran
    // to completion.
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });

    // The click lands WHILE the files are being processed — i.e. after
    // the loop's own check for this entry has already passed. The old
    // code then went straight into the push and ignored it entirely.
    let cancelled = false;
    const r = await drainOnce(
      makeDeps({
        onProgress: () => {
          cancelled = true;
        },
        cancelRequested: () => cancelled,
      }),
    );
    // Without the checkpoint this returns "ok" and the ref has moved.
    expect(r.status).toBe("cancelled");
    expect(r.pushedCommits).toEqual([]);
    expect(batches[0].removed).toBe(false); // the batch waits for the redo
    expect(hotUpdates).toEqual([]); // nothing confirmed

    // And the redo lands it — cancelling cost only the time already spent.
    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  it("S1 message+author: main push carries the BATCH's createdAt (message AND author.date); merge/conflict use now()", async () => {
    await setupAligned();
    const CREATED = 1_777_000_123_000;
    await stageBatch({ "note.md": "C1\n" }, 100, CREATED);

    const messageArgs: number[] = [];
    const pushedAuthors: Array<unknown> = [];
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    client.pushCommitFromTree = async (args) => {
      pushedAuthors.push((args as { author?: unknown }).author);
      return origPush(args);
    };
    const r = await drainOnce(
      makeDeps({
        client,
        commitMessage: (whenMs: number) => {
          messageArgs.push(whenMs);
          return `Sync at ${whenMs} (test-device)`;
        },
        gitAuthor: () => ({ name: "Vlad", email: "v@x" }),
      }),
    );
    expect(r.status).toBe("ok");
    expect(messageArgs).toEqual([CREATED]); // per-batch, not per-drain
    expect(pushedAuthors).toHaveLength(1);
    expect(pushedAuthors[0]).toMatchObject({ name: "Vlad", email: "v@x" });
    // author.date is the git-formatted BATCH moment (local offset
    // form) — the mtime invariant then records the EDIT moment
    // (owner decision п.1).
    expect(Date.parse((pushedAuthors[0] as { date: string }).date)).toBe(
      CREATED,
    );
  });

  it("S1 vault-step reporting: writes and removes are surfaced (pulledFiles + onPluginsAffected feed); progress carries the path", async () => {
    await setupAligned();
    // obs.md exists on remote AND locally, aligned; then the remote
    // edits note.md and deletes obs.md.
    baseCommit = await world.commitFiles({ "obs.md": "x" });
    vaultFiles.files.set("obs.md", { content: "x", mtime: 50 });
    baselines.set("obs.md", {
      baselineSha: await sha("x"),
      mtime: 50,
      size: 1,
    });
    await world.commitFiles({ "note.md": "R\n", "obs.md": null });
    await stageBatch({ "other.md": "O\n" });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    expect(r.vaultStepWrites).toEqual(["note.md"]);
    expect(r.vaultStepRemoves).toEqual(["obs.md"]);
    // §II.16: progress names BOTH sides. `other.md` is the push (a
    // batch entry); note.md and obs.md are the pull (remote changes
    // landing in the Vault-step). Before §II.16 only the batch entry
    // reported, so the two remote paths were a silent stretch.
    expect(snaps.map((p) => p.path)).toEqual([
      "other.md",
      "note.md",
      "obs.md",
    ]);
    // …and the counters end honest: one file out, two in.
    const last = snaps[snaps.length - 1];
    expect([last.pushDone, last.pushTotal]).toEqual([1, 1]);
    expect([last.pullDone, last.pullTotal]).toEqual([2, 2]);
  });


  it("S1 forbidden-name port: a remote path the platform can't materialise is written CANONICALLY; the baseline stays the honest remote truth", async () => {
    await setupAligned();
    const BAD = 'notes/we"ird?.md'; // " and ? are forbidden (cross-platform.ts)
    await world.commitFiles({ [BAD]: "remote content\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // Written under the canonical name, reported as such.
    expect(r.vaultStepWrites).toHaveLength(1);
    const canonical = r.vaultStepWrites[0];
    expect(canonical).not.toBe(BAD);
    expect(vaultFiles.files.has(canonical)).toBe(true);
    expect(vaultFiles.files.get(canonical)!.content).toBe("remote content\n");
    expect(vaultFiles.files.has(BAD)).toBe(false); // never materialised
    // The epilogue records the HONEST remote truth for the ORIGINAL
    // path — the next findChanges sees baseline-without-file and emits
    // the deletion that renames the remote (§III annotation).
    expect(baselines.get(BAD)!.baselineSha).toBe(await sha("remote content\n"));
    expect(baselines.has(canonical)).toBe(false); // detector picks it up as new
  });

  it("free-size (epilogue): a compare-born baseline carries the REAL size, never 0 — the stat short-circuit must stay usable", async () => {
    await setupAligned();
    // Remote-only change; the honest fake (like the real compare API)
    // reports NO size for it.
    discoveryOverride = async () => ({
      tree: null,
      changes: [
        {
          path: "note.md",
          sha: await sha("R\n"),
          size: null, // ← compare gives none
          mtime: null,
          deleted: false,
        },
      ],
    });
    await world.commitFiles({ "note.md": "R\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // The blob was fetched for the vault write, so the size is free.
    expect(baselines.get("note.md")!.size).toBe(enc("R\n").byteLength);
    expect(baselines.get("note.md")!.size).not.toBe(0);
  });

  it("S3 §12.5 sweep: an orphan sync_store blob is reaped at the drain boundaries; queue/journal/conflict-referenced blobs survive", async () => {
    await setupAligned();
    // An orphan from some previous crash…
    const orphan = await sha("orphan bytes\n");
    await syncStore.saveBlobToSyncStore(orphan, enc("orphan bytes\n"));
    // …and a batch whose blob IS referenced while queued.
    await stageBatch({ "note.md": "C1\n" });
    const batchBlob = await sha("C1\n");

    const deps = makeDeps({
      queueReferencedShas: async () => {
        const out = new Set<string>();
        for (const b of batches) {
          if (b.removed) continue;
          for (const e of b.claimed.meta.entries) {
            if (e.sha !== null) out.add(e.sha);
          }
        }
        return out;
      },
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    // The orphan died (start sweep); the batch blob died TOO — the
    // batch completed and nothing references it anymore (end sweep).
    expect(await syncStore.existInSyncStore(orphan)).toBe(false);
    expect(await syncStore.existInSyncStore(batchBlob)).toBe(false);
    // But the push landed — hygiene never touched correctness.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  it("S3b §12.5 sweep WIRING: all FOUR reference sources reach the store — the drain never sweeps on a partial view", async () => {
    // Found by mutation probe (§IX.3, 2026-09-23). F.5 pins the STORE
    // half (`sweep()` honours each source it is handed), and S3 above
    // pins reaping — but nothing pinned the LIST. Deleting the journal
    // source, the conflictStore source, or the Deleted-bin source from
    // `sweepSyncStore` left the whole suite green, and S3's title
    // ("queue/journal/conflict-referenced blobs survive") wrote a
    // cheque its body never cashed: both its blobs are expected to DIE.
    //
    // What a missing source costs is not hygiene. Source 5's own
    // comment says it plainly: the bin's captures are referenced by
    // nothing else until the deletion reaches a batch, so dropping it
    // deletes the user's only copy of a file between the delete and
    // its commit. The other two cost a crash-restart its blobs.
    //
    // Distinguishable markers, not real blobs: the assertion is about
    // WHICH sources were consulted, so the sweep's verdict on them is
    // beside the point.
    await setupAligned();
    journal.collectReferencedShas = async () => new Set(["marker-journal"]);
    conflictStore.collectReferencedShas = async () =>
      new Set(["marker-conflict"]);

    const consulted = new Set<string>();
    const realSweep = syncStore.sweep.bind(syncStore);
    syncStore.sweep = async (sources) => {
      for (const s of sources) {
        for (const sha of await s()) consulted.add(sha);
      }
      return realSweep(sources);
    };

    const r = await drainOnce(
      makeDeps({
        queueReferencedShas: async () => new Set(["marker-queue"]),
        deletedBinReferencedShas: () => new Set(["marker-bin"]),
      }),
    );
    expect(r.status).toBe("ok");
    expect([...consulted].sort()).toEqual([
      "marker-bin",
      "marker-conflict",
      "marker-journal",
      "marker-queue",
    ]);
  });

  it("S1 forbidden-name collision: canonical target exists → LOUD skip, NO baseline for the original (no silent remote deletion)", async () => {
    await setupAligned();
    const BAD = 'we"ird.md';
    await world.commitFiles({ [BAD]: "remote content\n" });
    // The canonical name is already occupied by DIFFERENT local content.
    const { sanitizeFilename } = await import("../../src/sync2/cross-platform");
    const canonical = sanitizeFilename(BAD);
    vaultFiles.files.set(canonical, { content: "user content", mtime: 60 });

    const warns: string[] = [];
    const r = await drainOnce(
      makeDeps({
        logger: { info: () => {}, warn: (m) => warns.push(m) },
      }),
    );
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get(canonical)!.content).toBe("user content"); // untouched
    expect(warns.some((w) => w.includes("sanitize skipped"))).toBe(true);
    // NO baseline for BAD: recording it would make the next commit-pass
    // DELETE remote content that never landed anywhere locally.
    expect(baselines.has(BAD)).toBe(false);
  });

  // ── P.29 — Layer 2 answered from discovery's tree snapshot ────────
  //
  // The measurement that forced this (owner's bootstrap on a 63 MB
  // vault, 2026-09-01): 255 of 283 requests were per-path Layer-2
  // HEADs, 78 s of a 90 s run. On a cold start EVERY local file is a
  // batch entry, so Layer 2 fired once per file — asking the network
  // for `sha`+`size` at a PINNED commit that discovery had already
  // read in full, one request earlier.
  //
  // These tests pin the two halves that make the substitution safe:
  // it must still catch a blindspot (that is Layer 2's whole job), and
  // it must refuse to answer for any commit other than the one the
  // tree was read at.

  // Wraps the world's client so a test can count the per-path HEADs
  // and, where needed, make them explode: a call that MUST NOT happen
  // is better proven by a throw than by a counter nobody reads.
  const countingClient = (opts?: { forbidHead?: boolean }) => {
    const base = world.makeClient();
    let heads = 0;
    return {
      client: {
        ...base,
        getContentsMetadataAtRef: async (path: string, ref: string) => {
          heads += 1;
          if (opts?.forbidHead) {
            throw new Error(`unexpected Layer-2 HEAD for ${path}@${ref}`);
          }
          return base.getContentsMetadataAtRef(path, ref);
        },
      } as DrainDeps["client"],
      heads: () => heads,
    };
  };

  // An HONEST snapshot of the fake repo at its current head — the same
  // thing production discovery builds from one recursive tree read.
  const snapshotAtHead = () => ({
    atCommit: world.head as string,
    paths: new Map(
      [...world.headFiles()].map(([p, f]) => [
        p,
        { sha: f.sha, size: f.bytes.byteLength as number | null },
      ]),
    ),
  });

  it("P.29a: on a COLD START the snapshot answers everything — zero per-path requests", async () => {
    // The shape that produced the 255 HEADs: no baseline commit, so
    // discovery reads the full tree, and every local file is a batch
    // entry that Layer 2 wants to verify.
    await setupAligned();
    baseCommit = null; // cold start — .runtime/ was wiped (or is new)
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    // P.28's sentinel: nothing was hidden, so nothing to correct.
    expect(r.layer2Corrections).toEqual([]);
  });

  it("P.29a-bis: when the remote has NOT moved, discovery is skipped — so is the snapshot, and Layer 2 pays per path", async () => {
    // Documents the boundary rather than pretending it away: the drain
    // only calls discovery when head !== base, so an incremental sync
    // against an unmoved remote has no tree to answer from. Cheap
    // anyway — the batch holds only what the user just edited.
    await setupAligned();
    const c = countingClient();
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(1); // one entry, one HEAD
  });

  it("P.29b: a blindspot is corrected from the snapshot exactly as it would be from a HEAD", async () => {
    // Byte-for-byte the P.2 scenario, with the only difference being
    // where the answer came from — the outcome must be identical.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nHIDDEN\n",
    );
  });

  it("P.29c: a snapshot from a DIFFERENT commit is refused — the network answers instead", async () => {
    // The guard that keeps this from becoming the silent clobber G9
    // exists to prevent: head rolls after every batch push, and a map
    // keyed to yesterday's commit must never speak for today's.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient();
    const stale = snapshotAtHead();
    discoveryOverride = async () => ({
      changes: [],
      tree: { ...stale, atCommit: "0".repeat(40) },
    });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBeGreaterThan(0);
    // And the correction still happens — via the transport, not the map.
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
  });

  it("P.29d: absent from a complete snapshot means DELETED, the same as a 404", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": null }); // deleted remotely
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].actual).toBe(DELETED_SHA_HASH);
    // 4.6.a — the live local edit wins over a remote deletion.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nthree\n",
    );
  });

  it("P.29e: no snapshot (the compare path) keeps using the per-path transport", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient();
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBeGreaterThan(0);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
  });

  // ── §II.13.2: the drain acquires the snapshot ITSELF ─────────────
  //
  // P.29a-e above all depend on discovery HAPPENING to have read a
  // tree. It only does that on the cold path, so the everyday shape —
  // many local files, remote barely moved — fell through to per-path
  // and cost the owner ~15 s of a 23 s sync (41 requests), and 78 s of
  // 90 s on a 63 MB vault (255 requests). These pin the fix: when
  // there is no usable snapshot and the batch is worth it, read the
  // tree once. Layer 2's logic is unchanged — only where it looks.

  // A batch of N ordinary files, remote NOT moved (so discovery is
  // never called and leaves no snapshot) — the exact field shape.
  const stageNFiles = async (n: number): Promise<string[]> => {
    const paths: string[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const p = `f${i}.md`;
      paths.push(p);
      files[p] = `content ${i}\n`;
    }
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const edits: Record<string, string> = {};
    for (const p of paths) edits[p] = `EDITED ${p}\n`;
    await stageBatch(edits);
    for (const p of paths) {
      vaultFiles.files.set(p, { content: `EDITED ${p}\n`, mtime: 100 });
    }
    return paths;
  };

  it("§II.13.2 🔑 (cost): a batch of 4+ with no snapshot reads the tree ONCE — zero per-path requests", async () => {
    const paths = await stageNFiles(6);
    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1); // one bulk answer…
    expect(world.metadataReads).toEqual([]); // …and nothing per path
    // The work still happened: all six edits reached the remote.
    for (const p of paths) {
      expect(dec(world.headFiles().get(p)!.bytes)).toBe(`EDITED ${p}\n`);
    }
  });

  it("§II.13.2 (threshold=4, owner): a batch of THREE stays on the per-path transport", async () => {
    // Below the threshold a tree — potentially megabytes — costs more
    // than three round trips. The number is the owner's decision
    // (2026-09-25); this pins that a decision is being honoured at all,
    // so moving it is a deliberate act rather than a silent drift.
    await stageNFiles(3);
    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toEqual([]);
    expect(world.metadataReads).toHaveLength(3);
  });

  it("§II.13.2 ⚠️ (truncated): a capped tree is REFUSED, falls back to per-path, and is not re-requested", async () => {
    // THE trap. "Absent from the snapshot == absent from the repo"
    // holds only for a COMPLETE tree; GitHub caps at 100k entries or
    // 7 MB and says so. Building a snapshot from a truncated response
    // would read "not listed" as "deleted", push over it, and produce
    // exactly the silent clobber Layer 2 exists to prevent.
    world.truncateTrees = true;
    const paths = await stageNFiles(6);
    const warnings: string[] = [];

    const r = await drainOnce(
      makeDeps({
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
        },
      }),
    );

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1); // asked ONCE, not per file
    expect(world.metadataReads).toHaveLength(6); // …then paid honestly
    expect(
      warnings.some((w) => w.includes("truncated")),
    ).toBe(true); // and said so out loud
    // Correctness is untouched by the fallback.
    for (const p of paths) {
      expect(dec(world.headFiles().get(p)!.bytes)).toBe(`EDITED ${p}\n`);
    }
  });

  it("§II.13.2 (correctness): a blindspot is corrected from the SELF-READ tree, identically to a HEAD", async () => {
    // The bulk source must be the same authority, not a cheaper guess:
    // a remote change discovery never mentioned has to be caught here
    // exactly as P.29b catches it through discovery's own snapshot.
    const paths = await stageNFiles(4);
    // A remote edit to ONE of them that discovery will not report.
    await world.commitFiles({ [paths[0]]: "HIDDEN REMOTE\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });

    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1);
    expect(world.metadataReads).toEqual([]);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual([paths[0]]);
  });
});
