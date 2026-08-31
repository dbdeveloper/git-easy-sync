import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import { drainOnce, DrainDeps, DrainClient } from "../../src/sync2/drain";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import { ClaimedBatch } from "../../src/sync2/get-batch";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import { RemoteFileChange, DELETED_SHA_HASH } from "../../src/sync2/discovery";
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
  let baselines: Map<string, { baselineSha: string; mtime: number; size: number }>;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let removedDirs: string[];
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let baseCommit: string | null;
  let discoveryOverride:
    | ((base: string | null, head: string) => Promise<RemoteFileChange[]>)
    | null;
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
    syncStore = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    journal = new DrainJournal({ vault: vault as never, selfPluginId: PLUGIN_ID });
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
  ): Promise<RemoteFileChange[]> => {
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
    return out;
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
        entries.push({ path: p, sha: null, size: null, mtime: null });
        continue;
      }
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({
        path: p,
        sha: s,
        size: enc(content).byteLength,
        mtime,
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
    onProgress: (a, b) => progressLog.push([a, b]),
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
    vaultFiles.files.set("note.md", { content: "C2-one\ntwo\nthree\n", mtime: 100 });

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
    vaultFiles.files.set("note.md", { content: "C2-one\ntwo\nthree\n", mtime: 100 });

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

    // Crash: journal.persist throws right after the push. The FIRST
    // persist call in a run stores the conflict-branch name (§II.7,
    // before any network) — the batch-completion persist is the
    // second call.
    const origPersist = journal.persist.bind(journal);
    let persists = 0;
    journal.persist = async (state) => {
      persists += 1;
      if (persists === 2) {
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
    vaultFiles.files.set("note.md", { content: "LOCAL\ntwo\nthree\n", mtime: 100 });

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
    vaultFiles.files.set("note.md", { content: "USER\ntwo\nthree\n", mtime: 77 });

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

  it("cold start (base=null) + empty repo (head=null): local batch pushes as the first commit, Layer 2 guarded off", async () => {
    // No setupAligned: bare repo, no baselines, fresh vault.
    await stageBatch({ "hello.md": "first\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(1);
    expect(dec(world.headFiles().get("hello.md")!.bytes)).toBe("first\n");
  });

  // ── P: Layer 2 + lying discovery ─────────────────────────────────

  it("P.2/P.9/P.27: discovery omits a remotely-changed path with a local edit → Layer 2 corrects EXACTLY once, then the normal path (merge)", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    discoveryOverride = async () => []; // the lie: "nothing changed"
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
    const state = (await journal.load()) ?? (await import("../../src/sync2/drain-journal")).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: { path: "note.md", sha: await sha(V0), size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      remote: { path: "note.md", sha: localSha, size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(state);
    // Truth: remote actually moved to something else entirely.
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => []; // and discovery misses it
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
    discoveryOverride = async () => [];
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
    discoveryOverride = async () => [];
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
      const store = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
      const j = new DrainJournal({ vault: vault as never, selfPluginId: `${PLUGIN_ID}-${victim}` });
      const vf = new FakeVaultFiles();
      const bl = new Map<string, { baselineSha: string; mtime: number; size: number }>();
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
          mtime: 100,
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
                  meta: { v: 1, id: "b1", createdAt: 0, entries: localBatchEntries },
                },
          removeBatchDir: async () => {
            removed = true;
          },
          discoverChangedFiles: async (b, h) => {
            const honest = await (async () => {
              const out: RemoteFileChange[] = [];
              for (const [p, f] of w.filesAt(h)) {
                const bf = b === null ? null : w.filesAt(b).get(p) ?? null;
                if (bf?.sha === f.sha) continue;
                out.push({ path: p, sha: f.sha, size: f.bytes.byteLength, mtime: null, deleted: false });
              }
              return out;
            })();
            return honest.filter((c) => c.path !== victim);
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
    const state = (await import("../../src/sync2/drain-journal")).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: { path: "note.md", sha: await sha(V0), size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      remote: { path: "note.md", sha: localSha, size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(state);
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => [];
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
    discoveryOverride = async () => []; // omitted, and no local batch
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
    expect(
      j1?.trackedFiles.get("note.md")?.remote.sha ?? null,
    ).not.toBe(await sha("C1\n"));
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
    baselines.set("obs.md", { baselineSha: await sha("x"), mtime: 50, size: 1 });
    await world.commitFiles({ "note.md": "R\n", "obs.md": null });
    await stageBatch({ "other.md": "O\n" });

    const paths: Array<string | undefined> = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (_p, _t, path) => paths.push(path) }),
    );
    expect(r.status).toBe("ok");
    expect(r.vaultStepWrites).toEqual(["note.md"]);
    expect(r.vaultStepRemoves).toEqual(["obs.md"]);
    expect(paths).toEqual(["other.md"]); // per-file progress names the file
  });

  it("S1 confirmDeleted (R3.5 layer 1a): fires with PUBLISHED deletions only; a deletion that lost to a remote edit is excluded", async () => {
    await setupAligned();
    baseCommit = await world.commitFiles({ "gone.md": "bye\n" });
    vaultFiles.files.set("gone.md", { content: "bye\n", mtime: 50 });
    baselines.set("gone.md", {
      baselineSha: await sha("bye\n"),
      mtime: 50,
      size: 4,
    });
    // Batch deletes gone.md (publishes) AND note.md — but remote
    // EDITED note.md meanwhile → that deletion loses (not published).
    await world.commitFiles({ "note.md": "REMOTE-EDIT\n" });
    await stageBatch({ "gone.md": null, "note.md": null });
    vaultFiles.files.delete("gone.md");
    vaultFiles.files.delete("note.md");

    const confirmed: string[][] = [];
    const r = await drainOnce(
      makeDeps({
        trashHooks: {
          confirmResolved: async () => {},
          confirmDeleted: async (paths) => {
            confirmed.push(paths);
          },
        },
      }),
    );
    expect(r.status).toBe("ok");
    expect(confirmed).toEqual([["gone.md"]]); // note.md excluded
    expect(world.headFiles().has("gone.md")).toBe(false);
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
});
