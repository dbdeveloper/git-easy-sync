// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Sync2Manager — THE SWITCH shell (Phase 5.5 step 4). The old
// ~4100-line engine (its own drain, pull, tree builder, conflict
// machinery) died here; what remains is the thin composition the UI
// talks to:
//
//   syncAll     = invariants → filename sanitize → COMMIT PASS
//                 (R3a singleton, SYNC2-FIX §6 «дзвоник») → drainOnce
//   commitOnly  = the commit pass alone (the [Commit] ribbon path)
//   commitFile  = one-path commit pass (active-tab command)
//   syncFile    = commitFile + drain
//   resumeQueue = drain only (onload pulse, watchdog tick, split mode)
//
// The engine itself is drainOnce (drain.ts) composed by buildDrainDeps
// (drain-deps.ts) — this class owns only session-scoped state: the
// `running` re-entrancy flag (H3 pin: concurrent syncs collapse), the
// R3a commit singleton, the §7.10 MainHeadGuard, the DrainStatus
// channel the Settings tab subscribes to, and the queue-sha index the
// change-detector's dedup reads through `peekLatestPathSha`.
//
// Deliberately ABSENT (each by a recorded decision):
// - bootstrapFromRemote / bootstrapIfNeeded — cold start is discovery
//   with base=null (MASTER-PLAN §6.4/§6.6); a bare repo is
//   pushCommitFromTree's parentless root commit.
// - reconcileRemoteIdentity — a repo switch reads as the
//   force-push class (§6.4): compare 404 → full-tree diff → per-path
//   rules; "конфлікт-шторм тут не вада, а особлива feature".
// - pull-side sanitize + pending-deletions — the vault-step writes
//   the canonical name; the honest baseline completes the remote
//   rename via the next findChanges (THE SWITCH п.3).
// - recoverPushInflight — the drain journal is the crash story now.
// - the 300 ms commit→drain delay — commit↔drain is the R3b
//   writer↔claimer Peterson protocol.

import { type Vault } from "obsidian";
import { drainOnce, DrainResult, DrainProgress } from "./drain";
import {
  buildDrainDeps,
  BuildDrainDepsArgs,
  DrainGithubClient,
  MainHeadGuard,
} from "./drain-deps";
import BatchWriter, { MAX_BATCH_ENTRIES } from "./batch-writer";
import { buildQueueShaIndex, QueueShaIndex } from "./queue-sha-index";
import { QUEUE_DIRNAME } from "./batch-metafile";
import ChangeDetector from "./change-detector";
import { FileChange } from "./types";
import SyncStore from "./sync-store";
import DrainJournal from "./drain-journal";
import ConflictStoreV2 from "./conflict-store-v2";
import SiblingTx from "./sibling-tx";
import HotMetadataStore from "./hot-metadata";
import FileBaselinesStore from "./file-baselines";
import { needsSanitization, sanitizeFilename } from "./cross-platform";
import { newBatchId } from "./timestamp-id";
import { AuthError, NetworkError } from "../errors";
import type { TrashHooks } from "./trash-hooks";
import { normalizePath } from "obsidian";

// ── DrainStatus (unchanged shape — the Settings tab renders it) ─────

export interface DrainStatus {
  state: "idle" | "running" | "cancelling";
  // ms-since-epoch when the current drain started; null when idle.
  startedAt: number | null;
  // Current file path within the active batch, or null.
  currentPath: string | null;
  // Counters for the per-file "N of M" line.
  totalFiles: number;
  currentFile: number;
  // §II.16 — the full two-counter snapshot behind the user-facing
  // notice. null until the drain reports for the first time (the
  // commit pass runs before it, and the notice may already be up).
  progress: DrainProgress | null;
  // Last error surfaced by drain (most recent); `isAuthError` drives
  // the Settings token-help box. Cleared by the next successful drain.
  lastError: {
    message: string;
    whenMs: number;
    isAuthError: boolean;
  } | null;
}

export interface Sync2Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface Sync2ManagerDeps {
  vault: Vault;
  selfPluginId: string;
  configDir: string;
  client: DrainGithubClient;
  worker: {
    computeGitBlobSHA(bytes: ArrayBuffer): Promise<string>;
    decodeBase64(b64: string): Promise<ArrayBuffer>;
    mergeText(
      ours: string,
      base: string,
      theirs: string,
    ): Promise<
      | { kind: "clean"; content: string }
      | { kind: "conflict"; conflictMarkedContent: string }
    >;
  };
  hotMeta: HotMetadataStore;
  baselines: FileBaselinesStore;
  detector: ChangeDetector;
  batchWriter: BatchWriter;
  syncStore: SyncStore;
  journal: DrainJournal;
  conflictStore: ConflictStoreV2;
  siblingTx: SiblingTx;
  invariants?: { enforce(): Promise<void> } | null;
  // DOT-FILES §8.0 — read-only view for the engine: "is this managed
  // .gitignore currently byte-identical to what we seeded?".
  // REQUIRED here, on purpose. It stays optional one level down (the
  // engine treats absence as "rule does not fire", which the drain
  // unit suites want), but the COMPOSITION must not be able to forget
  // it: that exact mistake made the first shape of this fix inert
  // outside main.ts, twice in one day, and only a live probe caught it.
  gitignoreSeeds: { matches(path: string, sha: string | null): boolean };
  // The Deleted bin's engine-facing surface (§5.2.1). Optional:
  // absence means "no bin wired", never "nothing to protect".
  //   referencedShas — sweep source №5 (pending captures + held ones)
  //   pruneBefore    — the retention backstop, drain-end on success
  deletedBin?: {
    referencedShas(): Set<string>;
    pruneBefore(beforeIso: string): Promise<void>;
  };
  // Discovery's remote-path filter (async-capable — gitignore walks).
  isSyncable(path: string): boolean | Promise<boolean>;
  mainBranch(): string;
  deviceLabel(): string;
  gitAuthor?: () => { name: string; email: string } | null;
  maxAutoMergeFileSize(): number;
  // true → a commit folds into the queue tail (offline-accumulate).
  accumulateOfflineSyncs(): boolean;
  // autoCanonicalizeTextFiles — the pull-side half (the commit side
  // lives in BatchWriter); both must read the SAME setting.
  autoCanonicalize?: () => boolean;
  tokenExpired(): Promise<boolean>;
  // §35 latch setter — fired when a drain ends "token-expired".
  onTokenExpired?(status: 401 | 403): void;
  trashHooks?: TrashHooks | null;
  // Obsidian-aware rename for the local filename sanitize pass.
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  onLocalCommitted?(filesCount: number): void;
  onNoLocalChanges?(): void;
  // §II.16 — the whole user-visible operation began. Paired with
  // onSyncCompleted; main.ts arms the 2 s progress timer here, so the
  // wait is measured from the CLICK, not from the drain (a slow commit
  // pass is silence too).
  onSyncStarted?(): void;
  onSyncCompleted?(summary: {
    pushedFiles: number;
    pulledFiles: number;
    // TRACKED conflicts only, counted in PATHS — the unit the user's
    // wording means ("files in conflict"). Synthetic siblings are a
    // diff2 concern and never a drain one (§III). ⚠️ Deliberately a
    // different unit from the status-bar badge, which counts sibling
    // FILES: one path with two siblings is 1 here and 2 there.
    conflicts: number;
    // False when the operation ended by throwing OR was cancelled —
    // the summary notice must not claim success over either.
    ok: boolean;
    // Distinguishes the two: a cancel is a user decision and gets its
    // own confirmation, an error already has its own notice.
    cancelled: boolean;
  }): void;
  onQueueDepthChanged?(depth: number): void;
  // Mobile auto-reload: plugin ids whose files the Vault-step touched.
  onPluginsAffected?(pluginIds: string[]): void;
  // Zero-byte restore guard surfaced a recovery (never silent).
  onZeroByteRestored?(path: string): void;
  logger: Sync2Logger;
  now?: () => number;
  // Test seam — the shell's unit suite fakes the engine.
  drainFn?: typeof drainOnce;
}

export class Sync2Manager {
  private readonly deps: Sync2ManagerDeps;
  private readonly now: () => number;
  private readonly headGuard: MainHeadGuard;

  // Drain re-entrancy (H3 pin): concurrent syncAll/resumeQueue calls
  // collapse into the one running drain.
  private running = false;
  private abortRequested = false;

  // R3a — commit is a SINGLETON with a coalescing bell (SYNC2-FIX §6):
  // a trigger during a pass rings the bell; the runner loops while it
  // rings. On error: release, surface, NO auto-restart (I6).
  // The bell carries a TARGET: §6's no-lost-signal proof assumes every
  // re-loop rescans the caller's scope — a single-file runner re-
  // looping its own file would swallow a coalesced FULL-scan (or
  // other-file) request, so any target mismatch escalates the next
  // loop to a full findChanges (null).
  private commitInProgress = false;
  private restartCommit = false;
  private currentCommitTarget: string | null = null;
  private bellTarget: string | null | undefined = undefined;

  // findChanges dedup reference over the queue metafiles — rebuilt at
  // the start of every commit pass, lazily on first out-of-pass read.
  private queueIndex: QueueShaIndex | null = null;

  private pulledFilesThisSync = 0;

  // §II.16 — the most recent progress snapshot, kept so a listener that
  // subscribes mid-drain (the notice arms itself 2 s in) can paint
  // immediately instead of waiting for the next file.
  private lastProgress: DrainProgress | null = null;
  // A cancelled drain returns NORMALLY (it is not an error), so without
  // this the closing summary would cheerfully announce "Sync done" over
  // a sync the user just stopped.
  private lastDrainWasCancelled = false;

  private drainStatus: DrainStatus = {
    state: "idle",
    startedAt: null,
    currentPath: null,
    progress: null,
    totalFiles: 0,
    currentFile: 0,
    lastError: null,
  };
  private drainStatusListeners: Array<(s: DrainStatus) => void> = [];

  constructor(deps: Sync2ManagerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.headGuard = new MainHeadGuard({ logger: deps.logger });
  }

  // ── public surface ─────────────────────────────────────────────────

  // §II.16 — tracked conflict PATHS, read after the drain has run
  // process_conflicts (which prunes records whose sibling files are
  // gone), so this is the settled number, not a mid-flight one.
  private trackedConflictPaths(): number {
    try {
      return this.deps.conflictStore.getCachedState().entries.size;
    } catch {
      return 0;
    }
  }

  async syncAll(): Promise<void> {
    this.deps.logger.info("Sync2 syncAll start");
    this.pulledFilesThisSync = 0;
    let pushedFiles = 0;
    let ok = false;
    this.deps.onSyncStarted?.();
    try {
      pushedFiles = await this.runCommitPass(null);
      await this.drain();
      ok = !this.lastDrainWasCancelled;
    } finally {
      this.deps.onSyncCompleted?.({
        pushedFiles,
        pulledFiles: this.pulledFilesThisSync,
        conflicts: this.trackedConflictPaths(),
        ok,
        cancelled: this.lastDrainWasCancelled,
      });
    }
  }

  async syncFile(path: string): Promise<void> {
    this.deps.logger.info("Sync2 syncFile start", { path });
    this.pulledFilesThisSync = 0;
    let pushedFiles = 0;
    let ok = false;
    this.deps.onSyncStarted?.();
    try {
      const outcome = await this.commitFile(path);
      pushedFiles = outcome.kind === "committed" ? outcome.count : 0;
      await this.drain();
      ok = !this.lastDrainWasCancelled;
    } finally {
      this.deps.onSyncCompleted?.({
        pushedFiles,
        pulledFiles: this.pulledFilesThisSync,
        conflicts: this.trackedConflictPaths(),
        ok,
        cancelled: this.lastDrainWasCancelled,
      });
    }
  }

  async commitOnly(): Promise<void> {
    this.deps.logger.info("Sync2 commitOnly start");
    await this.runCommitPass(null);
  }

  async commitFile(
    path: string,
  ): Promise<
    | { kind: "ignored" }
    | { kind: "no-change" }
    | { kind: "committed"; count: number }
  > {
    this.deps.logger.info("Sync2 commitFile start", { path });
    // Establish this operation's dot-space scope before asking about a
    // path — checkSyncable fails loud without it (DOT-FILES §5), and
    // this gate runs before runCommitPass gets a chance to do it.
    await this.deps.detector.beginScan();
    let syncable: boolean;
    try {
      syncable = await this.deps.detector.checkSyncable(path);
    } finally {
      this.deps.detector.endScan();
    }
    if (!syncable) return { kind: "ignored" };
    const count = await this.runCommitPass(path);
    return count > 0 ? { kind: "committed", count } : { kind: "no-change" };
  }

  // Drain any pending batches without re-running findChanges — the
  // onload pulse, the watchdog tick, and split-mode's sync surface.
  async resumeQueue(): Promise<void> {
    this.pulledFilesThisSync = 0;
    await this.drain();
  }

  async hasPendingBatches(): Promise<boolean> {
    return (await this.listQueueIds()).length > 0;
  }

  // Queue depth for the ribbon badge's first paint (main.ts seeds it
  // from disk before any sync fires the onQueueDepthChanged signal).
  async queueDepth(): Promise<number> {
    return (await this.listQueueIds()).length;
  }

  // Detector seam (PeekableQueue): "what does the queue already hold
  // for this path?" — served from the per-pass index. DELETED
  // sentinel semantics live in queue-sha-index.ts.
  async peekLatestPathSha(path: string): Promise<string | null> {
    if (this.queueIndex === null) {
      this.queueIndex = await buildQueueShaIndex(
        this.deps.vault,
        this.deps.selfPluginId,
      );
    }
    return this.queueIndex.peekLatestPathSha(path);
  }

  // Stage 7 cancellation surface: Settings [Stop sync] + the modal.
  // Takes effect at the next batch/file boundary; the cancelled exit
  // persists nothing (D.16 rule inside drainOnce).
  cancelDrain(): void {
    if (!this.running) return;
    this.abortRequested = true;
    this.emitDrainStatus({ state: "cancelling" });
    this.deps.logger.info("Sync2 cancelDrain requested");
  }

  // RESET-PLUGIN O3: reset cancels a running drain and polls this.
  isDrainRunning(): boolean {
    return this.running;
  }

  recordDrainError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof AuthError
        ? err.status
        : (err as { status?: number } | null)?.status;
    const isAuthError = status === 401 || status === 403;
    this.emitDrainStatus({
      lastError: { message, whenMs: Date.now(), isAuthError },
    });
  }

  setDrainStatusListener(listener: (s: DrainStatus) => void): () => void {
    this.drainStatusListeners.push(listener);
    listener(this.drainStatus);
    return () => {
      const i = this.drainStatusListeners.indexOf(listener);
      if (i >= 0) this.drainStatusListeners.splice(i, 1);
    };
  }

  getDrainStatus(): DrainStatus {
    return { ...this.drainStatus };
  }

  private emitDrainStatus(patch: Partial<DrainStatus>): void {
    this.drainStatus = { ...this.drainStatus, ...patch };
    for (const l of this.drainStatusListeners) l(this.drainStatus);
  }

  // ── commit pass (R3a singleton) ────────────────────────────────────

  // `target` — null = full findChanges; a path = single-file pass.
  // A trigger landing during a pass rings the bell and returns 0
  // (the RUNNING pass re-scans everything on its next loop, so the
  // coalesced caller's changes are picked up there — SYNC2-FIX §6).
  private async runCommitPass(target: string | null): Promise<number> {
    if (this.commitInProgress) {
      this.restartCommit = true;
      // Merge the coalesced target into the bell: identical target →
      // keep it; ANY mismatch (other file, or full-vs-file in either
      // direction) → escalate to a full scan.
      if (this.bellTarget === undefined) {
        this.bellTarget =
          target === this.currentCommitTarget ? target : null;
      } else if (this.bellTarget !== target) {
        this.bellTarget = null;
      }
      return 0;
    }
    this.commitInProgress = true;
    let total = 0;
    try {
      let t: string | null = target;
      do {
        // Reset BEFORE the pass — a bell during the pass is seen by
        // the while (the no-lost-signal proof in §6).
        this.restartCommit = false;
        this.bellTarget = undefined;
        this.currentCommitTarget = t;
        total += await this.doOneCommitPass(t);
        if (this.restartCommit && this.bellTarget !== undefined) {
          t = this.bellTarget; // the escalated scope for the re-loop
        }
      } while (this.restartCommit);
    } finally {
      this.commitInProgress = false; // ALWAYS release (deadlock guard)
      this.currentCommitTarget = null;
    }
    return total;
  }

  private async doOneCommitPass(target: string | null): Promise<number> {
    if (this.deps.invariants) await this.deps.invariants.enforce();
    if (target === null) await this.sanitizeForbiddenFilenames();
    // Fresh dedup reference for THIS pass.
    this.queueIndex = await buildQueueShaIndex(
      this.deps.vault,
      this.deps.selfPluginId,
    );

    let changes: FileChange[];
    if (target === null) {
      changes = await this.deps.detector.findChanges();
    } else {
      const one = await this.deps.detector.findChangeForPath(target);
      changes = one === null ? [] : [one];
    }
    if (changes.length === 0) {
      if ((await this.listQueueIds()).length === 0) {
        this.deps.onNoLocalChanges?.();
      }
      this.deps.logger.info("Sync2 commit pass: nothing to commit");
      return 0;
    }

    await this.applyZeroByteRestoreGuard(changes);

    let enqueued = 0;
    let rest = changes;
    // Offline-accumulate: fold into the queue TAIL first (R3b-safe,
    // cap-aware — a full tail backs off and we fall through to fresh
    // batches).
    if (this.deps.accumulateOfflineSyncs()) {
      const tailId = await this.deps.batchWriter.consolidateIntoTail(rest);
      if (tailId !== null) {
        enqueued += rest.length;
        rest = [];
      }
    }
    // ≤100-entry slices (MAX_BATCH_ENTRIES) as fresh batches.
    for (let i = 0; i < rest.length; i += MAX_BATCH_ENTRIES) {
      const slice = rest.slice(i, i + MAX_BATCH_ENTRIES);
      const id = await this.deps.batchWriter.writeBatch(slice);
      if (id !== null) enqueued += slice.length;
    }

    this.queueIndex = null; // the queue just changed — rebuild lazily
    await this.fireQueueDepth();
    if (enqueued > 0) {
      this.deps.onLocalCommitted?.(enqueued);
      this.deps.logger.info("Sync2 commit pass: committed", {
        count: enqueued,
        changes: changes.map((c) => `${c.kind} ${c.path}`),
      });
    }
    return enqueued;
  }

  // ── drain (the engine call) ────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.running) return; // H3: collapse into the in-flight drain
    this.running = true;
    this.abortRequested = false;
    this.lastDrainWasCancelled = false;
    // DOT-FILES §3.1.2 / owner 2026-09-20: the managed .gitignore
    // files return to canonical before EVERY operation, not just
    // before a commit. Until now enforce() ran only on the commit
    // path, so with `syncStartsWithCommit=false` the interval tick,
    // the startup pulse and the watchdog all pushed without checking
    // the invariants at all — and a foreign copy of
    // `<self>/.gitignore` pulled from another device stayed in force
    // until someone happened to commit.
    //
    // Safe to run here only BECAUSE of the §8.0 seed markers: a cold
    // start's freshly-written file now carries its own ancestor, so
    // this call cannot manufacture the conflict §8.0 is about.
    if (this.deps.invariants) {
      try {
        await this.deps.invariants.enforce();
      } catch (err) {
        // Hygiene, never a reason to skip the sync itself.
        this.deps.logger.warn("drain: invariant enforcement failed", {
          err: `${err}`,
        });
      }
    }
    // DOT-FILES §5: the drain asks isSyncable through discovery (the
    // pull-side filter), so it needs this operation's opt-in set — and
    // it needs it AFTER enforce(), which may have just recreated the
    // root .gitignore the set is read from. Without it an opted-in
    // dot-directory would silently fail to pull: a one-sided break that
    // only surfaces on the second device.
    const startedAtMs = this.now();
    // ⚠️ `progress: null` is load-bearing, not tidiness. It used to
    // carry the PREVIOUS drain's snapshot into the next one, so a sync
    // with nothing to do could paint "Uploading 1 of 1" from a run that
    // had ended minutes ago (field bug 2026-09-26).
    this.lastProgress = null;
    this.emitDrainStatus({
      state: "running",
      startedAt: startedAtMs,
      currentPath: null,
      totalFiles: 0,
      currentFile: 0,
      progress: null,
    });
    try {
      // Placed INSIDE the try and after the status flip: the UI's
      // "running" must light up before the first await yields (pinned
      // by the cancelDrain test), and a failure to read the opt-in set
      // should surface through the drain's own error path rather than
      // escaping the status machine.
      await this.deps.detector.beginScan();
      const r = await (this.deps.drainFn ?? drainOnce)(this.buildDeps());

      // Vault-step outcome → UI signals (independent of status: the
      // writes that DID land are real even on a later abort).
      const touched = [...r.vaultStepWrites, ...r.vaultStepRemoves];
      this.pulledFilesThisSync += touched.length;
      const pluginIds = this.derivePluginIds(touched);
      if (pluginIds.length > 0) this.deps.onPluginsAffected?.(pluginIds);
      await this.fireQueueDepth();

      switch (r.status) {
        case "ok": {
          this.emitDrainStatus({ lastError: null });
          // §5.2.1 retention (owner, 2026-09-21): a fully successful
          // drain drops every bin record that predates it — the
          // successor of R3.5 layer 2, and what bounds a bin whose
          // hand-off only releases deletions that reach a commit.
          // Records an open diff-editor holds are skipped by the store.
          if (this.deps.deletedBin) {
            try {
              await this.deps.deletedBin.pruneBefore(
                new Date(startedAtMs).toISOString(),
              );
            } catch (err) {
              this.deps.logger.warn("Sync2 drain: deleted-bin prune failed", {
                err: `${err}`,
              });
            }
          }
          this.logDrainSummary(r);
          return;
        }
        case "cancelled": {
          this.deps.logger.info("Sync2 drain cancelled by user");
          this.lastDrainWasCancelled = true;
          return;
        }
        case "token-expired": {
          const status = r.authErrorStatus ?? 401;
          this.deps.onTokenExpired?.(status);
          throw new AuthError(
            "GitHub authentication failed — token expired or lacks permissions",
            status,
          );
        }
        case "network-error":
          throw new NetworkError("Sync failed: network error");
        case "too-many-concurrent-pushes":
          throw new Error(
            "Sync deferred: very intensive pushes from other devices (or a transient GitHub glitch). Try again in a moment.",
          );
        case "conflict-push-failed":
          throw new Error(
            "Sync failed: the conflict-branch push kept failing (anomaly — the branch is device-owned)",
          );
      }
    } finally {
      // Scope belongs to the operation, not to the object — see
      // ChangeDetector.endScan.
      this.deps.detector.endScan();
      this.running = false;
      this.emitDrainStatus({
        state: "idle",
        startedAt: null,
        currentPath: null,
      });
    }
  }

  private buildDeps(): ReturnType<typeof buildDrainDeps> {
    const args: BuildDrainDepsArgs = {
      vault: this.deps.vault,
      selfPluginId: this.deps.selfPluginId,
      client: this.deps.client,
      mainBranch: this.deps.mainBranch,
      headGuard: this.headGuard,
      worker: {
        computeSha: (b) => this.deps.worker.computeGitBlobSHA(b),
        decodeBase64: (b64) => this.deps.worker.decodeBase64(b64),
        mergeText: (o, b, t) => this.deps.worker.mergeText(o, b, t),
      },
      syncStore: this.deps.syncStore,
      journal: this.deps.journal,
      conflictStore: this.deps.conflictStore,
      siblingTx: this.deps.siblingTx,
      hotMeta: this.deps.hotMeta,
      baselines: this.deps.baselines,
      tokenExpired: this.deps.tokenExpired,
      isSyncable: (p) => this.deps.isSyncable(p) as boolean,
      deviceLabel: this.deps.deviceLabel,
      maxAutoMergeFileSize: this.deps.maxAutoMergeFileSize,
      gitAuthor: this.deps.gitAuthor,
      autoCanonicalize: this.deps.autoCanonicalize,
      cancelRequested: () => this.abortRequested,
      trashHooks: this.deps.trashHooks,
      gitignoreSeeds: this.deps.gitignoreSeeds,
      deletedBinReferencedShas: this.deps.deletedBin
        ? () => this.deps.deletedBin!.referencedShas()
        : undefined,
      onProgress: (p) => {
        this.lastProgress = p;
        this.emitDrainStatus({
          // The Settings panel's per-file line keeps its old meaning:
          // the PUSH pair, which is what it always showed.
          currentFile: p.pushDone,
          totalFiles: p.pushTotal,
          currentPath: p.path,
          progress: p,
        });
      },
      logger: this.deps.logger,
      now: this.now,
    };
    const built = buildDrainDeps(args);
    // §II.16 — the status bar's "↑ N" must fall as batches land, not
    // jump to zero at the end. fireQueueDepth() used to run ONCE after
    // the whole drain, so a four-batch run showed "↑ 4" throughout.
    // Wrapping the removal is the smallest honest hook: the depth
    // changes exactly when a batch dir stops existing.
    const removeBatchDir = built.removeBatchDir;
    built.removeBatchDir = async (dir) => {
      await removeBatchDir(dir);
      this.queueIndex = null; // the queue just shrank — rebuild lazily
      await this.fireQueueDepth();
    };
    return built;
  }

  // ── helpers ────────────────────────────────────────────────────────

  // Local filename sanitize (pre-findChanges): names with chars some
  // platform can't materialise never reach the remote, regardless of
  // which device created them. Unchanged from the old engine.
  private async sanitizeForbiddenFilenames(): Promise<void> {
    if (!this.deps.renameFile) return;
    type FileLike = { path: string };
    const files: FileLike[] =
      (
        this.deps.vault as unknown as { getFiles?: () => FileLike[] }
      ).getFiles?.() ?? [];
    for (const f of files) {
      if (!needsSanitization(f.path)) continue;
      const canonical = sanitizeFilename(f.path);
      if (canonical === f.path) continue;
      if (await this.deps.vault.adapter.exists(canonical)) {
        this.deps.logger.warn("Sync2 sanitize-filename: target exists, skipping", {
          from: f.path,
          to: canonical,
        });
        continue;
      }
      this.deps.logger.info("Sync2 sanitize-filename: renaming", {
        from: f.path,
        to: canonical,
      });
      await this.deps.renameFile(f.path, canonical);
    }
  }

  // Zero-byte restore guard (2.0.2-beta2 field fix, re-homed from the
  // old per-batch pre-flight to COMMIT time — earlier is better): a
  // "modified to 0 bytes" change whose baseline was non-empty is the
  // mobile zero-collapse corruption shape, not an edit. Restore the
  // vault file from the last good bytes (sync_store by baseline sha,
  // else GitHub) and drop the change — the restore write re-detects
  // next pass if it truly differs. No bytes found → keep the 0-byte
  // change (the lesser evil vs losing a REAL emptying) and warn.
  private async applyZeroByteRestoreGuard(
    changes: FileChange[],
  ): Promise<void> {
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      if (c.kind !== "modified" && c.kind !== "added") continue;
      if (c.size !== 0) continue;
      const baseline = await this.deps.baselines.get(c.path);
      if (!baseline || baseline.size === 0) continue; // new OR was-empty
      let bytes: ArrayBuffer | null = null;
      let source = "";
      try {
        bytes = await this.deps.syncStore.getBlobFromSyncStore(
          baseline.baselineSha,
          new Set(),
        );
        source = `sync_store:${baseline.baselineSha.slice(0, 7)}`;
        if (bytes === null) {
          const blob = await this.deps.client.getBlob({
            sha: baseline.baselineSha,
            retry: true,
          });
          bytes = await this.deps.worker.decodeBase64(blob.content);
          source = `github:${baseline.baselineSha.slice(0, 7)}`;
        }
      } catch (err) {
        this.deps.logger.warn("Sync2 zero-byte restore: lookup failed", {
          path: c.path,
          err: `${err}`,
        });
      }
      if (bytes === null) {
        this.deps.logger.warn(
          "Sync2 zero-byte restore: no good version found, leaving as-is",
          { path: c.path, previousSize: baseline.size },
        );
        continue;
      }
      const { atomicWriteFile } = await import("./atomic-write");
      await atomicWriteFile(this.deps.vault, c.path, bytes);
      changes.splice(i, 1); // restored == baseline → nothing to commit
      this.deps.logger.warn(
        "Sync2 zero-byte restore: restored last good version",
        { path: c.path, source },
      );
      this.deps.onZeroByteRestored?.(c.path);
    }
  }

  private async listQueueIds(): Promise<string[]> {
    const root = normalizePath(
      `${this.deps.vault.configDir}/plugins/${this.deps.selfPluginId}/${QUEUE_DIRNAME}`,
    );
    if (!(await this.deps.vault.adapter.exists(root))) return [];
    const listing = await this.deps.vault.adapter.list(root);
    return listing.folders
      .map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      })
      .sort();
  }

  private async fireQueueDepth(): Promise<void> {
    if (!this.deps.onQueueDepthChanged) return;
    try {
      this.deps.onQueueDepthChanged((await this.listQueueIds()).length);
    } catch (err) {
      this.deps.logger.warn("Sync2 fireQueueDepth failed", {
        err: `${err}`,
      });
    }
  }

  private derivePluginIds(paths: string[]): string[] {
    const prefix = `${this.deps.configDir}/plugins/`;
    const ids = new Set<string>();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) ids.add(rest.slice(0, slash));
    }
    return [...ids];
  }

  private logDrainSummary(r: DrainResult): void {
    this.deps.logger.info("Sync2 drain done", {
      pushedCommits: r.pushedCommits.length,
      pulled: r.vaultStepWrites.length,
      removed: r.vaultStepRemoves.length,
      conflicts: r.conflictVerdicts.length,
      layer2Corrections: r.layer2Corrections.length,
      finalizedMerge: r.finalizedMergeSha !== null,
      vaultStepErrors: r.vaultStepErrors,
    });
  }
}

export default Sync2Manager;
