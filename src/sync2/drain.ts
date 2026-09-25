// The new drain — main loop (NEW-DRAIN §III). Since Phase 5.5 (THE
// SWITCH, 2026-08-31) this IS the live engine: `Sync2Manager` is a
// thin shell over `drainOnce`, and the old manager-owned drain/pull/
// tree-builder/conflict machinery is deleted. The fake-client unit
// suites (drain.test.ts, drain-conflicts.test.ts) stay the fast TDD
// loop; production composition lives in drain-deps.ts.
//
// ── What IS here (§III faithfully) ──────────────────────────────────
// - drain-scoped state: verifiedShas + layer2Corrections (§II.9/§II.13
//   ownership rules), restart_batch / 422-CAP / error422Count;
// - discovery head/base handling incl. cold start (base==null goes
//   through the tree fallback inside discovery) and the empty repo
//   (head==null → nothing to read, Layer 2 GUARDED OFF — there is
//   nothing to compare against);
// - pull-folding: remote_files unconditionally refresh tracked.remote;
// - per-batch transaction: claim (R3b) → accumulate (§II.15) → final
//   flush → chained empty-commit check → pushCommitFromTree → 422
//   restart with a FRESH accumulator (stale trees are discarded,
//   uploadedBlobs give resume-at-k) → persist journal → remove batch
//   dir. Rolling base: tracked.base = local, tracked.remote = D after
//   every resolved file — the next batch's diff3 sees the previous
//   push as its remote (§II.3/II.4);
// - Layer 2 (§II.13) BEFORE the short-circuit, with the
//   layer2Corrections counter (§VIII P.27-29);
// - the mtime invariant: tracked.remote.mtime is ALWAYS the date
//   GitHub actually assigned — pull-folding carries the discovery
//   value, our own push stamps committed_at onto main_push_tracked
//   AFTER the confirmed push, one date per batch;
// - Vault-step for NON-conflict paths (§II.3/II.4/II.5 endings +
//   B.7-9): live vault read, deletion-while-drain = DELETED (not
//   null), merged result written back / deleted; a conflict born here
//   goes through STEP1 like any other;
// - the conflict machinery (Phase 5, §II.6/II.7/II.11/II.14): STEP1-3,
//   the sibling replace-transaction + its recovery, process_conflicts()
//   dedup, seeding/RECONCILE and FINALIZE;
// - progress by FILE COUNT only, through the injected callback. The
//   progress bar is not worth a single extra request (§4.1) — every
//   number here is already in hand;
// - the EPILOGUE (§III steps 1-5, at the end of this file): baseline
//   transfer → conflicts reconcile → hot anchor → journal.clear() →
//   sweep. The journal is persisted at the branch-name mint and once
//   per COMPLETED batch — NOT after the Vault-step (checked, not
//   assumed: the persist sites are the mint, the batch end and
//   FINALIZE). That absence is load-bearing twice over: an aborted run
//   leaves the journal behind, so its presence at the next drain start
//   is what says "the previous one died mid-way" and the whole
//   Vault-step is redone; and a conflict born ON the Vault-step never
//   gets its flag into the journal, which is why it needs no durable
//   pairing (see the batch-end comment on §VIII D / W1).
//
// PHASE 6 (still absent): `vaultStepErrors` reach the LOG only
// (Sync2Manager.logDrainSummary) — surfacing them in the UI is the
// remaining epilogue item, together with the §VIII D/K crash matrix.

import { arrayBufferToBase64, type Vault } from "obsidian";
import { NewTreeRequestItem } from "../github/client";
import ConflictStoreV2, {
  ConflictsState,
} from "./conflict-store-v2";
import SiblingTx from "./sibling-tx";
import { processConflicts } from "./process-conflicts";
import {
  readSiblingFileFromVault,
  saveConflictSiblingFile,
} from "./conflict-siblings";
import { NetworkError, AuthError, ValidationError } from "../errors";
import NetworkRetry from "./retry-network";
import SyncStore from "./sync-store";
import DrainJournal, {
  DrainState,
  TrackedFile,
  emptyDrainState,
} from "./drain-journal";
import {
  DELETED,
  pickNewestForObsidian,
  needsObsidianMtimeTiebreak,
  Diff3Deps,
  Diff3Result,
  FileInfo,
  _diff3,
  emptyFileInfo,
} from "./diff3";
import {
  RemoteFileChange,
  DiscoveryResult,
  RemoteTreeSnapshot,
  DELETED_SHA_HASH,
} from "./discovery";
import { ClaimedBatch } from "./get-batch";
import { BatchEntry } from "./batch-metafile";
import {
  TreeCommitAccumulator,
  UploadedBlobs,
  addFileToTree,
  flushTreeAccumulator,
  newTreeAccumulator,
  treeChanged,
} from "./tree-accumulator";
import { buildConflictBranchName } from "./conflict-branch";
import { toGitAuthorDate } from "./commit-message";
import { needsSanitization, sanitizeFilename } from "./cross-platform";

export interface DrainClient {
  getGuardedHead(): Promise<string | null>;
  getCommit(args: {
    sha: string;
    retry?: boolean;
  }): Promise<{ tree: { sha: string } }>;
  createTree(args: {
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
  }): Promise<string>;
  createBlob(args: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
  }): Promise<{ sha: string }>;
  // BARE-REPO SEED (gate finding 2026-08-31, empirically re-verified):
  // Git Data API endpoints (blobs/trees/commits) answer 409 "Git
  // Repository is empty" until at least ONE ref exists, so a
  // parentless first commit is IMPOSSIBLE — the Contents API is the
  // only door into an empty repo. One PUT creates the first commit +
  // the branch; everything after it goes the normal Git Data way.
  // Returns the seed commit and its tree.
  seedBareRepoWithFile(args: {
    path: string;
    contentBase64: string;
    message: string;
  }): Promise<{ commitSha: string; treeSha: string }>;
  // Creates the commit on a READY tree and moves the branch ref.
  // Throws ValidationError on 422 (someone else moved the head).
  pushCommitFromTree(args: {
    treeSha: string;
    parent: string | null;
    message: string;
    author?: { name: string; email: string; date: string };
  }): Promise<{ sha: string; committedAt: number }>;
  // Layer 2 transport (§II.13 — the HEAD method in production).
  getContentsMetadataAtRef(
    path: string,
    ref: string,
  ): Promise<{ sha: string; size: number } | null>;
  // Layer 2's BULK transport (§II.13.2): the whole repo at one commit,
  // in one request, so a large batch stops paying per path. Same
  // authority — a commit's tree is immutable — cheaper transport.
  // ⚠️ `truncated` MUST be honoured by the caller: "absent from the
  // list" only means "absent from the repo" for a COMPLETE list.
  getRepoTreeAtCommit(sha: string): Promise<{
    files: Array<{ path: string; sha: string; size: number | null }>;
    truncated: boolean;
  }>;
  getBlobFromRepo(sha: string): Promise<ArrayBuffer | null>;
  // ── conflict-branch surface (Phase 5) ───────────────────────────
  // null = the branch doesn't exist yet (404).
  getBranchHeadSha(branch: string): Promise<string | null>;
  // The OLD push shape, deliberately (§II.15 scope boundary): a plain
  // blob list — units of files, no accumulator, no inline. Throws
  // ValidationError when `parent` is stale (the 3-attempt loop
  // re-reads the head — §III "АБСОЛЮТНО НЕМОЖЛИВО, але…").
  pushCommitToBranch(args: {
    branch: string;
    parent: string | null;
    // sha null = tree DELETION entry (ours-side deletion, 4.6.b).
    entries: Array<{ path: string; sha: string | null }>;
    message: string;
    author?: { name: string; email: string; date: string };
  }): Promise<{ sha: string }>;
  // (device_label, committed_at) of the last commit touching the path
  // (§III lazy sites; discovery.ts getCommitInfoForPath in prod).
  getCommitInfoForPath(
    path: string,
    atSha: string,
  ): Promise<{ deviceLabel: string; committedAtMs: number } | null>;
  // ── FINALIZE surface (§II.14) ───────────────────────────────────
  // A commit with an EXPLICIT parent pair — the reachability merge.
  createMergeCommit(args: {
    treeSha: string;
    parents: [string, string]; // [main_head, conflict_head] — POSITIONAL
    message: string;
    author?: { name: string; email: string; date: string };
  }): Promise<{ sha: string }>;
  // Non-force PATCH of the MAIN ref. Throws ValidationError on 422
  // (another device moved main while the merge commit was built).
  updateMainRef(sha: string): Promise<void>;
  // isAncestorOf via compare().status: "ahead"/"identical" = ancestor.
  compareStatus(
    base: string,
    head: string,
  ): Promise<"ahead" | "behind" | "identical" | "diverged">;
  // 404 = already gone = success.
  deleteBranch(branch: string): Promise<void>;
}

export interface VaultFileReader {
  // Cheap stat — the Vault-step's read short-circuit (§5.4 precedent):
  // an unchanged {mtime,size} vs the stored baseline proves the vault
  // still holds baseline content, so no read and no hash are needed
  // to resolve the path (rule 3 fires on shas alone). Without this a
  // 20k cold start would re-read and re-hash the WHOLE vault at the
  // end of the drain.
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
  // Live vault read at Vault-step time: null = the file does not
  // exist. `blob` is REQUIRED — the bytes were just read to compute
  // the sha, and _diff3 can't find live vault content in sync_store.
  read(path: string): Promise<{
    size: number;
    mtime: number;
    sha: string;
    blob: ArrayBuffer;
  } | null>;
  // Vault-step apply: write merged/remote bytes, or delete the path.
  write(path: string, bytes: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DrainDeps {
  vault: Vault;
  selfPluginId: string;
  client: DrainClient;
  syncStore: SyncStore;
  journal: DrainJournal;
  retry: NetworkRetry;
  claimBatch(): Promise<ClaimedBatch | null>;
  removeBatchDir(dir: string): Promise<void>;
  // §12.5 sweep source №1 (queue metafile shas). Optional — when
  // absent (fake-world unit suites) the sweep is skipped entirely.
  queueReferencedShas?: () => Promise<Set<string>>;
  // metadata.files (Phase 1 cold buckets) — the diff3 base source
  // (get) and the epilogue's transfer target (group ops, §2.2.1:
  // N paths in K buckets = K writes, never N).
  baselines: {
    get(
      path: string,
    ): Promise<{ baselineSha: string; mtime: number; size: number } | undefined>;
    setMany(
      entries: Array<{
        path: string;
        baselineSha: string;
        mtime: number;
        size: number;
      }>,
    ): Promise<void>;
    removeMany(paths: string[]): Promise<void>;
  };
  // Discovery Layer 1 (§II.12) — wired to discovery.ts in production,
  // a two-eyed fake in tests (P.8-13, truth vs discoveryAnswer).
  discoverChangedFiles(
    base: string | null,
    head: string,
  ): Promise<DiscoveryResult>;
  hot: {
    getLastSyncCommitSha(): string | null;
    // The tree stored BESIDE getLastSyncCommitSha(), written together
    // as one pair. Read by the epilogue to skip a getCommit when the
    // head never moved this run (§II.7.1) — the stored pair already
    // describes exactly that commit.
    getLastSyncTreeSha(): string | null;
    // J.2 fallback: the conflict-branch name survives BETWEEN drains
    // without a journal via the hot pair.
    getConflictBranch(): { name: string } | null;
    // Epilogue step 3 — the CONFIRMED anchor, written exactly once
    // per fully-completed drain (§1.C METAFILE), one ping-pong blob.
    update(fields: {
      lastSyncCommitSha: string | null;
      lastSyncTreeSha: string | null;
      conflictBranchName: string | null;
    }): Promise<void>;
  };
  // formatMergeConflictBranchMessage in production — keeps the
  // trailing "(deviceLabel)" contract. Called with now().
  mergeMessage(whenMs: number): string;
  conflictStore: ConflictStoreV2;
  // DOT-FILES §8.0 — which managed .gitignore files are currently
  // byte-identical to what we seeded (see applySeedAncestor).
  gitignoreSeeds?: { matches(path: string, sha: string | null): boolean };
  // Sweep source №5 — the Deleted bin's pending captures (§5.2.1).
  deletedBinReferencedShas?: () => Set<string>;
  siblingTx: SiblingTx;
  tokenExpired(): Promise<boolean>;
  // S1: cooperative cancellation (Settings [Stop sync], reset O3).
  // Checked at batch boundaries only — the D.16 rule verbatim: a
  // cancelled exit persists NOTHING (indistinguishable from a crash
  // before the current batch), or the journal-poisoning class returns
  // through a new door. FINALIZE/Vault-step are not interrupted.
  cancelRequested?: () => boolean;
  // S1: git author identity (owner decision, THE SWITCH п.1). Main
  // pushes stamp date=batch.createdAt (the mtime invariant then
  // records the EDIT moment — §III annotation); conflict pushes and
  // the FINALIZE merge stamp now(). null/undefined → GitHub identity.
  gitAuthor?: () => { name: string; email: string } | null;
  // The Deleted bin's one engine-side touchpoint: capture the bytes
  // just before the Vault-step removes a file (R3.4 / §5.2.1). The
  // other three hooks died with the re-platform — see trash-hooks.ts.
  trashHooks?: {
    captureForDelete(path: string): Promise<void>;
  } | null;
  vaultFiles: VaultFileReader;
  mergeBlobs: Diff3Deps["mergeBlobs"];
  computeSha(bytes: ArrayBuffer): Promise<string>;
  maxAutoMergeFileSize(): number;
  deviceLabel(): string;
  // S1: per-batch (owner decision, THE SWITCH п.2) — main pushes get
  // the BATCH's createdAt (formatSyncMessage uniqueness/greppability,
  // SYNC2 §4.4).
  commitMessage(whenMs: number): string;
  // "Init at … (label)" for the bare-repo seed commit
  // (formatInitMessage). Optional: fakes fall back to commitMessage.
  seedMessage?(whenMs: number): string;
  // Conflict-branch pushes keep the OLD "Conflict at … (label)"
  // format (formatConflictMessage) — greppable provenance, pinned by
  // branch-lifecycle. Optional: fakes fall back to commitMessage.
  conflictMessage?(whenMs: number): string;
  now(): number;
  // §II.16 — fired BEFORE the work it announces, so the number the user
  // sees is what is happening now, not what already finished.
  onProgress?: (p: DrainProgress) => void;
  logger?: {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
  };
}

export interface Layer2Correction {
  path: string;
  expected: string;
  actual: string;
}

export interface ConflictVerdict {
  path: string;
  // Where the conflict was detected — the three §III birth sites.
  site: "step1" | "step2-existing" | "vault-step";
}

export type DrainStatus =
  | "ok"
  | "token-expired"
  | "network-error"
  // S1: cooperative cancel — a clean batch-boundary exit that persists
  // nothing (see DrainDeps.cancelRequested).
  | "cancelled"
  | "too-many-concurrent-pushes"
  // 3 straight 422s on the DEVICE-OWNED conflict branch — "абсолютно
  // неможливо", so when it happens it is a real anomaly to surface.
  | "conflict-push-failed";

export interface DrainResult {
  status: DrainStatus;
  layer2Corrections: Layer2Correction[];
  conflictVerdicts: ConflictVerdict[];
  vaultStepErrors: Array<{ path: string; error: string }>;
  pushedCommits: string[]; // main-branch commit shas, in order
  // FINALIZE outcome: the merge commit that closed the conflict
  // branch this run, or null (no finalize / deferred / nothing to do).
  finalizedMergeSha: string | null;
  // S1: what the Vault-step actually did to the vault — the manager
  // derives BOTH the pulled-files count (onSyncCompleted) and the
  // plugin-id set for the mobile auto-reload (onPluginsAffected).
  // Writes report the path ACTUALLY written (canonical, when the
  // remote name needed sanitization).
  vaultStepWrites: string[];
  vaultStepRemoves: string[];
  // Set when status === "token-expired": the original 401/403 — the
  // manager's latch needs the class (invalid vs scope, §35).
  authErrorStatus?: 401 | 403;
}

const ERROR_422_CAP = 5;

// §II.13.2 — batch size from which Layer 2 stops asking per path and
// reads the whole tree once instead. OWNER DECISION (2026-09-25), not a
// constant pulled from the air: below it, per-path is genuinely cheaper
// (a tree can be megabytes; three HEADs are three round trips).
const LAYER2_TREE_THRESHOLD = 4;

// §II.16 — one progress snapshot for the user-facing notice.
//
// TWO independent counters, both live at once: this engine interleaves
// pull and push, so "file N of M" has no single meaning. Totals GROW as
// the run learns of more work (another batch claimed, another discovery
// call) — that is the model, not a glitch.
export interface DrainProgress {
  pullDone: number;
  pullTotal: number;
  pushDone: number;
  pushTotal: number;
  // Unresolved conflicts right now — the notice's third line, shown
  // only when non-zero.
  conflicts: number;
  // What the run is touching, for the Settings panel's detail line.
  path: string | null;
}

export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  // Drain-scoped state (§II.9 / §II.13 ownership: dies with this run).
  const verifiedShas = new Set<string>();
  const layer2Corrections: Layer2Correction[] = [];
  const conflictVerdicts: ConflictVerdict[] = [];
  const vaultStepErrors: Array<{ path: string; error: string }> = [];
  const pushedCommits: string[] = [];
  const vaultStepWrites: string[] = [];
  const vaultStepRemoves: string[] = [];
  let finalizedMergeSha: string | null = null;

  const result = (status: DrainStatus): DrainResult => ({
    status,
    layer2Corrections,
    conflictVerdicts,
    vaultStepErrors,
    pushedCommits,
    finalizedMergeSha,
    vaultStepWrites,
    vaultStepRemoves,
  });

  // S1: git identity per push site (main = batch.createdAt; conflict
  // branch + merge = now()) — see DrainDeps.gitAuthor.
  const authorAt = (
    whenMs: number,
  ): { name: string; email: string; date: string } | undefined => {
    const id = deps.gitAuthor?.() ?? null;
    if (id === null) return undefined;
    return { name: id.name, email: id.email, date: toGitAuthorDate(whenMs) };
  };

  // §II.11: STEP3 replace-transaction recovery — ONCE per run, first
  // line, under the caller's running lock. A live mark can only
  // belong to a PREVIOUS (dead) run: STEP3 executes once, after the
  // batch loop, so no 422 restart inside THIS run can ever see one.
  await deps.siblingTx.recoverIfNeeded();

  // §12.5 sweep, drain-START edition: reap sync_store blobs orphaned
  // by a previous crash BEFORE this run starts writing. Safe by
  // construction against concurrent writers (the store snapshots its
  // candidates before collecting references). Live sources: queue
  // metafiles + the (possibly surviving) journal + conflicts.json —
  // in-flight refs ride the journal. Optional: fake-world suites
  // don't wire a queue reader.
  await sweepSyncStore(deps);
  // §12.5 names this rearangeSyncStore(); it runs here and again after
  // the loop (epilogue step 5).

  const diff3Deps: Diff3Deps = {
    syncStore: deps.syncStore,
    verifiedShas,
    getBlobFromRepo: (sha) => deps.client.getBlobFromRepo(sha),
    getContentsMetadataAtRef: (path, ref) =>
      deps.client.getContentsMetadataAtRef(path, ref),
    maxAutoMergeFileSize: deps.maxAutoMergeFileSize,
    mergeBlobs: deps.mergeBlobs,
    computeSha: deps.computeSha,
  };

  // ── §II.16 progress counters (run-scoped) ────────────────────────
  // PULL grows: discovery answers again after a restart and the news
  // from the server genuinely got bigger. PUSH rolls BACK on a restart
  // instead — see §II.16 for why the same number means different things
  // depending on whose files it counts.
  let pullDone = 0;
  let pullTotal = 0;
  let pushDone = 0;
  let pushTotal = 0;
  // One remote change = one unit, even though a path can reach _diff3
  // from BOTH the batch loop and the Vault-step.
  const pullCounted = new Set<string>();
  // Paths discovery reported as changed remotely, this run.
  const remoteChanged = new Set<string>();
  // Snapshot taken when a batch is claimed, restored on a 422 restart.
  let pushDoneBeforeBatch = 0;
  let pushTotalBeforeBatch = 0;

  const emitProgress = (path: string | null): void => {
    deps.onProgress?.({
      pullDone,
      pullTotal,
      pushDone,
      pushTotal,
      conflicts: conflicts?.entries.size ?? 0,
      path,
    });
  };

  // Count a remote change the moment the run TAKES UP that path —
  // deliberately one step earlier than _diff3, because the batch loop's
  // "remote already equals our local content" short-circuit returns
  // before it, and such a path would otherwise never be counted at all
  // (§II.16). Returns true when this call did the counting.
  // §II.16 — a 422 restart re-processes the SAME batch, so its files
  // must not be counted twice. Put both numbers back to where they
  // stood before this batch; the re-claim adds the batch again and the
  // count runs up from there. The user sees a rollback, which is the
  // owner's explicit preference over an inflating counter.
  const rollbackPushCounters = (): void => {
    pushDone = pushDoneBeforeBatch;
    pushTotal = pushTotalBeforeBatch;
  };

  const countPull = (path: string): boolean => {
    if (!remoteChanged.has(path) || pullCounted.has(path)) return false;
    pullCounted.add(path);
    pullDone += 1;
    return true;
  };

  let restartBatch = true;
  let error422Count = 0;
  let state: DrainState = emptyDrainState();
  let headHash: string | null = null;
  // The tree of headHash, when this run happens to KNOW it without a
  // request (a push's own accumulator tree; the FINALIZE merge tree).
  // Invalidated whenever headHash is re-read live. The epilogue needs
  // the pair (commit, tree) written together — a skew points the
  // anchor at the wrong tree (METAFILE §2.1.2).
  let knownHeadTreeSha: string | null = null;
  let conflictHeadHash: string | null = null;
  // Has ensureConflictBranch() run for the CURRENT batch attempt?
  // `conflictHeadHash === null` cannot answer that — null is also the
  // legitimate "branch doesn't exist yet", and the two mean opposite
  // things to shouldPushToConflictBranch (§II.7.1).
  let conflictBranchResolved = false;
  // Discovery's complete picture of the repo at ONE pinned commit,
  // when it read the full tree. Layer 2 (§II.13) answers from it
  // instead of one HEAD request per file — see the call site for why
  // that is the same authority, not a shortcut around it. Set to null
  // whenever it can no longer be trusted for the CURRENT head.
  let remoteTree: RemoteTreeSnapshot | null = null;
  // Which head we have already tried to read a tree for (§II.13.2).
  // Distinct from `remoteTree === null`: a truncated response leaves no
  // snapshot but must NOT be re-requested for every remaining file in
  // the batch. Cleared implicitly by the head rolling.
  let treeFetchAttemptedForHead: string | null = null;
  // Run-scoped ambient conflicts (§III): null = not loaded yet; an
  // EMPTY state is a distinct legal value. Survives 422 restarts —
  // fresh in-memory STEP1 records must not vanish on a restart scan.
  let conflicts: ConflictsState | null = null;

  while (true) {
    // S1 cancel (batch boundary, BEFORE any repo access or the
    // branch-name mint): persist NOTHING — D.16 rule.
    if (deps.cancelRequested?.()) return result("cancelled");
    if (restartBatch) {
      // Step 0 (§III) — BEFORE any repo access: reconcile tracked
      // conflicts with the CURRENT vault state. Every restart gets
      // the freshest sibling reality as input — including conflicts
      // the user resolved manually in the diff-editor between drains.
      conflicts = await processConflicts(
        {
          vault: deps.vault,
          store: deps.conflictStore,
          computeSha: deps.computeSha,
          logger: deps.logger,
        },
        conflicts,
      );

      if (await deps.tokenExpired()) return result("token-expired");

      const baseHash = deps.hot.getLastSyncCommitSha();
      // base==null IS the cold-start signal — no separate flag, no
      // NEED_BOOTSTRAP: discovery step 0 reacts to it directly.

      // Restore the whole drain journal (one ping-pong blob, §V) or
      // start fresh. Re-restored on EVERY 422 restart — the failed
      // batch's in-memory mutations are discarded wholesale, which is
      // exactly the "batch is a transaction" rule.
      state = (await deps.journal.load()) ?? emptyDrainState();
      // The authoritative conflicts are the SCAN result (durable ∪
      // FS, reconciled above) — the journal's bundled copy is
      // superseded; from here both views share ONE Map, so journal
      // persists always carry the live conflicts.
      state.conflicts = conflicts.entries;

      // Seeding (J.3-J.5): every conflict path gets a tracked record
      // with the flag up — an EMPTY siblings list is still a conflict.
      // Placeholders are non-null alias-shaped objects ({path,
      // sha:null,…}) so STEP2 never dereferences null (J.4). Existing
      // journal progress for the path is NOT overwritten (J.5) — only
      // the flag is asserted.
      for (const path of conflicts.entries.keys()) {
        const existing = state.trackedFiles.get(path);
        if (existing === undefined) {
          state.trackedFiles.set(path, {
            base: { ...emptyFileInfo(), path },
            remote: { ...emptyFileInfo(), path },
            isManualConflict: true,
          });
        } else {
          existing.isManualConflict = true;
        }
      }
      // RECONCILE (J.6-J.7): a flagged path ABSENT from the
      // authoritative scan means the user resolved it externally —
      // reset the flag loudly. A record with siblings==[] is PRESENT
      // in the scan (I.7), so an in-flight STEP1 never trips this.
      for (const [path, t] of state.trackedFiles) {
        if (t.isManualConflict && !conflicts.entries.has(path)) {
          t.isManualConflict = false;
          deps.logger?.warn(
            "RECONCILE: conflict resolved outside the drain — flag reset",
            { path },
          );
        }
      }

      {
        const r = await deps.retry.run(() => deps.client.getGuardedHead());
        if (r.error !== null) return statusFromError(r.error, result);
        headHash = r.result;
        knownHeadTreeSha = null; // live read — the tree is unknown again
      }

      let remoteFiles: RemoteFileChange[] = [];
      if (headHash !== null && headHash !== baseHash) {
        const r = await deps.retry.run(() =>
          deps.discoverChangedFiles(baseHash, headHash!),
        );
        if (r.error !== null) return statusFromError(r.error, result);
        remoteFiles = r.result!.changes;
        // §II.16 — the pull total GROWS here, including on a 422
        // restart: discovery asked the server again and the news
        // genuinely got bigger. Paths already known are not re-added,
        // so a restart that re-reports the same change does not
        // inflate the total.
        for (const f of remoteFiles) {
          if (!remoteChanged.has(f.path)) {
            remoteChanged.add(f.path);
            pullTotal += 1;
          }
        }
        // Layer 2's free answer source for THIS head (§II.13 below).
        remoteTree = r.result!.tree;
      }
      // headHash == null: empty repo, nothing to read — the whole run
      // is one-directional (push local). headHash == baseHash: remote
      // did not move, the answer is known without the network call.

      if (state.conflictBranchName === null) {
        // J.2: the hot pair carries the name BETWEEN drains when the
        // journal is gone (a completed run) — generation is the LAST
        // resort, not the first.
        state.conflictBranchName =
          deps.hot.getConflictBranch()?.name ?? null;
      }
      // ⚠️ MINTING AND THE LIVE HEAD READ ARE NOT HERE (§II.7.1).
      // Seeding recovers a name a PREVIOUS run left behind; it never
      // invents one. Everything that needs an invented name goes
      // through ensureConflictBranch() below, at the moment the branch
      // is actually about to be touched. Measured 2026-09-23: minting
      // here cost three round trips on every empty sync — the probe of
      // a branch whose name carries this run's own timestamp, plus the
      // two FINALIZE reads that the resulting non-null name unlocked.
      conflictBranchResolved = false; // a 422 restart re-reads the head

      // Pull-folding: remote changes unconditionally refresh the
      // remote half of tracking (§II.2 "всі pull просто ЗАМІЩАЮТЬ").
      for (const file of remoteFiles) {
        const tracked = state.trackedFiles.get(file.path);
        if (tracked !== undefined) {
          if (tracked.remote.sha !== file.sha) {
            tracked.remote.sha = file.sha;
            tracked.remote.size = file.size;
            tracked.remote.mtime = file.mtime;
            tracked.remote.mode = file.deleted ? DELETED : "";
            tracked.remote.blob = null;
            if (tracked.isManualConflict && headHash !== null) {
              // LAZY device_label+mtime refresh — ONLY for paths
              // already in conflict (§III pull-folding): each new
              // pull during a live conflict may come from a different
              // device, and this remote becomes the next sibling.
              const info = await deps.retry.run(() =>
                deps.client.getCommitInfoForPath(file.path, headHash!),
              );
              if (info.error !== null) {
                return statusFromError(info.error, result);
              }
              tracked.remote.deviceLabel =
                info.result?.deviceLabel ?? null;
              tracked.remote.mtime = info.result?.committedAtMs ?? null;
            }
          }
        } else {
          const baseline = await deps.baselines.get(file.path);
          state.trackedFiles.set(file.path, {
            base: {
              ...emptyFileInfo(),
              path: baseline !== undefined ? file.path : null,
              sha: baseline?.baselineSha ?? null,
              size: baseline?.size ?? null,
              mtime: baseline?.mtime ?? null,
              mode: "", // never DELETED: deleted paths leave metadata.files
            },
            remote: {
              ...emptyFileInfo(),
              path: file.path,
              sha: file.sha,
              size: file.size,
              mtime: file.mtime,
              mode: file.deleted ? DELETED : "",
            },
            isManualConflict: false,
          });
        }
      }
    }

    // ── main batch loop ─────────────────────────────────────────────
    restartBatch = false;

    const claimed = await deps.claimBatch();
    if (claimed === null) break;
    // §II.16 — the push total grows by THIS batch. Both numbers are
    // snapshotted first so a 422 restart can put them back: the user
    // sees the count roll back and start again rather than inflate,
    // because these are files THEY changed and a doubled count reads
    // as "the plugin is sending something I did not ask for".
    pushDoneBeforeBatch = pushDone;
    pushTotalBeforeBatch = pushTotal;
    pushTotal += claimed.meta.entries.length;

    // BARE REPO: seed BEFORE any Git Data call (they all 409 while
    // the repo has no ref — gate finding). The seed content is one of
    // OUR OWN files from this batch, so nothing is invented and the
    // rest of the batch lands in the following sync commit. A
    // deletion-only batch against an empty repo has nothing to
    // create — deletions there are no-ops, so the seed is skipped and
    // the batch drops out through the normal empty-tree check.
    if (headHash === null) {
      const seedEntry = claimed.meta.entries.find((e) => e.sha !== null);
      if (seedEntry !== undefined) {
        const bytes = await deps.syncStore.getBlobFromSyncStore(
          seedEntry.sha!,
          verifiedShas,
        );
        if (bytes !== null) {
          const r = await deps.retry.run(() =>
            deps.client.seedBareRepoWithFile({
              path: seedEntry.path,
              contentBase64: arrayBufferToBase64(bytes),
              message: deps.seedMessage
                ? deps.seedMessage(deps.now())
                : deps.commitMessage(claimed.meta.createdAt),
            }),
          );
          if (r.error !== null) return statusFromError(r.error, result);
          headHash = r.result!.commitSha;
          knownHeadTreeSha = r.result!.treeSha;
          deps.logger?.info("bare repo seeded via Contents API", {
            path: seedEntry.path,
            commit: headHash,
          });
        }
      }
    }

    // Accumulator init (§II.15): both trees — the moving link and the
    // IMMUTABLE original base. Empty repo → both null, createTree
    // without base_tree.
    let parentTreeSha: string | null = null;
    if (headHash !== null) {
      const r = await deps.retry.run(() =>
        deps.client.getCommit({ sha: headHash!, retry: true }),
      );
      if (r.error !== null) return statusFromError(r.error, result);
      parentTreeSha = r.result!.tree.sha;
    }
    const acc: TreeCommitAccumulator = newTreeAccumulator(parentTreeSha);
    const uploadedBlobs = await UploadedBlobs.load(
      deps.vault,
      claimed.dir,
    );
    // conflict_commit — the plain blob-list for the conflict branch
    // (§II.15 scope boundary: NO inline, NO accumulator here).
    // sha:null = ours-side DELETION (4.6.b conflict born from a batch
    // deletion entry) — lands on the conflict branch as a tree
    // deletion, never as a blob.
    // §II.13.2 — acquire Layer 2's bulk answer source OURSELVES when
    // discovery did not happen to leave one.
    //
    // Lazy, at the first Layer-2 miss: a batch whose files all answer
    // from an existing snapshot never gets here, and the batch size is
    // only known once a batch is claimed (the seed block runs before
    // claimBatch()). The result lands in the SAME `remoteTree` the fast
    // path below reads, so Layer 2's own logic is untouched — only
    // where its answer comes from changes.
    const acquireRemoteTree = async (
      batchSize: number,
    ): Promise<DrainResult | null> => {
      if (headHash === null) return null;
      if (remoteTree !== null && remoteTree.atCommit === headHash) return null;
      // Below the threshold, per-path is genuinely cheaper: a tree can
      // be megabytes, three HEADs are three round trips.
      if (batchSize < LAYER2_TREE_THRESHOLD) return null;
      // A truncated tree (or a fetched-then-rolled head) must not make
      // every remaining file re-request it.
      if (treeFetchAttemptedForHead === headHash) return null;
      treeFetchAttemptedForHead = headHash;

      const r = await deps.retry.run(() =>
        deps.client.getRepoTreeAtCommit(headHash!),
      );
      if (r.error !== null) return statusFromError(r.error, result);
      if (r.result!.truncated) {
        // ⚠️ THE trap (§II.13.2). "Absent from the snapshot == 404"
        // holds ONLY for a COMPLETE tree; on a truncated one "not
        // listed" would read as "deleted", we would push over it, and
        // that is precisely the silent clobber Layer 2 exists to
        // prevent. Slow and correct beats fast and wrong.
        // The cost of this fallback is NOT graceful at scale: the tree
        // caps at 7 MB, which SPIKE-TREES-LIMIT §4 puts at ~25k files
        // (sooner with long or non-ASCII paths), and per-path at that
        // size is hours. Say the price out loud — a silent hour is
        // indistinguishable from a hang. Lifting the ceiling needs the
        // per-directory tree walk recorded in that same §4.
        deps.logger?.warn(
          "Layer 2: repo tree truncated — falling back to per-path checks",
          { atCommit: headHash, perPathRequests: batchSize },
        );
        return null;
      }
      const paths = new Map<string, { sha: string; size: number | null }>();
      // Deliberately UNFILTERED: a path outside the current sync scope
      // can still exist on the server, and a filtered snapshot would
      // show it as deleted (§II.13).
      for (const f of r.result!.files) {
        paths.set(f.path, { sha: f.sha, size: f.size });
      }
      remoteTree = { atCommit: headHash, paths };
      deps.logger?.info("Layer 2: repo tree read in bulk", {
        atCommit: headHash,
        paths: paths.size,
        batchSize,
      });
      return null;
    };

    // The ONE lazy remote-mtime fill, shared by every site that can
    // reach an mtime comparison (§II.1 п.3.b.e and the plugin-core
    // dispatch). Having two of these — one filled, one forgotten — is
    // the defect this consolidates; a third site must call THIS, not
    // copy it.
    //
    // No-ops when the mtime is already known or the repo is empty, so
    // callers may ask freely. Returns an abort result on a network
    // failure, null on success.
    const fillRemoteMtime = async (
      path: string,
      tracked: TrackedFile,
    ): Promise<DrainResult | null> => {
      if (tracked.remote.mtime !== null || headHash === null) return null;
      const info = await deps.retry.run(() =>
        deps.client.getCommitInfoForPath(path, headHash!),
      );
      if (info.error !== null) return statusFromError(info.error, result);
      tracked.remote.mtime =
        info.result?.committedAtMs ?? tracked.remote.mtime;
      return null;
    };

    const conflictCommitEntries: Array<{ path: string; sha: string | null }> =
      [];
    const mainPushTracked: TrackedFile[] = [];

    // §II.7.1 — mint the branch name and read its live head, ONCE per
    // batch attempt, at the moment the branch is first touched.
    //
    // The §II.7 order is preserved literally: the name reaches disk
    // BEFORE the network call, and THIS is that network call. What
    // changed is only WHEN the pair runs. §II.7's guarantee protects
    // against a crash between "push succeeded" and "journal written",
    // which can only happen on a run that reaches a push site — and
    // every such run passes through here first (both accumulation
    // sites call shouldPushToConflictBranch before staging anything).
    // A run that never gets here has nothing to orphan, so the name it
    // used to mint bought a guarantee against an impossible crash.
    const ensureConflictBranch = async (): Promise<DrainResult | null> => {
      if (conflictBranchResolved) return null;
      if (state.conflictBranchName === null) {
        state.conflictBranchName = buildConflictBranchName(
          deps.deviceLabel(),
          deps.now(),
        );
        await deps.journal.persist(state);
      }
      // Always LIVE, never persisted (§II.7); null = no branch yet.
      const r = await deps.retry.run(() =>
        deps.client.getBranchHeadSha(state.conflictBranchName!),
      );
      if (r.error !== null) return statusFromError(r.error, result);
      conflictHeadHash = r.result;
      conflictBranchResolved = true;
      return null;
    };

    // §II.7: the journal (conflicts) answers without the network on
    // the happy path; the live per-file check is the crash-safe
    // fallback (replaces the old bulk-diff). Returns null on an
    // abort-worthy network failure — the caller returns the result.
    const shouldPushToConflictBranch = async (
      path: string,
      sha: string | null, // null = ours is a DELETION
    ): Promise<{ should: boolean; abort: DrainResult | null }> => {
      // ⚠️ SECOND LINE OF DEFENCE, not the primary one — corrected
      // 2026-09-20 after the §VIII G.1 probes. The comment here used
      // to say this branch serves a crash-restart ("push succeeded,
      // disk didn't"); it does not, because such a restart finds the
      // durable record, seeding raises isManualConflict from it, and
      // the path then goes to STEP2 — whose caller compares these very
      // shas BEFORE calling. In normal operation this line is
      // therefore unreachable from either caller.
      //
      // It still earns its place: with the STEP2 caller's guard
      // removed and this one intact, G.1 stays green (measured — the
      // push is skipped HERE); removing both is what finally lets the
      // drain read the branch. So it is the belt behind STEP2's
      // braces, and arming G.1 needs a two-line probe for that reason.
      const rec = conflicts!.entries.get(path);
      if (rec !== undefined && rec.conflictBase.sha === sha) {
        return { should: false, abort: null }; // the record answers — no network
      }
      // Past the record's answer, this path may well end up on the
      // branch — so this is where the branch first gets touched
      // (§II.7.1). Deliberately BELOW the fast path: the happy path
      // must stay free of both the mint and the round trip.
      {
        const abort = await ensureConflictBranch();
        if (abort !== null) return { should: false, abort };
      }
      if (conflictHeadHash === null) {
        // Branch doesn't exist yet. A deletion-ours has nothing to
        // record on a FRESH branch (deleting a path the branch never
        // had is the §7-known 422 BadObjectState) — skip it; the
        // conflictBase (sha null) still records the ours-side absence.
        return { should: sha !== null, abort: null };
      }
      const r = await deps.retry.run(() =>
        deps.client.getContentsMetadataAtRef(path, conflictHeadHash!),
      );
      if (r.error !== null) {
        return { should: false, abort: statusFromError(r.error, result) };
      }
      // null-safe equality: live===null ∧ sha===null → already absent →
      // NO push (a redundant deletion-entry 422s — BadObjectState).
      return { should: (r.result?.sha ?? null) !== sha, abort: null };
    };

    // Upload one local blob for the conflict branch (saveBlobToGitHub
    // of §III) and collect it into conflict_commit. An ours-side
    // DELETION (blob null, 4.6.b) uploads nothing — it lands as a
    // tree deletion entry.
    const pushLocalToConflictCommit = async (
      local: FileInfo,
    ): Promise<DrainResult | null> => {
      if (local.sha === null || local.mode === DELETED) {
        conflictCommitEntries.push({ path: local.path!, sha: null });
        local.mtime = deps.now();
        return null;
      }
      const r = await deps.retry.run(() =>
        deps.client.createBlob({
          content: arrayBufferToBase64(local.blob!),
          encoding: "base64",
          retry: true,
        }),
      );
      if (r.error !== null) return statusFromError(r.error, result);
      conflictCommitEntries.push({ path: local.path!, sha: r.result!.sha });
      // Informational only — never a sibling timestamp (§VII.5).
      local.mtime = deps.now();
      return null;
    };

    const total = claimed.meta.entries.length;
    let processed = 0;

    let batchAborted: DrainResult | null = null;
    let restartFromFlush = false;

    for (const entry of claimed.meta.entries) {
      // S1 cancel (file boundary): the in-memory mutations of this
      // half-processed batch die with the return — D.16 rule.
      if (deps.cancelRequested?.()) return result("cancelled");
      // §4.1/§II.16: progress by file count, numbers already in hand —
      // the progress bar is not worth a single extra request. Fired
      // BEFORE the work, so the number names what is happening now.
      processed += 1;
      pushDone += 1;
      // A path that is BOTH in this batch and changed remotely is one
      // pull unit too — counted here, before the short-circuit below
      // can skip it (§II.16).
      countPull(entry.path);
      emitProgress(entry.path);

      const local = await loadLocalFromBatch(deps, entry);
      if (local === null) continue; // §12.5.B: vanished + changed — next detection re-emits

      let tracked = state.trackedFiles.get(entry.path);
      if (tracked === undefined) {
        const baseline = await deps.baselines.get(entry.path);
        tracked = {
          base: {
            ...emptyFileInfo(),
            path: baseline !== undefined ? entry.path : null,
            sha: baseline?.baselineSha ?? null,
            size: baseline?.size ?? null,
            mtime: baseline?.mtime ?? null,
          },
          remote: emptyFileInfo(),
          isManualConflict: false,
        };
        state.trackedFiles.set(entry.path, tracked);
      }

      applySeedAncestor(deps, tracked, local.sha, entry.path);

      if (tracked.isManualConflict) {
        // STEP2 (§II.6): while in conflict, every local edit goes to
        // the CONFLICT branch, never to main. The RECONCILE guarantee
        // makes the record's existence an assert, not a guard.
        const current = conflicts!.entries.get(entry.path);
        if (current === undefined) {
          throw new Error(
            `STEP2: no conflict record for ${entry.path} — RECONCILE guarantee broken`,
          );
        }
        if (current.conflictBase.sha !== local.sha) {
          const decision = await shouldPushToConflictBranch(
            entry.path,
            local.sha,
          );
          if (decision.abort !== null) return decision.abort;
          if (decision.should) {
            const abort = await pushLocalToConflictCommit(local);
            if (abort !== null) return abort;
          }
          // conflictBase-half replacement ONLY — the siblings list is
          // the Vault half, carried through unchanged (STEP3 owns it).
          conflicts!.entries.set(entry.path, {
            conflictBase: { ...local, blob: null },
            siblings: current.siblings,
          });
        }
        conflictVerdicts.push({ path: entry.path, site: "step2-existing" });
        tracked.base = tracked.remote;
        continue;
      }

      // ── Layer 2 (§II.13) — BEFORE the short-circuit ──────────────
      // Guard (2026-08-30): empty repo → the ref doesn't exist, there
      // is nothing to verify against, and a discovery blindspot is
      // impossible where the server holds nothing.
      if (headHash !== null) {
        // Source of the answer, in order of cost:
        //
        //   1. discovery's tree snapshot, when it was read at THIS very
        //      commit. Free — the bytes are already in memory.
        //   2. one HEAD request per path. ~300 ms each, and on a cold
        //      start EVERY local file is a batch entry: the owner's
        //      63 MB vault measured 255 of these, 78 s of a 90 s run.
        //
        // (1) is not a shortcut around Layer 2, it is the same
        // authority through a cheaper transport. `atCommit` is a
        // commit SHA, so the tree is immutable and `<path>@<sha>`
        // cannot answer anything else. And the snapshot stays an
        // INDEPENDENT read of the ref: discovery's cold path compares
        // baselines against the tree, while Layer 2 compares the
        // journal's belief against it — different beliefs, one
        // authority, so the blindspot check still checks something.
        //
        // The guard is `atCommit === headHash`, never "we have a
        // snapshot": headHash rolls after every batch push, and a map
        // answering for the wrong commit is precisely the silent
        // clobber G9 exists to prevent. Unknown commit → network.
        // §II.13.2: if there is no usable snapshot and this batch is
        // big enough to make one worth reading, read it now. Placed
        // BEFORE the source selection so the selection itself is
        // unchanged — it simply finds a snapshot more often.
        {
          const abort = await acquireRemoteTree(claimed.meta.entries.length);
          if (abort !== null) return abort;
        }
        let live: {
          sha: string;
          // NOT `number` as the HEAD transport types it: the tree can
          // legitimately omit a size, and `?? 0` here would be a LIE,
          // not a default — a recorded 0 permanently defeats the
          // change detector's stat short-circuit, so the path gets
          // re-read and re-hashed on every findChanges (gate finding,
          // 2026-08-31). Unknown stays null all the way down.
          size: number | null;
        } | null;
        if (remoteTree !== null && remoteTree.atCommit === headHash) {
          const hit = remoteTree.paths.get(entry.path);
          // Absent from a COMPLETE tree == the 404 a HEAD would give.
          live =
            hit === undefined
              ? null
              : { sha: hit.sha, size: hit.size };
        } else {
          const r = await deps.retry.run(() =>
            deps.client.getContentsMetadataAtRef(entry.path, headHash!),
          );
          if (r.error !== null) return statusFromError(r.error, result);
          live = r.result;
        }
        const liveSha = live?.sha ?? DELETED_SHA_HASH;
        // What we BELIEVE remote holds. ⚠️ Spec-gap found by P.28
        // (2026-08-30, annotated back into §III): the spec's literal
        // `tracked.remote.sha ?? DELETED_SHA_HASH` reads a
        // FRESH-SEEDED record (remote.sha=null, §III seeding sets an
        // empty remote half) as "we think it's deleted" — and then
        // every unchanged batch file logs a spurious correction on
        // the happy path, contradicting P.28's "0 corrections is the
        // regression sentinel". null-as-base is the convention _diff3
        // rule 5 already uses for exactly this state: an empty remote
        // half means "unchanged since base", not "deleted".
        const trackedSha =
          tracked.remote.sha ?? tracked.base.sha ?? DELETED_SHA_HASH;
        if (liveSha !== trackedSha) {
          tracked.remote.sha = live?.sha ?? DELETED_SHA_HASH;
          tracked.remote.size = live?.size ?? null;
          tracked.remote.mode = live === null ? DELETED : "";
          tracked.remote.blob = null;
          // Full-half replacement (pull-folding semantics): the
          // corrected remote is NEW content of unknown date/author —
          // stale mtime/deviceLabel from an earlier pull must not
          // survive into a sibling name (lazy-filled at conflict
          // sites only).
          tracked.remote.mtime = null;
          tracked.remote.deviceLabel = null;
          deps.logger?.warn("Layer 2: discovery mismatch corrected", {
            path: entry.path,
            expected: trackedSha,
            actual: liveSha,
          });
          layer2Corrections.push({
            path: entry.path,
            expected: trackedSha,
            actual: liveSha,
          });
        }
      }

      // Short-circuit: nothing changed remotely vs this local content.
      if (tracked.remote.sha !== null && tracked.remote.sha === local.sha) {
        tracked.base = local;
        continue;
      }

      // §II.1 п.3.b.e needs a remote mtime, and Layer 2 just above may
      // have nulled it (full-half replacement). _diff3 decides 3.b.e
      // INTERNALLY and has no network, so the fill has to happen here,
      // before the call — otherwise the null guard in
      // pickNewestForObsidian hands the path to remote unconditionally
      // and the documented "newest wins" never runs. That is the defect
      // the 2026-09-23 field log caught: a locally-enforced
      // `.obsidian/.gitignore`, seconds old, lost to a remote copy
      // written by a previous plugin version, and the correction came
      // back as its own commit on the next pass.
      //
      // The precondition is imported, never re-derived: two hand-copied
      // copies of it drifting apart is how only the plugin-core seam
      // got this fill in the first place.
      if (needsObsidianMtimeTiebreak(tracked, local)) {
        const abort = await fillRemoteMtime(entry.path, tracked);
        if (abort !== null) return abort;
      }
      let verdict = await _diff3(diff3Deps, tracked, local, headHash);
      if (verdict.kind === "plugin-dispatch") {
        // INTERIM (gate decision 2026-08-31): a genuine two-sided
        // plugin-core collision resolves like the rest of .obsidian —
        // newest wins, remote on ambiguity (3.b.e). Semver + bundle
        // atomicity (§28 class) return with PLUGIN-UPDATE-COMPAT.
        // Discovery leaves remote.mtime null — fetch it LAZILY (same
        // rule as the conflict-birth sites) or the tiebreak would
        // degenerate into "remote always wins" (gate finding, E4).
        {
          const abort = await fillRemoteMtime(entry.path, tracked);
          if (abort !== null) return abort;
        }
        deps.logger?.warn(
          "plugin-core collision resolved by mtime (interim until PLUGIN-UPDATE-COMPAT)",
          { path: entry.path },
        );
        verdict = {
          kind: "file",
          file: pickNewestForObsidian(local, tracked.remote),
        };
      }
      if (verdict.kind === "manual-conflict") {
        // STEP1 (§II.6) — a NEW manual conflict. The same idempotent
        // push check as STEP2: a crash-restart ("push succeeded, disk
        // didn't") must not duplicate the branch commit.
        const decision = await shouldPushToConflictBranch(
          entry.path,
          local.sha,
        );
        if (decision.abort !== null) return decision.abort;
        if (decision.should) {
          const abort = await pushLocalToConflictCommit(local);
          if (abort !== null) return abort;
        }
        // local IS the conflictBase; siblings start EMPTY — the first
        // sibling appears only in STEP3 (Vault-step).
        conflicts!.entries.set(entry.path, {
          conflictBase: { ...local, blob: null },
          siblings: [],
        });
        // Without the flag the next batch of this path would run rule
        // 4.4 and clobber remote (the I2/G9 class).
        tracked.isManualConflict = true;
        tracked.base = tracked.remote;
        // LAZY device_label+mtime — exactly HERE, at the conflict's
        // birth (never eagerly per remote file): tracked.remote is
        // what becomes the first sibling in STEP3, and its name needs
        // both fields (§VII.4/§VII.5).
        if (headHash !== null) {
          const info = await deps.retry.run(() =>
            deps.client.getCommitInfoForPath(entry.path, headHash!),
          );
          if (info.error !== null) {
            return statusFromError(info.error, result);
          }
          tracked.remote.deviceLabel = info.result?.deviceLabel ?? null;
          tracked.remote.mtime = info.result?.committedAtMs ?? null;
        }
        conflictVerdicts.push({ path: entry.path, site: "step1" });
        continue;
      }

      const D = verdict.file;
      // Bytes in memory ⇒ the size is hash-PROVEN and can never be
      // wrong (owner's rule 2026-08-31). Fill it as close to the use
      // as possible: D becomes tracked.remote below, and the epilogue
      // writes that size as the durable baseline.
      if (D.size === null && D.blob !== null) D.size = D.blob.byteLength;
      if (tracked.remote.sha !== D.sha) {
        // Push D. Ensure bytes (D may be a sha-only side verdict).
        if (D.blob === null && D.mode !== DELETED) {
          D.blob = await deps.syncStore.getBlobFromSyncStore(
            D.sha!,
            verifiedShas,
          );
          if (D.blob !== null) D.size = D.blob.byteLength;
          if (D.blob === null) {
            const r = await deps.retry.run(() =>
              deps.client.getBlobFromRepo(D.sha!),
            );
            if (r.error !== null) return statusFromError(r.error, result);
            D.blob = r.result;
            if (D.blob !== null) D.size = D.blob.byteLength;
            if (D.blob === null) {
              return statusFromError(
                new Error(`remote blob ${D.sha} vanished from repo`),
                result,
              );
            }
            if (!(await deps.syncStore.existInSyncStore(D.sha!))) {
              await deps.syncStore.saveBlobToSyncStore(D.sha!, D.blob);
            }
          }
        }
        try {
          await addFileToTree(acc, deps.client, uploadedBlobs, {
            path: entry.path,
            sha: D.sha,
            blob: D.blob,
            mode: D.mode,
          });
        } catch (e) {
          if (e instanceof ValidationError) {
            // Q.14: a stale uploadedBlobs record 422-ed a mid-batch
            // flush — clear the cache and restart the batch; blobs
            // re-upload, trees rebuild against the fresh head.
            await uploadedBlobs.clear();
            restartFromFlush = true;
            break;
          }
          batchAborted = statusFromError(e, result);
          break;
        }
        mainPushTracked.push(tracked);
      }
      // §II.3/II.4 unconditionally: rolling base.
      tracked.base = local;
      tracked.remote = D;
    }
    if (batchAborted !== null) return batchAborted;
    if (restartFromFlush) {
      restartBatch = true;
      rollbackPushCounters();
      error422Count += 1;
      if (error422Count >= ERROR_422_CAP) {
        // NO persist here (D.16): `state` carries the FAILED attempt's
        // rolled base/remote — writing it would make the next drain
        // short-circuit the batch as already-pushed and silently lose
        // it. The disk journal already holds the last COMPLETED
        // batch's state; a CAP exit must look exactly like a crash
        // right before the failed batch.
        return result("too-many-concurrent-pushes");
      }
      continue;
    }

    // Final flush (§II.15, load-bearing): without it the batch tail
    // below the threshold silently never becomes a tree (class I1).
    try {
      await flushTreeAccumulator(acc, deps.client);
    } catch (e) {
      if (e instanceof ValidationError) {
        await uploadedBlobs.clear();
        restartBatch = true;
        rollbackPushCounters();
        error422Count += 1;
        if (error422Count >= ERROR_422_CAP) {
          // NO persist — dirty state, see the restartFromFlush CAP.
          return result("too-many-concurrent-pushes");
        }
        continue;
      }
      return statusFromError(e, result);
    }

    // Chained empty-commit check: final tree vs the ORIGINAL base
    // tree, never the previous link (§II.15 / Q.11-12).
    if (treeChanged(acc)) {
      const r = await deps.retry.run(() =>
        deps.client.pushCommitFromTree({
          treeSha: acc.treeSha!,
          parent: headHash,
          message: deps.commitMessage(claimed.meta.createdAt),
          author: authorAt(claimed.meta.createdAt),
        }),
      );
      if (r.error !== null) {
        if (r.error instanceof ValidationError) {
          // 422: someone pushed while we were building. 422-CAP (I6):
          // give up cleanly after 5 in a row without a success — the
          // disk journal already holds the last completed batch's
          // state, and persisting the in-memory `state` here would
          // poison it with the FAILED attempt's rolled base/remote
          // (D.16: silent batch loss on the redo).
          error422Count += 1;
          if (error422Count >= ERROR_422_CAP) {
            return result("too-many-concurrent-pushes");
          }
          restartBatch = true;
          rollbackPushCounters();
          continue; // batch dir NOT removed — reprocessed with fresh remote state
        }
        return statusFromError(r.error, result);
      }
      const { sha, committedAt } = r.result!;
      headHash = sha; // MANDATORY: the next batch pushes against THIS head
      knownHeadTreeSha = acc.treeSha; // we BUILT this tree — no request needed later
      pushedCommits.push(sha);
      // mtime invariant: one authoritative GitHub date per batch,
      // stamped only after the CONFIRMED push.
      for (const t of mainPushTracked) t.remote.mtime = committedAt;
      error422Count = 0;
    }

    // Conflict-branch push (plain blob list, §II.15 boundary). A 422
    // here is "absolutely impossible" (the branch is device-owned) —
    // 3 re-read-head attempts, then surface the anomaly loudly.
    if (conflictCommitEntries.length > 0) {
      let pushed = false;
      for (let cnt = 0; cnt < 3 && !pushed; cnt++) {
        const h = await deps.retry.run(() =>
          deps.client.getBranchHeadSha(state.conflictBranchName!),
        );
        if (h.error !== null) return statusFromError(h.error, result);
        conflictHeadHash = h.result;
        const p = await deps.retry.run(() =>
          deps.client.pushCommitToBranch({
            branch: state.conflictBranchName!,
            parent: conflictHeadHash,
            entries: conflictCommitEntries,
            message: (deps.conflictMessage ?? deps.commitMessage)(deps.now()),
            author: authorAt(deps.now()),
          }),
        );
        if (p.error !== null) {
          if (p.error instanceof ValidationError) continue; // re-read + retry
          return statusFromError(p.error, result);
        }
        conflictHeadHash = p.result!.sha;
        error422Count = 0; // any success (either branch) resets the CAP
        pushed = true;
      }
      if (!pushed) return result("conflict-push-failed");
    }
    // FINALIZE deliberately NOT here (per-batch merge would move the
    // main head under the next push) — it lives after the loop.

    // BATCH ОБРОБЛЕНО! The durable conflicts FIRST, the journal
    // second, then the dir.
    //
    // ⚠️ THE ORDER IS THE POINT (§VIII D, W1). STEP1 raises
    // `isManualConflict` and the journal persist below is the only
    // place that flag becomes durable — so of the four crash states,
    // exactly one is destructive:
    //   journal flag + NO record → RECONCILE reads the empty scan as
    //     "resolved externally", drops the flag, FINALIZE then merges
    //     and deletes the branch, and the next batch takes rule 4.4
    //     and clobbers theirs on main. Silent, G9-class.
    //   record + NO journal flag → benign: seeding (J.3) re-asserts it.
    //   neither                  → benign: _diff3 re-derives the
    //     conflict, and shouldPushToConflictBranch's live check keeps
    //     the branch push idempotent.
    //   both                     → RECONCILE is correct.
    // Saving the store first makes the only reachable in-between state
    // the benign one. The invariant every consumer can now rely on:
    // a flag readable from the journal implies a durable record.
    //
    // This is the ONLY paired site, deliberately: the `:532` branch-name
    // mint persists a CLEAN state (D.16) and the CAP / cancel exits
    // persist nothing at all — both must stay unpaired. A conflict born
    // on the Vault-step needs no pairing either: nothing persists the
    // journal after the Vault-step, so its flag never outlives the run.
    await deps.conflictStore.save(conflicts!);
    await deps.journal.persist(state);
    await deps.removeBatchDir(claimed.dir);
  }

  // ── FINALIZE (§II.14) — ONCE, after the batch loop, BEFORE the
  // Vault-step (a per-batch merge would move the main head under the
  // next push). Gate: a branch name exists AND no unresolved tracked
  // conflicts remain. The merge is a REACHABILITY merge: the commit
  // carries the MAIN tree (content no-op) with parents
  // [main, conflict] — POST /merges is never used (a content merge
  // would resurrect the superseded C_n over the user's resolution).
  if (state.conflictBranchName !== null && conflicts!.entries.size === 0) {
    {
      const r = await deps.retry.run(() => deps.client.getGuardedHead());
      if (r.error !== null) return statusFromError(r.error, result);
      headHash = r.result; // fresh, not the last batch-push value
      knownHeadTreeSha = null;
    }
    const ch = await deps.retry.run(() =>
      deps.client.getBranchHeadSha(state.conflictBranchName!),
    );
    if (ch.error !== null) return statusFromError(ch.error, result);
    const conflictTip = ch.result;

    if (conflictTip === null) {
      // 404: already deleted (crash after delete, before the journal
      // write) — "already finalized", just clean the field.
      state.conflictBranchName = null;
      await deps.journal.persist(state);
    } else {
      const cmp = await deps.retry.run(() =>
        deps.client.compareStatus(conflictTip, headHash!),
      );
      if (cmp.error !== null) return statusFromError(cmp.error, result);
      const isAncestor =
        cmp.result === "ahead" || cmp.result === "identical";
      if (isAncestor) {
        // Idempotency: the tip is already reachable from main (a
        // previous merge succeeded, the crash hit after it) — no
        // second merge, just the delete.
        const del = await deps.retry.run(() =>
          deps.client.deleteBranch(state.conflictBranchName!),
        );
        if (del.error !== null) return statusFromError(del.error, result);
        state.conflictBranchName = null;
        await deps.journal.persist(state);
      } else {
        const headCommit = await deps.retry.run(() =>
          deps.client.getCommit({ sha: headHash!, retry: true }),
        );
        if (headCommit.error !== null) {
          return statusFromError(headCommit.error, result);
        }
        const merge = await deps.retry.run(() =>
          deps.client.createMergeCommit({
            treeSha: headCommit.result!.tree.sha, // ⚠️ THE MAIN TREE — this line is what makes the merge safe
            parents: [headHash!, conflictTip], // §4.3 order: main FIRST
            message: deps.mergeMessage(deps.now()),
            author: authorAt(deps.now()),
          }),
        );
        if (merge.error !== null) return statusFromError(merge.error, result);
        const upd = await deps.retry.run(() =>
          deps.client.updateMainRef(merge.result!.sha),
        );
        if (upd.error !== null) {
          if (upd.error instanceof ValidationError) {
            // 422: another device moved main while we built the merge
            // commit. DEFER (§II.14 policy): keep the name, keep the
            // branch, go on — the next drain's FINALIZE retries, and
            // the ancestor check keeps it idempotent. The orphan
            // commit is GC fodder.
            deps.logger?.warn(
              "FINALIZE deferred: main moved during the merge (422)",
              { branch: state.conflictBranchName },
            );
          } else {
            return statusFromError(upd.error, result);
          }
        } else {
          // MANDATORY (§II.14): the anchor must be honest — without
          // this the epilogue would record the PRE-merge commit.
          headHash = merge.result!.sha;
          knownHeadTreeSha = headCommit.result!.tree.sha; // tree-of-main by construction
          finalizedMergeSha = merge.result!.sha;
          const del = await deps.retry.run(() =>
            deps.client.deleteBranch(state.conflictBranchName!),
          );
          if (del.error !== null) return statusFromError(del.error, result);
          state.conflictBranchName = null;
          await deps.journal.persist(state);
        }
      }
    }
  }

  // Ensure the remote half's bytes are on hand (sync_store first,
  // network second; save-back on fetch). null result = confirmed
  // NOT_FOUND; a network failure aborts via the returned DrainResult.
  // Materialize tracked.remote.blob (store → network) AND, as a side
  // effect, its `size`: once the bytes are in memory their length is
  // hash-PROVEN, so it can never be wrong — strictly better than any
  // stat and closest to where the size is used (owner, 2026-08-31).
  // Discovery's compare path leaves size null, and a null size later
  // trips _diff3's rule-6 assert / weakens the baseline (C.20 class).
  const ensureRemoteBlob = async (
    tracked: TrackedFile,
  ): Promise<{ abort: DrainResult | null; found: boolean }> => {
    const proveSize = (): void => {
      if (tracked.remote.blob !== null) {
        tracked.remote.size = tracked.remote.blob.byteLength;
      }
    };
    if (tracked.remote.blob !== null) {
      proveSize();
      return { abort: null, found: true };
    }
    tracked.remote.blob = await deps.syncStore.getBlobFromSyncStore(
      tracked.remote.sha!,
      verifiedShas,
    );
    if (tracked.remote.blob !== null) {
      proveSize();
      return { abort: null, found: true };
    }
    const r = await deps.retry.run(() =>
      deps.client.getBlobFromRepo(tracked.remote.sha!),
    );
    if (r.error !== null) {
      return { abort: statusFromError(r.error, result), found: false };
    }
    tracked.remote.blob = r.result;
    if (tracked.remote.blob === null) return { abort: null, found: false };
    proveSize();
    if (!(await deps.syncStore.existInSyncStore(tracked.remote.sha!))) {
      await deps.syncStore.saveBlobToSyncStore(
        tracked.remote.sha!,
        tracked.remote.blob,
      );
    }
    return { abort: null, found: true };
  };

  // ── Vault-step (§II.3/II.4/II.5 endings + STEP3) ─────────────────
  for (const [path, tracked] of state.trackedFiles) {
    // §II.16 — count the remote change the moment this path is taken
    // up, BEFORE any of the skips below. A path already counted in the
    // batch loop is guarded by the set, so this is the second half of
    // "one remote change = exactly one unit", not a double count.
    if (countPull(path)) emitProgress(path);
    if (tracked.isManualConflict) {
      // STEP3 (§II.6): the ONLY place that decides what the sibling
      // file becomes — conflict content never rides batches/push.
      const current = conflicts!.entries.get(path);
      if (current === undefined) {
        throw new Error(
          `STEP3: no conflict record for ${path} — RECONCILE guarantee broken`,
        );
      }
      // ⚠️ conflictBase is passed to the fold's _diff3 DIRECTLY, never
      // assigned into tracked.base: the conflict-mode invariant is
      // tracked.base == tracked.remote (§II.11 cascade item 4 — the
      // Vault-step gate and the post-RECONCILE clean push both lean on
      // it). Mutating it here poisoned the journal: after the user
      // resolved a conflict, the next drain read base=conflictBase and
      // re-birthed the conflict instead of cleanly pushing the
      // resolution (found by G.9).
      const previousSibling =
        current.siblings.length > 0
          ? current.siblings[current.siblings.length - 1]
          : null;

      if (previousSibling === null) {
        // Case 1: no sibling yet. Idle lingering conflict (no fresh
        // pull, no fresh birth) → nothing to reflect this run (C.11).
        if (tracked.remote.sha === null) continue;
        const blob = await ensureRemoteBlob(tracked);
        if (blob.abort !== null) return blob.abort;
        if (!blob.found) {
          // Confirmed NOT_FOUND with ZERO siblings → this was the only
          // tracked record for the path: cancel the mode explicitly
          // (direct removal, not the scan) so the next restore can't
          // resurrect it; the next commit+drain re-detects the file
          // and likely births a fresh, healthy conflict (C.8).
          conflicts!.entries.delete(path);
          tracked.isManualConflict = false;
          await deps.conflictStore.save(conflicts!);
          vaultStepErrors.push({
            path,
            error:
              "conflict content vanished from the repo — conflict mode cancelled",
          });
          continue;
        }
        await saveConflictSiblingFile(deps.vault, {
          path,
          mtime: tracked.remote.mtime ?? 0, // remote commit date (§VII.5)
          deviceLabel: tracked.remote.deviceLabel,
          blob: tracked.remote.blob,
        });
        conflicts!.entries.set(path, {
          conflictBase: current.conflictBase,
          siblings: [siblingInfoFrom(tracked.remote)],
        });
        conflictVerdicts.push({ path, site: "vault-step" });
        continue;
      }

      // Case 2: a sibling exists — try to FOLD the fresh remote into
      // it. The previous sibling's bytes exist ONLY in the vault.
      if (tracked.remote.sha === null) continue; // idle lingering (C.11)
      const prevBlob = await readSiblingFileFromVault(deps.vault, {
        path,
        mtime: previousSibling.mtime ?? 0,
        deviceLabel: previousSibling.deviceLabel,
      });
      if (prevBlob === null) {
        // Same class as LOCAL_FILE_NOT_FOUND downstream — the scan at
        // the next drain start reconciles the missing file.
        vaultStepErrors.push({
          path,
          error: "previous sibling file missing from the vault",
        });
        continue;
      }
      // ⚠️ GATE FINDING 2026-08-31: `size` MUST be filled here. A
      // sibling born from a COMPARE-based discovery carries size=null
      // (the compare API returns no sizes — only the tree fallback
      // does), and _diff3's rule-6 assert ("an ordinary local always
      // has a size") then threw CompareWrongFilesError, so the fold
      // was skipped and the conflict's theirs-side froze at the FIRST
      // remote version forever. The bytes are in hand — the size is
      // knowable for free.
      const prevWithBlob: FileInfo = {
        ...previousSibling,
        blob: prevBlob,
        size: previousSibling.size ?? prevBlob.byteLength,
      };
      let foldVerdict;
      try {
        foldVerdict = await _diff3(
          diff3Deps,
          { base: current.conflictBase, remote: tracked.remote },
          prevWithBlob,
          headHash,
        );
      } catch (e) {
        if (e instanceof NetworkError || e instanceof AuthError) {
          return statusFromError(e, result); // abort — journal stays (§II.6 п.8)
        }
        // NOT_FOUND class with siblings ≠ [] → skip only, NO mode
        // cancellation — the other tracked siblings still stand (C.9).
        vaultStepErrors.push({ path, error: String(e) });
        continue;
      }

      if (foldVerdict.kind === "file") {
        // diff3 OK → REPLACE the last sibling via the §II.11 mark
        // transaction (the only branch that destroys evidence).
        const merged = foldVerdict.file;
        if (merged.sha === previousSibling.sha) {
          // No-op fold (the fresh pull equals the sibling — §II.6
          // "якщо тільки послідовно вони не однакові"): nothing to
          // replace. Running the transaction here would be worse than
          // wasteful — old and new derive the SAME file name, so
          // step 4 would delete the file step 2 just wrote.
          conflictVerdicts.push({ path, site: "vault-step" });
          continue;
        }
        if (merged.blob === null) {
          // A sha-only side verdict (e.g. rule 3: sibling unchanged
          // vs conflictBase → remote wins verbatim) — materialize the
          // bytes before writing the file.
          const b = await deps.syncStore.getBlobFromSyncStore(
            merged.sha!,
            verifiedShas,
          );
          if (b !== null) {
            merged.blob = b;
          } else {
            const r = await deps.retry.run(() =>
              deps.client.getBlobFromRepo(merged.sha!),
            );
            // The SAME rule as every other network call in the
            // Vault-step (§II.6 п.8 / §VIII E.1): a network or auth
            // failure aborts the WHOLE drain — the journal survives
            // and the next run repeats the fold. This site used to
            // fold `r.error` into `null` and fall into the per-path
            // record below, so a dead network — and an expired token,
            // which `retry` returns without retrying — silently
            // skipped the fold while the epilogue still advanced the
            // baseline past the remote version that never reached the
            // sibling.
            if (r.error !== null) return statusFromError(r.error, result);
            merged.blob = r.result;
          }
          if (merged.blob === null) {
            vaultStepErrors.push({
              path,
              error: `fold result blob ${merged.sha} unavailable`,
            });
            continue;
          }
          // Proven size for the sibling we are about to persist —
          // a null there is exactly what froze the theirs-side (C.20).
          merged.size = merged.blob.byteLength;
        }
        // Owner rule (§II.6 п.5): the sibling's name carries the date
        // and author of the LAST remote commit folded in — _diff3
        // always returns mtime=null for a fresh merge.
        merged.mtime = tracked.remote.mtime;
        merged.deviceLabel = tracked.remote.deviceLabel;
        await deps.siblingTx.runReplaceTransaction(
          conflicts!,
          path,
          previousSibling,
          merged,
        );
      } else {
        // MANUAL_CONFLICT (or the plugin seam, impossible here in
        // practice) → APPEND a new sibling; the old one stays tracked
        // (§II.6 п.6) — nothing destroyed, no transaction needed.
        const blob = await ensureRemoteBlob(tracked);
        if (blob.abort !== null) return blob.abort;
        if (!blob.found) {
          vaultStepErrors.push({
            path,
            error: "remote content for the new sibling vanished (append skipped)",
          });
          continue;
        }
        await saveConflictSiblingFile(deps.vault, {
          path,
          mtime: tracked.remote.mtime ?? 0,
          deviceLabel: tracked.remote.deviceLabel,
          blob: tracked.remote.blob,
        });
        conflicts!.entries.set(path, {
          conflictBase: current.conflictBase,
          siblings: [...current.siblings, siblingInfoFrom(tracked.remote)],
        });
      }
      conflictVerdicts.push({ path, site: "vault-step" });
      continue;
    }
    if (tracked.base.sha === tracked.remote.sha) continue; // II.4 ending: nothing came from remote

    // Stat-first short-circuit (advisor 2026-08-30, §5.4 precedent):
    // when the live {mtime,size} still equals the stored baseline
    // pair, the vault provably holds baseline content — local's sha
    // IS baselineSha, no read, no hash; rule 3 (clean pull) resolves
    // on shas alone and the write path fetches remote bytes from the
    // store. Only a file the user touched during the drain pays for a
    // full read. Without this a 20k cold start re-hashes the whole
    // vault at the end of the drain.
    const st = await deps.vaultFiles.stat(path);
    const baseline = await deps.baselines.get(path);
    let vaultEntry: {
      size: number;
      mtime: number;
      sha: string;
      blob: ArrayBuffer | null;
    } | null;
    if (st === null) {
      vaultEntry = null;
    } else if (
      baseline !== undefined &&
      st.size === baseline.size &&
      st.mtime === baseline.mtime
    ) {
      vaultEntry = { ...st, sha: baseline.baselineSha, blob: null };
    } else {
      vaultEntry = await deps.vaultFiles.read(path);
    }

    // Deleted from the vault WHILE the drain ran → a REAL deletion
    // (DELETED, not null): null would run rule 4.5.b and silently
    // resurrect the file against the user's intent (B.9).
    const local: FileInfo =
      vaultEntry === null
        ? {
            ...emptyFileInfo(),
            path,
            sha: null,
            mode: DELETED,
            mtime: 0,
          }
        : {
            ...emptyFileInfo(),
            path,
            size: vaultEntry.size,
            mtime: vaultEntry.mtime,
            sha: vaultEntry.sha,
            mode: "",
            blob: vaultEntry.blob,
          };

    applySeedAncestor(deps, tracked, local.sha, path);

    let verdict: Diff3Result;
    try {
      verdict = await _diff3(diff3Deps, tracked, local, headHash);
    } catch (e) {
      if (e instanceof NetworkError || e instanceof AuthError) {
        // Finding #2 (owner): abort, never per-file skip — the journal
        // stays, the next drain repeats the WHOLE Vault-step.
        return statusFromError(e, result);
      }
      // Confirmed-absent data (repo corruption class) — not a network
      // failure, retry won't help: record and move on (§12.5.D).
      vaultStepErrors.push({ path, error: String(e) });
      continue;
    }

    if (verdict.kind === "plugin-dispatch") {
      // Same INTERIM rule as the batch site (gate decision), incl.
      // the lazy remote-mtime fetch.
      if (tracked.remote.mtime === null && headHash !== null) {
        const info = await deps.retry.run(() =>
          deps.client.getCommitInfoForPath(path, headHash!),
        );
        if (info.error !== null) return statusFromError(info.error, result);
        tracked.remote.mtime =
          info.result?.committedAtMs ?? tracked.remote.mtime;
      }
      deps.logger?.warn(
        "plugin-core collision resolved by mtime in Vault-step (interim)",
        { path },
      );
      verdict = {
        kind: "file",
        file: pickNewestForObsidian(local, tracked.remote),
      };
    }
    if (verdict.kind === "manual-conflict") {
      // A conflict born ON the Vault-step (delete-vs-modify or
      // edit-vs-modify discovered just now) — the THIRD birth site.
      // Unlike STEP1 it never pushed to the conflict branch, so no
      // conflictBase existed yet: it is initialized as tracked.remote
      // (= R_m, the same content the first sibling holds) — the
      // correct diff3 ancestor for the NEXT drain's STEP2/STEP3.
      const blob = await ensureRemoteBlob(tracked);
      if (blob.abort !== null) return blob.abort;
      if (!blob.found) {
        // NOT_FOUND before the record exists → simply don't create it
        // (same effect as "no conflict this drain"); base NOT
        // advanced, the next drain retries.
        vaultStepErrors.push({
          path,
          error: `remote blob ${tracked.remote.sha} not in repo (conflict not registered)`,
        });
        continue;
      }
      if (tracked.remote.deviceLabel === null && headHash !== null) {
        // The third (and last) lazy device_label site.
        const info = await deps.retry.run(() =>
          deps.client.getCommitInfoForPath(path, headHash!),
        );
        if (info.error !== null) return statusFromError(info.error, result);
        tracked.remote.deviceLabel = info.result?.deviceLabel ?? null;
        tracked.remote.mtime =
          info.result?.committedAtMs ?? tracked.remote.mtime;
      }
      await saveConflictSiblingFile(deps.vault, {
        path,
        mtime: tracked.remote.mtime ?? 0,
        deviceLabel: tracked.remote.deviceLabel,
        blob: tracked.remote.blob,
      });
      conflicts!.entries.set(path, {
        conflictBase: siblingInfoFrom(tracked.remote),
        siblings: [siblingInfoFrom(tracked.remote)],
      });
      tracked.isManualConflict = true;
      conflictVerdicts.push({ path, site: "vault-step" });
      continue;
    }

    const v = verdict.file;
    if (vaultEntry !== null && v.sha === vaultEntry.sha) {
      // The live vault already holds exactly this content.
      tracked.base = tracked.remote;
      continue;
    }
    if (v.mode === DELETED || v.sha === DELETED_SHA_HASH) {
      if (vaultEntry !== null) {
        await deps.vaultFiles.remove(path);
        vaultStepRemoves.push(path);
      }
      tracked.base = tracked.remote;
      continue;
    }
    let bytes = v.blob;
    if (bytes === null) {
      bytes = await deps.syncStore.getBlobFromSyncStore(v.sha!, verifiedShas);
      if (bytes === null) {
        const r = await deps.retry.run(() =>
          deps.client.getBlobFromRepo(v.sha!),
        );
        if (r.error !== null) return statusFromError(r.error, result);
        bytes = r.result;
        if (bytes === null) {
          vaultStepErrors.push({
            path,
            error: `remote blob ${v.sha} not in repo`,
          });
          continue;
        }
        if (!(await deps.syncStore.existInSyncStore(v.sha!))) {
          await deps.syncStore.saveBlobToSyncStore(v.sha!, bytes);
        }
      }
    }
    // S1 — pull-side sanitize port (owner decision, THE SWITCH п.3;
    // §III vault-step annotation): a remote path the local platform
    // can't materialise (mobile CRASHED on desktop-legal names — the
    // field case) is written under its CANONICAL name instead. The
    // bookkeeping stays honest: the epilogue records baselines[P] =
    // remote truth, the vault (by the local-sanitize invariant) never
    // holds P → the next findChanges emits deletion(P)+addition(P')
    // and the next drain pushes the rename. No pending-deletions
    // store — its role dissolved into the honest baseline. Conflicts
    // cannot be born on P (the local side never exists), so the
    // sibling-name path never carries forbidden chars from here.
    let writePath = path;
    if (needsSanitization(path)) {
      const canonical = sanitizeFilename(path);
      if ((await deps.vaultFiles.stat(canonical)) !== null) {
        // Mirror of the old engine's collision rule: skip LOUDLY and
        // drop the tracked record — recording baselines[P] here would
        // make the next commit-pass push a DELETION of remote P whose
        // content never landed anywhere locally (silent loss). The
        // absent baseline makes the next drain re-report P instead.
        deps.logger?.warn(
          "Vault-step: forbidden-path target exists, sanitize skipped",
          { remote: path, local_canonical: canonical },
        );
        state.trackedFiles.delete(path);
        continue;
      }
      deps.logger?.info("Vault-step: sanitized remote forbidden path", {
        from: path,
        to: canonical,
      });
      writePath = canonical;
    }
    await deps.vaultFiles.write(writePath, bytes);
    vaultStepWrites.push(writePath);
    // The bytes we just wrote ARE the remote content (hash-proven on
    // load / by construction): record the proven size so the epilogue
    // writes a TRUE baseline instead of falling back to 0 (which
    // would defeat the change detector's stat short-circuit forever).
    if (tracked.remote.size === null) tracked.remote.size = bytes.byteLength;
    tracked.base = tracked.remote;
  }

  // ── EPILOGUE (§III steps 1-4; step 5 = the sync_store sweep).
  // Runs ONLY on the fully-completed
  // path — every abort above returns BEFORE it, leaving the journal
  // alive so the next run redoes the Vault-step + epilogue (§IV.2).
  // Order: step 2 MUST precede step 4 (after the journal dies, the
  // durable store is the only conflicts carrier); 1/3 are
  // interchangeable under the same redo umbrella.

  // Step 1 — baseline transfer: each tracked path's final remote
  // becomes the durable per-file baseline. GROUP ops (§2.2.1) — K
  // bucket writes, never N path writes. `mtime: 0` on purpose:
  // precision here is harmful (a user edit DURING the drain with an
  // equal size would short-circuit invisibly forever — D.15); the
  // detector self-heals with exactly one re-hash (D.14). A
  // placeholder record (remote.sha null — idle lingering conflict)
  // transfers NOTHING: writing nulls would erase the path's real
  // previous baseline. Deleted paths LEAVE metadata.files.
  {
    const writes: Array<{
      path: string;
      baselineSha: string;
      mtime: number;
      size: number;
    }> = [];
    const removals: string[] = [];
    for (const [path, tracked] of state.trackedFiles) {
      if (tracked.remote.sha === null) continue; // placeholder guard
      if (
        tracked.remote.mode === DELETED ||
        tracked.remote.sha === DELETED_SHA_HASH
      ) {
        removals.push(path);
        continue;
      }
      // `size` is about TRUTH here, not speed: a 0 written for an
      // unknown size permanently defeats the change detector's
      // stat short-circuit (`stat.size === snap.size` can never
      // hold), so the path is fully re-read + re-hashed on EVERY
      // findChanges until something re-syncs it through the
      // tree fallback. Discovery's compare path gives no sizes, so
      // take it for free: bytes in hand → byteLength; else the
      // content-addressed store's stat; only then the honest 0.
      // In-memory bytes FIRST (owner's preference order): they are
      // hash-proven, so byteLength CANNOT be wrong; the store's stat
      // trusts the file name and is the weaker fallback.
      let size = tracked.remote.size;
      if (size === null) {
        size =
          tracked.remote.blob?.byteLength ??
          (await deps.syncStore.sizeOf(tracked.remote.sha));
      }
      writes.push({
        path,
        baselineSha: tracked.remote.sha,
        mtime: 0,
        size: size ?? 0,
      });
    }
    if (writes.length > 0) await deps.baselines.setMany(writes);
    if (removals.length > 0) await deps.baselines.removeMany(removals);
  }

  // Step 2 — one more reconcile pass (the Vault-step may have created
  // sibling duplicates) + the durable conflicts save. MUST land
  // before step 4.
  conflicts = await processConflicts(
    {
      vault: deps.vault,
      store: deps.conflictStore,
      computeSha: deps.computeSha,
      logger: deps.logger,
    },
    conflicts,
  );
  await deps.conflictStore.save(conflicts);

  // Step 3 — the CONFIRMED hot anchor, exactly once per completed
  // drain (§1.C). The (commit, tree) pair goes TOGETHER; when this
  // run never learned the head's tree (pull-only drain — no push, no
  // merge), one getCommit aligns the pair honestly. ⚠️ Deliberate
  // deviation from the spec's 'значення НЕ змінюється' note for that
  // case: leaving the OLD tree beside the NEW commit is exactly the
  // skew METAFILE §2.1.2 forbids — one request per pull-only drain is
  // the price of an honest anchor.
  if (headHash !== null && knownHeadTreeSha === null) {
    // …and when the head never moved, the stored anchor is already the
    // honest pair for THIS commit (§II.7.1): `hot` still holds the
    // pre-run values here — update() is the next statement, not this
    // one. Measured 2026-09-23: this was the 5th round trip of an
    // empty sync, spent re-learning what was already on disk.
    if (headHash === deps.hot.getLastSyncCommitSha()) {
      knownHeadTreeSha = deps.hot.getLastSyncTreeSha();
    }
  }
  if (headHash !== null && knownHeadTreeSha === null) {
    // Either the head moved, or the stored pair had no tree to give
    // (a pre-anchor install) — pay for it honestly.
    const r = await deps.retry.run(() =>
      deps.client.getCommit({ sha: headHash!, retry: true }),
    );
    if (r.error !== null) return statusFromError(r.error, result);
    knownHeadTreeSha = r.result!.tree.sha;
  }
  await deps.hot.update({
    lastSyncCommitSha: headHash,
    lastSyncTreeSha: knownHeadTreeSha,
    // Nulled ONLY by a confirmed FINALIZE (merge+delete or 404) —
    // 'no conflicts right now' is NOT 'the branch was merged'.
    conflictBranchName: state.conflictBranchName,
  });

  // Step 4 — the journal dies; its absence tells the next run
  // 'previous drain finished'. Both slots, 404-tolerant.
  await deps.journal.clear();

  // Step 5 — the §12.5 sweep, drain-END edition: the journal died in
  // step 4, so everything a completed drain no longer references is
  // reaped now (batch dirs are gone, resolved conflicts pruned).
  await sweepSyncStore(deps);

  return result("ok");
}

// Batch entry → local FileInfo, §III "for each local in batch" prologue:
// mtime from the batch METAFILE (enqueue-time, canonical-writeback-safe;
// 0 = owner's ambiguity-loses-to-remote fallback), bytes from
// sync_store with the live-vault repair fallback (§12.5.B: changed or
// gone → skip, next detection re-emits).
// §12.5 rearangeSyncStore — both drain boundaries call this. A sweep
// failure never aborts a drain (it is hygiene, not correctness): warn
// and continue.
async function sweepSyncStore(deps: DrainDeps): Promise<void> {
  if (!deps.queueReferencedShas) return;
  try {
    const r = await deps.syncStore.sweep([
      deps.queueReferencedShas,
      () => deps.journal.collectReferencedShas(),
      () => deps.conflictStore.collectReferencedShas(),
      // Source №5 (HISTORY-DELETED §5.2.1): the Deleted bin's pending
      // captures. Their bytes are referenced by NOTHING else until the
      // deletion reaches a batch — miss this and the restore window
      // dies between a delete and its commit.
      async () => deps.deletedBinReferencedShas?.() ?? new Set<string>(),
    ]);
    if (r.removed > 0) {
      deps.logger?.info("sync_store sweep", r);
    }
  } catch (err) {
    deps.logger?.warn("sync_store sweep failed (hygiene only)", {
      err: `${err}`,
    });
  }
}

async function loadLocalFromBatch(
  deps: DrainDeps,
  entry: BatchEntry,
): Promise<FileInfo | null> {
  const local: FileInfo = {
    ...emptyFileInfo(),
    path: entry.path,
    sha: entry.sha,
    size: entry.size,
    mtime: entry.mtime ?? 0,
    mode: entry.sha === null ? DELETED : "",
  };
  if (local.mode === DELETED) return local;

  local.blob = await deps.syncStore.getBlobFromSyncStore(
    entry.sha!,
    new Set(), // first read of batch content always hash-verifies
  );
  if (local.blob !== null) return local;

  // Repair from the live vault when it still matches (size gate first
  // — §12.9; the claimer's crash repair uses the same recipe).
  const vaultFile = await deps.vaultFiles.read(entry.path);
  if (
    vaultFile !== null &&
    (entry.size === null || vaultFile.size === entry.size) &&
    vaultFile.sha === entry.sha
  ) {
    await deps.syncStore.saveBlobToSyncStore(entry.sha!, vaultFile.blob);
    local.blob = vaultFile.blob;
    return local;
  }
  deps.logger?.warn(
    "drain: batch entry unrecoverable (vault changed/gone) — skipped; next detection re-emits",
    { path: entry.path },
  );
  return null;
}

// Persisted-FileInfo normalizer for conflicts.json: strip the blob
// (never serialized) and BACKFILL `size` from it while it is still in
// hand. Discovery's compare path yields size=null, and a null size in
// a stored sibling later trips _diff3's rule-6 assert on the fold
// (gate finding 2026-08-31).
function siblingInfoFrom(info: FileInfo): FileInfo {
  return {
    ...info,
    size: info.size ?? info.blob?.byteLength ?? null,
    blob: null,
  };
}

// DOT-FILES §8.0 — the "fake ancestor" for a managed .gitignore.
//
// `enforce()` writes our managed .gitignore files before any sync has
// happened, so on a cold start OUR OWN write meets the repo's own
// .gitignore with no common base and rule 4.2 calls it a manual
// conflict the user never caused (measured twice on real GitHub).
//
// A file whose bytes are exactly what we seed is not user content, it
// is our proposal — so it may serve as the BASE for its own path:
// the repo's version then reads as an ordinary edit on top of it and
// resolves as a clean pull (4.3, or 3.b.2.b inside .obsidian/ — same
// outcome, and it replaces that branch's mtime coin-flip with a
// determined answer). The next enforce() splices our block into the
// adopted file and it travels back as an ordinary local change.
//
// THREE conditions, and the third is not optional:
//   - no baseline yet (this is a first meeting, nothing else to use);
//   - the marker matches the CURRENT local sha (any user edit drops
//     the claim, and the path returns to ordinary rules — including a
//     legitimate conflict, which is scenario B);
//   - THE REMOTE ACTUALLY HAS THE PATH. Without this the substitution
//     would make base == local with remote == null, which no rule
//     handles: 2.a/2.b need matching nullness, 4.3-4.6 all require
//     local.sha !== base.sha, so it falls through to the merge path
//     with a null remote. Today that case is base==null → 4.1.a →
//     "push ours", which is exactly right and must stay.
function applySeedAncestor(
  deps: DrainDeps,
  tracked: TrackedFile,
  localSha: string | null,
  path: string,
): void {
  if (tracked.base.sha !== null) return;
  if (tracked.remote.sha === null) return;
  if (!deps.gitignoreSeeds?.matches(path, localSha)) return;
  tracked.base = {
    ...tracked.base,
    path,
    sha: localSha,
  };
  deps.logger?.info("§8.0: seeded .gitignore acts as its own base", {
    path,
  });
}


function statusFromError(
  error: unknown,
  result: (s: DrainStatus) => DrainResult,
): DrainResult {
  if (error instanceof AuthError) {
    // The live token latch belongs to the manager; the module reports
    // the status + the 401/403 class (§35 invalid-vs-scope).
    const r = result("token-expired");
    r.authErrorStatus = error.status === 403 ? 403 : 401;
    return r;
  }
  if (error instanceof NetworkError) {
    return result("network-error");
  }
  throw error; // domain errors and bugs propagate loudly
}
