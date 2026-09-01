import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import { drainOnce, DrainDeps } from "../../src/sync2/drain";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { ClaimedBatch } from "../../src/sync2/get-batch";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import {
  RemoteFileChange,
  DiscoveryResult,
  DELETED_SHA_HASH,
} from "../../src/sync2/discovery";
import { calculateGitBlobSHA } from "../../src/utils";
import {
  FakeWorld,
  FakeVaultFiles,
  RepoFiles,
  enc,
  sha,
} from "../sync2/drain-harness";
import {
  findAllConflicts,
  entryFromSibling,
  pendingConflictSummary,
} from "../../src/diff2/synthetic-detector";

// Phase 5.5 step 3b — THE acceptance test of the diff2 port ("honest
// port, no adapter", §5.0/1): the REAL drainOnce births a conflict
// against the fake world → conflicts.json lands on disk via the
// epilogue → the PORTED UI reader (findAllConflicts) classifies that
// very sibling as TRACKED, and an unregistered look-alike sibling as
// SYNTHETIC. No stub fixtures anywhere between the engine and the UI.

const PLUGIN_ID = "git-easy-sync";
const NOTE = "note.md";
const V0 = "one\ntwo\nthree\n";
const REMOTE_CLASH = "REMOTE\ntwo\nthree\n";
const LOCAL_CLASH = "LOCAL\ntwo\nthree\n";
const REMOTE_LABEL = "other-device";

describe("diff2 port real composition (drainOnce → conflicts.json → findAllConflicts)", () => {
  let dir: string;
  let vault: Vault;
  let world: FakeWorld;
  let syncStore: SyncStore;
  let journal: DrainJournal;
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let vaultFiles: FakeVaultFiles;
  let baselines: Map<
    string,
    { baselineSha: string; mtime: number; size: number }
  >;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let baseCommit: string | null;
  let batchSeq: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "port-comp-test-"));
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
      generateGuid: () => `guid-${++batchSeq}`,
    });
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    batches = [];
    baseCommit = null;
    batchSeq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

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

  const stageBatch = async (
    files: Record<string, string>,
    mtime = 100,
  ): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({ path: p, sha: s, size: enc(content).byteLength, mtime });
    }
    const id = `b${++batchSeq}`;
    batches.push({
      claimed: { id, dir: `queue/${id}`, meta: { v: 1, id, createdAt: 0, entries } },
      removed: false,
    });
  };

  const makeDeps = (): DrainDeps => ({
    vault: vault as never,
    selfPluginId: PLUGIN_ID,
    client: world.makeClient(),
    syncStore,
    journal,
    retry: new NetworkRetry({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      maxAttempts: 2,
      sleep: async () => {},
    }),
    claimBatch: async () => batches.find((b) => !b.removed)?.claimed ?? null,
    removeBatchDir: async (d) => {
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
    discoverChangedFiles: honestDiscovery,
    hot: {
      getLastSyncCommitSha: () => baseCommit,
      getConflictBranch: () => null,
      update: async () => {},
    },
    conflictStore,
    siblingTx,
    tokenExpired: async () => false,
    vaultFiles,
    mergeBlobs: mergeBlobsWithMainThreadDiff3,
    computeSha: calculateGitBlobSHA,
    maxAutoMergeFileSize: () => 10_000_000,
    deviceLabel: () => "this-device",
    commitMessage: () => "Sync at test (this-device)",
    mergeMessage: () => "Merge conflict branch (this-device)",
    now: () => 1_800_000_000_000,
  });

  it("a drain-born conflict is TRACKED to the ported UI; an unregistered look-alike sibling is SYNTHETIC; the gate goes tracked-only", async () => {
    // Same-line clash births a manual conflict through the REAL engine.
    baseCommit = await world.commitFiles({ [NOTE]: V0 });
    baselines.set(NOTE, {
      baselineSha: await sha(V0),
      mtime: 50,
      size: enc(V0).byteLength,
    });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // (one path — it may be reported from more than one birth site)
    expect(new Set(r.conflictVerdicts.map((v) => v.path))).toEqual(
      new Set([NOTE]),
    );

    // The engine's own trail: conflicts.json holds the entry, the
    // sibling file is on the REAL (mock) vault disk at the derived
    // name — remote side's mtime + device label.
    const state = conflictStore.getCachedState();
    expect(state.entries.has(NOTE)).toBe(true);
    const sib = state.entries.get(NOTE)!.siblings.at(-1)!;
    const sibName = buildSiblingFilePath(NOTE, sib.mtime ?? 0, sib.deviceLabel);
    expect(fs.existsSync(path.join(dir, sibName))).toBe(true);

    // An unregistered look-alike next to it (the user copied the pair
    // into being, R3.3 rule 3) — the engine never created this one.
    const ghostName = buildSiblingFilePath(
      "ghost.md",
      Date.UTC(2026, 5, 5),
      "old-phone",
    );
    fs.writeFileSync(path.join(dir, ghostName), "ghost");

    // ── the PORTED UI reads the SAME store instance the drain wrote ──
    const { entries, byBasePath } = findAllConflicts(
      vault as unknown as import("obsidian").Vault,
      conflictStore,
    );
    const kinds = new Map(entries.map((e) => [e.siblingPath, e.kind]));
    expect(kinds.get(sibName)).toBe("tracked");
    expect(kinds.get(ghostName)).toBe("synthetic");
    expect(byBasePath.get(NOTE)).toHaveLength(1);

    // Single-entry reader (row-click path) agrees.
    expect(
      entryFromSibling(conflictStore, sibName)!.kind,
    ).toBe("tracked");

    // The §24 gate lists ONLY the tracked base — the ghost is a
    // local-only leftover with no cross-device consequence.
    const summary = pendingConflictSummary(
      vault as unknown as import("obsidian").Vault,
      conflictStore,
    );
    expect(summary!.trackedPaths).toEqual([NOTE]);
    expect(summary!.trackedConflictCount).toBe(1);

    // ── a FRESH store instance (plugin reload) sees the same truth ──
    const reloaded = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await reloaded.load();
    expect(
      entryFromSibling(reloaded, sibName)!.kind,
    ).toBe("tracked");
  });
});
