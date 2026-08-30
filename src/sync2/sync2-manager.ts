// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import WorkerClient from "../worker/worker-client";
import {
  GetTreeResponseItem,
  NewTreeRequestItem,
} from "../github/client";
import {
  calculateGitBlobSHA,
  decodeBase64String,
  describeError,
  hasTextExtension,
} from "../utils";
import ChangeDetector from "./change-detector";
import { atomicWriteFile } from "./atomic-write";
import {
  extractAffectedPluginId,
  isOwnPluginRecoverableFile,
} from "./plugin-update-bootloader";
import {
  needsSanitization,
  sanitizeFilename,
} from "./cross-platform";
import { StaleStateError, AuthError } from "../errors";
import GitignoreInvariants from "./gitignore-invariants";
import PushQueue, { EnqueueMeta } from "./push-queue";
import HotMetadataStore, { RemoteIdentity } from "./hot-metadata";
import FileBaselinesStore from "./file-baselines";
import TreeBuilder from "./tree-builder";
import {
  pluginDirFileRole,
  pluginRootOf,
  readPluginVersion,
  type PluginDirFileRole,
} from "./plugin-js";
import {
  commitMessageForBatch,
  formatConflictMessage,
  formatMergeConflictBranchMessage,
  formatInitMessage,
  parseDeviceSuffix,
  toGitAuthorDate,
} from "./commit-message";
import ConflictStore, { ConflictKind } from "./conflict-store";
import PendingDeletionsStore from "./pending-deletions-store";
import {
  attemptAutoMerge,
  PluginResolveContext,
  MergeTextFn,
} from "./conflict-detection";
import { evaluateConflictState } from "./conflict-classifier";
import { ConflictWatcher } from "./conflict-watcher";
import { ConflictCounter } from "./conflict-counter";
import { buildConflictBranchName } from "./conflict-branch";
import { newBatchId } from "./timestamp-id";
import type { TrashHooks } from "./trash-hooks";
import { normalizeText, shouldCanonicalize } from "./text-normalize";
import {
  writePushInflight,
  readPushInflight,
  clearPushInflight,
} from "./push-inflight";
import { FileChange, QueueBatch } from "./types";

// §28: a plugin's local bundle state, snapshotted before a pull mutates
// anything, so the atomic resolver reads a stable "ours" signal even
// after sibling files have been applied inline. `null` SHA/version =
// the file was absent locally.
interface LocalPluginBundle {
  mainSha: string | null;
  manifestSha: string | null;
  manifestVersion: string | null;
  // Canonical bundle mtime source: main.js's, else manifest's.
  mainMtime: number;
  manifestMtime: number;
  // True when styles.css is among this plugin's remote changes — the
  // only case that needs the (potentially multi-MB) blob SHAs, so we
  // skip hashing main.js otherwise.
  hasStylesChange: boolean;
}

// ── Skip-class taxonomy (SYNC2 §6 + §7.5) ─────────
//
// Every `continue` / `return` inside the loops in `pullIfNeeded`,
// `applyRemoteAddOrModify`, `applyRemoteDeletion`, `processBatch`,
// `reconcileBatchAgainstHead`, `bootstrapFromRemote`, and
// `adoptionPullAndRecord` carries a `// skip-class: <label>` comment
// with one of four labels:
//
//   - **applied** — the operation completed (write happened, snapshot
//     updated, queue entry consumed). Cursor advances normally.
//   - **deferred** — the operation is intentionally postponed; some
//     other code path (next drain, reconcile, future sync click)
//     will handle it. Cursor does NOT advance for this path; an
//     anyOverlapDeferred-style flag often signals the caller to
//     hold lastSync.
//   - **already-correct** — desired state is already on disk; the
//     skip is a true no-op (mtime stat-cache refresh allowed).
//     Cursor may advance.
//   - **unexpected** — the operation could not be applied and we
//     don't know why. NEVER use `continue` here — `throw new
//     StaleStateError("...", { context })` instead. The Phase 1
//     orphan-prevention site (1.4 bug) is the canonical example:
//     compare diff says the path exists at currentHead, fetch
//     returns null; the prior silent-skip behaviour left orphan
//     state requiring a Plugin Reset to recover.
//
// When adding a new skip, label it explicitly. When auditing an
// existing one, treat the absence of a label as a flag for review.

// Minimal client surface Sync2Manager needs. Lets tests inject a stub
// without dragging the real GithubClient (settings, retries, logger…).
// In production this is satisfied by GithubClient directly.
export interface Sync2Client {
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
  createTree(args: {
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
  }): Promise<string>;
  createCommit(args: {
    message: string;
    treeSha: string;
    // Single parent (existing call sites). Use `parents` for merge
    // commits in pseudo-merge stage 7+ (multi-parent finalize).
    parent?: string;
    parents?: string[];
    // Optional git author/committer identity + local date (SYNC2 §4.4).
    author?: { name: string; email: string; date: string };
    retry?: boolean;
  }): Promise<string>;
  updateBranchHead(args: { sha: string; retry?: boolean }): Promise<void>;
  // Pseudo-merge stage 7+: arbitrary-ref operations for the per-
  // device conflict branch lifecycle.
  // `ref` is in the post-"refs/" form, e.g. "heads/easy-sync-
  // conflicts-Obsidian-20260520143022-847".
  createReference(args: {
    ref: string;
    sha: string;
    retry?: boolean;
  }): Promise<void>;
  updateReference(args: {
    ref: string;
    sha: string;
    force?: boolean;
    retry?: boolean;
  }): Promise<void>;
  deleteReference(args: { ref: string; retry?: boolean }): Promise<void>;
  // Lists refs whose name starts with `prefix` (post-"refs/" form).
  // Returns [] on 404. Used by the recovery sweep to enumerate our
  // conflict branches on this device's GitHub repo.
  getMatchingRefs(args: {
    prefix: string;
    retry?: boolean;
  }): Promise<Array<{ ref: string; sha: string }>>;
  // Contents API write. The only endpoint that works against a bare
  // repo (no commits yet) — Git Data API returns 409 "Git Repository
  // is empty" until at least one ref exists. Sync2 uses this to seed
  // a bare repo with <vault>/.gitignore as the first commit, then
  // switches to the Git Data API for everything after. Returns the
  // SHAs from the response so callers can build on top without a
  // follow-up GET (avoiding the eventual-consistency window).
  // PUT /repos/{o}/{r}/contents/{path}.
  createFile(args: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
  }): Promise<{ blobSha: string; treeSha: string; commitSha: string }>;
  getBranchHeadSha(args?: { retry?: boolean }): Promise<string>;
  // Conflict reconciliation needs the tree SHA of an arbitrary commit
  // (rebase target) and the committer date (binary atomic resolver).
  // GET /repos/{o}/{r}/git/commits/{sha}.
  getCommit(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{
    tree: { sha: string };
    committer: { date: string };
    // Full commit message — sync2 reads the trailing " (label)" off
    // it via parseDeviceSuffix to identify the foreign device that
    // authored a conflict's "theirs" side.
    message: string;
  }>;
  // The committer date (ms since epoch) of the LATEST commit that touched
  // `path` at/under `ref` — i.e. when that file was last changed on the
  // remote, NOT when the branch HEAD last moved. Used as the plugin-js
  // mtime tie-break's "theirs" timestamp (SYNC2 §7): comparing against the
  // branch HEAD date wrongly favoured the remote whenever HEAD advanced
  // past the file (a later unrelated commit). Returns null on no commit /
  // error — a best-effort heuristic, never throws.
  // GET /repos/{o}/{r}/commits?path={path}&sha={ref}&per_page=1.
  getLatestCommitDateForPath(args: {
    path: string;
    ref: string;
    retry?: boolean;
  }): Promise<number | null>;
  // Fetches the base64-encoded blob content for `path` at a specific
  // commit `ref`. Returns null on 404 (path not present at that
  // commit, or commit GC'd after force-push). Used for both base
  // (lastSyncCommitSha) and theirs (currentHead) sides of a 3-way
  // merge. GET /repos/{o}/{r}/contents/{path}?ref={sha}.
  getContentsAtRef(args: {
    path: string;
    ref: string;
    retry?: boolean;
  }): Promise<{ content: string; sha: string } | null>;
  // Stage 5 SHA-first reconcile: metadata-only variant that returns
  // sha + size without ever downloading the blob content. Lets the
  // reconcile path decide based on SHAs alone before paying for the
  // bytes + decoding round-trip.
  getContentsMetadataAtRef(args: {
    path: string;
    ref: string;
    retry?: boolean;
  }): Promise<{ sha: string; size: number } | null>;
  // Recursive listing of the branch's HEAD tree — every blob with its
  // path and SHA. Used by bootstrap-from-remote to enumerate what to
  // download into a fresh vault. GET /repos/{o}/{r}/git/trees/{branch}?recursive=1.
  getRepoContent(args?: {
    retry?: boolean;
  }): Promise<{ files: { [key: string]: GetTreeResponseItem }; sha: string }>;
  // Reads a single blob by SHA. Bootstrap fetches blobs through this
  // (one call per file). GET /repos/{o}/{r}/git/blobs/{sha}.
  getBlob(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{ content: string; sha: string }>;
  // Files changed between two refs. Used by the pull pass to discover
  // remote-driven adds/modifies/deletes. Returns a flat list with
  // status. GET /repos/{o}/{r}/compare/{base}...{head}.
  compare(args: {
    base: string;
    head: string;
    retry?: boolean;
  }): Promise<{
    status: "ahead" | "behind" | "identical" | "diverged";
    files: Array<{
      filename: string;
      status:
        | "added"
        | "modified"
        | "removed"
        | "renamed"
        | "copied"
        | "changed"
        | "unchanged";
      sha: string | null;
      previous_filename?: string;
    }>;
  }>;
}

// Thresholds for the lazy-opened progress notice. A pull or push
// cycle stays silent (no long-lived notice) below these; above either
// bound, drain opens a "Pull/Push N/M…" notice the user can watch.
// PROGRESS_BYTES_THRESHOLD applies to both pull (sum of tree sizes
// for the syncable changes) and push (estimateBatchBytes). Default
// 500 KB — overridable via Sync2ManagerDeps.progressBytesThreshold
// so tests can flip it to 0 to assert notice behaviour without
// having to fabricate 500 KB+ of test data.
export const PROGRESS_BYTES_THRESHOLD = 500 * 1024;
const PROGRESS_COUNT_THRESHOLD = 5;

// Drain fallback: how many times to re-fetch a fresh head + reconcile + re-push a batch that
// hit a not-fast-forward 422 (rare — a concurrent multi-device push, or a GitHub ref-read
// replica lag that survived the per-batch head chaining). Bounded so a persistently-diverged
// ref can't spin forever; the next drain still reconciles.
const REF_STALE_MAX_RETRIES = 3;

// Monotonic-head guard (SYNC2 §7.10). GitHub's ref READ is eventually-consistent: right after
// our own push advances the head, a read can be served by a lagging replica that still shows a
// PRIOR (behind) head we already superseded. Building on that stale head reconciles our own
// commits as a phantom "remote conflict" → 422. The guard NEVER accepts a read that matches a
// head we confirmed earlier this session (but is not our latest): it backs off exponentially
// and re-reads until the replica catches up, bounded by the window. Past the window a still-
// behind read is accepted as reality (a real branch reset — out of scope; we ASSUME the branch
// is append-only, so this only degrades gracefully on an unsupported operation).
const MONOTONIC_HEAD_WINDOW_MS = 10_000;
const MONOTONIC_HEAD_BASE_DELAY_MS = 500;
const MONOTONIC_HEAD_MAX_DELAY_MS = 4_000;

interface StaleHeadGuardConfig {
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// Progress UI hook. Sync2Manager keeps one handle per drain run and
// calls update() as it advances commits or files. Whether that maps
// to an Obsidian Notice, a status-bar item, or a noop is the caller's
// decision — sync2's logic doesn't depend on which.
export interface ProgressHandle {
  update(message: string): void;
  hide(): void;
}
export type ProgressFactory = (initialMessage: string) => ProgressHandle;

// Logger surface used by Sync2Manager — phase markers, errors,
// diagnostic probes. Backed by src/logger.ts which appends JSON
// lines to <vault>/<plugin-id>.log.
//
// API is SYNCHRONOUS by design: when logging is disabled, every
// log call is a pure no-op (no Promise allocation, no microtask).
// When enabled, the underlying disk-append fires in the background;
// callers do NOT await log I/O. The lambda form of `data` is only
// invoked when logging is enabled, so diagnostic prep (memory
// snapshots, walk-prototype error extraction, large array maps)
// costs nothing in production.
export interface Sync2Logger {
  info(message: string, data?: unknown | (() => unknown)): void;
  warn(message: string, data?: unknown | (() => unknown)): void;
  error(message: string, data?: unknown | (() => unknown)): void;
  // Read-only flag for sites that need to GUARD a multi-step
  // diagnostic probe (e.g. before+after memory snapshots).
  readonly isEnabled?: boolean;
}

export interface Sync2ManagerDeps {
  vault: Vault;
  hotMeta: HotMetadataStore;
  baselines: FileBaselinesStore;
  detector: ChangeDetector;
  queue: PushQueue;
  builder: TreeBuilder;
  client: Sync2Client;
  logger: Sync2Logger;
  // Optional: when omitted, sync2 doesn't manage the two invariant
  // gitignores. Plugin code passes a real GitignoreInvariants here;
  // unit tests that don't care can leave it out.
  invariants?: GitignoreInvariants;
  configDir: string;
  selfPluginId: string;
  // Per-device label appended to every commit message as a fixed
  // " (label)" suffix and recorded in conflict-store metadata. One
  // setting drives both surfaces — see commit-message.ts /
  // conflict-store.ts for the consumers. Live-readable for the same
  // reason as the templates above.
  deviceLabel: string | (() => string);
  // Optional git author identity (SYNC2.md §4.4). Live getter so a
  // settings change applies on the next commit without re-wiring.
  // Returns {name, email} when BOTH are set, else null → no author
  // override (GitHub uses the token user + push time, as before).
  gitAuthor?: () => { name: string; email: string } | null;
  // Pseudo-merge ConflictStore. Receives a record whenever detection
  // can't auto-resolve a conflict. Required in production; unit tests
  // that don't exercise the conflict path can omit it (the manager
  // throws if a conflict tries to register and the store is missing).
  conflictStore?: ConflictStore;
  // Pending-deletions queue (SYNC2 §4.2). Receives an
  // entry whenever pull-side sanitize observes a forbidden GitHub
  // path and writes its canonical form locally — the entry drives a
  // future push to delete the forbidden path from GitHub. Optional:
  // unit tests that don't exercise sanitize/push paths can omit it
  // (the corresponding code paths guard on `!this.pendingDeletions`
  // and skip the queue operation).
  pendingDeletions?: PendingDeletionsStore;
  // TrashStore integration (R3.4 + R3.5). Optional — when omitted,
  // every trash-relevant touchpoint silently skips (no captureForDelete
  // on pull-delete, no confirmDeleted/confirmResolved/sweepOlderThan
  // at the push/drain-end boundaries). diff2's TrashStore.asHooks()
  // returns a conforming implementation; main.ts wires it in.
  //
  // Position MATTERS: this is the LAST field in this interface and the
  // ONLY new optional field added since pre-PR-5b helpers were written.
  // Existing test-fixture call sites (createSync2Client, etc.) construct
  // Sync2ManagerDeps positionally — adding the field anywhere else
  // would break them and violate Principle #4 ("tests pass unchanged").
  trashHooks?: TrashHooks;
  // Pseudo-merge ConflictWatcher (stage 9 wiring). The drain wraps
  // its batch loop in pause/resume so mid-drain vault writes from
  // sibling-create don't trigger nested evaluateConflictState
  // invocations. Optional: tests that don't care leave it out and
  // sweeps still run inline via evaluateConflictState directly.
  conflictWatcher?: ConflictWatcher;
  // Sweep-skip optimization. When wired, drain consults
  // counter.consumeSweepRequest() before running
  // evaluateConflictState — skips the sweep entirely on idle drains
  // where no vault events touched conflict-relevant paths since the
  // previous drain. Optional: when omitted, drain falls back to
  // "always sweep if records exist" semantics.
  conflictCounter?: ConflictCounter;
  // UI hook for queue-drain progress. main.ts wires this to a long-
  // lived Notice; tests omit it. Returns a handle whose update()
  // changes the displayed text and hide() dismisses the notice.
  onProgress?: ProgressFactory;
  // Brief feedback hooks for the local phase (before any network
  // I/O). Plugin code wires them to short-lived Notices so the user
  // gets immediate feedback that "your work is saved locally; if
  // we're offline, you can keep editing":
  //   - onLocalCommitted fires once per syncAll/syncFile call after
  //     enqueueOrMerge has materialised a batch on disk. The count
  //     is how many distinct file paths landed in the batch (already
  //     filtered for pending-conflict paths).
  //   - onNoLocalChanges fires when there's nothing to enqueue AND
  //     no pending batches in the queue — i.e. a truly idle sync.
  //   - onSyncCompleted fires AT THE END of every successful
  //     syncAll/syncFile (in a finally block, so it fires even after
  //     errors — the wrapper hook is responsible for deciding
  //     whether to flash a success or failure notice).
  //     `pushedFiles` reflects the count enqueued in this sync
  //     specifically; 0 means "nothing went up to remote".
  //     `pulledFiles` counts vault mutations from the pull phases
  //     (bootstrap-from-remote + pullIfNeeded — adds, modifies,
  //     deletes, renames), so "nothing went up but stuff came down"
  //     reads as pushedFiles=0, pulledFiles>0. Identical-SHA no-ops
  //     during adoption do NOT count — those are comparisons, not
  //     content changes.
  // All are no-ops in unit tests that don't pass them.
  onLocalCommitted?(filesCount: number): void;
  onNoLocalChanges?(): void;
  onSyncCompleted?(summary: {
    pushedFiles: number;
    pulledFiles: number;
  }): void;
  // Push-queue depth changed. Fired after every persistent mutation
  // to .push-queue/ — enqueueOrMerge writes a new batch (depth +1)
  // or folds into existing (depth +0); processBatch deletes a
  // successfully-pushed batch (depth -1). Subscriber pattern for
  // SYNC2 §4.3: ribbon sync-icon badge displays this
  // number so the user sees push-queue state directly rather than
  // the indirect conflict-count proxy. `depth` is the count AFTER
  // the mutation that triggered the callback. No-op in unit tests
  // that don't pass it.
  onQueueDepthChanged?(depth: number): void;
  // 2.0.2-beta2: fired at the end of a successful drain when one or
  // more plugin files (main.js / manifest.json / styles.css /
  // data.json) under `<configDir>/plugins/<id>/` were written.
  // main.ts uses it to call `app.plugins.reloadPlugin(id)` for each
  // affected plugin so the new code takes effect immediately
  // instead of waiting for the user to disable + re-enable by hand.
  // Self-plugin update (git-easy-sync's own files) goes through
  // here too; the bootloader at our onload() top is just the
  // crash-recovery backstop for the case where the swap was left
  // mid-protocol.
  onPluginsAffected?(pluginIds: string[]): void;
  // 2.0.2-beta2: fired when the zero-byte restore guard (SYNC2 §2.9)
  // restores an accidentally-emptied file instead of pushing the
  // 0-byte version. main.ts surfaces a user-visible Notice so the
  // recovery is never silent.
  onZeroByteRestored?(path: string): void;
  // When true, a new sync click while pending batches exist (i.e.
  // earlier push attempt failed — typically offline) folds the new
  // changes into the latest pending batch instead of stacking. The
  // eventual replay produces one commit instead of N.
  consolidateCommits?: boolean;
  // (owner, repo, branch) currently configured in settings. Read live
  // at the start of every syncAll: if it differs from the triplet the
  // snapshot was last reconciled against, the manager treats the
  // current state as "wrong remote", wipes snapshot + push-queue +
  // conflict-store, and routes through adoption-from-remote (the
  // bootstrap path) so the new repo is cloned cleanly. Optional —
  // unit tests that don't care about remote-identity tracking can
  // omit it; mismatch detection is skipped when undefined.
  remoteIdentity?: () => RemoteIdentity;
  // Bytes threshold for lazy-opening the long-lived progress notice
  // during drain's pull and push cycles. Defaults to 500 KB; tests
  // pass 0 to make every cycle "heavy" so they can assert the
  // notice transitions.
  progressBytesThreshold?: number;
  // Live getter for the autoCanonicalizeTextFiles setting. When `false`,
  // writeRemoteText writes raw remote bytes without CRLF→LF/BOM/trailing
  // -NL rewrites — the engine treats text the same as binary at the
  // byte level. Optional; default is true (canonicalization on).
  autoCanonicalize?: () => boolean;
  // Stage 7: live getter for the `maxAutoMergeSizeBytes` setting.
  // Read on every reconcile path so the user can tune the
  // threshold without restarting. Defaults to 1 MB when undefined.
  maxAutoMergeSizeBytes?: () => number;
  // Cross-platform filename sanitization callback. Invoked by syncAll
  // before findChanges to rename any vault file whose path contains a
  // Windows-forbidden ASCII char (`< > : " | ? * \`) to its canonical
  // Unicode form (see filename-sanitizer.ts). Plugin code passes a
  // wrapper around `app.fileManager.renameFile` so Obsidian-aware link
  // updates run on the rename. Unit tests pass a fs-only rename for
  // determinism. Optional: when undefined, sanitization is skipped
  // (legacy behaviour — useful for tests that pre-seed forbidden paths
  // to assert push-side guards).
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  // Override the clock for deterministic tests.
  now?: () => number;
  // Test override for the monotonic-head guard timing (SYNC2 §7.10). Production uses the
  // module defaults; tests pass tiny values so backoff re-reads run fast.
  staleHeadGuardConfig?: StaleHeadGuardConfig;
  // Optional Worker orchestra controller. When provided, hot-path
  // CPU operations (SHA computation, base64 decode, 3-way merge)
  // dispatch through the worker pool — threshold-gated, large
  // inputs only. When omitted (most unit tests, fallback
  // environments), a default WorkerClient is constructed which
  // falls back to main-thread execution since Web Worker isn't
  // available in Node test environment. Either way the algorithms
  // are byte-exact (worker and fallback share the same code).
  workerClient?: WorkerClient;
}

// Stage 7 drain status — observed surface for the Settings tab's
// "Drain status" section. Updated as drain progresses; the
// settings page subscribes via setDrainStatusListener and
// re-renders the timer, current path, and last error on each
// event.
export interface DrainStatus {
  state: "idle" | "running" | "cancelling";
  // ms-since-epoch when the current drain started; null when idle.
  // Settings tab computes elapsed = Date.now() - startedAt on every
  // render frame, so a single subscription update is enough — the
  // timer ticks itself.
  startedAt: number | null;
  // Current file path within the active batch, or null when no
  // file is being processed (between batches, or between paths
  // inside the per-batch initialisation).
  currentPath: string | null;
  // Counters for the per-file "N of M" Notice.
  totalFiles: number;
  currentFile: number;
  // Last error surfaced by drain (most recent) — string for
  // serialisation simplicity, with ISO timestamp prefix for the
  // UI to render "x minutes ago". `isAuthError` is set when the
  // error was a 401/403 (AuthError), so the Settings drain-status
  // section can surface the token-help box without re-parsing the
  // message string.
  lastError: {
    message: string;
    whenMs: number;
    isAuthError: boolean;
  } | null;
}

export class Sync2Manager {
  private readonly vault: Vault;
  private readonly hotMeta: HotMetadataStore;
  private readonly baselines: FileBaselinesStore;
  private readonly detector: ChangeDetector;
  private readonly queue: PushQueue;
  private readonly builder: TreeBuilder;
  private readonly client: Sync2Client;
  private readonly logger: Sync2Logger;
  private readonly invariants: GitignoreInvariants | undefined;
  private readonly configDir: string;
  private readonly selfPluginId: string;
  private readonly deviceLabel: () => string;
  private readonly gitAuthor: () => { name: string; email: string } | null;
  private readonly conflictStore: ConflictStore | undefined;
  private readonly pendingDeletions: PendingDeletionsStore | undefined;
  private readonly conflictWatcher: ConflictWatcher | undefined;
  private readonly conflictCounter: ConflictCounter | undefined;
  private readonly trashHooks: TrashHooks | undefined;
  private readonly consolidateCommits: boolean;
  private readonly workerClient: WorkerClient;
  private readonly onProgress: ProgressFactory | undefined;
  private readonly onLocalCommitted:
    | ((filesCount: number) => void)
    | undefined;
  private readonly onNoLocalChanges: (() => void) | undefined;
  private readonly onSyncCompleted:
    | ((summary: { pushedFiles: number; pulledFiles: number }) => void)
    | undefined;
  private readonly onQueueDepthChanged: ((depth: number) => void) | undefined;
  private readonly onPluginsAffected:
    | ((pluginIds: string[]) => void)
    | undefined;
  private readonly onZeroByteRestored:
    | ((path: string) => void)
    | undefined;
  // Single definition of the worker-backed 3-way merge, shared by
  // every attemptAutoMerge call site (pull side, push-reconcile side,
  // resolution-synthesis side). Keeping it in one place stops the
  // three sites from drifting apart — they must all route through the
  // same off-main-thread mergeText (SYNC2 §8). An arrow field so it's
  // pre-bound; reads this.workerClient lazily at call time.
  private readonly mergeViaWorker: MergeTextFn = (ours, base, theirs) =>
    this.workerClient.mergeText(ours, base, theirs);
  // 2.0.2-beta2: accumulated through a drain cycle by maybeMarkPluginAffected.
  // Cleared at drain end after the callback fires.
  private affectedPluginIds: Set<string> = new Set();
  // §28: local plugin-bundle state captured ONCE before a pull applies
  // any file, keyed by plugin root. The pull loop applies each remote
  // file inline, so a sibling main.js/manifest that resolves earlier can
  // overwrite the local file a later styles.css resolution would read —
  // making codeDiffers/version/mtime reflect post-apply state and split
  // the bundle. Reading the "ours" bundle signal from this pre-apply
  // snapshot keeps the group atomic. Null outside a pull.
  private pullBundleSnapshots: Map<string, LocalPluginBundle> | null = null;
  // Accumulator for the pull-side phases (bootstrapFromRemote +
  // pullIfNeeded) so onSyncCompleted can report how many files
  // actually came down from the remote. Reset at the start of each
  // syncAll/syncFile; only counts real vault mutations
  // (no identical-SHA noops).
  private pulledFilesThisSync = 0;
  private readonly remoteIdentity: (() => RemoteIdentity) | undefined;
  private readonly progressBytesThreshold: number;
  private readonly autoCanonicalize: () => boolean;
  private readonly maxAutoMergeSizeBytes: () => number;
  private readonly renameFile:
    | ((oldPath: string, newPath: string) => Promise<void>)
    | undefined;
  private readonly now: () => number;
  private readonly staleHeadGuard: StaleHeadGuardConfig;
  // Heads we have CONFIRMED (PATCH → 200) this session, oldest-first, with the time confirmed.
  // The monotonic-head guard uses this to recognise a replica-lagged read of a head we already
  // superseded. In-memory + window-pruned — replica lag is a live-session concern only.
  private recentConfirmedHeads: { sha: string; at: number }[] = [];
  // Guard against re-entrant drain. The runner only loops one
  // batch at a time; if a second syncAll() lands while the first is
  // still pushing, we let it enqueue but skip the second drain
  // invocation — the first one will pick the new batch up.
  private running = false;

  // Stage 7 cancellation. Set by cancelDrain(); cleared at the
  // start of every fresh drain. Drain checks this flag between
  // per-file iterations and bails cleanly when set. Worker
  // termination is handled separately — the WorkerClient is
  // shared across the plugin so cancelling here doesn't bring
  // down the orchestra. (A future enhancement could terminate +
  // recreate the orchestra to interrupt mid-Worker compute.)
  private abortRequested = false;

  // Stage 7 drain status — observable surface for the Settings
  // tab's "Drain status" section. Updated at the start/end of
  // drain and per file inside reconcile. The Settings page
  // subscribes via setDrainStatusListener and re-renders the
  // timer + current path + last error on each event.
  private drainStatus: DrainStatus = {
    state: "idle",
    startedAt: null,
    currentPath: null,
    totalFiles: 0,
    currentFile: 0,
    lastError: null,
  };
  private drainStatusListeners: Array<(s: DrainStatus) => void> = [];

  constructor(deps: Sync2ManagerDeps) {
    this.vault = deps.vault;
    this.hotMeta = deps.hotMeta;
    this.baselines = deps.baselines;
    this.detector = deps.detector;
    this.queue = deps.queue;
    this.builder = deps.builder;
    this.client = deps.client;
    this.logger = deps.logger;
    this.invariants = deps.invariants;
    this.configDir = deps.configDir;
    this.selfPluginId = deps.selfPluginId;
    this.deviceLabel =
      typeof deps.deviceLabel === "function"
        ? deps.deviceLabel
        : () => deps.deviceLabel as string;
    this.gitAuthor = deps.gitAuthor ?? (() => null);
    this.conflictStore = deps.conflictStore;
    this.pendingDeletions = deps.pendingDeletions;
    this.conflictWatcher = deps.conflictWatcher;
    this.conflictCounter = deps.conflictCounter;
    this.trashHooks = deps.trashHooks;
    this.consolidateCommits = deps.consolidateCommits ?? false;
    this.workerClient = deps.workerClient ?? new WorkerClient();
    this.onProgress = deps.onProgress;
    this.onLocalCommitted = deps.onLocalCommitted;
    this.onNoLocalChanges = deps.onNoLocalChanges;
    this.onSyncCompleted = deps.onSyncCompleted;
    this.onQueueDepthChanged = deps.onQueueDepthChanged;
    this.onPluginsAffected = deps.onPluginsAffected;
    this.onZeroByteRestored = deps.onZeroByteRestored;
    this.remoteIdentity = deps.remoteIdentity;
    this.progressBytesThreshold =
      deps.progressBytesThreshold ?? PROGRESS_BYTES_THRESHOLD;
    this.autoCanonicalize = deps.autoCanonicalize ?? (() => true);
    this.maxAutoMergeSizeBytes =
      deps.maxAutoMergeSizeBytes ?? (() => 1_000_000);
    this.renameFile = deps.renameFile;
    this.now = deps.now ?? (() => Date.now());
    this.staleHeadGuard = deps.staleHeadGuardConfig ?? {
      windowMs: MONOTONIC_HEAD_WINDOW_MS,
      baseDelayMs: MONOTONIC_HEAD_BASE_DELAY_MS,
      maxDelayMs: MONOTONIC_HEAD_MAX_DELAY_MS,
    };
  }

  // Fire onQueueDepthChanged with the CURRENT push-queue depth. Used
  // at every persistent queue mutation (enqueue success, processBatch
  // delete, reset, etc.) so the ribbon sync-icon badge
  // (SYNC2 §4.3) reflects on-disk state without
  // polling. No-op when the
  // callback is not wired (most unit tests).
  private async fireQueueDepth(): Promise<void> {
    if (!this.onQueueDepthChanged) return;
    try {
      const ids = await this.queue.list();
      this.onQueueDepthChanged(ids.length);
    } catch (err) {
      this.logger.warn(
        "Sync2 fireQueueDepth: queue.list() failed",
        { err: `${err}` },
      );
    }
  }

  // Action 1 — full sync.
  //
  // Click path is LOCAL ONLY: identity check → optional one-time
  // bootstrap (network, fires only when lastSyncCommitSha is null) →
  // invariants → findChanges → enqueue. Returns when the batch is on
  // disk. Network drain (pull + push) runs inside drain() which can
  // also be triggered by the interval timer or onload.
  async syncAll(): Promise<void> {
    this.logger.info("Sync2 syncAll start");
    // Remote-identity drift check runs FIRST — before bootstrapIfNeeded.
    // If the user pointed the plugin at a different
    // (owner, repo, branch), we wipe local state here so the rest of
    // syncAll naturally routes through adoption-from-remote against
    // the new remote (lastSyncCommitSha is null after the wipe →
    // bootstrapIfNeeded sees the new branch and clones it).
    await this.reconcileRemoteIdentity();
    // Click is local-only; the long-lived progress notice is opened
    // LAZILY inside drain only when a batch's pull or push exceeds
    // PROGRESS_BYTES_THRESHOLD. Light syncs run silent and finish
    // with a brief "Sync done" via onSyncCompleted.
    const progress: ProgressHandle | null = (null as ProgressHandle | null);
    let syncedFiles = 0;
    this.pulledFilesThisSync = 0;
    try {
      // Bootstrap is the one network step the click body still runs:
      // first-ever sync needs a remote tree probe so the upcoming
      // enqueue doesn't blindly mass-overwrite a non-bare remote. After
      // the first success, lastSyncCommitSha !== null and
      // bootstrapIfNeeded returns null in O(1) — every subsequent click
      // is pure-local.
      await this.bootstrapIfNeeded(progress);
      // Crash-recovery (SYNC2 §7.9): heal a push→record gap BEFORE findChanges, so the
      // base is correct before the change-detector enqueues anything against it.
      await this.recoverPushInflight();
      if (this.invariants) await this.invariants.enforce();
      // Sanitize vault filenames containing Windows-forbidden ASCII
      // chars (`< > : " | ? * \`) BEFORE findChanges so the rename
      // surfaces as a normal delete-old/add-new pair that the rest of
      // the pipeline pushes to GitHub. Hard invariant — these chars
      // never reach the remote regardless of which device created the
      // file (some platforms, notably Obsidian Android, refuse to
      // materialise such names on pull and block multi-device sync
      // permanently). See `filename-sanitizer.ts` for the mapping.
      await this.sanitizeForbiddenFilenames();
      const changes = await this.detector.findChanges();
      if (changes.length === 0) {
        // "Nothing local AND nothing pending in the queue" is the
        // truly idle case — fire onNoLocalChanges so plugin code can
        // flash a brief "Nothing to commit" notice. If the queue still has
        // pending batches (offline-accumulate case), drain
        // picks them up and onProgress takes over the user feedback.
        const pendingBatches = await this.queue.list();
        if (pendingBatches.length === 0) this.onNoLocalChanges?.();
        await this.drain(progress);
        this.logger.info("Sync2 syncAll: nothing to sync");
        return;
      }
      const enqueued = await this.enqueueOrMerge(changes, this.fullSyncMeta());
      syncedFiles = enqueued;
      // SYNC2 §4.3: queue depth changes after enqueue (whether a
      // new batch was persisted or an existing one folded into).
      // Ribbon badge refreshes on this signal.
      await this.fireQueueDepth();
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        // TEMPORARY DEBUG LOG: list every file the click is about to
        // commit so a user reading `<plugin-id>.log` can cross-check
        // the "Commit N files" notice against the actual paths. Drop
        // once the change-detection pipeline has had enough field
        // testing on multi-device traffic.
        this.logger.info("Sync2 syncAll committed", {
          count: enqueued,
          changes: changes.map((c) => `${c.kind} ${c.path}`),
        });
        progress?.update(
          enqueued === 1 ? "Commit 1 file" : `Commit ${enqueued} files`,
        );
        // 2.0.2-beta2: if a batch was just enqueued, wait ~300 ms
        // before dispatching drain. Race-free composition with
        // ANY concurrent drain entry point: an in-flight drain
        // gets time to enter its tail re-check window and pick
        // up the new batch; if no drain is running, the 300 ms is
        // negligible and our drain call below starts cleanly.
        // The new commits are durable on disk in .push-queue/
        // regardless — worst-case they wait for the next drain.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      }
      await this.drain(progress);
    } finally {
      progress?.hide();
      this.onSyncCompleted?.({
        pushedFiles: syncedFiles,
        pulledFiles: this.pulledFilesThisSync,
      });
    }
  }

  // Stage 7 — commit-only entry point. Runs change-detection +
  // enqueue + persists the snapshot, but does NOT drain. Used by
  // the [Commit] ribbon button when the user wants to stage edits
  // without touching the network.
  //
  // Reuses syncAll's pre-enqueue invariants (filename sanitization,
  // gitignore invariants) so the bytes that land in .push-queue
  // match what a full sync would have enqueued. Skips bootstrap
  // entirely — first-time bootstrap is the drain's responsibility;
  // there's no need to fetch the remote tree just to stage local
  // changes.
  // Stage 7 cancellation surface. Settings tab's [Stop drain]
  // button and the split-mode confirmation modal both call this.
  // Sets an abort flag that drain checks between files; the
  // in-flight per-file work doesn't get interrupted mid-step,
  // so a stuck Worker compute would still need its own timeout
  // to surface as a cancellation. The next file boundary is the
  // earliest cancellation can take effect.
  cancelDrain(): void {
    if (!this.running) return;
    this.abortRequested = true;
    this.logger.info("Sync2 cancelDrain requested");
  }

  // Stage 7 error capture. Called by main.ts's sync() catch block
  // (and backgroundDrain) right before re-throwing or swallowing
  // an error. Surfaces in the Settings drain-status section as
  // "⚠ Last error (Ns ago): {message}". Survives drain completion
  // — only overwritten on the next error or cleared by a successful
  // next drain.
  recordDrainError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // Detect 401/403 so the Settings drain-status section can show the
    // token-help box. AuthError is the typed 401/403 from the engine;
    // also catch a bare status field on duck-typed errors from the
    // worker network path.
    const status =
      err instanceof AuthError
        ? err.status
        : (err as { status?: number } | null)?.status;
    const isAuthError = status === 401 || status === 403;
    this.emitDrainStatus({
      lastError: { message, whenMs: Date.now(), isAuthError },
    });
  }

  // Subscribe to drain status changes (Stage 7 Settings "Drain
  // status" section). Returns an unsubscribe function.
  setDrainStatusListener(listener: (s: DrainStatus) => void): () => void {
    this.drainStatusListeners.push(listener);
    listener(this.drainStatus);
    return () => {
      const i = this.drainStatusListeners.indexOf(listener);
      if (i >= 0) this.drainStatusListeners.splice(i, 1);
    };
  }

  // Current snapshot of drain state — used by the Settings page
  // when it renders without an active subscription update yet.
  getDrainStatus(): DrainStatus {
    return { ...this.drainStatus };
  }

  private emitDrainStatus(patch: Partial<DrainStatus>): void {
    this.drainStatus = { ...this.drainStatus, ...patch };
    for (const l of this.drainStatusListeners) l(this.drainStatus);
  }

  // 2.0.2-beta2 commit-file action. Commits ONE path (the file in
  // the active tab, typically) without draining. Returns a tagged
  // outcome so the plugin layer can pick the right Notice:
  //   { kind: "ignored" } → path is in .gitignore OR hardcoded
  //     blocklist. The plugin surfaces "File is in ignore list"
  //     so the user understands why their explicit commit was a
  //     no-op.
  //   { kind: "no-change" } → checkSyncable passed but
  //     findChangeForPath returned null (file matches snapshot,
  //     not modified since last sync). Plugin shows "Nothing to
  //     commit for this file".
  //   { kind: "committed", count: 1 } → path enqueued into a new
  //     or merged batch.
  async commitFile(path: string): Promise<
    | { kind: "ignored" }
    | { kind: "no-change" }
    | { kind: "committed"; count: number }
  > {
    this.logger.info("Sync2 commitFile start", { path });
    await this.reconcileRemoteIdentity();
    if (this.invariants) await this.invariants.enforce();
    if (!(await this.detector.checkSyncable(path))) {
      this.logger.info("Sync2 commitFile: path is ignored", { path });
      return { kind: "ignored" };
    }
    const change = await this.detector.findChangeForPath(path);
    if (change === null) {
      this.logger.info("Sync2 commitFile: nothing to commit for path", {
        path,
      });
      return { kind: "no-change" };
    }
    const enqueued = await this.enqueueOrMerge(
      [change],
      this.fullSyncMeta(),
    );
    await this.fireQueueDepth();
    if (enqueued > 0) {
      this.onLocalCommitted?.(enqueued);
      this.logger.info("Sync2 commitFile committed", {
        path,
        change: `${change.kind} ${change.path}`,
      });
    }
    return { kind: "committed", count: enqueued };
  }

  async commitOnly(): Promise<void> {
    this.logger.info("Sync2 commitOnly start");
    await this.reconcileRemoteIdentity();
    // Crash-recovery (SYNC2 §7.9) — same reason as syncAll: correct the base before the
    // change-detector enqueues, or a post-crash commit would carry a stale parent that the
    // later drain 3-way-conflicts. Network only if a marker is present (rare); a plain
    // commit stays local.
    await this.recoverPushInflight();
    if (this.invariants) await this.invariants.enforce();
    await this.sanitizeForbiddenFilenames();
    const changes = await this.detector.findChanges();
    if (changes.length === 0) {
      this.onNoLocalChanges?.();
      this.logger.info("Sync2 commitOnly: nothing to commit");
      return;
    }
    const enqueued = await this.enqueueOrMerge(changes, this.fullSyncMeta());
    await this.fireQueueDepth();
    if (enqueued > 0) {
      this.onLocalCommitted?.(enqueued);
      this.logger.info("Sync2 commitOnly committed", {
        count: enqueued,
        changes: changes.map((c) => `${c.kind} ${c.path}`),
      });
    }
  }

  // Action 2 — sync just the file at `path`.
  //
  // Behaviour when there's nothing to push (file matches snapshot,
  // missing on both sides, hardcoded-blocked, gitignored): logs a
  // notice and returns silently. No queue batch is created.
  async syncFile(path: string): Promise<void> {
    this.logger.info(`Sync2 syncFile start`, { path });
    // Remote-identity drift check first — same reason as syncAll. If
    // settings now point at a different remote, the snapshot is
    // useless and we'd be pushing single-file content to the wrong
    // repo if we kept going.
    await this.reconcileRemoteIdentity();
    const progress: ProgressHandle | null = (null as ProgressHandle | null);
    let syncedFiles = 0;
    this.pulledFilesThisSync = 0;
    try {
      // Click body is local-only after bootstrap: the only network
      // step is the first-ever bootstrap probe. Pull + push live in
      // drain (the network worker).
      await this.bootstrapIfNeeded(progress);
      // Only enforce invariants when the active path is under
      // configDir; single-file syncs of regular notes don't risk
      // touching them.
      if (this.invariants && path.startsWith(`${this.configDir}/`)) {
        await this.invariants.enforce();
      }
      const change = await this.detector.findChangeForPath(path);
      if (!change) {
        const pendingBatches = await this.queue.list();
        if (pendingBatches.length === 0) this.onNoLocalChanges?.();
        await this.drain(progress);
        this.logger.info(`Sync2 syncFile: nothing to sync`, { path });
        return;
      }

      // No commitMessage passed — processBatch derives
      // `sync ({deviceLabel})` at push time from batch.synthetic +
      // current deviceLabel setting via commitMessageForBatch.
      const enqueued = await this.enqueueOrMerge([change], {
        parentCommitSha: this.hotMeta.getLastSyncCommitSha(),
        parentTreeSha: this.hotMeta.getLastSyncTreeSha(),
      });
      syncedFiles = enqueued;
      // SYNC2 §4.3 — same depth-changed signal as syncAll.
      await this.fireQueueDepth();
      if (enqueued > 0) {
        this.onLocalCommitted?.(enqueued);
        // TEMPORARY DEBUG LOG (matches syncAll). Single-file path so
        // the entry shape stays identical for grep-ability.
        this.logger.info("Sync2 syncFile committed", {
          count: enqueued,
          changes: [`${change.kind} ${change.path}`],
        });
        progress?.update("Commit 1 file");
      }
      await this.drain(progress);
    } finally {
      progress?.hide();
      this.onSyncCompleted?.({
        pushedFiles: syncedFiles,
        pulledFiles: this.pulledFilesThisSync,
      });
    }
  }

  // resumeQueue — drain any pending batches without re-running
  // findChanges. Background entry point: invoked from onload (after
  // a previous session crashed mid-push) and from the watchdog tick
  // when interval-strategy is "manually" but the queue has work.
  async resumeQueue(): Promise<void> {
    // 2.0.2-beta2 BUG FIX. The pulled-files counter must reset
    // here too — resumeQueue is the entry point used by the
    // background drain (interval watchdog + onload pulse) AND by
    // the new `sync` command (split-mode upload-only). Without
    // this reset the counter stayed at whatever the previous full
    // syncAll left it, so the "Sync done (N files updated from
    // GitHub)" notice kept showing the same N on every
    // subsequent click even when nothing actually changed.
    this.pulledFilesThisSync = 0;
    await this.drain();
  }

  // True iff the on-disk push-queue has at least one pending batch.
  // Used by main.ts's interval timer to gate watchdog-style drain
  // ticks: when interval is OFF and the queue is empty, the timer
  // is a no-op (we don't periodically poll remote for changes the
  // user didn't ask for).
  async hasPendingBatches(): Promise<boolean> {
    const ids = await this.queue.list();
    return ids.length > 0;
  }

  // ── internal ────────────────────────────────────────────────────────

  // Pull remote-driven changes from GitHub since lastSyncCommitSha,
  // applying adds/modifies/deletes to the vault. Runs at the start of
  // every syncAll/syncFile so subsequent local change detection is
  // computed against the freshest snapshot baseline.
  //
  // No-op when:
  //   - lastSyncCommitSha is null (first-ever sync; the in-flight
  //     batch will pick up currentHead as parent in processBatch);
  //   - HEAD hasn't moved (compare-step skipped, ~150-byte ref ping);
  //   - compare returns 404 (force-pushed history, GC'd commit) —
  //     graceful degradation, the user keeps editing locally and the
  //     next push will reconcile.
  //
  // For each remote-changed file:
  //   - the path is checked against gitignore + hardcoded blocklist,
  //     so ignored files on the remote don't pollute the local vault;
  //   - if locally clean, the new content overwrites the file and the
  //     snapshot is recorded;
  //   - if locally dirty (the user edited the same file between
  //     syncs), `attemptAutoMerge` runs against base = lastSyncCommitSha
  //     content. Clean merges land silently; plugin-js gets atomic
  //     semver resolution; everything that can't auto-resolve goes
  //     into the ConflictStore as a sibling on a per-device conflict
  //     branch (split-push, pseudo-merge).
  // Removals: delete-vs-modify races route through the same conflict
  // path (kind="delete-vs-modify"), so the user explicitly picks
  // keep-delete vs accept-remote-version via the sibling-file UI.
  // Crash-recovery for the push→record gap (SYNC2 §7.9). The push flow advances the
  // tracked branch (updateBranchHead) and THEN persists the snapshot (store.save); a crash
  // between the two leaves a `.push-inflight` marker + a remote that moved without the
  // snapshot recording it. On a single-writer vault that stale base is the ONLY way a
  // modify-vs-modify "conflict with yourself" can arise (after a post-crash edit). This
  // runs BEFORE findChanges on every enqueue path so the base is corrected first. Cheap: an
  // exists() when no marker; one getBranchHeadSha only when a marker is present (rare).
  private async recoverPushInflight(): Promise<void> {
    const marker = await readPushInflight(this.vault, this.selfPluginId);
    if (!marker) return;
    let realHead: string;
    try {
      realHead = await this.getGuardedHead();
    } catch {
      // Offline / transient — LEAVE the marker so a later drain retries the heal. Clearing
      // it here would forfeit the correction and re-expose the false conflict.
      return;
    }
    if (realHead === marker.newHead) {
      // Our push DID land but the snapshot wasn't recorded. Record it now so `base` reflects
      // the remote → pullIfNeeded sees no drift → a post-crash edit pushes cleanly onto this
      // head instead of 3-way-conflicting against a stale base. Delete the completed batch
      // (its content already landed) so it doesn't re-push.
      await this.hotMeta.update({
        lastSyncCommitSha: marker.newHead,
        lastSyncTreeSha: marker.newTreeSha,
      });
      if (marker.batchId) await this.queue.delete(marker.batchId);
      this.logger.info("Sync2 push-inflight recovered (push landed; snapshot re-recorded)", {
        newHead: marker.newHead,
        batchId: marker.batchId,
      });
    } else {
      // realHead == the OLD head → the ref-advance never landed (crash before/during it);
      // the batch is still valid and re-pushes normally. OR another device moved the head
      // after our crash → the normal drift reconcile (same safe multi-device path) handles
      // it. Either way just drop the marker.
      this.logger.info("Sync2 push-inflight cleared (push did not land / head moved)", {
        newHead: marker.newHead,
        realHead,
      });
    }
    await clearPushInflight(this.vault, this.selfPluginId);
  }

  // Record a head we just CONFIRMED via a 200 PATCH (or seed). Prunes anything older than the
  // guard window so the set stays tiny. SYNC2 §7.10.
  private recordConfirmedHead(sha: string): void {
    const nowMs = this.now();
    this.recentConfirmedHeads.push({ sha, at: nowMs });
    const cutoff = nowMs - this.staleHeadGuard.windowMs;
    this.recentConfirmedHeads = this.recentConfirmedHeads.filter(
      (h) => h.at >= cutoff,
    );
  }

  // Monotonic-head guard (SYNC2 §7.10). Read the branch head, but NEVER trust a read that
  // matches a head we confirmed earlier this session and have already superseded — that is a
  // replica-lagged read of our own past push. Back off exponentially and re-read until the
  // replica catches up (read is our latest, or a head we never confirmed → a genuine remote
  // move for the normal reconcile to handle). Past the window, accept a still-behind read as
  // reality (append-only assumption; a real reset is out of scope). This is what keeps the
  // 422-retry's fresh read (and pullIfNeeded / recoverPushInflight) honest under lag.
  private async getGuardedHead(): Promise<string> {
    let delay = this.staleHeadGuard.baseDelayMs;
    let waited = 0;
    for (;;) {
      const read = await this.client.getBranchHeadSha({ retry: true });
      const cutoff = this.now() - this.staleHeadGuard.windowMs;
      this.recentConfirmedHeads = this.recentConfirmedHeads.filter(
        (h) => h.at >= cutoff,
      );
      const idx = this.recentConfirmedHeads.findIndex((h) => h.sha === read);
      const superseded =
        idx >= 0 && idx < this.recentConfirmedHeads.length - 1;
      if (!superseded) return read;
      if (waited >= this.staleHeadGuard.windowMs) {
        this.logger.warn(
          "Sync2 monotonic-head: read stuck behind a confirmed head past the window — accepting as real (append-only assumption)",
          { read },
        );
        return read;
      }
      this.logger.info(
        "Sync2 monotonic-head: read is a SUPERSEDED confirmed head (replica lag) — backoff + re-read",
        { read, delayMs: delay },
      );
      await new Promise<void>((r) => setTimeout(r, delay));
      waited += delay;
      delay = Math.min(delay * 2, this.staleHeadGuard.maxDelayMs);
    }
  }

  private async pullIfNeeded(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<string | null> {
    const expectedHead = this.hotMeta.getLastSyncCommitSha();
    if (expectedHead === null) return null;

    let currentHead: string | null;
    try {
      currentHead = await this.getGuardedHead();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) return null; // bare repo somehow
      throw err;
    }
    if (currentHead === expectedHead) return currentHead;

    let cmp;
    try {
      cmp = await this.client.compare({
        base: expectedHead,
        head: currentHead,
        retry: true,
      });
    } catch (err) {
      // compare returns 404 when the base commit is unreachable
      // (force-pushed history, GC'd commit, manifest corruption that
      // landed a bogus SHA). The unreachable base means we can't
      // diff and can't 3-way-merge against it later — so advance
      // lastSync to the live head right now. The upcoming
      // enqueueOrMerge picks up that fresh parent and processBatch
      // hits the Case 3 fast-path (head matches), skipping the
      // reconcile branch that would try to fetch blobs at the
      // bogus base SHA. Pinned by K3.
      const status = (err as { status?: number }).status;
      if (status === 404) {
        this.logger.warn("Sync2 pull: compare base unreachable", {
          expectedHead,
          currentHead,
        });
        const headCommit = await this.client.getCommit({
          sha: currentHead,
          retry: true,
        });
        await this.hotMeta.update({
          lastSyncCommitSha: currentHead,
          lastSyncTreeSha: headCommit.tree.sha,
          lastCommitMtime: this.now(),
        });
        return currentHead;
      }
      throw err;
    }

    // Identify which remote-changed paths overlap with files the user
    // has already queued for push. Those overlapping paths must NOT be
    // mutated in the live vault here — the batch's snapshot is the
    // user's source-of-truth and gets reconciled at push time via
    // `reconcileBatchAgainstHead`. Touching them now would clobber
    // batch intent (the batch's snapshot would stay stale and still
    // get pushed, undoing the merge we just wrote into the vault).
    const queuedPaths = await this.queue.collectAllPaths();
    let anyOverlapDeferred = false;

    // Pre-filter syncable changes so the progress notice's "N"
    // matches what the loop will actually touch — same pattern as
    // bootstrapFromRemote. Each pulled file (added/modified/removed/
    // renamed) takes one network round-trip (getBlob) so the user
    // wants live feedback on per-file granularity, not "blob calls".
    const syncableChanges = [] as typeof cmp.files;
    for (const f of cmp.files) {
      if (await this.detector.checkSyncable(f.filename)) {
        syncableChanges.push(f);
      }
    }
    // Reuse the click-time progress notice if syncAll opened one;
    // otherwise spin up our own and own its hide.
    const ownPullProgress = sharedProgress === null;
    let pullProgress: ProgressHandle | null = sharedProgress;
    // Bytes-based threshold, sized per-path rather than via a whole-repo
    // tree fetch. `getRepoContent()` (`GET /git/trees/{head}?recursive=1`)
    // used to be called here just to look up a handful of sizes — its
    // response scales with the ENTIRE vault (measured: ~273 bytes/entry;
    // a 20k-file vault costs ~5.5 MB on every non-empty pull, regardless
    // of how few files actually changed). `getContentsMetadataAtRef` is
    // the same per-path lookup `reconcileBatchAgainstHead` already uses
    // (SHA-first branch) — one small request per changed path instead of
    // one huge one. Above PROGRESS_COUNT_THRESHOLD changed files we skip
    // the precision lookup entirely and just call it heavy — that's the
    // same threshold this code already used as its error-path fallback,
    // now applied proactively so a pull doesn't fire dozens of sequential
    // per-path requests just to decide whether to show a progress notice.
    let isHeavyPull = false;
    if (syncableChanges.length > PROGRESS_COUNT_THRESHOLD) {
      isHeavyPull = true;
    } else if (syncableChanges.length > 0) {
      let totalBytes = 0;
      for (const f of syncableChanges) {
        const meta = await this.client
          .getContentsMetadataAtRef({ path: f.filename, ref: currentHead, retry: true })
          .catch(() => null);
        totalBytes += meta?.size ?? 0;
      }
      isHeavyPull = totalBytes > this.progressBytesThreshold;
    }
    // The progress notice opens lazily on the FIRST file tick rather
    // than pre-loop. tickPull runs at loop-start (below), so each
    // "Pull P/N" appears BEFORE that file is fetched (the user sees the
    // operation in progress, not after it) and the first glimpse is
    // "Pull 1/N" — never a "0/N" that reads as "nothing happened".
    let processed = 0;
    const tickPull = (): void => {
      processed += 1;
      const msg =
        syncableChanges.length === 1
          ? "Pulling 1 file from GitHub…"
          : `Pulling ${processed}/${syncableChanges.length} files from GitHub`;
      if (pullProgress) {
        // Shared notice (syncAll opened one) OR our own, already open.
        pullProgress.update(msg);
      } else if (isHeavyPull && this.onProgress) {
        // Own notice — sharedProgress was null (ownPullProgress true),
        // so the finally-hide below fires for it. Gated on isHeavyPull
        // so light pulls stay silent.
        pullProgress = this.onProgress(msg);
      }
    };

    // §28: capture each involved plugin's local bundle state BEFORE the
    // loop applies any file, so a styles.css conflict resolved after a
    // sibling main.js/manifest was already written still sees the
    // pre-pull bundle (keeps the atomic group from splitting).
    this.pullBundleSnapshots = await this.snapshotLocalPluginBundles(syncableChanges);

    try {
      for (const f of syncableChanges) {
        // Pre-op tick: advance the counter BEFORE this file is handled,
        // so "Pull P/N" reflects the file currently in flight. Every
        // file ticks exactly once here (replacing the old per-branch
        // post-op ticks); pulledFilesThisSync++ stays on the real-pull
        // branches only — it is NOT 1:1 with the counter.
        tickPull();
        try {
          // Pull-side sanitize: when GitHub carries a path with chars
          // the local platform can't materialise (Mobile rejects `"`,
          // Obsidian rejects `# ^ [ ]`), short-circuit and write to
          // canonical-path locally. Phantom snapshot under forbidden
          // path triggers next ChangeDetector to emit a deletion that
          // cleans GitHub. Canonical path itself is NOT recorded —
          // ChangeDetector picks it up as a new file and the same
          // push that deletes forbidden also adds canonical. One
          // round-trip migrates legacy GitHub state to clean form.
          // See `filename-sanitizer.ts`.
          if (
            (f.status === "added" ||
              f.status === "modified" ||
              f.status === "renamed" ||
              f.status === "copied" ||
              f.status === "changed") &&
            needsSanitization(f.filename)
          ) {
            const canonical = sanitizeFilename(f.filename);
            const canonicalExists = await this.vault.adapter.exists(canonical);
            if (!canonicalExists) {
              const blob = await this.safeFetchContents(f.filename, currentHead);
              if (blob) {
                if (hasTextExtension(canonical)) {
                  const text = decodeBase64String(blob.content);
                  await this.writeRemoteText(canonical, text);
                } else {
                  await this.writeBinaryRemote(canonical, blob.content);
                }
                // Record the intent to delete the forbidden GitHub
                // path on the next push. SYNC2 §4.2:
                // pre-2.0.1-beta4 this was a phantom snapshot entry
                // (mtime=0/size=0). beta4 moves the intent to the
                // explicit pending-deletions queue — same observable
                // behaviour (next push emits the deletion), cleaner
                // invariant (the snapshot stays "real entries only").
                if (this.pendingDeletions) {
                  await this.pendingDeletions.add(f.filename, {
                    source: "pull-side-sanitize",
                    observedAtCommit: currentHead,
                    remoteSha: f.sha ?? blob.sha,
                  });
                }
                this.logger.info(
                  "Sync2 pull: sanitized remote forbidden path",
                  { from: f.filename, to: canonical },
                );
                this.pulledFilesThisSync++;
                // skip-class: applied ("forbidden remote path sanitized
                //   to canonical local + intent recorded in
                //   pendingDeletions queue; next push cleans GitHub")
                continue;
              }
            } else {
              this.logger.warn(
                "Sync2 pull: forbidden-path target exists, sanitize skipped",
                { remote: f.filename, local_canonical: canonical },
              );
              // Fall through to normal apply — will likely fail on
              // mobile but the warn-log + per-file catch below surface
              // the path to the user.
            }
          }

          if (queuedPaths.has(f.filename)) {
            // Defer: processBatch's Case 4 (expectedHead != currentHead)
            // will run reconcileBatchAgainstHead on this path. We
            // deliberately leave lastSync at the OLD expectedHead so
            // processBatch sees the drift and triggers reconcile.
            anyOverlapDeferred = true;
            // skip-class: deferred ("path overlaps push-queue;
            //   processBatch's reconcile branch handles it")
            continue;
          }

          if (f.status === "removed") {
            await this.applyRemoteDeletion(f.filename, expectedHead, currentHead);
            this.pulledFilesThisSync++;
            // skip-class: applied ("remote-deletion processed inline")
            continue;
          }

          // Resume: a prior pull pass may have already written this file
          // before crashing. Mirrors bootstrapFromRemote's SHA-match skip.
          if (
            f.status !== "renamed" &&
            f.sha &&
            (await this.vault.adapter.exists(f.filename))
          ) {
            const localBuf = await this.vault.adapter.readBinary(f.filename);
            const localSha = await this.workerClient.computeGitBlobSHA(localBuf);
            if (localSha === f.sha) {
              const stat = await this.vault.adapter.stat(f.filename);
              if (stat) {
                await this.baselines.set(f.filename, {
                  baselineSha: f.sha,
                  mtime: stat.mtime,
                  size: stat.size,
                });
              }
              // skip-class: already-correct ("local file's git-blob SHA
              //   already matches the compare diff's expected SHA;
              //   snapshot stat-cache refreshed, no write needed")
              continue;
            }
          }

          // added / modified / renamed / copied / changed → fetch and
          // apply remote content. previous_filename only matters for
          // renamed status; we treat it as a delete-of-old + add-of-new
          // since GitHub's tree view does the same on its side.
          if (
            f.status === "renamed" &&
            f.previous_filename &&
            (await this.detector.checkSyncable(f.previous_filename))
          ) {
            await this.applyRemoteDeletion(f.previous_filename, expectedHead, currentHead);
          }
          await this.applyRemoteAddOrModify(
            f.filename,
            currentHead,
            expectedHead,
          );
          this.pulledFilesThisSync++;
        } catch (err) {
          // Per-file observability: without this catch, the very first
          // failure aborted the entire pull loop and the only signal
          // was a generic toast from main.ts:sync(). Pre-extract err
          // info verbosely — Capacitor's native-bridge errors on
          // mobile can be objects whose `message`/`stack` neither live
          // as own enumerable properties nor make `instanceof Error`
          // true, so the default JSON.stringify renders them as `{}`.
          // The describeError dump pulls everything reachable
          // (typeof, constructor name, String(err), own properties,
          // common error-shape fields) so something always lands in
          // the log regardless of the thrown value's shape.
          //
          // Re-throw preserves existing safety semantics: lastSync
          // stays at expectedHead so the next sync retries — without
          // this, partial pulls would silently advance lastSync and
          // skip the failed files.
          this.logger.error("Sync2 pull: file apply failed", {
            path: f.filename,
            status: f.status,
            sha: f.sha ?? null,
            previous_filename: f.previous_filename ?? null,
            err: describeError(err),
          });
          throw err;
        }
      }
    } finally {
      if (ownPullProgress) pullProgress?.hide();
      this.pullBundleSnapshots = null;
    }

    if (anyOverlapDeferred) {
      // At least one remote path overlaps with our queue. Keep lastSync
      // at expectedHead so processBatch enters reconcile and resolves
      // the overlap against the batch's snapshot. Non-overlap files
      // were applied above and their per-file snapshots are current —
      // the commit-level lastSync just hasn't caught up yet.
      return currentHead;
    }

    // No overlap: every remote change has been applied to the vault.
    // Safe to advance lastSync so the upcoming push (if any) sees a
    // clean Case 3 fast-path head match.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    await this.hotMeta.update({
      lastSyncCommitSha: currentHead,
      lastSyncTreeSha: headCommit.tree.sha,
      lastCommitMtime: this.now(),
    });
    return currentHead;
  }

  // Pull every blob the branch already carries into the freshly-empty
  // local snapshot store. Runs at most once per device — when sync2
  // sees lastSyncCommitSha=null but the branch has commits, this is
  // the only honest way to align local state with remote without
  // Check the (owner, repo, branch) the snapshot was last reconciled
  // against. If it matches current settings: record (no-op when
  // already recorded) and proceed. If it differs: the user pointed
  // the plugin at a different remote (or branch); wipe snapshot +
  // push-queue + conflict-store so the rest of syncAll routes through
  // bootstrapIfNeeded → bootstrapFromRemote (adoption) against the
  // new remote. The pending batches in the queue carry the previous
  // repo's parent SHAs and would push wrong content if we kept them.
  //
  // First-observation case (recordedRemote === null on a vault that
  // has been synced before — e.g. an upgrade from an older sync2
  // version): record current settings without resetting.
  //
  // Walk the vault, detect any file whose path contains a
  // cross-platform-incompatible ASCII char (per
  // filename-sanitizer.ts), and rename it to its canonical Unicode
  // form. Runs early in syncAll (after invariants.enforce, before
  // findChanges) so the rename surfaces to ChangeDetector as a
  // normal delete-old/add-new pair that the rest of the pipeline
  // publishes to GitHub. Hard invariant — these chars never reach
  // the remote regardless of which device created the file.
  //
  // Skips silently when `renameFile` callback is absent (unit tests
  // that don't wire it). Logs every rename to the activity log so a
  // user reviewing the log can audit what got renamed and why.
  // Collision protection: if the canonical target already exists,
  // log a warning and skip — the user must resolve the duplicate
  // manually before sync can converge on that path.
  private async sanitizeForbiddenFilenames(): Promise<void> {
    if (!this.renameFile) return;
    type FileLike = { path: string };
    const files: FileLike[] = (
      this.vault as unknown as { getFiles?: () => FileLike[] }
    ).getFiles?.() ?? [];
    const renames: Array<{ from: string; to: string }> = [];
    for (const f of files) {
      if (!needsSanitization(f.path)) continue;
      const canonical = sanitizeFilename(f.path);
      if (canonical === f.path) continue;
      if (await this.vault.adapter.exists(canonical)) {
        this.logger.warn(
          "Sync2 sanitize-filename: target exists, skipping",
          { from: f.path, to: canonical },
        );
        continue;
      }
      renames.push({ from: f.path, to: canonical });
    }
    if (renames.length === 0) return;
    this.logger.info(
      `Sync2 sanitize-filename: renaming ${renames.length} file(s)`,
      { renames },
    );
    for (const { from, to } of renames) {
      try {
        await this.renameFile(from, to);
      } catch (err) {
        this.logger.error(
          "Sync2 sanitize-filename: rename failed",
          { from, to, err: describeError(err) },
        );
        throw err;
      }
    }
  }

  // Pre-flight validation of deletion entries in a tree-create payload
  // (SYNC2 §4.1). For each entry with `sha: null` (a
  // deletion), confirm the path still exists at `currentHead`. Drop
  // any whose path is already absent — sending them as a deletion in
  // a `createTree` request triggers a 422 `GitRPC::BadObjectState`
  // that fails the whole push and can deadlock if the stale
  // entry stays in the queued batch across retries.
  //
  // Snapshot also gets the matching entry removed for any dropped
  // deletion. Without this, ChangeDetector's next pass would re-emit
  // the same stale deletion, creating a re-validate-and-drop loop
  // that wastes one round-trip per sync forever.
  //
  // Validator failure policy (SYNC2 §4.1): if
  // `getContentsAtRef` itself errors (network, GitHub 5xx, rate
  // limit), throw. The caller's catch in `processBatch` aborts the
  // push; the queued batch survives; the next drain retries. Better
  // than optimistically proceeding and reintroducing the 422.
  //
  // Non-deletion entries (with `content` for additions/modifies, or
  // with a concrete blob `sha`) pass through unchanged — their
  // failure modes are different and unrelated to remote-tree drift.
  private async validateDeletionsAgainstHead(
    rawEntries: NewTreeRequestItem[],
    currentHead: string,
  ): Promise<NewTreeRequestItem[]> {
    const out: NewTreeRequestItem[] = [];
    const droppedStale: string[] = [];
    for (const entry of rawEntries) {
      // Only pure deletions have `sha === null`. Inline-content entries
      // have `sha === undefined` (and `content: "..."`); blob-reference
      // entries have a concrete `sha`. We check `=== null` to capture
      // exactly the deletion shape.
      if (entry.sha !== null) {
        out.push(entry);
        continue;
      }
      let blob: { content: string; sha: string } | null;
      try {
        blob = await this.client.getContentsAtRef({
          path: entry.path,
          ref: currentHead,
          retry: true,
        });
      } catch (err) {
        this.logger.error(
          "Sync2 pre-flight validation: getContentsAtRef errored, aborting push",
          {
            path: entry.path,
            ref: currentHead,
            err: describeError(err),
          },
        );
        throw err;
      }
      if (blob === null) {
        // Path absent at currentHead — deletion is stale (another
        // device or manual GitHub edit already removed it). Drop the
        // entry AND the matching snapshot row AND the matching
        // pending-deletions queue entry. The latter two are
        // independent stores; either, both, or neither may carry the
        // path, and remove() on either is idempotent — calling both
        // unconditionally is the safe pattern.
        droppedStale.push(entry.path);
        if (this.pendingDeletions) {
          await this.pendingDeletions.remove(entry.path);
        }
      } else {
        out.push(entry);
      }
    }
    if (droppedStale.length > 0) {
      this.logger.info(
        `Sync2 pre-flight validation: dropped ${droppedStale.length} stale deletion(s); snapshot + pending-deletions cleared`,
        { paths: droppedStale },
      );
      // Drop the baseline rows in one grouped write (§2.2.1); the
      // write-through persist closes the same crash window the old
      // save() did. PendingDeletionsStore.remove() above is already
      // self-persisting.
      await this.baselines.removeMany(droppedStale);
    }
    return out;
  }

  // No-op when the manager wasn't given a remoteIdentity getter
  // (unit tests that don't care about this surface).
  private async reconcileRemoteIdentity(): Promise<void> {
    if (!this.remoteIdentity) return;
    const current = this.remoteIdentity();
    const recorded = this.hotMeta.getRemoteIdentity();
    if (recorded === null) {
      // First-ever observation. Record and continue — don't treat
      // this as a mismatch (an upgrade from an older sync2 version
      // would land here once and shouldn't wipe state).
      await this.hotMeta.update({ remoteIdentity: current });
      return;
    }
    if (
      recorded.owner === current.owner &&
      recorded.repo === current.repo &&
      recorded.branch === current.branch
    ) {
      return;
    }
    this.logger.warn(
      "Sync2 remote identity changed; wiping local state",
      { from: recorded, to: current },
    );
    // Cold first, then hot: a crash between the two re-detects the
    // mismatch on the next sync and repeats the wipe (idempotent).
    await this.baselines.clear();
    await this.hotMeta.update({
      lastSyncCommitSha: null,
      lastSyncTreeSha: null,
      lastCommitMtime: null,
      conflictBranch: null,
      remoteIdentity: current,
    });
    await this.queue.clearAll();
    if (this.conflictStore) {
      await this.conflictStore.clearAll();
    }
  }

  // letting the user's first push silently overwrite history.
  //
  // Returns the head SHA observed (so callers can pass it as a hint
  // to drain), or null when the branch is bare or there's
  // nothing to bootstrap (lastSyncCommitSha already set).
  private async bootstrapIfNeeded(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<string | null> {
    if (this.hotMeta.getLastSyncCommitSha() !== null) return null;
    let currentHead: string | null;
    try {
      currentHead = await this.client.getBranchHeadSha({ retry: true });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) return null; // bare repo
      throw err;
    }
    if (currentHead === null) return null;
    await this.bootstrapFromRemote(currentHead, sharedProgress);
    return currentHead;
  }

  // First-sync adoption from a non-bare remote. sync2 has no prior
  // history at this point (lastSyncCommitSha === null), so it can't do
  // a real 3-way merge for diverging files. Instead, per-file
  // resolution by content + atomic mtime:
  //
  //   - local has no copy → pull (write vault, recordSync).
  //   - local has the exact bytes (SHA match) → recordSync, no transfer.
  //   - local has different bytes → atomic resolution by mtime:
  //       localMtime  >= remoteHeadCommitDate → local wins. Don't
  //         touch vault, don't recordSync. findChanges later emits
  //         the path as "added", push lifts it to remote.
  //       localMtime  <  remoteHeadCommitDate → remote wins. Pull,
  //         OVERWRITING the local copy. (README must instruct users
  //         to pre-sync via the previous plugin to keep this branch
  //         from firing on divergent files.)
  //
  // Local-only files (in vault, not in remote tree) are NOT touched
  // here — findChanges naturally emits them as "added" once adoption
  // sets lastSyncCommitSha.
  //
  // Tie on mtime: local wins ("user's last edit is more important
  // than a peer's push from the same minute").
  private async bootstrapFromRemote(
    currentHead: string,
    sharedProgress: ProgressHandle | null = null,
  ): Promise<void> {
    this.logger.info("Sync2 adoption-from-remote start", {
      head: currentHead,
    });
    const { files, sha: treeSha } = await this.client.getRepoContent({
      retry: true,
    });
    // getCommit gives us the HEAD tree sha for the final setLastSync below. It used to
    // ALSO supply a single "remote last touched" date (headCommit.committer.date) reused
    // as every file's freshness — but that was the SYNC2 §7.8 bug: the HEAD date is NOT
    // when a given file was last changed, so a HEAD that advanced past a file made the
    // remote look newer than a genuinely newer local edit → adoption could overwrite the
    // user's local copy with an older remote one. The per-file last-change date is now
    // fetched INSIDE the loop, only for files that actually differ (identical/canonical-
    // match short-circuit before it), so the cost stays bounded.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });

    // Pre-filter syncable paths so the progress notice's "N" matches
    // what the loop will actually touch. Without this, a 500-file
    // repo with a 300-file `.obsidian/` (toggle off) would advertise
    // "0/500" while the real work is just 200 files.
    const syncablePaths: string[] = [];
    for (const filePath of Object.keys(files)) {
      if (await this.detector.checkSyncable(filePath)) {
        syncablePaths.push(filePath);
      }
    }
    // Spin up the long-running notice once we know there's real work.
    // Adoption is mostly a *comparison* pass — for a vault previously
    // synced via another tool (obsidian-git, etc.), most files'
    // local content already matches the remote SHA and the loop
    // just stat-caches them. Only the "missing locally" and
    // "remote-newer" branches actually fire getBlob. Calling the
    // notice "Downloading…" misled a real user: the counter ripped
    // through 245 files in seconds and looked broken because nothing
    // was actually downloading. "Reconciling…" sets the right
    // expectation: we're cross-checking local against remote,
    // downloading what's missing as we go.
    // Reuse the click-time progress notice if syncAll opened one;
    // otherwise spin up our own and own its hide.
    const ownPullProgress = sharedProgress === null;
    let pullProgress: ProgressHandle | null = sharedProgress;
    if (syncablePaths.length > 0) {
      if (pullProgress === null && this.onProgress) {
        pullProgress = this.onProgress(
          `Preparing GitHub syncing…`,
        );
      } else if (pullProgress) {
        pullProgress.update(
          `Preparing GitHub syncing…`,
        );
      }
    }
    let processed = 0;
    const tickPull = (): void => {
      processed += 1;
      if (pullProgress) {
        pullProgress.update(
          `Preparing GitHub syncing: ${processed}/${syncablePaths.length}`,
        );
      }
    };

    let pulled = 0;
    let identical = 0;
    let localKept = 0;
    let remoteOverwrote = 0;
    try {
      for (const filePath of syncablePaths) {
        // Pre-op tick: advance BEFORE this file is handled, so
        // "Preparing GitHub syncing: P/N" reflects the file currently
        // in flight (same contract as pullIfNeeded, SYNC2 §4.5). One
        // tick per file here replaces the old per-branch post-op ticks.
        tickPull();
        const item = files[filePath];
        // Pull-side sanitize for bootstrap (initial vault clone). Same
        // shape as in pullIfNeeded — see comment there. Bootstrap runs
        // before lastSync is set, so a phantom snapshot here is what
        // ChangeDetector's first findChanges will use to emit a
        // deletion that cleans the legacy forbidden path from GitHub.
        if (needsSanitization(filePath)) {
          const canonical = sanitizeFilename(filePath);
          if (!(await this.vault.adapter.exists(canonical))) {
            const blob = await this.client.getBlob({
              sha: item.sha,
              retry: true,
            });
            const bytes = await this.workerClient.decodeBase64(blob.content);
            if (hasTextExtension(canonical)) {
              const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
                bytes,
              );
              await this.writeRemoteText(canonical, text);
            } else {
              await this.ensureParentDir(canonical);
              await this.vault.adapter.writeBinary(canonical, bytes);
            }
            // Pending-deletion intent (SYNC2 §4.2;
            // see pullIfNeeded sanitize site for full rationale).
            // Bootstrap's currentHead is the freshly-fetched branch
            // head; the entry observes the forbidden path at that
            // exact commit.
            if (this.pendingDeletions) {
              await this.pendingDeletions.add(filePath, {
                source: "pull-side-sanitize",
                observedAtCommit: currentHead,
                remoteSha: item.sha,
              });
            }
            this.logger.info(
              "Sync2 bootstrap: sanitized remote forbidden path",
              { from: filePath, to: canonical },
            );
            pulled++;
            this.pulledFilesThisSync++;
            continue;
          } else {
            this.logger.warn(
              "Sync2 bootstrap: forbidden-path target exists, sanitize skipped",
              { remote: filePath, local_canonical: canonical },
            );
          }
        }

        const localExists = await this.vault.adapter.exists(filePath);
        if (!localExists) {
          await this.adoptionPullAndRecord(filePath, item);
          pulled++;
          this.pulledFilesThisSync++;
          continue;
        }

        const localBuf = await this.vault.adapter.readBinary(filePath);
        const localSha = await this.workerClient.computeGitBlobSHA(localBuf);

        if (localSha === item.sha) {
          // Identical content. Stat-cache the snapshot so subsequent
          // syncs short-circuit via the watermark+stat-equality check.
          const stat = await this.vault.adapter.stat(filePath);
          if (stat) {
            await this.baselines.set(filePath, {
              baselineSha: item.sha,
              mtime: stat.mtime,
              size: stat.size,
            });
          }
          identical++;
          continue;
        }

        // Canonicalize-aware resume: when the local copy matches what
        // we WOULD write under autoCanonicalize, the file is our own
        // interrupted-adoption leftover from a previous run that was
        // killed (e.g., Android process suspended) before recordSync
        // landed for this entry. Without this branch, the mtime-newer
        // check below would mis-classify it as user-edited "local
        // wins" and push the canonicalized bytes back to GitHub
        // pretending they're user content — exactly the surprise
        // 96-file re-push reported on first Android setup.
        if (
          shouldCanonicalize(filePath, this.configDir) &&
          this.autoCanonicalize() &&
          (await this.canonicalMatchesLocal(filePath, item.sha, localSha))
        ) {
          const stat = await this.vault.adapter.stat(filePath);
          if (stat) {
            await this.baselines.set(filePath, {
              baselineSha: localSha,
              mtime: stat.mtime,
              size: stat.size,
            });
          }
          identical++;
          continue;
        }

        const stat = await this.vault.adapter.stat(filePath);
        const localMtimeMs = stat?.mtime ?? 0;
        // theirs "freshness" = when THIS FILE was last changed on the remote (SYNC2 §7.8),
        // NOT the branch HEAD date. Only reached for DIFFERING files (identical/canonical-
        // match continue above), so the per-file lookup is bounded. null → 0 → local wins:
        // adoption is local-authority-leaning ("I'm bringing my vault to this repo"), so on
        // a failed date-fetch keep the user's working copy rather than pull a remote we
        // can't date.
        const remoteFileDateMs =
          (await this.client.getLatestCommitDateForPath({
            path: filePath,
            ref: currentHead,
            retry: true,
          })) ?? 0;
        if (localMtimeMs >= remoteFileDateMs) {
          // Local wins. Don't recordSync — findChanges will emit
          // the file as "added" (no snapshot entry) and the next push
          // will lift this local version onto the remote.
          localKept++;
          continue;
        }
        // Remote wins. Pull, overwriting the local copy in place.
        await this.adoptionPullAndRecord(filePath, item);
        remoteOverwrote++;
        this.pulledFilesThisSync++;
      }
    } finally {
      if (ownPullProgress) pullProgress?.hide();
    }

    await this.hotMeta.update({
      lastSyncCommitSha: currentHead,
      lastSyncTreeSha: headCommit.tree.sha ?? treeSha,
      lastCommitMtime: this.now(),
    });
    this.logger.info("Sync2 adoption-from-remote done", {
      pulled,
      identical,
      localKept,
      remoteOverwrote,
      treeSha,
    });
  }

  // Shared "download from remote and write to vault" path used by
  // adoption's three pull branches (missing-locally, remote-newer
  // overwrite, and the legacy bootstrap pull). Text bytes go through
  // canonicalization (CRLF→LF, BOM strip, trailing-NL); when bytes
  // change, snapshot stays stale so the next findChanges treats the
  // file as added/modified and the next push uploads canonical bytes.
  private async adoptionPullAndRecord(
    filePath: string,
    item: GetTreeResponseItem,
  ): Promise<void> {
    const blob = await this.client.getBlob({ sha: item.sha, retry: true });
    const bytes = await this.workerClient.decodeBase64(blob.content);
    if (hasTextExtension(filePath)) {
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      const { canonicalSha, changed } = await this.writeRemoteText(
        filePath,
        text,
      );
      // recordSync only when bytes are already canonical. When pull
      // rewrote them, leave snapshot stale so the next findChanges
      // picks the file up as added/modified and pushes canonical back.
      if (!changed) {
        await this.detector.recordSync(filePath, canonicalSha);
      }
    } else {
      await this.ensureParentDir(filePath);
      await this.vault.adapter.writeBinary(filePath, bytes);
      const stat = await this.vault.adapter.stat(filePath);
      if (stat) {
        await this.baselines.set(filePath, {
          baselineSha: item.sha,
          mtime: stat.mtime,
          size: stat.size,
        });
      }
    }
  }

  // When pull rewrites the on-disk file (CRLF→LF, BOM strip,
  // trailing-NL), recordSync is intentionally skipped so the snapshot
  // stays at the old remote SHA. Next findChanges sees the local-vs-
  // remote divergence and emits the file as modified; the next push
  // uploads canonical bytes back to GitHub.
  private async applyRemoteAddOrModify(
    path: string,
    headRef: string,
    baseRef: string,
  ): Promise<void> {
    const blob = await this.safeFetchContents(path, headRef);
    if (!blob) {
      // The compare diff named this path as added/modified at headRef,
      // but the Contents endpoint returned null. Possible causes:
      //   (a) Race: the file was deleted in a push between our compare
      //       call and this fetch. Rare but real.
      //   (b) Permission drift: the token lost access between compare
      //       and now.
      //   (c) Build/client bug producing a malformed Contents URL
      //       (URL-encoding regression, encoding-by-segment slip, etc).
      // Throw rather than silently skip — earlier silent-skip behaviour
      // produced an orphan-file class of bug on 2026-05-25 where Mobile
      // got a URL-encoding 404 on `[1] File ^ opa?.md`, the loop
      // continued, lastSync advanced past the file's introduction commit,
      // and subsequent compare diffs no longer surfaced the path. Path
      // was permanently invisible to incremental sync until a Reset.
      // With this throw, the per-file catch in pullIfNeeded logs the
      // exact path, the loop aborts, lastSync stays at expectedHead,
      // and the next sync retries — either succeeds (cases a/b resolve)
      // or re-fails until a fixed build is deployed (case c).
      // skip-class: unexpected (compare diff said this path is at
      // currentHead; the very next fetch returned null. Throw rather
      // than silent-skip — silent-skip is what caused the 1.4 orphan
      // bug. The per-file catch in pullIfNeeded captures and
      // re-throws; loop aborts; lastSync stays at expectedHead; the
      // next drain retries.)
      throw new StaleStateError(
        `Sync2 pull: contents endpoint returned null for path the compare diff lists as present: ${path}`,
      );
    }

    const localChange = await this.detector.findChangeForPath(path);
    const exists = await this.vault.adapter.exists(path);

    // Case 1: local is clean against snapshot → pull straight in.
    if (localChange === null) {
      if (hasTextExtension(path)) {
        const remoteText = decodeBase64String(blob.content);
        const { canonicalSha, changed } = await this.writeRemoteText(
          path,
          remoteText,
        );
        // recordSync only when local bytes match remote bytes byte-
        // exactly. When canonicalization rewrote anything (CRLF→LF,
        // BOM strip, trailing-NL), snapshot stays stale on purpose so
        // findChanges emits the file on the next sync click and the
        // canonical version reaches GitHub.
        if (!changed) {
          await this.detector.recordSync(path, canonicalSha);
        }
      } else {
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
      }
      return;
    }

    const theirsBytes = await this.workerClient.decodeBase64(blob.content) as ArrayBuffer;

    // Case 2: ours deleted, theirs modified → delete-vs-modify.
    if (localChange.kind === "deleted") {
      // §28: a plugin folder must NEVER grow a conflict sibling. If the
      // deleted-then-modified file is one of the plugin's synced files,
      // the modify wins and the file resurrects locally (e.g. the plugin
      // was uninstalled on this device while another device updated it).
      // Note: if only one bundle member was remote-modified, only that
      // member resurrects — an accepted stray, not data loss.
      if (pluginDirFileRole(path, this.configDir) !== null) {
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
        this.logger.info(
          "Sync2 §28 plugin delete-vs-modify: modify wins, file resurrected",
          { path },
        );
        return;
      }
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "delete-vs-modify",
        theirsContent: theirsBytes,
        theirsBlobSha: blob.sha,
        oursBlobSha: null,
        remoteDevice: await this.fetchRemoteDevice(headRef),
        fromBatchId: null,
      });
      // skip-class: applied (conflict registered in ConflictStore;
      // user-driven resolution path takes over from here)
      return;
    }

    // Case 3: both modified → try auto-merge, register if it fails.
    const oursBytes = exists
      ? await this.vault.adapter.readBinary(path)
      : new ArrayBuffer(0);
    const baseFetched = await this.safeFetchContents(path, baseRef);
    const baseBytes = baseFetched
      ? (await this.workerClient.decodeBase64(baseFetched.content))
      : null;

    const pullRole = pluginDirFileRole(path, this.configDir);
    let pluginResolve: PluginResolveContext | undefined;
    if (pullRole !== null) {
      pluginResolve = await this.readPluginResolveContext(path, pullRole, headRef);
    }

    const auto = await attemptAutoMerge({
      path,
      ours: oursBytes,
      theirs: theirsBytes,
      base: baseBytes,
      configDir: this.configDir,
      mergeFn: this.mergeViaWorker,
      pluginResolve,
    });

    if (auto.type === "clean") {
      // Text 3-way merged cleanly. Write canonical; recordSync only
      // when canonical bytes match the remote SHA (otherwise the
      // canonicalization gap surfaces on the next findChanges).
      const text = new TextDecoder().decode(auto.content);
      const { canonicalSha } = await this.writeRemoteText(path, text);
      if (canonicalSha === blob.sha) {
        await this.detector.recordSync(path, canonicalSha);
      }
      return;
    }

    if (auto.type === "atomic") {
      if (auto.side === "ours") {
        // Keep local; snapshot stays at the old SHA so the next push
        // surfaces ours to remote.
        this.logger.info(
          "Sync2 atomic auto-merge: kept ours",
          { path },
        );
      } else {
        // Remote wins — overwrite local in place.
        await this.writeBinaryRemote(path, blob.content);
        await this.detector.recordSync(path, blob.sha);
        this.logger.info(
          "Sync2 atomic auto-merge: overwrote with theirs",
          { path },
        );
      }
      return;
    }

    // auto.type === "register-conflict"
    await this.registerConflictAndDropPath({
      vaultPath: path,
      kind: "modify-vs-modify",
      theirsContent: theirsBytes,
      theirsBlobSha: blob.sha,
      oursBlobSha: await this.workerClient.computeGitBlobSHA(oursBytes),
      remoteDevice: await this.fetchRemoteDevice(headRef),
      fromBatchId: null,
    });
  }

  // 2.0.2-beta2: when a remote-driven write hits a plugin file under
  // `<configDir>/plugins/<id>/(main.js|manifest.json|styles.css|
  // data.json)`, add `<id>` to the drain-scoped affected set so we
  // can fire `onPluginsAffected` once at the end and the main
  // thread can call `reloadPlugin(id)`. Subdirectory files and
  // anything outside plugins/ are ignored.
  // SYNC2 §11 Plugin Reload After Pull.
  private maybeMarkPluginAffected(path: string): void {
    const id = extractAffectedPluginId(path, this.configDir);
    if (id !== null) this.affectedPluginIds.add(id);
  }

  // 2.0.2-beta2 marker-based self-update protocol for OUR plugin's
  // main.js / manifest.json / styles.css. SYNC2 §12
  // Self-Update Marker Protocol — full spec including crash-window
  // matrix, bootloader 4-case decision table, and design rationale
  // for using marker presence instead of SHA verification.
  //
  // The bootloader (which
  // runs at the very top of our onload() before logger/snapshot
  // init) needs an integrity signal it can verify WITHOUT access
  // to ground-truth SHAs from the snapshot store. The marker file
  // `.<basename>.<ext>.ges-tmp.` is that signal: its presence
  // certifies that the ges-tmp write completed fully and the
  // bytes are safe to apply.
  //
  // Protocol (executed in current drain process — POSIX rename of
  // a running plugin's main.js is safe; the V8 in-memory image is
  // independent of the file's inode):
  //   Step 1: writeBinary(ges-tmp, bytes) — full write commit
  //   Step 2: write(marker, "")            — "ges-tmp is verified"
  //   Step 3: rename(file → bak)           — backup (Capacitor-safe)
  //   Step 4: rename(ges-tmp → file)      — atomic swap
  //   Step 5: afterCommit()                — snapshot update
  //   Step 6: remove(marker)               — marker no longer needed
  //   Step 7: remove(bak)                  — backup cleanup
  //   add self to affectedPluginIds        — reloadPlugin at drain end
  //
  // All crash windows are covered by the bootloader's Cases A/B/C
  // (see plugin-update-bootloader.ts): marker presence + ges-tmp
  // presence directs the next-launch recovery deterministically.
  //
  // Used for all three of (main.js, manifest.json, styles.css)
  // in our plugin dir. data.json is excluded (never synced from
  // remote — per-device state).
  private async applySelfUpdateOwnFile(
    path: string,
    bytes: ArrayBuffer,
    afterCommit?: () => Promise<void>,
  ): Promise<void> {
    // Derive the staging + marker + bak filenames from the target.
    // For `<dir>/main.js`: tmp = `<dir>/main.ges-tmp.js`,
    // marker = `<dir>/.main.js.ges-tmp.`, bak = `<dir>/main.ges-bak.js`.
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash);
    const fileName = path.slice(slash + 1);
    const dotIdx = fileName.lastIndexOf(".");
    const baseName = fileName.slice(0, dotIdx);
    const ext = fileName.slice(dotIdx);
    const tmpPath = `${dir}/${baseName}.ges-tmp${ext}`;
    // Marker shape matches the modify-in-place convention so the
    // existing AtomicWriteRecovery.sweep handles this protocol as a
    // free defense-in-depth layer if the bootloader is bypassed.
    const markerPath = `${dir}/.${fileName}.ges-tmp.`;
    const bakPath = `${dir}/${baseName}.ges-bak${ext}`;

    // Step 1: full write of ges-tmp (awaited; bytes flushed before
    // marker write begins).
    await this.vault.adapter.writeBinary(tmpPath, bytes);
    // Step 2: drop marker — "ges-tmp is the gold standard, apply it".
    await this.vault.adapter.write(markerPath, "");
    // Steps 3-4: atomic swap via bak intermediate (portable —
    // Capacitor rename does not overwrite, so we have to clear the
    // destination first).
    if (await this.vault.adapter.exists(path)) {
      if (await this.vault.adapter.exists(bakPath)) {
        await this.vault.adapter.remove(bakPath);
      }
      await this.vault.adapter.rename(path, bakPath);
    }
    await this.vault.adapter.rename(tmpPath, path);
    // Step 5: afterCommit records the new snapshot.
    if (afterCommit) await afterCommit();
    // Steps 6-7: cleanup (best-effort; sweep handles any leftover).
    try {
      await this.vault.adapter.remove(markerPath);
    } catch {
      // ignore — bootloader's Case B handles next-launch
    }
    try {
      await this.vault.adapter.remove(bakPath);
    } catch {
      // ignore — sweep handles next-launch
    }
    // Mark for reload at drain end. The drain.finally fires
    // onPluginsAffected → main.ts schedules reloadPlugin.
    this.affectedPluginIds.add(this.selfPluginId);
  }

  private async writeBinaryRemote(
    path: string,
    base64Content: string,
    afterCommit?: () => Promise<void>,
  ): Promise<void> {
    const bytes = await this.workerClient.decodeBase64(base64Content);
    await this.ensureParentDir(path);
    // 2.0.2-beta2: OUR plugin's main.js / manifest.json / styles.css
    // take the marker-based self-update path instead of plain
    // atomicWriteFile. They have the "running code matches running
    // metadata matches running stylesheet" recursion — the bootloader
    // at our next onload() applies any half-finished update before
    // anything else can touch the directory.
    if (
      isOwnPluginRecoverableFile(path, this.configDir, this.selfPluginId)
    ) {
      await this.applySelfUpdateOwnFile(path, bytes, afterCommit);
      return;
    }
    // Atomic-with-backup: a crash mid-write (especially of a plugin's
    // manifest.json or main.js bundle) would otherwise leave the file
    // partial and break the plugin at the next Obsidian launch. The
    // afterCommit callback (typically recordSync) runs AFTER the
    // bytes are in place but BEFORE the backup cleanup so the
    // onload recovery sweep can disambiguate state.
    await atomicWriteFile(this.vault, path, bytes, afterCommit);
    this.maybeMarkPluginAffected(path);
  }

  private async applyRemoteDeletion(
    path: string,
    _baseRef: string,
    _currentHead: string,
  ): Promise<void> {
    const exists = await this.vault.adapter.exists(path);
    if (!exists) {
      await this.detector.recordDeletions([path]);
      return;
    }

    const localChange = await this.detector.findChangeForPath(path);
    if (localChange === null) {
      // Local matches the version that just got deleted. Apply.
      // Best-effort trash capture before removal — gives the user one
      // drain-cycle recovery window if they didn't expect this delete
      // (R3.4). Failure of capture is logged and swallowed; the actual
      // adapter.remove proceeds either way.
      if (this.trashHooks) {
        try {
          await this.trashHooks.captureForDelete(path);
        } catch (err) {
          this.logger.warn(
            "Sync2 applyRemoteDeletion: trash capture failed",
            { path, err: `${err}` },
          );
        }
      }
      await this.vault.adapter.remove(path);
      await this.detector.recordDeletions([path]);
      return;
    }

    // Local has its own changes — modify-vs-delete. Auto-resolves in
    // favour of local: leave the file alone, no recordSync (so the
    // pending batch's "modified" entry stays in the queue and pushes
    // the local content back to remote on the next pass, resurrecting
    // the file). In practice this branch is unreachable because
    // pullIfNeeded skips applyRemoteDeletion for paths in queuedPaths
    // (those route through reconcileBatchAgainstHead instead, which
    // surfaces the same outcome as AutoMergeResult.type ===
    // "modify-wins"). Kept as a defensive no-op for symmetry.
    this.logger.info(
      "Sync2 applyRemoteDeletion: modify-wins (local-modify resurrects file)",
      { path },
    );
  }

  // ── pseudo-merge detection helpers (stage 5c) ──────────────────────

  // Snapshot live base file stats + SHA at conflict-registration time.
  // ConflictRecord caches these so the classifier can detect "user
  // copied sibling onto base" (case 6) without re-reading the vault on
  // every sweep. Returns nulls for kind=delete-vs-modify (the base
  // file doesn't exist by definition).
  private async snapshotBaseCache(
    path: string,
    kind: ConflictKind,
  ): Promise<{
    baseMtime: number | null;
    baseSize: number | null;
    baseSha: string | null;
  }> {
    if (kind === "delete-vs-modify") {
      return { baseMtime: null, baseSize: null, baseSha: null };
    }
    const stat = await this.vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      return { baseMtime: null, baseSize: null, baseSha: null };
    }
    const bytes = await this.vault.adapter.readBinary(path);
    return {
      baseMtime: stat.mtime,
      baseSize: stat.size,
      baseSha: await this.workerClient.computeGitBlobSHA(bytes),
    };
  }

  // Read the remote commit's device suffix off the trailing
  // " (label)" of its message. Failures (network, GC'd ref) degrade
  // gracefully to "unknown" — the sibling filename still lands, just
  // labelled as such.
  private async fetchRemoteDevice(ref: string): Promise<string> {
    try {
      const headCommit = await this.client.getCommit({
        sha: ref,
        retry: true,
      });
      return parseDeviceSuffix(headCommit.message);
    } catch {
      return "unknown";
    }
  }

  // §28 PULL-side plugin-dir resolve context. Gathers only what the
  // file's role needs so the atomic resolver can pick a winner without
  // ever registering a conflict:
  //   - data   → the file's own mtime on each side (rule 4).
  //   - code   → manifest versions + the canonical bundle mtime.
  //   - styles → the above PLUS `codeDiffers` (does the bundle differ
  //              ours-vs-theirs?) so styles.css follows the bundle
  //              winner (rule 1) or its own mtime when the bundle is
  //              identical (rule 3).
  // "ours" bundle signal = the PRE-APPLY snapshot (pullBundleSnapshots),
  // NOT the live vault — a sibling may already have been applied inline.
  // "theirs" = the remote head.
  private async readPluginResolveContext(
    path: string,
    role: PluginDirFileRole,
    headRef: string,
  ): Promise<PluginResolveContext | undefined> {
    const root = pluginRootOf(path, this.configDir);
    if (root === null) return undefined;

    // The resolving file's own mtime — read live. The file being
    // resolved is the conflict itself, NOT yet applied this drain, so
    // its local state is intact; only its SIBLING bundle files may
    // already be overwritten (those come from the snapshot below).
    const fileOursMtime = (await this.vault.adapter.stat(path))?.mtime ?? 0;
    const fileTheirsMtime = await this.remoteChangeMtime(path, headRef);

    if (role === "data") {
      return this.dataOnlyResolveContext(fileOursMtime, fileTheirsMtime);
    }

    // Pre-apply local bundle snapshot (defensive live fallback if
    // absent — the pull loop always populates it).
    const snap =
      this.pullBundleSnapshots?.get(root) ??
      (await this.snapshotOneBundle(root, role === "styles"));

    const manifestPath = `${root}/manifest.json`;
    const remoteManifest = await this.safeFetchContents(manifestPath, headRef);
    const theirsVersion = remoteManifest
      ? readPluginVersion(decodeBase64String(remoteManifest.content))
      : null;

    // Canonical bundle mtime = main.js's (fallback manifest). ONE value
    // per side so main.js/manifest/styles.css can never split on a
    // semver tie. theirs mtime = the file's LAST-CHANGE commit date,
    // never the branch HEAD date (SYNC2 §7).
    const codeOursMtime = snap.mainMtime || snap.manifestMtime;
    const codeTheirsMtime =
      (await this.remoteChangeMtime(`${root}/main.js`, headRef)) ||
      (await this.remoteChangeMtime(manifestPath, headRef));

    // codeDiffers only affects styles.css (rule 1 vs rule 3). Compare
    // the snapshot's local SHAs against remote metadata — no big
    // download, and immune to the sibling already being applied.
    let codeDiffers = true;
    if (role === "styles") {
      const remoteMain = await this.client.getContentsMetadataAtRef({
        path: `${root}/main.js`,
        ref: headRef,
        retry: true,
      });
      codeDiffers =
        snap.mainSha !== (remoteMain?.sha ?? null) ||
        snap.manifestSha !== (remoteManifest?.sha ?? null);
    }

    return {
      oursVersion: snap.manifestVersion,
      theirsVersion,
      codeDiffers,
      codeOursMtime,
      codeTheirsMtime,
      fileOursMtime,
      fileTheirsMtime,
    };
  }

  // A plugin-dir resolve context carrying only the resolving file's own
  // mtimes — used for data.json (rule 4) and as the shape both readers
  // return for that role.
  private dataOnlyResolveContext(
    fileOursMtime: number,
    fileTheirsMtime: number,
  ): PluginResolveContext {
    return {
      oursVersion: null,
      theirsVersion: null,
      codeDiffers: false,
      codeOursMtime: 0,
      codeTheirsMtime: 0,
      fileOursMtime,
      fileTheirsMtime,
    };
  }

  // Remote last-change commit date for a path (NOT the branch HEAD
  // date; SYNC2 §7). null → 0.
  private async remoteChangeMtime(path: string, ref: string): Promise<number> {
    return (
      (await this.client.getLatestCommitDateForPath({ path, ref, retry: true })) ?? 0
    );
  }

  // §28: snapshot every involved plugin's local bundle state BEFORE the
  // pull applies anything. Only plugins with a coupled-file (main.js /
  // manifest.json / styles.css) change need it — data.json resolves by
  // its own mtime. The blob SHAs (which may hash a multi-MB main.js) are
  // taken only when styles.css is among the plugin's changes, the sole
  // case codeDiffers is consulted.
  private async snapshotLocalPluginBundles(
    changes: Array<{ filename: string }>,
  ): Promise<Map<string, LocalPluginBundle>> {
    const roots = new Map<string, boolean>(); // root → hasStylesChange
    for (const f of changes) {
      const role = pluginDirFileRole(f.filename, this.configDir);
      if (role === null || role === "data") continue;
      const root = pluginRootOf(f.filename, this.configDir);
      if (!root) continue;
      roots.set(root, (roots.get(root) ?? false) || role === "styles");
    }
    const out = new Map<string, LocalPluginBundle>();
    for (const [root, hasStyles] of roots) {
      out.set(root, await this.snapshotOneBundle(root, hasStyles));
    }
    return out;
  }

  private async snapshotOneBundle(
    root: string,
    needSha: boolean,
  ): Promise<LocalPluginBundle> {
    const manifestPath = `${root}/manifest.json`;
    const mainJsPath = `${root}/main.js`;
    const manifestVersion = (await this.vault.adapter.exists(manifestPath))
      ? readPluginVersion(await this.vault.adapter.read(manifestPath))
      : null;
    return {
      mainSha: needSha ? await this.localBlobShaOrNull(mainJsPath) : null,
      manifestSha: needSha ? await this.localBlobShaOrNull(manifestPath) : null,
      manifestVersion,
      mainMtime: (await this.vault.adapter.stat(mainJsPath))?.mtime ?? 0,
      manifestMtime: (await this.vault.adapter.stat(manifestPath))?.mtime ?? 0,
      hasStylesChange: needSha,
    };
  }

  private async localBlobShaOrNull(path: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(path))) return null;
    return this.workerClient.computeGitBlobSHA(
      await this.vault.adapter.readBinary(path),
    );
  }

  // Register a conflict in the ConflictStore and remove the path from
  // any queued batches. Pull-side callers pass fromBatchId=null (no
  // batch yet for this path); push-side reconcile callers pass the
  // batch id so the path drops out of the current batch + every
  // later batch (cascade-defer) before reaching the main-push tree
  // build. Also pushes a snapshot of the local "ours" version to the
  // per-device conflict branch so the pre-conflict state is preserved
  // on GitHub even though it's filtered out of main.
  private async registerConflictAndDropPath(args: {
    vaultPath: string;
    kind: ConflictKind;
    theirsContent: ArrayBuffer;
    theirsBlobSha: string;
    oursBlobSha: string | null;
    remoteDevice: string;
    fromBatchId: string | null;
  }): Promise<void> {
    if (!this.conflictStore) {
      throw new Error(
        "Sync2 conflict registration requested but no ConflictStore is wired",
      );
    }
    const baseCache = await this.snapshotBaseCache(args.vaultPath, args.kind);
    await this.conflictStore.create({
      vaultPath: args.vaultPath,
      kind: args.kind,
      theirsContent: args.theirsContent,
      theirsBlobSha: args.theirsBlobSha,
      oursBlobSha: args.oursBlobSha,
      baseMtime: baseCache.baseMtime,
      baseSize: baseCache.baseSize,
      baseSha: baseCache.baseSha,
      remoteDevice: args.remoteDevice,
    });
    this.pulledFilesThisSync++;
    this.logger.info("Sync2 conflict registered", {
      path: args.vaultPath,
      kind: args.kind,
    });
    // Push ours' version to the per-device conflict branch so the
    // user's pre-conflict state is preserved as a server-side
    // commit (see docs/PSEUDO-MERGE-MODE.md §4.3 + §10 Scenario E).
    // Eager: branch is created at current main HEAD on the first
    // conflict registration of the session, each subsequent
    // conflict appends one commit. For delete-vs-modify, ours was
    // "delete" → tree entry is sha:null.
    const branchContent = args.kind === "delete-vs-modify" ? null : await this.readLocalBytesForBranchPush(args.vaultPath);
    await this.pushConflictPathsToBranch(
      [{ path: args.vaultPath, content: branchContent }],
      formatConflictMessage(this.deviceLabel(), this.now()),
    );

    if (args.fromBatchId === null) return;

    // Push-side cascade: drop the path from the current batch + every
    // later queued batch so main-push doesn't accidentally upload
    // pre-conflict bytes.
    const ids = await this.queue.list();
    const startIdx = ids.indexOf(args.fromBatchId);
    if (startIdx < 0) return;
    for (const id of ids.slice(startIdx)) {
      const batch = await this.queue.read(id);
      if (
        !batch.files.includes(args.vaultPath) &&
        !batch.deletions.includes(args.vaultPath)
      ) {
        continue;
      }
      if (id !== args.fromBatchId && batch.inProgress) continue;
      await this.queue.removeFile(id, args.vaultPath);
      if (id === args.fromBatchId) continue;
      const refreshed = await this.queue.read(id);
      if (
        refreshed.files.length === 0 &&
        refreshed.deletions.length === 0
      ) {
        await this.queue.delete(id);
        await this.fireQueueDepth();  // §3.6
      }
    }
  }

  // Read the local "ours" bytes for a path being registered as a
  // conflict, for the conflict-branch push. Pulls from the live
  // vault — applyRemoteAddOrModify / applyRemoteDeletion / reconcile
  // callers all observe a vault that matches the value we want to
  // preserve on the server side. Missing file → 0-byte buffer
  // (defensive; the caller should already have routed delete-vs-modify
  // to a sha:null tree entry by the time we get here).
  private async readLocalBytesForBranchPush(
    vaultPath: string,
  ): Promise<ArrayBuffer> {
    if (!(await this.vault.adapter.exists(vaultPath))) {
      return new ArrayBuffer(0);
    }
    return await this.vault.adapter.readBinary(vaultPath);
  }

  // Push N conflict-path entries to the per-device conflict branch
  // as a single commit. Eager-create the branch at current main
  // HEAD when this is the first conflict of the session; otherwise
  // append to the existing branch head. `base_tree` for the new
  // commit is ALWAYS current main.tree — the "rebase forward"
  // rule — so the branch stays trivially merge-able back to main
  // on finalize: branch.tree == main.tree + (only the conflict
  // paths overridden). See docs/PSEUDO-MERGE-MODE.md §4.3.
  //
  // Each `entries[i].content` is the bytes that go on the branch:
  //   - ArrayBuffer → uploaded as a blob; tree entry references the
  //     blob's SHA.
  //   - null        → deletion (tree entry `sha: null`).
  //
  // Updates the hot conflictBranch state with the new head and
  // persists. Caller is responsible for ordering vs other writes.
  private async pushConflictPathsToBranch(
    entries: Array<{ path: string; content: ArrayBuffer | null }>,
    message: string,
  ): Promise<void> {
    if (entries.length === 0) return;

    // 1. Fresh main HEAD + tree (rebase forward).
    const mainHead = await this.client.getBranchHeadSha({ retry: true });
    const mainCommit = await this.client.getCommit({
      sha: mainHead,
      retry: true,
    });
    const mainTreeSha = mainCommit.tree.sha;

    // 2. Resolve / create the conflict branch.
    let cb = this.hotMeta.getConflictBranch();
    if (cb === null) {
      // Eager creation: name = git-easy-sync-conflicts-{label}-{ts}-{mmm}.
      // On the rare 422 "Reference already exists" (cross-device
      // sub-second collision on the default label), re-generate
      // with a freshly-clocked now() — millisecond resolution makes
      // a second collision vanishingly small.
      let attempt = 0;
      while (true) {
        const name = buildConflictBranchName(this.deviceLabel(), this.now());
        try {
          await this.client.createReference({
            ref: `refs/heads/${name}`,
            sha: mainHead,
            retry: true,
          });
          cb = { name, head: mainHead };
          break;
        } catch (err) {
          attempt += 1;
          const status = (err as { status?: number }).status;
          if (status === 422 && attempt < 5) {
            // Yield a millisecond and retry.
            await new Promise((r) => setTimeout(r, 2));
            continue;
          }
          throw err;
        }
      }
      await this.hotMeta.update({ conflictBranch: cb });
      this.logger.info("Sync2 conflict-branch created", {
        name: cb.name,
        baseSha: mainHead,
      });
    }

    // 3. Build tree entries. For each path with content: createBlob
    //    + tree entry referencing the blob SHA. For sha:null entries
    //    (delete-vs-modify), the tree entry directly records the
    //    delete against base_tree.
    const treeEntries: NewTreeRequestItem[] = [];
    // TODO §26 — the git-blob sha each base was pushed to the branch with,
    // so we can advance its record's branchBaseSha after the push lands.
    const pushedShaByPath = new Map<string, string>();
    for (const e of entries) {
      if (e.content === null) {
        treeEntries.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      } else {
        const base64 = arrayBufferToBase64(e.content);
        const { sha } = await this.client.createBlob({
          content: base64,
          encoding: "base64",
          retry: true,
        });
        treeEntries.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          sha,
        });
        pushedShaByPath.set(e.path, sha);
      }
    }

    // 4. createTree on top of main.tree (always rebase forward).
    const newTreeSha = await this.client.createTree({
      tree: { tree: treeEntries, base_tree: mainTreeSha },
      retry: true,
    });

    // 5. createCommit on branch.head. On a freshly-created branch
    //    cb.head === mainHead, so the first conflict commit's parent
    //    is main; subsequent conflicts chain on the previous one.
    const commitSha = await this.client.createCommit({
      message,
      author: this.commitAuthorFor(this.now()),
      treeSha: newTreeSha,
      parent: cb.head,
      retry: true,
    });

    // 6. updateReference (PATCH /git/refs/heads/<branch>) + persist.
    await this.client.updateReference({
      ref: `heads/${cb.name}`,
      sha: commitSha,
      retry: true,
    });
    await this.hotMeta.update({
      conflictBranch: { name: cb.name, head: commitSha },
    });
    // TODO §26 — advance each routed base's branch value so the change-
    // detector stops re-committing the (now unchanged) base every sync.
    if (this.conflictStore) {
      for (const [path, sha] of pushedShaByPath) {
        await this.conflictStore.recordBranchBasePush(path, sha);
      }
    }
    this.logger.info("Sync2 conflict-branch commit pushed", {
      branch: cb.name,
      newHead: commitSha,
      paths: entries.map((e) => e.path),
    });
  }

  // Phase B side-batch synthesis. When evaluateConflictState closes
  // a path (all records for it dropped), drain synthesizes a side-
  // batch carrying the live vault state for that path to main. The
  // batch flows through the normal processBatch loop as a synthetic
  // batch (meta.synthetic=true → "resolve conflict (...)" commit
  // message; never merged with user batches). See
  // docs/PSEUDO-MERGE-MODE.md §10 Scenario E for a worked example.
  //
  // Dedup: if the user already has a non-attempted, non-synthetic
  // pending batch touching the closed path, skip — the user batch's
  // content already covers it. processBatch's no-op-tree-skip would
  // drop the duplicate anyway, but skipping here keeps the queue
  // minimal.
  private async synthesizeResolutionSideBatches(
    resolvedPaths: Set<string>,
  ): Promise<void> {
    const userPaths = await this.collectPathsInPendingUserBatches();
    for (const closedPath of resolvedPaths) {
      if (userPaths.has(closedPath)) continue;
      const exists = await this.vault.adapter.exists(closedPath);
      let content: Uint8Array | null = null;
      let contentSha: string | null = null;
      if (exists) {
        const buf = await this.vault.adapter.readBinary(closedPath);
        content = new Uint8Array(buf);
        contentSha = await this.workerClient.computeGitBlobSHA(buf);
      }
      await this.queue.enqueueSynthetic({
        path: closedPath,
        content,
        contentSha,
        parentCommitSha: this.hotMeta.getLastSyncCommitSha() ?? "",
        parentTreeSha: this.hotMeta.getLastSyncTreeSha() ?? "",
        // R3.5 layer 1b marker. After this side-batch lands on GitHub,
        // processBatch fires trashHooks.confirmResolved(closedPath) →
        // TrashStore wipes sibling-trash entries for the just-resolved
        // base path. See docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.5.
        resolvesConflictForBasePath: closedPath,
      });
    }
  }

  // Collect paths covered by pending user batches (not synthetic,
  // not attempted, not in-progress). Used by Phase B side-batch
  // synthesis to avoid pushing the same content twice when the
  // user's own batch already covers a resolved path.
  private async collectPathsInPendingUserBatches(): Promise<Set<string>> {
    const result = new Set<string>();
    const ids = await this.queue.list();
    for (const id of ids) {
      try {
        const batch = await this.queue.read(id);
        if (batch.synthetic) continue;
        if (batch.attempted) continue;
        if (batch.inProgress) continue;
        for (const p of batch.files) result.add(p);
        for (const p of batch.deletions) result.add(p);
      } catch {
        // Unreadable batch — skip; processBatch retry handles it.
      }
    }
    return result;
  }

  // Finalize the active conflict branch back into main when every
  // record in the ConflictStore has been resolved. Manual
  // merge-commit on main with parents=[main.head, branch.head] +
  // tree=main.tree (the user's resolutions already landed in main
  // via the regular push path; the branch just carries history).
  // Then deleteReference + clear local conflictBranch state.
  //
  // No-op when there's no active branch OR when records remain.
  // Safe to call multiple times — idempotent on a "nothing to do"
  // input.
  private async finalizeConflictBranchIfReady(): Promise<void> {
    const cb = this.hotMeta.getConflictBranch();
    if (cb === null) return;
    if (!this.conflictStore) return;
    if (this.conflictStore.getAll().length > 0) return;

    const mainHead = await this.client.getBranchHeadSha({ retry: true });
    const mainCommit = await this.client.getCommit({
      sha: mainHead,
      retry: true,
    });
    const mainTreeSha = mainCommit.tree.sha;

    // Hardcoded `merge conflict-branch ({deviceLabel})`. The branch
    // name itself is discoverable from the merge-commit's second
    // parent SHA, and the (still-deleted) ref shows up in the
    // Network graph as a tip.
    const message = formatMergeConflictBranchMessage(this.deviceLabel(), this.now());
    const mergeCommit = await this.client.createCommit({
      message,
      author: this.commitAuthorFor(this.now()),
      treeSha: mainTreeSha,
      parents: [mainHead, cb.head],
      retry: true,
    });
    // SYNC2 §7.9 — this site ALSO has the push→record gap, but it is NOT the false-conflict
    // bug and needs NO marker (proven: test "finalize-merge crash SELF-RECOVERS"). The merge
    // tree == mainTreeSha (a history merge — resolutions already landed on main), so for
    // every file theirs@mergeCommit == base → a post-crash edit 3-ways CLEAN (only a
    // content-advancing push can cause the false conflict). And this whole method is
    // idempotent (deleteReference tolerates "already gone"), so a crash here self-recovers
    // via re-finalize on the next drain (cosmetic cost: a redundant merge commit). Marking
    // it would add machinery to an already-solved problem and risk breaking that re-finalize.
    await this.client.updateBranchHead({ sha: mergeCommit, retry: true });
    this.recordConfirmedHead(mergeCommit); // SYNC2 §7.10 monotonic-head guard
    await this.client.deleteReference({
      ref: `heads/${cb.name}`,
      retry: true,
    });

    // One slot write: branch-clear + anchor advance land together
    // (today they could tear between clear and setLastSync).
    await this.hotMeta.update({
      conflictBranch: null,
      lastSyncCommitSha: mergeCommit,
      lastSyncTreeSha: mainTreeSha,
    });
    this.logger.info("Sync2 conflict-branch finalized", {
      branch: cb.name,
      mergeCommit,
    });
  }

  // Write text content to disk in canonical form (LF, no BOM,
  // trailing-NL iff non-empty) when autoCanonicalize is on. Returns
  // the on-disk SHA so the caller can recordSync against the actual
  // bytes, plus a `changed` flag indicating whether normalization
  // mutated the input — callers use that to decide whether the next
  // findChanges should treat the file as modified (republish).
  //
  // When autoCanonicalize is off, no normalization happens: the input
  // bytes are written verbatim, the returned `changed` is always false,
  // and the SHA is computed against the raw bytes.
  private async writeRemoteText(
    path: string,
    content: string,
    afterCommit?: () => Promise<void>,
  ): Promise<{ canonicalSha: string; changed: boolean }> {
    if (!hasTextExtension(path)) {
      // Routing guard: binary paths must never funnel through here
      // (would re-encode bytes via UTF-8 round-trip and corrupt them).
      throw new Error(
        `Sync2 internal: writeRemoteText called with non-text path ${path}`,
      );
    }
    // hasTextExtension is already guaranteed by the routing guard above; the remaining
    // decision is the setting AND the config-dir exclusion (this is the pull-side write
    // — it MUST match the push-side path set in shouldCanonicalize, or a config file
    // would oscillate between canonical (one side) and raw (the other) forever).
    const canonicalize =
      this.autoCanonicalize() && shouldCanonicalize(path, this.configDir);
    const { content: canonical, changed } = canonicalize
      ? normalizeText(content)
      : { content, changed: false };
    await this.ensureParentDir(path);
    const bytes = new TextEncoder().encode(canonical).buffer as ArrayBuffer;
    // 2.0.2-beta2: OUR plugin's recoverable text files
    // (manifest.json, styles.css) take the marker-based protocol
    // alongside main.js. See writeBinaryRemote.
    if (
      isOwnPluginRecoverableFile(path, this.configDir, this.selfPluginId)
    ) {
      await this.applySelfUpdateOwnFile(path, bytes, afterCommit);
      const canonicalSha = await this.workerClient.computeGitBlobSHA(bytes);
      return { canonicalSha, changed };
    }
    // Atomic-with-backup. See writeBinaryRemote rationale.
    await atomicWriteFile(this.vault, path, bytes, afterCommit);
    this.maybeMarkPluginAffected(path);
    const canonicalSha = await this.workerClient.computeGitBlobSHA(bytes);
    return { canonicalSha, changed };
  }

  // Fetch the remote text blob, run it through the same canonicalize
  // logic writeRemoteText would apply, and compare its git-blob SHA to
  // the local file's SHA. Used by adoption resume to recognize files
  // that the previous (interrupted) bootstrap already wrote out in
  // canonical form but didn't get to recordSync. Adds one getBlob per
  // candidate path during adoption only — the post-adoption fast path
  // (pullIfNeeded) never reaches this code.
  private async canonicalMatchesLocal(
    filePath: string,
    remoteSha: string,
    localSha: string,
  ): Promise<boolean> {
    try {
      const blob = await this.client.getBlob({ sha: remoteSha, retry: true });
      const remoteText = decodeBase64String(blob.content);
      const { content: canonical } = normalizeText(remoteText);
      const canonicalBytes = new TextEncoder().encode(canonical)
        .buffer as ArrayBuffer;
      const canonicalSha = await this.workerClient.computeGitBlobSHA(canonicalBytes);
      return localSha === canonicalSha;
    } catch {
      // Fail closed: if we can't fetch / decode the blob, fall through
      // to the mtime branch — same behavior as before the resume hint.
      return false;
    }
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = filePath.substring(0, slash);
    if (await this.vault.adapter.exists(parent)) return;
    const parts = parent.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }

  // Either enqueue a fresh batch or fold into the latest pending one,
  // depending on the accumulate-offline-syncs setting and whether
  // there's already a non-in-progress batch waiting. mergeIntoLatest
  // returns null when no candidate exists; we then create a new one.
  //
  // Pseudo-merge note: paths currently in the ConflictStore are NOT
  // filtered here — processBatch's split-push partition (see below)
  // routes them to the conflict branch instead of main. The user's
  // edits to an in-conflict file thus accumulate as commits on the
  // branch, and never leak to main until the conflict resolves.
  // Returns the number of distinct file paths actually enqueued.
  // Callers use this to drive the local-phase user feedback Notice
  // ("Commit N files").
  private async enqueueOrMerge(
    changes: import("./types").FileChange[],
    meta: EnqueueMeta,
  ): Promise<number> {
    if (changes.length === 0) return 0;
    // Pseudo-merge stage 7c: in-conflict paths are NOT filtered here
    // anymore. Edits to a file that's currently in conflict flow
    // through to processBatch's split-push partition step, where
    // they're routed to the per-device conflict branch on GitHub
    // (not main). The conflict's local "ours" history accumulates
    // server-side, invisible to other devices until resolution.
    if (this.consolidateCommits) {
      const target = await this.queue.mergeIntoLatestPending(changes);
      if (target !== null) {
        // Commit messages are hardcoded, so accumulate-merge does
        // not need a "template re-render" — the existing batch's
        // derived message stays correct.
        return changes.length;
      }
    }
    await this.queue.enqueue(changes, meta);
    return changes.length;
  }

  private fullSyncMeta(): EnqueueMeta {
    return {
      // commitMessage is not persisted; processBatch derives
      // `sync ({deviceLabel})` from batch.synthetic + the current
      // setting at push time.
      parentCommitSha: this.hotMeta.getLastSyncCommitSha(),
      parentTreeSha: this.hotMeta.getLastSyncTreeSha(),
    };
  }

  // Drain runner — the network worker. Each iteration:
  //   1. pullIfNeeded — apply remote-driven changes to the vault for
  //      paths NOT already in the queue. For paths that ARE in the
  //      queue (overlap), pull defers — push-side reconcile resolves
  //      them against the batch's snapshot.
  //   2. queue.list. Empty → exit.
  //   3. processBatch(oldest) — push, with reconcile if remote moved.
  //   4. Loop. Picks up new batches that the user enqueued mid-drain.
  //
  // Pull runs BEFORE every push so each batch lands on the freshest
  // possible HEAD; even if the previous batch advanced HEAD itself,
  // the next iteration's pull re-syncs against that.
  //
  // Re-entry guard: in-memory `running` flag serializes concurrent
  // drain() calls. A click while drain is active becomes no-op here,
  // but the click's enqueueOrMerge upstream already added the new
  // batch to disk, which the active drain picks up on its next list().
  //
  // Stops on the first failure so the user sees the error notice and
  // can retry; remaining batches stay on disk for the next trigger
  // (next click, next interval tick, next onload).
  private async drain(
    sharedProgress: ProgressHandle | null = null,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    // R3.5 layer 2 anchor — capture inside the re-entrant guard so
    // skipped invocations (interval tick during a user click) don't
    // burn their own timestamp. One drain cycle = one drain.startedAt.
    const drainStartedAt = newBatchId(new Date());
    let drainSucceeded = false;
    // Stage 7: clear any leftover abort signal and announce that the
    // drain has begun. Settings tab's "GitHub sync status" section
    // observes this to flip the timer on + show [Stop sync].
    this.abortRequested = false;
    this.emitDrainStatus({
      state: "running",
      startedAt: Date.now(),
      currentPath: null,
      totalFiles: 0,
      currentFile: 0,
    });
    // 2.0.2-beta2 log marker — bookends the entire drain cycle so a
    // reader can grep `"Sync started"` and `"Sync done"` to see
    // exactly when the cycle began and ended. The HTTP-level lines
    // alone left the cycle boundary implicit; the user had no
    // accurate "is it safe to click again?" signal from the log.
    this.logger.info("Sync started", {
      startedAt: drainStartedAt,
    });
    const ownProgress = sharedProgress === null;
    let progress: ProgressHandle | null = sharedProgress;
    let commitNum = 0;
    try {
      // First-ever sync against this remote needs the bootstrap probe
      // BEFORE pullIfNeeded — adoption resolves identical/local-only/
      // remote-only/diverging files, sets lastSyncCommitSha. Click
      // paths (syncAll/syncFile) already call this in their body, but
      // background entry points (onload's resumeQueue, interval-tick
      // backgroundDrain) reach drain directly without going through
      // the click body — they MUST bootstrap here or fresh devices
      // would silently no-op forever.
      // bootstrapIfNeeded short-circuits in O(1) when
      // lastSyncCommitSha !== null, so the click-path callers pay
      // nothing for this defensive call.
      // Drain-start sweep — the ONLY point of state mutation for
      // conflict resolution. See docs/PSEUDO-MERGE-MODE.md §5 for
      // the layer separation: ConflictWatcher is counter-only
      // (read-only), drain owns all store mutations.
      //
      // Guard: skip sweep when no records exist (90% of drains keep
      // drain latency at parity with the no-conflict baseline). Also
      // skip when a wired ConflictCounter reports no sweep-relevant
      // vault events since the last drain (idle drain). When the
      // counter isn't wired, default to "always sweep if records
      // exist" semantics.
      const recordsExist =
        this.conflictStore !== undefined &&
        this.conflictStore.getAll().length > 0;
      const sweepRequested =
        this.conflictCounter !== undefined
          ? this.conflictCounter.consumeSweepRequest()
          : true;
      if (recordsExist && sweepRequested) {
        const evalResult = await evaluateConflictState(
          this.conflictStore!,
          this.vault,
          this.now,
        );
        // Phase B side-batch synthesis. For each path the classifier
        // closed (all records gone), synthesize a side-batch that
        // propagates the live vault state to main as an explicit
        // `resolve conflict ({deviceLabel})` commit. The synthetic
        // batch flows through the regular queue.list() loop below,
        // gets `meta.synthetic=true`, and skips mergeIntoLatestPending
        // so user edits never fold into it. See
        // docs/PSEUDO-MERGE-MODE.md §10 Scenario E.
        //
        // Dedup against user batches: if the user already has a
        // pending batch covering the closed path, the user batch's
        // content takes precedence — skipping synthesis here avoids
        // pushing the same bytes twice. processBatch's no-op-tree-skip
        // would silently drop the duplicate commit anyway, but
        // skipping at this layer keeps the queue cleaner.
        if (evalResult.pathsResolved.size > 0) {
          await this.synthesizeResolutionSideBatches(evalResult.pathsResolved);
        }
      }

      await this.bootstrapIfNeeded(progress);
      let pushedAnyBatch = false;
      let finalizeAttempted = false;
      // 2.0.2-beta2 outer loop: tail re-check window.
      // SYNC2 §2.8 Tail Re-Check Window — full spec
      // including the cooperating 300ms commit-to-drain delay
      // inside syncAll() and the "every committed batch is
      // eventually drained" invariant.
      //
      // After the inner per-batch loop exits (queue empty), wait
      // ~50 ms and re-list. A late-arriving batch (e.g., a
      // `commit` triggered 300 ms before the syncAll dispatch, or
      // a different drain entry point landing a batch as we were
      // finishing) may have been written to disk after our last
      // `queue.list()` inside the inner loop. The 50 ms wait is
      // enough for any in-flight FS write to be observable. If
      // new batches show up, the outer loop runs again and the
      // inner loop drains them. The explicit log line is
      // intentional — it makes "we caught a late arrival"
      // greppable from the field.
      while (true) {
        // SYNC2 §2.8 — CHAIN successive batches on our OWN known head instead of re-reading
        // it before each. Right after a push, GitHub's ref read is eventually-consistent and
        // can return a STALE (behind) head; in a multi-batch drain that made processBatch
        // reconcile our own just-pushed commits as if the remote diverged → 422 "not a fast
        // forward" / "own data came back as a conflict" (single device, no other machine).
        // processBatch records the new head in the snapshot; we thread that DETERMINISTIC
        // value into the next batch's headHint. pullIfNeeded (which reads the head) runs only
        // for the FIRST batch — or after a 422 forces a fresh reconcile (see the retry below).
        let chainedHead: string | null = null;
        while (true) {
          const headHint = chainedHead ?? (await this.pullIfNeeded(progress));
          const ids = await this.queue.list();
          if (ids.length === 0) break;
          commitNum += 1;
          // Progress notice (heavy batches only). The long-lived notice
          // opens LAZILY on the first per-file tick inside processBatch
          // — not pre-opened here — so the user's first glimpse is
          // "Pushing 1/N" (never a "0/N" that reads as "nothing
          // happened"), shown BEFORE that file ships and held for
          // exactly its upload. `ensurePushProgress` closes over the
          // drain-loop `progress`, so the handle it opens is the one the
          // "Sync done" finale hides; gated on isHeavyPush so light
          // batches stay silent. Once any batch has opened it, later
          // (even light) batches keep ticking the same notice. SYNC2 §4.5.
          const batchBytes = await this.estimateBatchBytes(ids[0]);
          const isHeavyPush = batchBytes > this.progressBytesThreshold;
          const ensurePushProgress = (msg: string): void => {
            if (progress) {
              progress.update(msg);
            } else if (isHeavyPush && this.onProgress) {
              progress = this.onProgress(msg);
            }
          };
          // Fallback for a genuine head move (concurrent multi-device push, or the chained
          // head somehow diverged): a not-fast-forward 422 → drop the chained head, force a
          // FRESH head read + reconcile, and re-push. Bounded; a short backoff lets GitHub's
          // ref replica catch up before the fresh read. With chaining above, the FIRST attempt
          // already builds on our own known head, so this rarely fires.
          let realPushHappened = false;
          for (let attempt = 0; ; attempt++) {
            try {
              realPushHappened = await this.processBatch(
                ids[0],
                attempt === 0 ? headHint : null, // retry → null forces processBatch's own fresh GET
                ensurePushProgress,
                commitNum,
                commitNum + ids.length - 1,
              );
              break;
            } catch (err) {
              const status = (err as { status?: number }).status;
              if (status === 422 && attempt < REF_STALE_MAX_RETRIES) {
                chainedHead = null; // the chained head is suspect → re-read fresh next time
                this.logger.info(
                  "Sync2 push 422 (not-fast-forward / stale ref) — fresh head + retry",
                  { batchId: ids[0], attempt: attempt + 1 },
                );
                await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
                continue;
              }
              throw err;
            }
          }
          // SYNC2 §7.10 chaining fix (2026-08-29, field bug bisected to 3a98c96 — G3/G4/D6/D8/
          // branch-lifecycle/edit-while-in-conflict/multi-copy-pair-resolution/defer-then-
          // resolve-via-sibling-delete). CHAIN only when a REAL commit landed: the next batch
          // then correctly builds on the head WE just recorded (processBatch's setLastSync) —
          // never a fresh re-read that could be replica-lag stale. But when the batch emptied
          // out WITHOUT a push (every path reconciled into a conflict, or dropped as stale),
          // `getLastSyncCommitSha()` is UNCHANGED — chaining on it would silently skip the next
          // iteration's pullIfNeeded() call. That call is not optional bookkeeping: its own
          // post-loop logic ("no overlap — safe to advance lastSync") is what promotes
          // lastSyncCommitSha to the live head EVEN when the per-file outcome was a
          // register-conflict, not a clean apply — without it, lastSyncCommitSha stays stuck at
          // the PRE-conflict commit forever, and every later edit to the same path re-derives
          // the SAME stale conflict against the SAME stale base, even after the user resolves
          // it. Forcing chainedHead=null here restores that call on the very next iteration.
          chainedHead = realPushHappened
            ? this.hotMeta.getLastSyncCommitSha()
            : null;
          pushedAnyBatch = true;
        }
        // 2.0.2-beta2 tail re-check. See outer-loop comment above.
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        const tailCheckIds = await this.queue.list();
        if (tailCheckIds.length === 0) break;
        this.logger.info(
          "Sync drain tail re-check found new batches; restarting",
          { newBatchCount: tailCheckIds.length },
        );
      }
      // No drain-end sweep. Listeners are read-only, so state that
      // changed DURING drain (sibling writes from our own conflict
      // registration, user mid-drain edits) is picked up at the
      // start of the NEXT drain — an accepted latency trade-off for
      // the single-mutation-point model in §5 of the spec.
      //
      // Conflict-branch finalize hook. Runs
      // once per drain when the queue is empty: if the active
      // conflict-branch state holds AND every record in the
      // ConflictStore has been resolved, merge the branch back into
      // main and deleteRef. Idempotent on "nothing to do" inputs;
      // the `finalizeAttempted` guard just keeps the log line tidy.
      if (!finalizeAttempted) {
        finalizeAttempted = true;
        await this.finalizeConflictBranchIfReady();
      }
      // Drain finished cleanly with an empty queue. Show "Sync done":
      //   - reuse the long-lived handle if we opened one (heavy phase)
      //   - otherwise, briefly flash a new one only if SOMETHING
      //     actually moved (a pull applied remote changes, OR we
      //     pushed at least one batch). True no-op drains (no remote
      //     changes, no pending queue) stay silent.
      // When the pull side touched local files (writes from remote,
      // canonicalisations, sibling files for deferred conflicts), the
      // message is padded with "(updated N files)" so the user knows
      // their vault changed. Push-only syncs use the plain "Sync done"
      // — the user already saw "Commit N files" at click time and
      // their vault didn't get modified by sync. Counter resets at the
      // start of EVERY drain (pulledFilesThisSync; 2.0.2-beta2 bug
      // fix) so the count is always for THIS drain cycle.
      //
      // 2.0.2-beta2: "Sync done" ALWAYS shows now, regardless of
      // whether the drain pushed or pulled. The previous rule
      // ("suppress on no-op") was confusing — the user lost the
      // explicit signal that "it's safe to click again." The suffix
      // "(N files updated from GitHub)" is still gated on actually
      // having pulled at least one file — and pulledFilesThisSync
      // counts only confirmed writes to disk, not paths "considered".
      const doneMessage =
        this.pulledFilesThisSync > 0
          ? this.pulledFilesThisSync === 1
            ? "Sync done (1 file updated from GitHub)"
            : `Sync done (${this.pulledFilesThisSync} files updated from GitHub)`
          : "Sync done";
      if (ownProgress && progress) {
        progress.update(doneMessage);
        const handle = progress;
        setTimeout(() => handle.hide(), 1000);
      } else if (ownProgress && this.onProgress) {
        // 2.0.2-beta2: drainDidWork gate removed — always emit
        // "Sync done" so the user has an unambiguous signal.
        const handle = this.onProgress(doneMessage);
        setTimeout(() => handle.hide(), 1000);
      }
      // 2.0.2-beta2 log marker — counterpart of the "Sync started"
      // line at the top of drain. Note the timestamp: this fires
      // AFTER processBatch + trash-sweep, so a reader can trust
      // "Sync done" to mark when ALL drain side-effects are
      // observable on disk + remote. (The setTimeout above only
      // hides the toast; the actual work is complete here.)
      this.logger.info("Sync done", {
        startedAt: drainStartedAt,
        pulledFiles: this.pulledFilesThisSync,
        pushedAnyBatch,
      });
      // Drain reached the end of the try block without throwing — queue
      // is empty, finalize ran. Anything reachable here is a success.
      drainSucceeded = true;
    } finally {
      // R3.5 layer 2 — drain-end backstop sweep. ONLY runs on full
      // success (queue empty + no exception). Best-effort: a sweep
      // failure is logged and doesn't break the drain semantics that
      // already succeeded by this point.
      if (drainSucceeded && this.trashHooks) {
        try {
          await this.trashHooks.sweepOlderThan(drainStartedAt);
        } catch (err) {
          this.logger.warn("Sync2 drain: trash sweep failed", {
            err: `${err}`,
          });
        }
      }
      this.running = false;
      // Stage 7: announce drain end. Settings tab flips the timer
      // back to "Last sync: …" and removes the [Stop drain] button.
      this.emitDrainStatus({
        state: "idle",
        startedAt: null,
        currentPath: null,
        totalFiles: 0,
        currentFile: 0,
      });
      this.abortRequested = false;
      // 2.0.2-beta2: fire plugin-affected callback. ONLY on full
      // drain success (failed drain leaves the set populated; the
      // next drain accumulates more IDs and fires once the cycle
      // completes). This avoids "plugin reloaded mid-failure" UX.
      if (drainSucceeded && this.affectedPluginIds.size > 0) {
        const ids = Array.from(this.affectedPluginIds);
        this.affectedPluginIds.clear();
        try {
          this.onPluginsAffected?.(ids);
        } catch (err) {
          this.logger.warn(
            "Sync2 drain: onPluginsAffected callback threw",
            { err: `${err}`, ids },
          );
        }
      }
      // No listener resume — ConflictWatcher is read-only and was
      // never paused. Drain doesn't own listener lifecycle.
    }
  }

  // 2.0.2-beta2 zero-byte restore guard (SYNC2 §2.9). For each
  // add/modify path in batch `id`, detect the "accidental deletion"
  // signature: the committed copy is 0 bytes, yet the last-synced
  // snapshot recorded a NON-zero size. A 0-length file is
  // indistinguishable from an accidental truncation/corruption — and
  // semantically it looks like the file was deleted — so we treat it
  // as an un-delete: restore the last good version and drop the empty
  // copy from the push.
  //
  // Decision is ZERO-network (frozen size + snapshot.size). Only the
  // restore ACTION fetches bytes, and only for the rare collapse.
  //
  // Carve-outs (let the empty file through):
  //   - no snapshot entry  → brand-new file the user just created
  //   - snapshot.size === 0 → file was already empty last sync
  private async applyZeroByteRestoreGuard(id: string): Promise<void> {
    let batch: QueueBatch;
    try {
      batch = await this.queue.read(id);
    } catch {
      return; // unreadable batch — let normal processing surface it
    }
    for (const path of batch.files) {
      let oursSize: number | null;
      try {
        oursSize = await this.queue.fileSize(id, path);
      } catch {
        continue;
      }
      if (oursSize === null || oursSize !== 0) continue; // not zeroed
      const snap = await this.baselines.get(path);
      if (!snap || snap.size === 0) continue; // brand-new OR was-empty
      // Zero-collapse confirmed — restore from the last good version.
      let restored: { bytes: ArrayBuffer; source: string } | null = null;
      try {
        restored = await this.findLastGoodVersion(path, id, snap.baselineSha);
      } catch (err) {
        this.logger.warn("Sync2 zero-byte restore: lookup failed", {
          path,
          err: `${err}`,
        });
      }
      if (!restored) {
        // Neither the queue nor GitHub yielded bytes (e.g. the blob
        // was GC'd and no pending batch holds a copy). Leave the path
        // in the batch — pushing the 0-byte version is the lesser
        // evil to losing the user's deletion intent if it WAS
        // intentional. Surface it loudly so the user can react.
        this.logger.warn(
          "Sync2 zero-byte restore: no good version found, leaving as-is",
          { path, previousSize: snap.size },
        );
        continue;
      }
      try {
        await atomicWriteFile(this.vault, path, restored.bytes);
        await this.queue.removeFile(id, path);
      } catch (err) {
        this.logger.error("Sync2 zero-byte restore: apply failed", {
          path,
          err: `${err}`,
        });
        continue;
      }
      // No snapshot mutation: the next findChanges re-classifies the
      // restored file. If restored === remote (GitHub source) it's a
      // cache hit → no re-push; if restored === a newer queued good
      // version (queue source) it re-enqueues → the good version
      // pushes next drain. Both converge correctly.
      this.onZeroByteRestored?.(path);
      this.logger.info("Sync2 zero-byte restore applied", {
        path,
        previousSize: snap.size,
        restoredSize: restored.bytes.byteLength,
        source: restored.source,
      });
    }
  }

  // 2.0.2-beta2: find the last available NON-zero version of `path` to
  // restore over an accidental 0-byte collapse (SYNC2 §2.9). Search
  // order:
  //   1. All pending push-queue batches, newest-first (excluding the
  //      batch being drained). The freshest non-zero frozen copy wins
  //      — if the user zeroed then re-typed in a later batch, that
  //      later good version is the one to keep.
  //   2. GitHub, via the snapshot's remoteSha (the last-synced
  //      content). Fetched by SHA so it's exactly the pre-collapse
  //      bytes regardless of where HEAD has moved.
  // Returns null if no non-zero version exists anywhere.
  private async findLastGoodVersion(
    path: string,
    excludeBatchId: string,
    snapshotRemoteSha: string,
  ): Promise<{ bytes: ArrayBuffer; source: string } | null> {
    const ids = (await this.queue.list())
      .filter((qid) => qid !== excludeBatchId)
      .reverse(); // list() is oldest-first; newest-first here
    for (const qid of ids) {
      let size: number | null;
      try {
        size = await this.queue.fileSize(qid, path);
      } catch {
        continue;
      }
      if (size !== null && size > 0) {
        const bytes = await this.queue.readFile(qid, path);
        return { bytes, source: `queue:${qid}` };
      }
    }
    // Fall back to GitHub by the last-synced blob SHA.
    const blob = await this.client.getBlob({
      sha: snapshotRemoteSha,
      retry: true,
    });
    const bytes = await this.workerClient.decodeBase64(blob.content);
    return { bytes, source: `github:${snapshotRemoteSha.slice(0, 7)}` };
  }

  // 2.0.2-beta2 git-author identity (SYNC2.md §4.4). Builds the
  // {name, email, date} object for createCommit when the user has
  // configured both a git author name and email; returns undefined
  // otherwise (no override → GitHub uses the token user + push time).
  // `whenMs` is the local commit moment (batch.createdAt for batch
  // commits, this.now() for live engine commits) — the same value
  // the message timestamp uses, so message and git date agree.
  private commitAuthorFor(
    whenMs: number,
  ): { name: string; email: string; date: string } | undefined {
    const id = this.gitAuthor();
    if (id === null) return undefined;
    return { name: id.name, email: id.email, date: toGitAuthorDate(whenMs) };
  }

  private async processBatch(
    id: string,
    headHint: string | null = null,
    // Lazy-opening progress sink. Called pre-op once per file with the
    // message to show; opens the notice on first call (heavy only) and
    // updates it after. Default no-op for callers without a UI. SYNC2 §4.5.
    ensurePushProgress: (msg: string) => void = () => {},
    commitNum: number = 1,
    commitTotal: number = 1,
    // Returns whether a REAL commit landed on main (true) vs the batch
    // emptied out with nothing left to push — e.g. every path got
    // reconciled into a conflict, or dropped as a stale duplicate (false).
    // SYNC2 §7.10 chaining fix (2026-08-29, field bug bisected to
    // 3a98c96): the caller's `chainedHead` optimization must NOT be
    // trusted after a `false` return — see drain()'s call site.
  ): Promise<boolean> {
    this.logger.info(`Sync2 push batch ${id}`);
    await this.queue.markInProgress(id);
    // 2.0.2-beta2 zero-byte restore guard (SYNC2 §2.9). BEFORE the
    // batch's bytes reach GitHub, catch any file that collapsed to 0
    // bytes despite having a non-empty last-synced version — almost
    // always corruption, not intent. Restore the last good version
    // and drop the zeroed path from this batch so the 0-byte version
    // never lands on the server. Runs first so the reconcile + tree
    // build below never sees the corrupted path.
    await this.applyZeroByteRestoreGuard(id);
    // Freeze this batch against further merges. The marker survives a
    // failure (in-progress is cleared in the catch below, attempted is
    // not), so a follow-up sync click can't accumulate new changes
    // into a batch we already tried to push. See PushQueue.markAttempted.
    await this.queue.markAttempted(id);
    try {
      // Four states for the head before push:
      //   1. expectedHead = null, currentHead = null → bare repo.
      //      Seed via Contents API (<vault>/.gitignore — guaranteed
      //      by invariants.enforce()), then build the batch on top.
      //   2. expectedHead = null, currentHead set → first sync on
      //      this device against an existing line of history. No
      //      snapshot to 3-way against; re-target the batch onto
      //      currentHead and let local files land on top. Server-
      //      side contents we don't carry are preserved through
      //      base_tree.
      //   3. expectedHead set, currentHead matches → fast path.
      //   4. expectedHead set, currentHead drifted → reconcile + re-target.
      let currentHead: string | null;
      if (headHint !== null) {
        currentHead = headHint;
      } else {
        try {
          currentHead = await this.getGuardedHead();
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 404 || status === 409) currentHead = null;
          else throw err;
        }
      }
      const expectedHead = this.hotMeta.getLastSyncCommitSha();
      if (expectedHead === null && currentHead === null) {
        // Case 1: bare repo. Seed turns the repo into a non-bare
        // one-commit state and rewrites the batch's parent SHAs so
        // the rest of processBatch builds on top of the seed.
        await this.seedBareRepo(id);
      } else if (expectedHead === null && currentHead !== null) {
        // Case 2.
        const headCommit = await this.client.getCommit({
          sha: currentHead,
          retry: true,
        });
        await this.queue.updateMeta(id, {
          parentCommitSha: currentHead,
          parentTreeSha: headCommit.tree.sha,
        });
      } else if (
        expectedHead !== null &&
        currentHead !== null &&
        currentHead !== expectedHead
      ) {
        // Case 4.
        await this.reconcileBatchAgainstHead(id, expectedHead, currentHead);
      } else if (currentHead !== null) {
        // Case 3 (expectedHead set + currentHead matches), but the
        // batch's recorded parent may be stale: if an earlier batch
        // in this same drain already committed, this
        // batch's parentCommitSha now lags behind reality. Without
        // a re-target, createCommit would build on the stale parent
        // and updateBranchHead would reject the non-fast-forward
        // with 422. Re-fetching head's tree is cheap (one GET) and
        // keeps the rest of the flow building on the right base.
        const peek = await this.queue.read(id);
        if (peek.parentCommitSha !== currentHead) {
          const headCommit = await this.client.getCommit({
            sha: currentHead,
            retry: true,
          });
          await this.queue.updateMeta(id, {
            parentCommitSha: currentHead,
            parentTreeSha: headCommit.tree.sha,
          });
        }
      }

      // Split-push partition. See docs/PSEUDO-MERGE-MODE.md §8
      // (edit-while-in-conflict).
      //
      // After reconcile / case-3 re-target settles, walk the batch
      // looking for paths that are now in the ConflictStore — they
      // were filtered into a conflict during a prior drain (then the
      // user edited them locally, which findChanges re-detected and
      // enqueueOrMerge accepted without filtering now that
      // dropPendingConflictPaths is gone). These conflict paths get
      // pushed to the per-device conflict branch instead of main:
      // the user's edits land on GitHub but stay invisible to other
      // devices until the conflict is resolved.
      //
      // We push them as a single multi-path commit via the same
      // helper that conflict registration uses, then drop the paths
      // from the batch so the main-side tree build below sees only
      // plain paths.
      if (this.conflictStore) {
        const peek = await this.queue.read(id);
        const conflictPaths = peek.files.filter((p) =>
          this.conflictStore!.hasPending(p),
        );
        if (conflictPaths.length > 0) {
          const branchEntries: Array<{
            path: string;
            content: ArrayBuffer | null;
          }> = [];
          for (const p of conflictPaths) {
            const bytes = await this.queue.readFile(id, p);
            branchEntries.push({ path: p, content: bytes });
          }
          await this.pushConflictPathsToBranch(
            branchEntries,
            // Same hardcoded `conflict ({deviceLabel})` as the
            // initial registration commit. The branch log shows a
            // uniform sequence of conflict commits with no
            // per-commit metadata in the message itself.
            formatConflictMessage(this.deviceLabel(), this.now()),
          );
          for (const p of conflictPaths) {
            await this.queue.removeFile(id, p);
          }
          this.logger.info(
            "Sync2 split-push: routed edit-while-in-conflict paths to branch",
            { paths: conflictPaths },
          );
        }
      }

      const { entries: rawEntries, baseTreeSha, batch } =
        await this.builder.buildTreeEntries(id, {
          // Pre-op per-file tick. `ensurePushProgress` lazy-opens the
          // notice on its first call (heavy batches only) and updates it
          // thereafter — so "Pushing P/N" appears BEFORE file P ships
          // and holds for exactly its upload. A single file reads
          // "Pushing 1 file to GitHub…" (no meaningless "1/1"). SYNC2 §4.5.
          onFileProcessed: (done, total) => {
            ensurePushProgress(
              total === 1
                ? "Pushing 1 file to GitHub…"
                : `Pushing ${done}/${total} files to GitHub`,
            );
          },
        });

      // Inject pending-deletions queue contents as additional deletion
      // entries (SYNC2 §4.2). Each queue entry was added
      // by pull-side sanitize to record the intent "delete this
      // forbidden GitHub path on the next push." Injection happens at
      // push-time (not enqueue-time) so the queue can accept new
      // entries between batch creation and push without losing them.
      //
      // Dedup: skip paths already present in batch.files (a paradoxical
      // case — the user is editing the same path the queue wants
      // deleted; the user's intent wins, the queue entry is dropped
      // as obsolete) or already in batch.deletions (no need to
      // duplicate the sha:null entry; whichever source wrote it is
      // fine).
      const injectedFromQueue: string[] = [];
      const entriesWithInjection = [...rawEntries];
      if (this.pendingDeletions) {
        const existingPaths = new Set(
          rawEntries.map((e) => e.path),
        );
        const conflictingFilePaths = new Set(batch.files);
        for (const pending of this.pendingDeletions.getAll()) {
          if (
            existingPaths.has(pending.path) ||
            conflictingFilePaths.has(pending.path)
          ) {
            continue;
          }
          entriesWithInjection.push({
            path: pending.path,
            mode: "100644",
            type: "blob",
            sha: null,
          });
          injectedFromQueue.push(pending.path);
        }
      }

      // Pre-flight validation of deletion entries
      // (SYNC2 §4.1). For each entry with `sha: null` (a
      // deletion), confirm the path still exists at currentHead. If
      // it doesn't, the deletion is stale (another device or a manual
      // GitHub Web action removed it between when our batch was
      // constructed and now) — sending it would draw a 422
      // GitRPC::BadObjectState. Drop the entry AND the matching
      // snapshot row, so the next ChangeDetector pass doesn't re-emit
      // the same stale deletion. Also drops the matching
      // pending-deletions queue entry for paths injected above.
      //
      // Validator network failure (per §7.1): if `getContentsAtRef`
      // itself errors, `validateDeletionsAgainstHead` throws and
      // processBatch aborts. The queued batch is preserved on disk;
      // the next drain retries. This is intentional — pre-flight
      // validation is a safety net, and we'd rather defer one push
      // than silently reintroduce the 422 we're trying to prevent.
      const entries =
        currentHead === null
          ? entriesWithInjection
          : await this.validateDeletionsAgainstHead(
              entriesWithInjection,
              currentHead,
            );

      // Empty batch: reconcile may have deferred every path via
      // ConflictStore, pre-flight validation may have dropped every
      // deletion entry as stale, or both. Skip createTree/Commit
      // entirely and delete the batch so the drain loop moves on.
      // (Both `entries.length === 0` and `batch.deletions.length === 0`
      // before this fix were a defensive belt-and-braces — entries
      // always contained the deletions, so the first check was
      // sufficient. Post-validation, only `entries.length` is
      // authoritative, since dropped deletions still appear in
      // `batch.deletions` until the next ChangeDetector pass.)
      if (entries.length === 0) {
        this.logger.info(
          `Sync2 push batch ${id}: empty after reconcile + pre-flight validation, skipping`,
        );
        await this.queue.delete(id);
        await this.fireQueueDepth();  // §3.6
        // skip-class: already-correct (nothing left to push — every
        // entry was either reconciled out of the batch or dropped as
        // stale by pre-flight validation; the queue entry is deleted
        // so the drain loop moves on to the next batch)
        // SYNC2 §7.10 chaining fix: false — no real push happened, so
        // drain()'s chainedHead must NOT be trusted for the next
        // iteration (see the long comment on this function's signature).
        return false;
      }

      // After all blobs settled, the work shifts to createTree +
      // createCommit + updateBranchHead. ~1-2 seconds; the notice
      // keeps the last "Push N/N files to GitHub" text until the
      // drain-level "Sync done" finale replaces it. No
      // intermediate phase label — the user gets one consistent
      // message per drain.

      // Build path → blob SHA map for snapshot updates after success.
      // Text entries have inline content but no SHA from buildTreeEntries
      // (createTree assigns the SHA server-side); we compute it locally
      // via git's blob-hash formula so we don't need a follow-up GET.
      const shaByPath = await this.computeShaByPath(entries);

      const newTreeSha = await this.client.createTree({
        tree: {
          tree: entries,
          base_tree: baseTreeSha ?? undefined,
        },
        retry: true,
      });
      // No-op tree change vs the parent: typically a bare-repo seed
      // already includes every path in the batch (e.g. empty vault →
      // only <vault>/.gitignore in the batch, which the seed itself
      // wrote). Skip the redundant empty commit — the parent IS the
      // synced state. Without this branch we'd land an empty commit
      // on top of the seed.
      let commitSha: string;
      if (
        baseTreeSha !== null &&
        newTreeSha === baseTreeSha &&
        batch.parentCommitSha !== null
      ) {
        commitSha = batch.parentCommitSha;
        this.logger.info(
          `Sync2 push batch ${id}: tree unchanged vs parent — reusing parent commit`,
          { commitSha, treeSha: newTreeSha },
        );
      } else {
        // Commit message derived inline from batch.synthetic +
        // current deviceLabel setting. No persisted commitMessage
        // on the batch.
        commitSha = await this.client.createCommit({
          // whenMs = the batch's LOCAL commit moment (createdAt), not
          // this.now() (which would be push time). Legacy batches with
          // createdAt === 0 fall back to the current time. The same
          // whenMs feeds the message timestamp AND the optional git
          // author date so they agree.
          message: commitMessageForBatch(
            batch.synthetic,
            this.deviceLabel(),
            batch.createdAt || this.now(),
          ),
          author: this.commitAuthorFor(batch.createdAt || this.now()),
          treeSha: newTreeSha,
          parent: batch.parentCommitSha ?? undefined,
          retry: true,
        });
        // SYNC2 §7.9 — mark the push in-flight BEFORE advancing the tracked branch. A crash
        // between this ref-advance and store.save() below leaves the remote ahead of the
        // snapshot; recoverPushInflight() heals it on the next drain. Cleared after persist.
        await writePushInflight(this.vault, this.selfPluginId, {
          newHead: commitSha,
          newTreeSha,
          batchId: id,
        });
        await this.client.updateBranchHead({
          sha: commitSha,
          retry: true,
        });
        this.recordConfirmedHead(commitSha); // SYNC2 §7.10 monotonic-head guard
      }

      // Update local state. recordSync re-stats the file so its mtime
      // is current; subsequent findChanges() short-circuits via the
      // stat-cache for these paths.
      // §2.2.1 — one grouped baseline write for the whole batch
      // instead of a bucket write per file.
      const recordEntries: Array<{ path: string; sha: string }> = [];
      for (const path of batch.files) {
        const sha = shaByPath.get(path);
        if (sha === undefined) {
          this.logger.warn(
            `Sync2 push: missing computed SHA for ${path} — skipping recordSync`,
          );
          continue;
        }
        recordEntries.push({ path, sha });
        // If the file we just pushed is one of the managed gitignores,
        // refresh the invariant cache too — otherwise the next sync
        // would see mtime drift, re-read, find the hash matches, and
        // burn an extra read+hash for nothing.
        if (this.invariants) {
          await this.invariants.notePathSelfWritten(path);
        }
      }
      await this.detector.recordSyncMany(recordEntries);
      await this.detector.recordDeletions(batch.deletions);
      // Pending-deletions queue cleanup (SYNC2 §4.2):
      // every queue entry whose path was just successfully deleted on
      // GitHub (or was injected from the queue into this batch and
      // didn't survive pre-flight validation) is no longer needed.
      // The store's remove() is idempotent — calling it on a path
      // that wasn't in the queue is a no-op, so we don't need to
      // distinguish "came from change-detector" from "came from
      // queue injection."
      if (this.pendingDeletions) {
        const cleanupPaths = new Set<string>([
          ...batch.deletions,
          ...injectedFromQueue,
        ]);
        for (const path of cleanupPaths) {
          await this.pendingDeletions.remove(path);
        }
      }
      await this.hotMeta.update({
        lastSyncCommitSha: commitSha,
        lastSyncTreeSha: newTreeSha,
        lastCommitMtime: this.now(),
      });
      // SYNC2 §7.9 — anchor persisted; the push→record window is closed.
      await clearPushInflight(this.vault, this.selfPluginId);

      await this.queue.delete(id);
      // SYNC2 §4.3: queue depth dropped after successful push.
      await this.fireQueueDepth();
      // R3.5 layers 1a + 1b — trash cleanup confirmation. Best-effort:
      // hook failure is logged and swallowed; the push itself already
      // succeeded, so we don't roll back. Drain's layer 2 sweep at end
      // catches anything 1a/1b miss.
      if (this.trashHooks) {
        try {
          if (batch.deletions.length > 0) {
            await this.trashHooks.confirmDeleted(batch.deletions);
          }
          if (batch.resolvesConflictForBasePath) {
            await this.trashHooks.confirmResolved(
              batch.resolvesConflictForBasePath,
            );
          }
        } catch (err) {
          this.logger.warn(`Sync2 push batch ${id} trash confirm failed`, {
            err: `${err}`,
          });
        }
      }
      this.logger.info(`Sync2 push batch ${id} succeeded`, {
        commitSha,
        treeSha: newTreeSha,
      });
      // SYNC2 §7.10 chaining fix: a real commit landed on main — the
      // caller's chainedHead optimization is sound for the next iteration.
      return true;
    } catch (err) {
      // Roll back the in-progress marker so a later resume can retry.
      await this.queue.clearInProgress(id);
      this.logger.error(`Sync2 push batch ${id} failed`, {
        error: String(err),
      });
      throw err;
    }
  }

  // Seed a bare repo with a single Contents API write of
  // <vault>/.gitignore — guaranteed to exist after
  // GitignoreInvariants.enforce() (run by syncAll before
  // drain). Git Data API endpoints return 409 "Git Repository
  // is empty" until the branch has at least one ref, so this is the
  // only way to bootstrap. After this call the branch has one commit
  // ("Init at {date} {time} (label)") and we rewrite the batch's
  // parent SHAs so the rest of processBatch builds on top of the
  // seed just like any Case 2/3 push.
  private async seedBareRepo(batchId: string): Promise<void> {
    const path = this.invariants?.rootPath ?? ".gitignore";
    const buf = await this.vault.adapter.readBinary(path);
    const content = arrayBufferToBase64(buf);
    const message = formatInitMessage(this.deviceLabel(), this.now());
    this.logger.info(`Sync2 seed bare repo`, { path, message });
    const seed = await this.client.createFile({
      path,
      content,
      message,
      retry: true,
    });
    await this.queue.updateMeta(batchId, {
      parentCommitSha: seed.commitSha,
      parentTreeSha: seed.treeSha,
    });
    await this.detector.recordSync(path, seed.blobSha);
    if (this.invariants) {
      await this.invariants.notePathSelfWritten(path);
    }
  }

  // Reconcile a batch's contents against a remote head that moved
  // past the batch's parent. For each path in the batch we run
  // `attemptAutoMerge` against (ours = batch snapshot, theirs =
  // currentHead, base = expectedHead). Clean merges silently
  // overwrite the batch snapshot; plugin-js gets atomic semver;
  // anything else routes through `registerConflictAndDropPath`
  // (sibling + ConflictStore + branch push).
  //
  // After reconcile, the batch's parent SHAs are rewritten so the next
  // step in processBatch builds the commit on top of currentHead. Any
  // later queued batches that touch the same paths are cascade-rebased
  // onto the resolved versions, so they don't push stale "ours".
  private async reconcileBatchAgainstHead(
    batchId: string,
    expectedHead: string,
    currentHead: string,
  ): Promise<void> {
    this.logger.info(`Sync2 reconcile batch ${batchId}`, {
      expectedHead,
      currentHead,
    });
    const batch = await this.queue.read(batchId);
    // Collect per-path resolved versions so we can cascade-rebase
    // later batches in a single pass instead of N×M loops. Records
    // ours-bytes (pre) and theirs-bytes (post) for each clean
    // auto-merge.
    const resolvedPerPath = new Map<
      string,
      { oldOurs: ArrayBuffer; newOurs: ArrayBuffer }
    >();

    // Snapshot the iteration list once so for-of stays immune to
    // in-loop mutations of `batch.files`. `batch.files` is then kept
    // canonical with disk state via splice on every drop site below,
    // so helper reads (readReconcilePluginResolveContext, etc.) that
    // consult `batch.files` see the same view the disk has.
    const toProcess = [...batch.files];
    const dropFromBatchInMemory = (path: string): void => {
      const idx = batch.files.indexOf(path);
      if (idx >= 0) batch.files.splice(idx, 1);
    };

    // Stage 7 progress: announce the path count so the Settings
    // page can render "N of M" for the current batch.
    this.emitDrainStatus({
      totalFiles: toProcess.length,
      currentFile: 0,
    });
    let fileIndex = 0;
    for (const path of toProcess) {
      fileIndex += 1;
      // Stage 7 cancel check. The flag flips at batch-file boundaries
      // (the next `await` past the yield below picks it up). A stuck
      // mid-file step won't see this — the per-file timeout (60 s,
      // Stage 2) is the deeper escape valve.
      if (this.abortRequested) {
        this.logger.info(
          "Sync2 reconcile path SKIP — cancellation requested",
          { path, fileIndex, total: toProcess.length },
        );
        break;
      }
      this.emitDrainStatus({ currentPath: path, currentFile: fileIndex });
      // Yield to the macrotask queue before each path so the JS
      // event loop gets a chance to process pending work between
      // files: UI repaint, Capacitor bridge callbacks, queued
      // vault.adapter.append writes from logger. Without this the
      // entire reconcile loop runs as a single uninterruptible
      // task — microtask-only awaits (the standard `await` chain)
      // don't drain the macrotask queue, so UI is frozen and
      // bridge work stalls until the whole batch finishes. The
      // `setTimeout(0)` explicitly hands control to the event
      // loop, which is the documented mechanism for cooperative
      // multitasking in single-threaded JS. See §0 P1 — "click
      // Sync, keep editing".
      //
      // Field-confirmed: in the base64 N-iter diagnostic harness
      // 15 chained ~15 ms decodes total ~225 ms — but with no
      // yields the UI froze for the entire ~225 ms because the
      // macrotask queue couldn't drain between iterations. Same
      // pattern applied to the reconcile loop here.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Per-path reconcile diagnostic probe. Fires ONLY when logging
      // is enabled (lazy lambda — never invoked in production). The
      // probe is here because the reconcile path is the most memory-
      // intensive surface in the engine: each iteration fetches ours-
      // and theirs- bytes for the SAME path (e.g. 168KB main.js × 2 =
      // 336KB held in JS strings), then decodes both to ArrayBuffer.
      // On mobile WebView with tight heap budgets, this is where
      // pressure-induced UI freezes have correlated empirically.
      // Probe captures the per-iteration entry point with the path
      // and (if available) memoryUsage snapshot.
      this.logger.info("Sync2 reconcile path enter", () => ({
        path,
        memUsage:
          typeof (globalThis as { process?: { memoryUsage?: () => unknown } })
            .process?.memoryUsage === "function"
            ? (globalThis as { process: { memoryUsage: () => unknown } })
                .process.memoryUsage()
            : null,
      }));

      // Read OURS first — the local side that's already on disk
      // in the queue snapshot. We read it before going to the
      // network for base+theirs because:
      //   (a) the read is cheap (~25 ms for 1.9 MB on phone via
      //       the fetch(getResourcePath) path);
      //   (b) most reconcile branches need ours bytes anyway, so
      //       we'd read it eventually;
      //   (c) reading first means the network fetches start with
      //       all of ours already in memory — no later wait when
      //       we hit the size-guard / convergence / merge
      //       branches.
      //
      // Cost: in the "no remote-side change" short-circuit
      // branch we'll have read ours unnecessarily, ~25 ms wasted.
      // Acceptable trade for the simpler ordering and consistent
      // memory profile across branches.
      const oursBytes = await this.queue.readFile(batchId, path);

      // Stage 5 SHA-first reconcile: fetch metadata (sha + size)
      // for base and theirs WITHOUT pulling down the blob bytes.
      // The decision tree below resolves ~75% of paths from SHAs
      // alone — no decode, no merge, no bytes round-trip — which
      // is the §0 P2 principle in practice. Only the rare
      // genuine-3-way-divergence case pays for the full content
      // fetch + base64 decode.
      const baseMeta = await this.safeFetchMetadata(path, expectedHead);
      const theirsMeta = await this.safeFetchMetadata(path, currentHead);

      // Branch 1 (existing): no remote-side change between base and
      // theirs → batch pushes through unchanged.
      if (
        baseMeta !== null &&
        theirsMeta !== null &&
        baseMeta.sha === theirsMeta.sha
      ) {
        this.logger.info(
          "Sync2 reconcile path SHA-first: no remote change (base.sha === theirs.sha)",
          () => ({ path, sha: baseMeta.sha }),
        );
        continue;
      }

      // Compute ours SHA now — needed for the remaining branches.
      // The CPU worker handles it off main thread for files above
      // the SHA threshold (~100 KB).
      const oursSha = await this.workerClient.computeGitBlobSHA(oursBytes);

      // Branch 2 (new): ours already byte-identical to theirs on
      // remote. Out-of-band sync (adb push, manual download, etc.)
      // is the most common cause. Drop from batch — no push, no
      // upload, no merge.
      if (theirsMeta !== null && oursSha === theirsMeta.sha) {
        await this.detector.recordSync(path, theirsMeta.sha);
        await this.queue.removeFile(batchId, path);
        dropFromBatchInMemory(path);
        this.logger.info(
          "Sync2 reconcile path SHA-first: ours already matches theirs (no upload)",
          () => ({ path, sha: theirsMeta.sha }),
        );
        continue;
      }

      // Branch 3 (new): ours unchanged vs base, but theirs has
      // moved forward → atomic theirs wins. We need theirs bytes
      // to write to the vault; base bytes never needed.
      if (
        baseMeta !== null &&
        theirsMeta !== null &&
        oursSha === baseMeta.sha
      ) {
        const theirsFetchedSolo = await this.safeFetchContents(
          path,
          currentHead,
        );
        if (theirsFetchedSolo !== null) {
          await this.writeBinaryRemote(path, theirsFetchedSolo.content);
          await this.detector.recordSync(path, theirsFetchedSolo.sha);
          await this.queue.removeFile(batchId, path);
          dropFromBatchInMemory(path);
          this.logger.info(
            "Sync2 reconcile path SHA-first: theirs wins (ours unchanged vs base)",
            () => ({
              path,
              oursSha,
              baseSha: baseMeta.sha,
              theirsSha: theirsMeta.sha,
            }),
          );
          continue;
        }
        // Fall through to full path if theirs fetch failed (rare).
      }

      // Branch 4: all three SHAs differ → genuine 3-way divergence.
      // Fall through to the full content-fetch + decode + merge path
      // below.
      const baseFetched = await this.safeFetchContents(path, expectedHead);
      const theirsFetched = await this.safeFetchContents(path, currentHead);
      const theirsBytes =
        theirsFetched === null
          ? null
          : (await this.workerClient.decodeBase64(theirsFetched.content));
      // Diagnostic probe after both blobs are in memory — this is
      // the peak-byte point of the iteration. Lazy lambda; runs only
      // when logging is enabled.
      this.logger.info("Sync2 reconcile path bytes-resident", () => ({
        path,
        oursBytes: oursBytes.byteLength,
        theirsBytes: theirsBytes?.byteLength ?? 0,
        memUsage:
          typeof (globalThis as { process?: { memoryUsage?: () => unknown } })
            .process?.memoryUsage === "function"
            ? (globalThis as { process: { memoryUsage: () => unknown } })
                .process.memoryUsage()
            : null,
      }));
      const baseBytes = baseFetched
        ? (await this.workerClient.decodeBase64(baseFetched.content))
        : null;

      // (Stage 5 note: the byte-level convergence short-circuit
      // that used to live here is now dead. Branch 2 of the
      // SHA-first reconcile decision tree above already catches
      // every "ours === theirs" case directly from the metadata
      // SHAs — no bytes, no decode, no length check needed.)

      // Size guard: skip 3-way merge for files larger than
      // RECONCILE_AUTO_MERGE_LIMIT. Above this size two things
      // bite: (a) node-diff3 hits a hard scaling cliff around
      // 4 MB on mobile (~85 s at 4.6 MB observed on Pixel 6 Pro);
      // (b) field-observed Capacitor bridge stalls during the
      // base64 decode of multi-MB GitHub blob responses, even
      // though the same payload decodes cleanly in isolation.
      // The size guard sidesteps both by skipping the
      // attemptAutoMerge dance — the path stays in batch.files
      // so the subsequent push step uploads OURS bytes, making
      // the local side win for this file. Documented loss of
      // automated 3-way merge for big files; the trade is
      // accepted vs. the user-facing "infinite hang" we'd
      // otherwise reach.
      //
      // Stage 7: read from settings live so the user can tune
      // without restarting the plugin. Default 1 MB per the Stage 8
      // perf-test recommendation (tests/perf/README.md).
      const RECONCILE_AUTO_MERGE_LIMIT = this.maxAutoMergeSizeBytes();
      const oursIsLarge =
        oursBytes.byteLength > RECONCILE_AUTO_MERGE_LIMIT;
      const baseIsLarge =
        baseBytes !== null &&
        baseBytes.byteLength > RECONCILE_AUTO_MERGE_LIMIT;
      const theirsIsLarge =
        theirsBytes !== null &&
        theirsBytes.byteLength > RECONCILE_AUTO_MERGE_LIMIT;
      if (oursIsLarge || baseIsLarge || theirsIsLarge) {
        // (Stage 5 note: the SHA-skip that used to live here is
        // dead too. Branch 2 of the SHA-first decision tree
        // already drops paths where ours === theirs, before we
        // even fetched the blob bytes that drive the size check.)
        this.logger.warn(
          "Sync2 reconcile path SKIP auto-merge — file > size limit, ours pushed as-is",
          () => ({
            path,
            limit: RECONCILE_AUTO_MERGE_LIMIT,
            oursBytes: oursBytes.byteLength,
            theirsBytes: theirsBytes?.byteLength ?? 0,
            baseBytes: baseBytes?.byteLength ?? 0,
            oursSha,
            theirsSha: theirsFetched?.sha ?? null,
          }),
        );
        continue;
      }

      const reconcileRole = pluginDirFileRole(path, this.configDir);
      let pluginResolve: PluginResolveContext | undefined;
      if (theirsFetched !== null && reconcileRole !== null) {
        pluginResolve = await this.readReconcilePluginResolveContext(
          batchId,
          batch.files,
          path,
          reconcileRole,
          expectedHead,
          currentHead,
          batch.fileMtimes ?? {},
        );
      }

      const auto = await attemptAutoMerge({
        path,
        ours: oursBytes,
        theirs: theirsBytes,
        base: baseBytes,
        configDir: this.configDir,
        mergeFn: this.mergeViaWorker,
        pluginResolve,
      });

      if (auto.type === "modify-wins") {
        // Remote deleted the file but the batch still carries our
        // modification. Local-intent wins automatically — leave the
        // batch entry intact; push will resurrect the file on remote.
        this.logger.info(
          "Sync2 reconcile modify-wins: remote deleted, local modify resurrects",
          { path },
        );
        continue;
      }

      if (auto.type === "clean") {
        // Write merged bytes to BOTH the batch snapshot (what gets
        // pushed) and the live vault (what the user sees).
        const text = new TextDecoder().decode(auto.content);
        await this.queue.overwriteFile(batchId, path, auto.content);
        await this.writeRemoteText(path, text);
        resolvedPerPath.set(path, {
          oldOurs: oursBytes,
          newOurs: auto.content,
        });
        continue;
      }

      if (auto.type === "atomic") {
        if (auto.side === "theirs") {
          // Remote wins → apply remote bytes to live vault, drop the
          // path from this batch so push doesn't upload stale "ours".
          // theirsFetched is non-null here: modify-wins already
          // handled the theirs===null case above.
          await this.writeBinaryRemote(path, theirsFetched!.content);
          await this.detector.recordSync(path, theirsFetched!.sha);
          await this.queue.removeFile(batchId, path);
          dropFromBatchInMemory(path);
          this.logger.info(
            "Sync2 reconcile atomic: theirs wins, dropped from batch",
            { path },
          );
        }
        // side === "ours": local wins → leave batch entry intact;
        // push will overwrite remote.
        continue;
      }

      // auto.type === "register-conflict"
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "modify-vs-modify",
        theirsContent: theirsBytes!,
        theirsBlobSha: theirsFetched!.sha,
        oursBlobSha: await this.workerClient.computeGitBlobSHA(oursBytes),
        remoteDevice: await this.fetchRemoteDevice(currentHead),
        fromBatchId: batchId,
      });
      dropFromBatchInMemory(path);
    }

    if (resolvedPerPath.size > 0) {
      await this.cascadeRebase(batchId, resolvedPerPath, currentHead);
    }

    // Reconcile batch.deletions against the current remote head.
    //   - Remote already deleted: drop the redundant deletion (createTree
    //     would 422 on a deletion not in base_tree).
    //   - Remote unchanged: deletion stands.
    //   - Remote modified: delete-vs-modify conflict — register and
    //     drop from queue. User resolves via sibling file (delete the
    //     .deleted placeholder → keep delete; delete the base → accept
    //     remote modification).
    for (const path of batch.deletions) {
      const theirs = await this.safeFetchContents(path, currentHead);
      if (theirs === null) {
        await this.queue.removeDeletion(batchId, path);
        continue;
      }
      const base = await this.safeFetchContents(path, expectedHead);
      if (base !== null && base.sha === theirs.sha) {
        continue;
      }
      // Remote modified since base → delete-vs-modify.
      // §28: a plugin folder never grows a conflict sibling — the modify
      // wins and the file resurrects (apply remote to the live vault,
      // drop the deletion).
      if (pluginDirFileRole(path, this.configDir) !== null) {
        await this.queue.removeDeletion(batchId, path);
        await this.writeBinaryRemote(path, theirs.content);
        await this.detector.recordSync(path, theirs.sha);
        this.logger.info(
          "Sync2 §28 plugin delete-vs-modify (reconcile): modify wins, resurrected",
          { path },
        );
        continue;
      }
      // ours = "deleted", theirs = remote bytes → register conflict.
      const theirsBytes = await this.workerClient.decodeBase64(theirs.content) as ArrayBuffer;
      await this.queue.removeDeletion(batchId, path);
      await this.registerConflictAndDropPath({
        vaultPath: path,
        kind: "delete-vs-modify",
        theirsContent: theirsBytes,
        theirsBlobSha: theirs.sha,
        oursBlobSha: null,
        remoteDevice: await this.fetchRemoteDevice(currentHead),
        fromBatchId: batchId,
      });
    }

    // Re-target the batch onto the current head so the next step in
    // processBatch builds the commit there. We need its tree SHA for
    // base_tree.
    const headCommit = await this.client.getCommit({
      sha: currentHead,
      retry: true,
    });
    await this.queue.updateMeta(batchId, {
      parentCommitSha: currentHead,
      parentTreeSha: headCommit.tree.sha,
    });
  }

  // §28 PUSH-side (reconcile) plugin-dir resolve context. Same shape as
  // the pull-side reader, but "ours" is the batch snapshot as it WAS at
  // click time — pull may have just overwritten the live manifest with
  // the remote version, which would make oursVersion == theirsVersion
  // and silently flip resolution. Two cases for the ours version/code:
  //   - User bumped/changed it themselves (it's in this batch): use the
  //     batch's snapshot.
  //   - Otherwise: fetch from expectedHead (lastSync) — the version the
  //     user was effectively on.
  // Ours mtimes come from batch.fileMtimes (captured at enqueue BEFORE
  // canonical-write-back); theirs mtimes from the current head's
  // last-change commit date.
  private async readReconcilePluginResolveContext(
    batchId: string,
    batchFiles: string[],
    path: string,
    role: PluginDirFileRole,
    expectedHead: string,
    currentHead: string,
    fileMtimes: Record<string, number>,
  ): Promise<PluginResolveContext | undefined> {
    const root = pluginRootOf(path, this.configDir);
    if (root === null) return undefined;
    const manifestPath = `${root}/manifest.json`;
    const mainJsPath = `${root}/main.js`;

    const fileOursMtime = fileMtimes[path] ?? 0;
    const fileTheirsMtime = await this.remoteChangeMtime(path, currentHead);

    if (role === "data") {
      return this.dataOnlyResolveContext(fileOursMtime, fileTheirsMtime);
    }

    let oursVersion: string | null = null;
    if (batchFiles.includes(manifestPath)) {
      const buf = await this.queue.readFile(batchId, manifestPath);
      oursVersion = readPluginVersion(new TextDecoder().decode(buf));
    } else {
      const baseManifestBlob = await this.safeFetchContents(manifestPath, expectedHead);
      if (baseManifestBlob) {
        oursVersion = readPluginVersion(decodeBase64String(baseManifestBlob.content));
      }
    }

    let theirsVersion: string | null = null;
    const remoteManifestBlob = await this.safeFetchContents(manifestPath, currentHead);
    if (remoteManifestBlob) {
      theirsVersion = readPluginVersion(decodeBase64String(remoteManifestBlob.content));
    }

    // Canonical bundle mtime = main.js's (fallback manifest). ONE value
    // per side keeps the group atomic. When neither is IN this batch
    // (the bundle wasn't changed locally — e.g. only styles.css was),
    // "ours" main.js is the version at expectedHead, so its mtime is
    // that ref's last-change date — NOT the resolving file's own mtime,
    // which would compare a local styles-edit time against a remote
    // commit date and could pick the wrong side on a semver tie.
    const codeOursMtime =
      fileMtimes[mainJsPath] ??
      fileMtimes[manifestPath] ??
      ((await this.remoteChangeMtime(mainJsPath, expectedHead)) ||
        (await this.remoteChangeMtime(manifestPath, expectedHead)));
    const codeTheirsMtime =
      (await this.remoteChangeMtime(mainJsPath, currentHead)) ||
      (await this.remoteChangeMtime(manifestPath, currentHead));

    // codeDiffers only affects styles.css (rule 1 vs rule 3).
    let codeDiffers = true;
    if (role === "styles") {
      codeDiffers =
        (await this.reconcileCodeDiffers(batchId, batchFiles, mainJsPath, expectedHead, currentHead)) ||
        (await this.reconcileCodeDiffers(batchId, batchFiles, manifestPath, expectedHead, currentHead));
    }

    return {
      oursVersion,
      theirsVersion,
      codeDiffers,
      codeOursMtime,
      codeTheirsMtime,
      fileOursMtime,
      fileTheirsMtime,
    };
  }

  // Does a plugin code file differ between OUR side (the batch snapshot
  // if it's in this batch, else the lastSync/expectedHead version) and
  // the remote currentHead? SHAs only — the remote side is a
  // metadata-only fetch so a big main.js is never downloaded.
  private async reconcileCodeDiffers(
    batchId: string,
    batchFiles: string[],
    path: string,
    expectedHead: string,
    currentHead: string,
  ): Promise<boolean> {
    let oursSha: string | null;
    if (batchFiles.includes(path)) {
      oursSha = await this.workerClient.computeGitBlobSHA(
        await this.queue.readFile(batchId, path),
      );
    } else {
      oursSha =
        (await this.client.getContentsMetadataAtRef({ path, ref: expectedHead, retry: true }))
          ?.sha ?? null;
    }
    const theirsSha =
      (await this.client.getContentsMetadataAtRef({ path, ref: currentHead, retry: true }))
        ?.sha ?? null;
    return oursSha !== theirsSha;
  }

  // Propagate every resolution from a just-reconciled batch into the
  // batches behind it in the queue. Single-pass: list() + read() per
  // later batch happens once each, regardless of how many paths the
  // primary reconcile resolved. For each later batch we then
  // intersect resolvedPerPath with the batch's file list and run
  // attemptAutoMerge against (ours_of_later_batch, theirs=newOurs,
  // base=oldOurs).
  //
  // Clean → overwrite the later batch's snapshot silently.
  // Conflict (markers) → register modify-vs-modify + cascade-drop the
  // path from this and every later batch (per advisor's "option A"
  // for stage 5c: no more throw-on-defer).
  private async cascadeRebase(
    fromBatchId: string,
    resolvedPerPath: Map<
      string,
      { oldOurs: ArrayBuffer; newOurs: ArrayBuffer }
    >,
    currentHead: string,
  ): Promise<void> {
    if (resolvedPerPath.size === 0) return;
    const ids = await this.queue.list();
    const startIdx = ids.indexOf(fromBatchId);
    if (startIdx < 0) return;
    for (const id of ids.slice(startIdx + 1)) {
      const batch = await this.queue.read(id);
      const intersection = batch.files.filter((p) => resolvedPerPath.has(p));
      if (intersection.length === 0) continue;
      for (const path of intersection) {
        const { oldOurs, newOurs } = resolvedPerPath.get(path)!;
        const oursBytes = await this.queue.readFile(id, path);
        const auto = await attemptAutoMerge({
          path,
          ours: oursBytes,
          theirs: newOurs,
          base: oldOurs,
          configDir: this.configDir,
          mergeFn: this.mergeViaWorker,
        });
        if (auto.type === "clean") {
          await this.queue.overwriteFile(id, path, auto.content);
          continue;
        }
        if (auto.type === "atomic") {
          // §28: only plugin-dir files reach "atomic" in a cascade, and
          // they must NEVER register a conflict. "theirs" is the earlier
          // batch's already-resolved bytes; adopt them when they win so
          // this later batch pushes the resolved value (side "ours" =
          // keep this batch's version).
          if (auto.side === "theirs") {
            await this.queue.overwriteFile(id, path, newOurs);
          }
          continue;
        }
        // register-conflict during cascade → can't silently pick a
        // winner; register the conflict and drop the path from this
        // batch (and any later batches that also carry it).
        await this.registerConflictAndDropPath({
          vaultPath: path,
          kind: "modify-vs-modify",
          theirsContent: newOurs,
          theirsBlobSha: await this.workerClient.computeGitBlobSHA(newOurs),
          oursBlobSha: await this.workerClient.computeGitBlobSHA(oursBytes),
          remoteDevice: await this.fetchRemoteDevice(currentHead),
          fromBatchId: id,
        });
      }
    }
  }

  private async safeFetchContents(
    path: string,
    ref: string,
  ): Promise<{ content: string; sha: string } | null> {
    try {
      return await this.client.getContentsAtRef({
        path,
        ref,
        retry: true,
      });
    } catch {
      // Force-push or commit GC made the ref unreachable. Treat as
      // "no base available" → the merge will run against an empty
      // base, which is the documented graceful-degradation path.
      return null;
    }
  }

  // Stage 5 SHA-first reconcile helper. Returns the path's metadata
  // (sha + size) at a ref WITHOUT downloading the blob content. The
  // reconcile loop calls this before deciding whether the heavier
  // safeFetchContents+decode round-trip is actually needed.
  //
  // Same graceful-degradation contract as safeFetchContents: errors
  // (force-push, GC'd commit) → null, the loop treats it as
  // "no base available".
  private async safeFetchMetadata(
    path: string,
    ref: string,
  ): Promise<{ sha: string; size: number } | null> {
    try {
      return await this.client.getContentsMetadataAtRef({
        path,
        ref,
        retry: true,
      });
    } catch {
      return null;
    }
  }

  private async estimateBatchBytes(batchId: string): Promise<number> {
    const batch = await this.queue.read(batchId);
    let total = 0;
    const vaultRoot = `${this.configDir}/plugins/${this.selfPluginId}/.runtime/push-queue/${batchId}/vault`;
    for (const f of batch.files) {
      const stat = await this.vault.adapter.stat(`${vaultRoot}/${f}`);
      if (stat) total += stat.size;
    }
    return total;
  }

  private async computeShaByPath(
    entries: NewTreeRequestItem[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const entry of entries) {
      if (entry.sha === null) continue; // deletion — nothing to record
      if (typeof entry.sha === "string") {
        // Binary path: TreeBuilder fed createBlob and recorded the SHA.
        out.set(entry.path, entry.sha);
        continue;
      }
      if (typeof entry.content === "string") {
        // Text path: we know the bytes we sent; compute git's blob SHA
        // locally so we don't need a round-trip to learn what GitHub
        // assigned (it's deterministic).
        const buf = new TextEncoder().encode(entry.content)
          .buffer as ArrayBuffer;
        out.set(entry.path, await this.workerClient.computeGitBlobSHA(buf));
      }
    }
    return out;
  }
}

