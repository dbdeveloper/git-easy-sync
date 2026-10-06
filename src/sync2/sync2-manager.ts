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
import ChangeDetector, { type ScanPlan } from "./change-detector";
import { FileChange } from "./types";
import SyncStore, { PIN_OWNER_COMMIT } from "./sync-store";
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
  // ⚠️ Fires the INSTANT a commit begins — before `enforce()`, before
  // the scan, before anything can be known (owner, 2026-10-03). There
  // is no number yet and inventing one would be a lie; the point is
  // only "your click registered". Every commit path goes through
  // `runCommitPass`, so one hook covers syncAll, syncFile, commitOnly
  // and commitFile alike.
  //
  // 📌 It replaced `onCommitCounted` (fired after the scan): measured
  // on desktop the scan is 0.12 s at 2k files and 0.71 s at 20k, but
  // `p6` records a full walk at 10-22 s on Android — so "after the
  // count" is early enough on a laptop and nowhere near it on a phone.
  // (owner, repo, branch) as the user has them RIGHT NOW. Compared at
  // the start of every user-driven sync against what the metadata was
  // built against — see `reconcileRemoteIdentity`.
  remoteIdentity?(): { owner: string; repo: string; branch: string };
  // `fullScan`: false for a single-file commit — quick by nature, so
  // the notice layer opens nothing for it.
  onCommitStarted?(fullScan: boolean): void;
  // ⚠️ THE CLOSING HALF, and it must be unconditional because the
  // opening one is. Fires from a `finally` around the WHOLE commit
  // pass, so it covers the paths that produce no result at all:
  //   • the R3a bell — a trigger landing mid-pass returns 0 immediately;
  //   • no local changes WITH a non-empty queue inside a sync — the
  //     notice layer stays silent there, since the drain is about to
  //     speak (see onNoLocalChanges).
  // Field report 2026-10-03: "Committing…" hung on screen after "Sync
  // done" and stayed until the next sync, because the section had been
  // opened by a call that always happens and closed by calls that
  // sometimes do.
  onCommitFinished?(): void;
  // COMMIT-PASS-PERF 3c (spec §3.1) — ONE counter for stages 2 and 3
  // of a full-scan commit. onCommitPlan: stage 1 is done, nothing has
  // been read; `total` = M = candidates + deletions. onCommitChecked:
  // `done` of `total` — every stage-2 check counts whatever its outcome,
  // then stage 3's deletions (and unhashed adds) as their batches land.
  onCommitPlan?(plan: ScanPlan, total: number): void;
  onCommitChecked?(done: number, total: number): void;
  onLocalCommitted?(filesCount: number): void;
  // The scan found nothing. `queued`: older batches are still waiting
  // in the queue. Whether to SAY "Nothing to commit" is the notice
  // layer's call (owner, 2026-10-05): inside a sync with batches queued
  // it stays quiet — the drain is about to send them; a STANDALONE
  // commit always says it, because it speaks only for that one call.
  onNoLocalChanges?(queued: boolean): void;
  // COMMIT-PASS-PERF 3a: the forecast statistics (commit-stats.ts) —
  // summarised into the commit-timing line and flushed after each pass.
  // Optional and cosmetic: a failed flush is a warning, never an error.
  commitStats?: {
    summary(): Record<string, unknown>;
    flush(): Promise<void>;
  };
  // §II.16 — the whole user-visible operation began. Paired with
  // onSyncCompleted; main.ts arms the 2 s progress timer here, so the
  // wait is measured from the CLICK, not from the drain (a slow commit
  // pass is silence too).
  onSyncStarted?(): void;
  onSyncCompleted?(summary: {
    // Paths this operation's drains really changed on the server, and
    // paths really written to / removed from the vault (see
    // sentThisSync / receivedThisSync) — not the commit pass's count.
    pushedFiles: number;
    pulledFiles: number;
    // Plugins whose files this operation changed — ALL of them, enabled
    // or not (owner, 2026-10-05) — and those it removed (manifest.json
    // deleted). For the summary's plugin lines.
    pluginsUpdated: number;
    pluginsRemoved: number;
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
  // A conflict was CANCELLED because its content is gone from the repo.
  // The same "never silent" contract as the line above, and the only
  // vault-step failure the user hears about (owner's rule, 2026-10-02:
  // log what the next sync will retry, tell them what it will not).
  onConflictCancelled?(path: string): void;
  logger: Sync2Logger;
  now?: () => number;
  // Test seam — the shell's unit suite fakes the engine.
  drainFn?: typeof drainOnce;
}

// Timing values in logs: one decimal is plenty and keeps lines short.
const round1 = (n: number): number => Math.round(n * 10) / 10;

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

  // The "N sent, M received" of the sync summary — what the drains of
  // THIS user-visible operation really changed (owner, 2026-10-05).
  // Sent = paths the drain confirmed on the main branch (drainOnce's
  // `pushedPaths`); received = paths written to or removed from the
  // vault, plus our own plugin's staged self-update. Sets: one path is
  // one file however many drains or batches touched it. NOT the commit
  // pass's count — that one counts entries queued, and on a fresh device
  // it said "19 sent" for one file actually changed on the server.
  private sentThisSync = new Set<string>();
  private receivedThisSync = new Set<string>();
  // Plugin id → what the drains of this operation did to it, last word
  // wins (a plugin removed and then re-added within one sync is updated).
  private pluginsThisSync = new Map<string, "updated" | "removed">();

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

  // ⚠️ THE SNAPSHOT MUST DIE AT THE *SYNC* START, NOT THE DRAIN START.
  //
  // `drain()` already clears `lastProgress` — but main.ts arms the 2 s
  // progress timer at `onSyncStarted`, deliberately, so the wait is
  // measured from the CLICK ("a slow commit pass is silence too").
  // Between those two points sits the commit pass, and on a large vault
  // it runs for seconds. A timer firing in that gap reads a snapshot
  // nobody has cleared yet — the PREVIOUS run's.
  //
  // Field report 2026-10-03: a sync with nothing to do flashed "258"
  // at the owner, who was watching for "nothing to commit" and was
  // confused by it. The log showed the engine idle; the numbers came
  // from the bootstrap run that had finished five seconds earlier.
  //
  // 📌 The same bug was fixed once before (2026-09-26) and the fix was
  // put in `drain()` — correct for the drain, blind to the window in
  // front of it. Clearing it HERE covers both, and the one in `drain()`
  // stays for the entry points that do not come through a user sync.
  private clearProgressForNewUserSync(): void {
    this.lastProgress = null;
    this.emitDrainStatus({ progress: null });
  }

  // ⚠️ THE PROVENANCE `base` DOES NOT CARRY.
  //
  // `FileBaseline` is {baselineSha, mtime, size}: it records WHAT this
  // device and the remote last agreed on for a path, never WITH WHOM.
  // Strip that and two situations become bit-identical — a force-push
  // to an empty tree, and a DIFFERENT empty repository. Both answer
  // compare() with 404 and present an empty tree, so discovery's
  // fallback emits a deletion for every baselined path, and rule 4.3
  // ("local unchanged, remote moved → clean pull") turns each one into
  // a local delete. Foreign baselines can empty the vault.
  //
  // (A mass deletion committed NORMALLY is a different thing and is
  // handled correctly: history moves forward, compare() answers 200,
  // and pulling those deletions is right. Only the 404 case is
  // ambiguous, and no heuristic ON THE DATA can disambiguate it,
  // because the data really is the same. Only identity can.)
  //
  // 📌 Restored 2026-10-03. `reconcileRemoteIdentity` was deleted at THE
  // SWITCH on the reasoning that a repo switch "reads as the force-push
  // class" — true about the MECHANISM and wrong about the MEANING. Its
  // storage survived the deletion, and so did the comment in
  // hot-metadata.ts promising this check; the field was written and
  // read by nobody until now.
  private async reconcileRemoteIdentity(): Promise<void> {
    if (!this.deps.remoteIdentity) return;
    const current = this.deps.remoteIdentity();
    const recorded = this.deps.hotMeta.getRemoteIdentity();
    if (recorded === null) {
      // First observation — record and continue. NOT a mismatch: an
      // install upgrading from a build without this field would
      // otherwise wipe its state once, for nothing.
      await this.deps.hotMeta.update({ remoteIdentity: current });
      return;
    }
    if (
      recorded.owner === current.owner &&
      recorded.repo === current.repo &&
      recorded.branch === current.branch
    ) {
      return;
    }
    this.deps.logger.warn("Sync2 remote identity changed; wiping local state", {
      from: recorded,
      to: current,
    });
    // ⚠️ COLD first, then HOT — the order is what makes this safe to
    // crash in the middle: with the baselines already gone but the
    // identity not yet updated, the next sync detects the same mismatch
    // and repeats the wipe. Idempotent by construction.
    await this.deps.baselines.clear();
    await this.deps.hotMeta.update({
      lastSyncCommitSha: null,
      lastSyncTreeSha: null,
      conflictBranch: null,
      remoteIdentity: current,
    });
    // The queue holds batches enqueued against repo A's baselines. The
    // BYTES are repo-independent (content-addressed in sync_store), but
    // each entry's `previousRemoteSha` is repo A's — and the wipe above
    // guarantees the next commit pass re-enqueues everything anyway, so
    // keeping them buys nothing and carries stale provenance.
    const queueRoot = normalizePath(
      `${this.deps.vault.configDir}/plugins/${this.deps.selfPluginId}/${QUEUE_DIRNAME}`,
    );
    if (await this.deps.vault.adapter.exists(queueRoot)) {
      await this.deps.vault.adapter.rmdir(queueRoot, true);
    }
    // Conflict RECORDS reference repo A's blobs; the sibling FILES stay
    // in the vault untouched, exactly as a Reset leaves them, and the
    // reconciler re-detects them as orphans on the next pass.
    const conflicts = await this.deps.conflictStore.load();
    conflicts.entries.clear();
    await this.deps.conflictStore.save(conflicts);
  }

  async syncAll(): Promise<void> {
    this.deps.logger.info("Sync2 syncAll start");
    // Timed: it sits between "syncAll start" and the commit pass, so a
    // device measurement of "the commit" includes it (COMMIT-PASS-PERF).
    const tIdentity = performance.now();
    await this.reconcileRemoteIdentity();
    this.deps.logger.info("Sync2 syncAll: remote identity checked", {
      ms: round1(performance.now() - tIdentity),
    });
    this.clearSyncCounts();
    this.clearProgressForNewUserSync();
    let ok = false;
    this.deps.onSyncStarted?.();
    try {
      await this.runCommitPass(null);
      await this.drain();
      ok = !this.lastDrainWasCancelled;
    } finally {
      this.deps.onSyncCompleted?.({
        pushedFiles: this.sentThisSync.size,
        pulledFiles: this.receivedThisSync.size,
        pluginsUpdated: this.pluginCount("updated"),
        pluginsRemoved: this.pluginCount("removed"),
        conflicts: this.trackedConflictPaths(),
        ok,
        cancelled: this.lastDrainWasCancelled,
      });
    }
  }

  async syncFile(path: string): Promise<void> {
    this.deps.logger.info("Sync2 syncFile start", { path });
    this.clearSyncCounts();
    this.clearProgressForNewUserSync();
    let ok = false;
    this.deps.onSyncStarted?.();
    try {
      await this.commitFile(path);
      await this.drain();
      ok = !this.lastDrainWasCancelled;
    } finally {
      this.deps.onSyncCompleted?.({
        pushedFiles: this.sentThisSync.size,
        pulledFiles: this.receivedThisSync.size,
        pluginsUpdated: this.pluginCount("updated"),
        pluginsRemoved: this.pluginCount("removed"),
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
  private clearSyncCounts(): void {
    this.sentThisSync.clear();
    this.receivedThisSync.clear();
    this.pluginsThisSync.clear();
  }

  private pluginCount(kind: "updated" | "removed"): number {
    let n = 0;
    for (const v of this.pluginsThisSync.values()) if (v === kind) n += 1;
    return n;
  }

  async resumeQueue(): Promise<void> {
    this.clearSyncCounts();
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
    // The click registered. Before enforce(), before the scan, before
    // anything is knowable — see `onCommitStarted`.
    this.deps.onCommitStarted?.(target === null);
    try {
      return await this.runCommitPassInner(target);
    } finally {
      // Whatever happened — a result, an early return, a throw — the
      // section this method opened is now this method's to close.
      this.deps.onCommitFinished?.();
    }
  }

  private async runCommitPassInner(target: string | null): Promise<number> {
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
        try {
          total += await this.doOneCommitPass(t);
        } finally {
          // COMMIT-PASS-PERF Крок 2: the detector pinned the blobs it
          // stored while hashing; every metafile that references them is
          // on disk now (or the pass failed and they are orphans the
          // sweep should reap). Per pass, not per run: a bell re-loop
          // re-detects and re-pins what it still needs.
          this.deps.syncStore.releaseOwner(PIN_OWNER_COMMIT);
          await this.flushCommitStats();
        }
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
    // COMMIT-PASS-PERF (2026-10-05): where the pass's time goes, one log
    // line per pass — see logCommitTiming.
    const ph: Record<string, number> = {};
    const t0 = performance.now();
    let mark = t0;
    const lap = (name: string): void => {
      const t = performance.now();
      ph[name] = round1(t - mark);
      mark = t;
    };
    if (this.deps.invariants) await this.deps.invariants.enforce();
    lap("enforceMs");
    if (target === null) await this.sanitizeForbiddenFilenames();
    lap("sanitizeMs");
    // Fresh dedup reference for THIS pass.
    this.queueIndex = await buildQueueShaIndex(
      this.deps.vault,
      this.deps.selfPluginId,
    );
    lap("queueIndexMs");

    let changes: FileChange[];
    // The stage 2+3 counter (§3.1): stage 2's checks come from the
    // detector; stage 3 continues from there in the batch loop below.
    let plan: ScanPlan | null = null;
    let total = 0;
    let checksDone = 0;
    if (target === null) {
      changes = await this.deps.detector.findChanges({
        onPlan: (p) => {
          plan = p;
          total = p.checks + p.unhashedAdds + p.deletions;
          this.deps.onCommitPlan?.(p, total);
        },
        onChecked: (done) => {
          checksDone = done;
          this.deps.onCommitChecked?.(done, total);
        },
      });
    } else {
      const one = await this.deps.detector.findChangeForPath(target);
      changes = one === null ? [] : [one];
    }
    lap("detectMs");
    if (changes.length === 0) {
      this.logCommitTiming(target, ph, t0, 0);
      this.deps.onNoLocalChanges?.((await this.listQueueIds()).length > 0);
      this.deps.logger.info("Sync2 commit pass: nothing to commit");
      return 0;
    }

    await this.applyZeroByteRestoreGuard(changes);
    lap("zeroByteGuardMs");

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
    //
    // ⚠️ THIS is the slow half of a commit (owner, 2026-10-03): the scan
    // above counts in well under a second even at 20k files, while every
    // entry here is hashed and its bytes copied into `sync_store/`. A
    // static "Commit N files…" across all of it would be the same
    // silence the early message was meant to end, just later — so each
    // batch reports. One update per ≤100 files means a vault under that
    // size sees exactly one text, as before.
    // Stage 3 of the counter: what stage 2 did not already count —
    // deletions, and new files emitted unhashed (no queue; tests).
    let stage3 = 0;
    let unhashedLeft = (plan as ScanPlan | null)?.unhashedAdds ?? 0;
    for (let i = 0; i < rest.length; i += MAX_BATCH_ENTRIES) {
      const slice = rest.slice(i, i + MAX_BATCH_ENTRIES);
      const id = await this.deps.batchWriter.writeBatch(slice);
      if (id !== null) enqueued += slice.length;
      if (total > 0) {
        for (const c of slice) {
          if (c.kind === "deleted") stage3 += 1;
          else if (c.kind === "added" && c.sha === undefined && unhashedLeft > 0) {
            unhashedLeft -= 1;
            stage3 += 1;
          }
        }
        this.deps.onCommitChecked?.(Math.min(total, checksDone + stage3), total);
      }
    }

    lap("writeBatchesMs");
    this.logCommitTiming(target, ph, t0, changes.length);
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

  // COMMIT-PASS-PERF 3a — best effort: the statistics are cosmetic
  // (commit-stats.ts), so a failed write is worth a warning, not a
  // failed commit.
  private async flushCommitStats(): Promise<void> {
    try {
      await this.deps.commitStats?.flush();
    } catch (err) {
      this.deps.logger.warn("commit stats: flush failed (cosmetic)", {
        err: `${err}`,
      });
    }
  }

  // One line per commit pass: the pass's own phases plus, for a full
  // scan, the detector's breakdown (ScanTiming). Written so that ONE
  // device run answers "which part is slow" — the first measurement
  // after step 1 had only a total, and the guess drawn from it was wrong.
  private logCommitTiming(
    target: string | null,
    phases: Record<string, number>,
    t0: number,
    changes: number,
  ): void {
    const scan =
      target === null ? this.deps.detector.lastScanTiming : null;
    this.deps.logger.info("Sync2 commit pass timing", {
      totalMs: round1(performance.now() - t0),
      changes,
      ...phases,
      ...(this.deps.commitStats
        ? { stats: this.deps.commitStats.summary() }
        : {}),
      ...(scan === null
        ? {}
        : {
            scan: Object.fromEntries(
              Object.entries(scan).map(([k, v]) => [k, round1(v)]),
            ),
          }),
    });
  }

  // ── drain (the engine call) ────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.running) return; // H3: collapse into the in-flight drain
    this.running = true;
    this.abortRequested = false;
    this.lastDrainWasCancelled = false;
    // Phase timing for the "drain done" line (owner's question,
    // 2026-10-06: why "Syncing with GitHub" shows after a Commit but not
    // on repeated Syncs). `visibleMs` is what the notice sees — from the
    // "running" flip to the end — against its 700 ms start delay.
    const tEntry = performance.now();
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
    const tRunning = performance.now();
    const startedAtMs = this.now();
    // ⚠️ `progress: null` is load-bearing, not tidiness. It used to
    // carry the PREVIOUS drain's snapshot into the next one, so a sync
    // with nothing to do could paint "Pushing 1 of 1" from a run that
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
      const tScanned = performance.now();
      const r = await (this.deps.drainFn ?? drainOnce)(this.buildDeps());
      const tDrained = performance.now();

      // Vault-step outcome → UI signals (independent of status: the
      // writes that DID land are real even on a later abort).
      const touched = [...r.vaultStepWrites, ...r.vaultStepRemoves];
      for (const p of touched) this.receivedThisSync.add(p);
      for (const p of r.selfUpdateStaged) this.receivedThisSync.add(p);
      for (const p of r.pushedPaths) this.sentThisSync.add(p);
      // A STAGED self-update must reload us too (regression 2026-10-05):
      // since 86c808e our own loadable files are staged, not written, and
      // the bootloader applies them at the top of onload — the onload
      // this reload runs. Without the staged paths here the update waited
      // for a manual restart of Obsidian.
      const pluginIds = this.derivePluginIds([
        ...touched,
        ...r.selfUpdateStaged,
      ]);
      // A plugin whose manifest.json the drain deleted is REMOVED; any
      // other touched plugin is updated.
      const removedManifests = new Set(r.vaultStepRemoves);
      for (const p of r.vaultStepWrites) removedManifests.delete(p);
      for (const id of pluginIds) {
        const manifestPath = `${this.deps.configDir}/plugins/${id}/manifest.json`;
        this.pluginsThisSync.set(
          id,
          removedManifests.has(manifestPath) ? "removed" : "updated",
        );
      }
      if (pluginIds.length > 0) this.deps.onPluginsAffected?.(pluginIds);
      // Reported from the SAME status-independent block, and for the
      // same reason given above: the cancellation already happened —
      // the record was deleted and saved — so a later abort does not
      // un-cancel it. Reporting only on "ok" would hide exactly the
      // runs that went worst.
      for (const path of r.cancelledConflicts) {
        this.deps.onConflictCancelled?.(path);
      }
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
          const tEnd = performance.now();
          this.logDrainSummary(r, {
            totalMs: round1(tEnd - tEntry),
            enforceMs: round1(tRunning - tEntry),
            beginScanMs: round1(tScanned - tRunning),
            drainOnceMs: round1(tDrained - tScanned),
            afterMs: round1(tEnd - tDrained),
            visibleMs: round1(tEnd - tRunning),
          });
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

  private logDrainSummary(r: DrainResult, timing: Record<string, number>): void {
    this.deps.logger.info("Sync2 drain done", {
      timing,
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
