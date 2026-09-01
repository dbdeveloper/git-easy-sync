// The new drain — main loop (NEW-DRAIN §III), Phase 4 assembly.
// NOT wired into the live engine: the cutover is Phase 5.5, after the
// conflict machinery (Phase 5) completes this module. Until then it
// exists as a module behind tests (fake client + the real Phase 1-3
// primitives).
//
// ── PHASE 5 SEAMS (explicit, greppable) ─────────────────────────────
// Every place the conflict machinery plugs in is marked `PHASE5:`.
// In Phase 4 a manual conflict is a VERDICT-AS-DATA: the loop records
// it in DrainResult.conflictVerdicts, sets the tracked flag and the
// in-memory/journal conflict record — but never pushes to the
// conflict branch, never writes sibling files, never finalizes.
// process_conflicts() / recoverSiblingTransactionIfNeeded() /
// STEP1-3 pushes / FINALIZE all arrive in Phase 5 and replace these
// seams in place.
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
//   null), merged result written back / deleted; conflict verdicts
//   born here are recorded (PHASE5 registers them);
// - progress by FILE COUNT only, through the injected callback. The
//   progress bar is not worth a single extra request (§4.1) — every
//   number here is already in hand.
//
// PHASE 6 (deliberately absent): the epilogue (baselines/hot/journal
// clear). The journal is persisted per batch and after the
// Vault-step, and intentionally LEFT on disk — the next drain resumes
// from it. Epilogue lands with Phase 6.

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
  // Optional trash seam: confirmResolved fires on the process_conflicts
  // prune transition (R3.5 layer 1b); confirmDeleted fires at batch
  // completion for deletion entries whose final remote state is
  // DELETED (layer 1a — the old manager:3891 site dies at THE SWITCH).
  trashHooks?: {
    confirmResolved(basePath: string): Promise<void>;
    confirmDeleted?(paths: string[]): Promise<void>;
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
  onProgress?: (processed: number, total: number, path?: string) => void;
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
  // PHASE5.5 (cutover): rearangeSyncStore() — the §12.5 sweep runs
  // here and again after the loop.

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
  // Discovery's complete picture of the repo at ONE pinned commit,
  // when it read the full tree. Layer 2 (§II.13) answers from it
  // instead of one HEAD request per file — see the call site for why
  // that is the same authority, not a shortcut around it. Set to null
  // whenever it can no longer be trusted for the CURRENT head.
  let remoteTree: RemoteTreeSnapshot | null = null;
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
          trashHooks: deps.trashHooks,
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
      if (state.conflictBranchName === null) {
        // Persist BEFORE any network call that would touch the branch
        // (§II.7) — the name must survive a crash even if this drain
        // never pushes to it.
        state.conflictBranchName = buildConflictBranchName(
          deps.deviceLabel(),
          deps.now(),
        );
        await deps.journal.persist(state);
      }

      // conflict_head_hash — always read LIVE, never persisted
      // (§II.7); null = the branch doesn't exist yet.
      {
        const r = await deps.retry.run(() =>
          deps.client.getBranchHeadSha(state.conflictBranchName!),
        );
        if (r.error !== null) return statusFromError(r.error, result);
        conflictHeadHash = r.result;
      }

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
    const conflictCommitEntries: Array<{ path: string; sha: string | null }> =
      [];
    const mainPushTracked: TrackedFile[] = [];

    // §II.7: the journal (conflicts) answers without the network on
    // the happy path; the live per-file check is the crash-safe
    // fallback (replaces the old bulk-diff). Returns null on an
    // abort-worthy network failure — the caller returns the result.
    const shouldPushToConflictBranch = async (
      path: string,
      sha: string | null, // null = ours is a DELETION
    ): Promise<{ should: boolean; abort: DrainResult | null }> => {
      const rec = conflicts!.entries.get(path);
      if (rec !== undefined && rec.conflictBase.sha === sha) {
        return { should: false, abort: null }; // journal confirms — no network
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
      // §4.1: progress by file count, numbers already in hand — the
      // progress bar is not worth a single extra request.
      processed += 1;
      deps.onProgress?.(processed, total, entry.path);

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

      let verdict = await _diff3(diff3Deps, tracked, local, headHash);
      if (verdict.kind === "plugin-dispatch") {
        // INTERIM (gate decision 2026-08-31): a genuine two-sided
        // plugin-core collision resolves like the rest of .obsidian —
        // newest wins, remote on ambiguity (3.b.e). Semver + bundle
        // atomicity (§28 class) return with PLUGIN-UPDATE-COMPAT.
        // Discovery leaves remote.mtime null — fetch it LAZILY (same
        // rule as the conflict-birth sites) or the tiebreak would
        // degenerate into "remote always wins" (gate finding, E4).
        if (tracked.remote.mtime === null && headHash !== null) {
          const info = await deps.retry.run(() =>
            deps.client.getCommitInfoForPath(entry.path, headHash!),
          );
          if (info.error !== null) return statusFromError(info.error, result);
          tracked.remote.mtime =
            info.result?.committedAtMs ?? tracked.remote.mtime;
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

    // S1 — trash R3.5 layer 1a: deletion entries whose FINAL remote
    // state is DELETED are now published (pushed by us, or dropped as
    // already-deleted — either way the remote agrees). A deletion that
    // LOST (remote modified → resurrect/conflict) is excluded: nothing
    // was published. Best-effort per the TrashHooks contract.
    if (deps.trashHooks?.confirmDeleted) {
      const published = claimed.meta.entries
        .filter((e) => e.sha === null)
        .map((e) => e.path)
        .filter((p) => {
          const t = state.trackedFiles.get(p);
          return (
            t !== undefined &&
            (t.remote.mode === DELETED || t.remote.sha === DELETED_SHA_HASH)
          );
        });
      if (published.length > 0) {
        try {
          await deps.trashHooks.confirmDeleted(published);
        } catch (err) {
          deps.logger?.warn(
            "drain: confirmDeleted hook failed (trash is best-effort)",
            { paths: published, err: `${err}` },
          );
        }
      }
    }

    // BATCH ОБРОБЛЕНО! One ping-pong journal write, then the dir.
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
          merged.blob =
            b ??
            (await (async () => {
              const r = await deps.retry.run(() =>
                deps.client.getBlobFromRepo(merged.sha!),
              );
              if (r.error !== null) return null;
              return r.result;
            })());
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

  // ── EPILOGUE (§III steps 1-4; step 5 = the sync_store sweep, wired
  // in the Phase 5.5 wiring commit). Runs ONLY on the fully-completed
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
      trashHooks: deps.trashHooks,
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
