// Sync2 integration helpers. Mirrors the legacy `helpers.ts` shape but
// constructs a Sync2Manager + dependencies instead of legacy SyncManager.
//
// Sync2 has no built-in bootstrap-from-remote; tests typically work
// against a freshly created branch with one well-known initial commit
// (default-branch HEAD), then drive the manager through edits. The
// `bootstrapSync2OnBranch` helper aligns the local snapshot store with
// the branch's current tree before the first syncAll, so the manager
// starts from a sane baseline.

import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { Vault as ObsidianVault } from "obsidian";
import {
  Vault as MockVault,
  recordedNotices,
  clearRecordedNotices,
} from "../../../../mock-obsidian";
import GithubClient from "../../../../src/github/client";
import Logger from "../../../../src/logger";
import GI from "../../../../src/gi";
import { Sync2Manager } from "../../../../src/sync2/sync2-manager";
import HotMetadataStore from "../../../../src/sync2/hot-metadata";
import FileBaselinesStore from "../../../../src/sync2/file-baselines";
import ChangeDetector from "../../../../src/sync2/change-detector";
import GitignoreInvariants from "../../../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../../../src/sync2/invariant-state";
import ConflictStoreV2 from "../../../../src/sync2/conflict-store-v2";
import BatchWriter from "../../../../src/sync2/batch-writer";
import BatchHistorySource from "../../../../src/sync2/batch-history-source";
import SyncStore from "../../../../src/sync2/sync-store";
import DrainJournal from "../../../../src/sync2/drain-journal";
import SiblingTx from "../../../../src/sync2/sibling-tx";
import { calculateGitBlobSHA } from "../../../../src/utils";
import { mergeText } from "../../../../src/sync2/three-way-merge";
import { processConflicts } from "../../../../src/sync2/process-conflicts";
import { buildSiblingFilePath } from "../../../../src/sync2/conflict-siblings";
import * as crypto from "crypto";
import { ConflictWatcher } from "../../../../src/sync2/conflict-watcher";
import { ConflictCounter } from "../../../../src/sync2/conflict-counter";
import { TrashStore } from "../../../../src/diff2/trash-store";
import {
  GitHubSyncSettings,
  DEFAULT_SETTINGS,
} from "../../../../src/settings/settings";
import { requireEnv, RepoEnv } from "../../helpers";
import manifest from "../../../../manifest.json";

const SELF_PLUGIN_ID = manifest.id;
const CONFIG_DIR = ".obsidian";

export interface Sync2ClientOpts {
  branch: string;
  env?: RepoEnv;
  vaultPath?: string;
  // When set, overrides the default vault-ownership rule
  // (`true` when vaultPath was auto-created, `false` when caller
  // supplied one). Lets disable/re-enable tests transfer ownership
  // from one client instance to its successor without losing the
  // rm-rf on cleanup. Defaults to `vaultPath === undefined`.
  ownsVaultPath?: boolean;
  consolidateCommits?: boolean;
  enableLogging?: boolean;
  // Per-device configDir gate. Defaults to true (matches the
  // production default in settings.ts) so existing tests keep
  // syncing configDir paths the way they did before the toggle
  // landed. I-series tests opt into false explicitly.
  syncConfigDir?: boolean;
  // Default `true` here for back-compat with existing C-series tests
  // that exercise normalization. Production default flipped to false
  // in DEFAULT_SETTINGS to avoid the "convergence push" surprise on
  // first adoption — tests that exercise that surprise (interrupted
  // adoption resume) should pass `autoCanonicalize: true` explicitly.
  autoCanonicalize?: boolean;
}

export interface Sync2TestClient {
  vault: ObsidianVault;
  vaultPath: string;
  manager: Sync2Manager;
  hotMeta: HotMetadataStore;
  baselines: FileBaselinesStore;
  detector: ChangeDetector;
  // THE SWITCH: the new-format queue surfaces.
  batchWriter: BatchWriter;
  batchHistorySource: BatchHistorySource;
  // Read-only queue view (list/read over the new metafiles) — the
  // shape most scenario assertions need; a thin alias of
  // batchHistorySource so old `c.queue.list()` asserts keep working.
  queue: {
    list(): Promise<string[]>;
    read(
      id: string,
    ): Promise<{ id: string; createdAt: number; files: string[] }>;
  };
  syncStore: SyncStore;
  journal: DrainJournal;
  client: GithubClient;
  logger: Logger;
  // v2 conflicts.json — the drain writes it, the UI reads it.
  conflictStore: ConflictStoreV2;
  conflictWatcher: ConflictWatcher;
  // Always present in the integration fixture; n-series tests inspect
  // .trash state directly. Wired into Sync2Manager via trashHooks so
  // pull-delete capture (R3.4) + the three R3.5 cleanup layers fire
  // end-to-end. For tests that don't exercise trash, the store is
  // simply unused — TrashStore.init() creates an empty .trash/ dir
  // which has no effect on assertions about remote/vault state.
  trashStore: TrashStore;
  branch: string;
  // Live settings reference — same object the detector reads
  // through. I-series tests mutate fields here (e.g. syncConfigDir,
  // deviceLabel) between syncs and the next syncAll picks them up.
  settings: GitHubSyncSettings;
  cleanup(): void;
}

export async function createSync2Client(
  opts: Sync2ClientOpts,
): Promise<Sync2TestClient> {
  const { token, owner, repo } = opts.env ?? requireEnv();
  const ownsVaultPath =
    opts.ownsVaultPath ?? opts.vaultPath === undefined;
  const vaultPath =
    opts.vaultPath ??
    mkdtempSync(path.join(os.tmpdir(), "git-easy-sync-int-"));
  const vault = new MockVault(vaultPath) as unknown as ObsidianVault;

  const settings: GitHubSyncSettings = {
    ...DEFAULT_SETTINGS,
    githubToken: token,
    githubOwner: owner,
    githubRepo: repo,
    githubBranch: opts.branch,
    enableLogging: opts.enableLogging ?? false,
    syncStrategy: "manual",
    showStatusBarItem: false,
    showSyncRibbonButton: false,
    consolidateCommits: opts.consolidateCommits ?? false,
    syncConfigDir: opts.syncConfigDir ?? true,
  };

  const logger = new Logger(vault, SELF_PLUGIN_ID, opts.enableLogging ?? false);
  const client = new GithubClient(settings, logger);

  const hotMeta = new HotMetadataStore({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  await hotMeta.load();
  const baselines = new FileBaselinesStore({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const gi = new GI(vaultPath);
  const syncStore = new SyncStore({ vault, selfPluginId: SELF_PLUGIN_ID });
  const journal = new DrainJournal({ vault, selfPluginId: SELF_PLUGIN_ID });
  const batchWriter = new BatchWriter({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
    syncStore,
    autoCanonicalize: () => opts.autoCanonicalize ?? true,
    logger,
  });
  const batchHistorySource = new BatchHistorySource({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
    syncStore,
  });
  // Detector's queue-dedup reads the manager's per-pass index —
  // same lazy-thunk wiring as production main.ts.
  let managerRef: Sync2Manager | null = null;
  const detector = new ChangeDetector({
    vault,
    hotMeta,
    baselines,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: vaultPath,
    syncConfigDir: () => settings.syncConfigDir ?? true,
    queue: {
      peekLatestPathSha: async (p: string) =>
        (await managerRef?.peekLatestPathSha(p)) ?? null,
    },
  });
  const invariantState = new InvariantStateStore({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  await invariantState.load();
  const invariants = new GitignoreInvariants({
    vault,
    state: invariantState,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });

  // TrashStore — always wired into the integration fixture so trash
  // hooks fire end-to-end in any test that pull-deletes or pushes
  // batches. Tests that don't care about trash get an empty .trash/
  // dir which doesn't affect any remote/vault assertion.
  const trashStore = new TrashStore({
    vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  await trashStore.init();
  // ConflictCounter + counter-only ConflictWatcher. The watcher's
  // only side effect is `counter.markDirty()` on relevant vault
  // events. Production main.ts wires identically.
  // Phase 5.5 step 3b: counter + watcher read the V2 store (same as
  // production main.ts). The old engine keeps writing v1 until THE
  // SWITCH, so during the interim these surfaces see drain-born
  // conflicts as synthetic-only — mirrored deliberately.
  const conflictStoreV2 = new ConflictStoreV2({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  await conflictStoreV2.load();
  const siblingTx = new SiblingTx({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
    store: conflictStoreV2,
    computeSha: calculateGitBlobSHA,
    generateGuid: () => crypto.randomUUID(),
  });
  const conflictCounter = new ConflictCounter({
    vault,
    store: conflictStoreV2,
  });
  const conflictWatcher = new ConflictWatcher({
    vault,
    store: conflictStoreV2,
    counter: conflictCounter,
  });
  conflictWatcher.start();

  const manager = new Sync2Manager({
    vault,
    selfPluginId: SELF_PLUGIN_ID,
    configDir: CONFIG_DIR,
    client,
    // Main-thread implementations — the integration harness has no
    // Web Worker runtime; these are byte-identical to the worker ops.
    worker: {
      computeGitBlobSHA: calculateGitBlobSHA,
      decodeBase64: async (b64: string) =>
        Uint8Array.from(Buffer.from(b64, "base64")).buffer as ArrayBuffer,
      mergeText: async (o, b, t) => mergeText(o, b, t),
    },
    hotMeta,
    baselines,
    detector,
    batchWriter,
    syncStore,
    journal,
    conflictStore: conflictStoreV2,
    siblingTx,
    logger,
    invariants,
    isSyncable: (p) => detector.checkSyncable(p),
    mainBranch: () => settings.githubBranch,
    // Pass through live getter so I-series tests can mutate
    // `settings.deviceLabel` between syncs and the next push picks
    // up the new value.
    deviceLabel: () => settings.deviceLabel ?? "sync2-int-test",
    maxAutoMergeFileSize: () => settings.maxAutoMergeSizeBytes ?? 1_000_000,
    accumulateOfflineSyncs: () => opts.consolidateCommits ?? false,
    autoCanonicalize: () => opts.autoCanonicalize ?? true,
    tokenExpired: async () => false,
    trashHooks: trashStore.asHooks(),
    // POSIX-flavoured rename via mock-obsidian's adapter — no wiki-link
    // updates (no real `app.fileManager`), but adequate for integration
    // tests that just need the file to move.
    renameFile: async (oldPath: string, newPath: string): Promise<void> => {
      if (await vault.adapter.exists(newPath)) {
        await vault.adapter.remove(newPath);
      }
      await vault.adapter.rename(oldPath, newPath);
    },
  });
  managerRef = manager;

  return {
    vault,
    vaultPath,
    manager,
    hotMeta,
    baselines,
    detector,
    batchWriter,
    batchHistorySource,
    queue: {
      list: () => batchHistorySource.list(),
      read: (id: string) => batchHistorySource.read(id),
    },
    syncStore,
    journal,
    client,
    logger,
    conflictStore: conflictStoreV2,
    conflictWatcher,
    trashStore,
    branch: opts.branch,
    settings,
    cleanup() {
      conflictWatcher.stop();
      if (!ownsVaultPath) return;
      try {
        rmSync(vaultPath, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function sync2AllAndAssertNoErrors(
  c: Sync2TestClient,
): Promise<void> {
  clearRecordedNotices();
  await c.manager.syncAll();
  const errors = recordedNotices
    .map((n) => n.message)
    .filter((m) => m.toLowerCase().includes("error"));
  if (errors.length > 0) {
    throw new Error(`syncAll errors: ${errors.join("; ")}`);
  }
}

export async function sync2FileAndAssertNoErrors(
  c: Sync2TestClient,
  vaultPath: string,
): Promise<void> {
  clearRecordedNotices();
  await c.manager.syncFile(vaultPath);
  const errors = recordedNotices
    .map((n) => n.message)
    .filter((m) => m.toLowerCase().includes("error"));
  if (errors.length > 0) {
    throw new Error(`syncFile errors: ${errors.join("; ")}`);
  }
}

// ── v2 conflict-test helpers (THE SWITCH M-pass) ─────────────────────

// The v1 classifier's evaluateConflictState analog: reconcile
// conflicts.json with the live vault (dedup, content-equal
// auto-resolve, prune) and persist. Production runs this at the drain
// restarts + the three UI sites; the mock vault fires no events, so
// tests drive it explicitly, exactly like they drove the classifier.
export async function reconcileConflictsForTest(
  c: Sync2TestClient,
): Promise<void> {
  const state = await processConflicts(
    {
      vault: c.vault,
      store: c.conflictStore,
      computeSha: calculateGitBlobSHA,
    },
    null,
  );
  await c.conflictStore.save(state);
}

// Derived on-disk sibling names for a base path's tracked siblings
// (v2 keeps FileInfo rows; the disk name is derived, not stored).
export function trackedSiblingPathsFor(
  c: Sync2TestClient,
  basePath: string,
): string[] {
  const entry = c.conflictStore.getCachedState().entries.get(basePath);
  if (!entry) return [];
  return entry.siblings.map((s) =>
    buildSiblingFilePath(basePath, s.mtime ?? 0, s.deviceLabel),
  );
}

// "How many conflict entries live in the store" — the v1 getAll()
// length analog for no-conflicts asserts.
export function conflictEntryCount(c: Sync2TestClient): number {
  return c.conflictStore.getCachedState().entries.size;
}
