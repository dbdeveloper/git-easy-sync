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
// PHASE 6, settled 2026-10-02: `vaultStepErrors` reach the LOG, and
// exactly ONE of them also reaches the user — see
// `DrainResult.cancelledConflicts` for the owner's rule and why the
// other eight sites stay quiet. What remains of Phase 6 here is the
// §VIII D/K crash matrix.

import { type Vault } from "obsidian";
import { encodeBase64 } from "../utils";
import { isOwnPluginRecoverableFile } from "./plugin-update-bootloader";
import { MAX_SYNC_FILE_BYTES } from "./change-detector";
import { pluginRootOf, readPluginVersion } from "./plugin-js";
import { compareSemver } from "./semver";
import { requireApiVersion } from "obsidian";
import {
  decideHold,
  isHeldPath,
  pluginFolderOf,
  type HeldPluginUpdates,
} from "./held-plugins";
import {
  addRecheckPaths,
  dropRecheckPath,
  readRecheckPaths,
} from "./recheck-paths";
import { NewTreeRequestItem } from "../github/client";
import ConflictStoreV2, {
  ConflictsState,
} from "./conflict-store-v2";
import SiblingTx from "./sibling-tx";
import { processConflicts } from "./process-conflicts";
import {
  buildSiblingFilePath,
  readSiblingFileFromVault,
  saveConflictSiblingFile,
} from "./conflict-siblings";
import { NetworkError, AuthError, ValidationError, BaseFileNotInRepoError } from "../errors";
import NetworkRetry from "./retry-network";
import SyncStore from "./sync-store";
import {
  appendProgress,
  clearProgress,
  keepProvenStats,
  replayProgress,
  type ProgressRecord,
} from "./vault-step-progress";
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
import { freeNameFor, needsSanitization, sanitizeFilename } from "./cross-platform";

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
  // §II.20 — what a pull write does to these bytes (the user's "Auto-
  // canonicalize text files"): whether it rewrites this path, and the
  // bytes it would land. Optional: absent = writes land as given.
  canonicalizesOnWrite?(path: string): boolean;
  canonicalize?(path: string, bytes: ArrayBuffer): ArrayBuffer;
  // Vault-step apply: write merged/remote bytes, or delete the path.
  write(path: string, bytes: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  // ⚠️ OUR OWN plugin's loadable files (main.js, manifest.json,
  // styles.css) never take the two calls above. They are staged beside
  // the live file with a completion marker, and the BOOTLOADER applies
  // them at the top of the next onload — the only moment at which the
  // file Obsidian loads can be replaced by code that is still running
  // and healthy. Written live, a crash leaves us damaged or absent,
  // and every repair mechanism we own lives inside the file that is
  // broken (owner, 2026-10-01).
  stageSelfUpdate(path: string, bytes: ArrayBuffer): Promise<void>;
  // "Are these exact bytes already staged AND complete?" — asked
  // before the blob is fetched, so an update waiting for a restart is
  // not re-downloaded on every sync.
  isSelfUpdateStaged(path: string, sha: string): Promise<boolean>;
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
    // Group read (one bucket open per bucket) — what the baseline
    // transfer uses to keep a proven stat (keepProvenStats).
    getMany(
      paths: string[],
    ): Promise<Map<string, { baselineSha: string; mtime: number; size: number }>>;
    setMany(
      entries: Array<{
        path: string;
        baselineSha: string;
        mtime: number;
        size: number;
      }>,
    ): Promise<void>;
    removeMany(paths: string[]): Promise<void>;
    // Every baseline under a prefix — what a hold has to rescue before
    // the change detector erases it (§5.4). Folder-shaped on purpose:
    // the unit of holding is the plugin, and the paths in the incoming
    // change are only ever a subset of what the hold makes invisible.
    listUnder(
      prefix: string,
    ): Promise<
      Array<{ path: string; baselineSha: string; mtime: number; size: number }>
    >;
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
    // Plugin updates held back because this Obsidian cannot load them
    // yet (§5.5). `{}` is the normal state, and the drain is the only
    // place that writes it.
    getHeldPluginUpdates(): HeldPluginUpdates;
    // Epilogue step 3 — the CONFIRMED anchor, written exactly once
    // per fully-completed drain (§1.C METAFILE), one ping-pong blob.
    // ⚠️ PARTIAL: the hold gate writes `heldPluginUpdates` alone, mid
    // run, because the record and the baselines it rescues must land
    // together (§5.5) — the epilogue is far too late for that.
    update(fields: {
      lastSyncCommitSha?: string | null;
      lastSyncTreeSha?: string | null;
      conflictBranchName?: string | null;
      heldPluginUpdates?: HeldPluginUpdates;
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
  // A conflict copy was REPLACED by a newer server version (STEP3): the
  // host forgets the OLD copy at once — closes its editor tabs and wipes its
  // diff2-autosave dir (owner, 2026-10-09). A hook because the engine must
  // not touch the diff2 layer. Best-effort: a failure is logged, the drain
  // goes on.
  onConflictCopyReplaced?: (path: string, oldSiblingPath: string) => Promise<void>;
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
  // ⚠️ THE SUBSET OF `vaultStepErrors` THE USER MUST BE TOLD ABOUT.
  //
  // Owner's rule, 2026-10-02: «там де є сподівання, що наступна
  // ітерація виправить помилку — можна просто писати в лог. Якщо ж це
  // зміна поведінки, яку користувач не очікує — писати хоча б щось».
  //
  // Almost every `vaultStepError` passes the first half: the path is
  // dropped from tracking and written into `.recheck-paths`, so the
  // NEXT sync asks about it again — and the commonest cause (GitHub's
  // own eventual consistency; see the open 422 BadObjectState note)
  // clears by itself in minutes. Telling the user about those would be
  // noise that teaches them to ignore the channel.
  //
  // This array is the other half, and today exactly one site qualifies:
  // a conflict whose content is confirmed GONE from the repo has its
  // conflict mode CANCELLED. Nothing retries it — the record is deleted
  // on purpose so a later restore cannot resurrect it — and the thing
  // that vanished is something the user was looking at. Silence there
  // is the engine changing its mind behind their back.
  cancelledConflicts: string[];
  // Conflict copies that are NEW this run — born or appended (one entry per
  // copy, by base path). A replace is NOT new: it updates a copy that was
  // there. For the log line after a Sync (owner, 2026-10-09).
  newConflictCopies: string[];
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
  // Paths staged for the bootloader (our own plugin's loadable files).
  // Reported for the log — the update is pending, not applied.
  selfUpdateStaged: string[];
  // Paths this drain REALLY changed on the main branch — the "N sent" of
  // the sync summary (owner, 2026-10-05). A path enters only when its
  // local side won AND differed from the server (an entry identical to
  // the server is never added to a tree), and only once the commit
  // holding it is CONFIRMED: a 422 restart, a network drop or a cancel
  // before the ref move leaves nothing behind. Distinct, in first-push
  // order. Conflict-branch pushes are NOT here — a conflict is reported
  // on its own.
  pushedPaths: string[];
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
  const cancelledConflicts: string[] = [];
  const newConflictCopies: string[] = [];
  const pushedCommits: string[] = [];
  const vaultStepWrites: string[] = [];
  const vaultStepRemoves: string[] = [];
  // §II.19 — the progress log: one line per path whose outcome this run
  // has fixed (base == remote), appended AFTER the vault write / removal
  // or the confirmed push, never before. Any exit short of the epilogue —
  // cancel, network drop, a dead battery — leaves these lines behind, and
  // the next commit pass replays them into the baselines first, so the
  // files are not taken for local additions. `progressLogged` keeps one
  // line per (path, sha) per run.
  const progressLogged = new Map<string, string>();
  let progressDirKnown = false;
  // What the log costs per run — field measurement (the owner rejects
  // unmeasured performance claims): logged once, at the epilogue.
  const progressStats = { lines: 0, ms: 0 };
  const noteProgress = async (paths: Iterable<string>): Promise<void> => {
    const records: ProgressRecord[] = [];
    for (const path of paths) {
      const tracked = state.trackedFiles.get(path);
      if (tracked === undefined || tracked.isManualConflict) continue;
      // Our own loadable files have another baseline writer that runs at
      // onload, BEFORE any replay (the applied self-update) — a line here
      // could roll it back. At most three spare commits after a crash.
      if (isOwnPluginRecoverableFile(path, configDir, deps.selfPluginId)) continue;
      const sha = tracked.remote.sha;
      if (sha === null || tracked.base.sha !== sha) continue;
      if (progressLogged.get(path) === sha) continue;
      if (tracked.remote.mode === DELETED || sha === DELETED_SHA_HASH) {
        records.push({ path, deleted: true });
      } else {
        const size =
          tracked.remote.size ??
          tracked.remote.blob?.byteLength ??
          (await deps.syncStore.sizeOf(sha));
        records.push({ path, sha, size: size ?? 0 });
      }
      progressLogged.set(path, sha);
    }
    if (records.length === 0) return;
    const t0 = performance.now();
    progressDirKnown = await appendProgress(
      deps.vault.adapter,
      selfPluginDir,
      records,
      progressDirKnown,
    );
    progressStats.lines += records.length;
    progressStats.ms += performance.now() - t0;
  };
  // §II.20 — "same content under the user's canonicalization" (owner,
  // 2026-10-10). Does `localSha` hold what a PULL of `remoteSha` writes?
  // The exact sha, or — when the vault's writer canonicalizes this path
  // ("Auto-canonicalize text files") — the canonical form of the remote
  // bytes. Without this, every sha comparison of "what is on disk" with
  // "what is in the repo" sees a CRLF-vs-LF difference the user does not.
  // Bytes from sync_store first, network second (saved back); a network
  // failure aborts, as everywhere in the drain.
  const samePulledForm = async (
    path: string,
    remoteSha: string,
    localSha: string,
  ): Promise<{ abort: DrainResult | null; same: boolean }> => {
    if (localSha === remoteSha) return { abort: null, same: true };
    const vf = deps.vaultFiles;
    if (vf.canonicalizesOnWrite?.(path) !== true || vf.canonicalize === undefined) {
      return { abort: null, same: false };
    }
    let bytes = await deps.syncStore.getBlobFromSyncStore(remoteSha, verifiedShas);
    if (bytes === null) {
      const r = await deps.retry.run(() => deps.client.getBlobFromRepo(remoteSha));
      if (r.error !== null) return { abort: statusFromError(r.error, result), same: false };
      bytes = r.result;
      if (bytes === null) return { abort: null, same: false };
      await deps.syncStore.saveBlobToSyncStore(remoteSha, bytes);
    }
    const pulled = vf.canonicalize(path, bytes);
    return { abort: null, same: (await deps.computeSha(pulled)) === localSha };
  };
  // Does the vault hold exactly the remote version this journal record
  // carries? (§IV.2 row 7a.) A deletion counts as held when the file is
  // gone. One read per path, and only for a journal path whose remote
  // moved again — the rare resume case, never an ordinary drain. "Exactly"
  // means as a pull writes it (§II.20): the canonical form, when the user
  // canonicalizes.
  const vaultHoldsRemoteOf = async (
    tracked: TrackedFile,
  ): Promise<{ abort: DrainResult | null; same: boolean }> => {
    const path = tracked.remote.path ?? tracked.base.path;
    if (path === null) return { abort: null, same: false };
    const live = await deps.vaultFiles.read(path);
    if (tracked.remote.mode === DELETED || tracked.remote.sha === DELETED_SHA_HASH) {
      return { abort: null, same: live === null };
    }
    if (live === null) return { abort: null, same: false };
    return samePulledForm(path, tracked.remote.sha!, live.sha);
  };
  // Our own plugin's files put beside the live ones for the bootloader
  // to apply at the next start. NOT part of vaultStepWrites on
  // purpose: that list drives the plugin-reload signal, and there is
  // nothing to reload — the running code is still the old code, by
  // design.
  const selfUpdateStaged: string[] = [];
  const pushedPaths = new Set<string>();
  const configDir = deps.vault.configDir;
  const selfPluginDir = `${configDir}/plugins/${deps.selfPluginId}`;
  // Paths this run SKIPPED. Each one is invisible to every future
  // delta (the pointer advances past the commit that carried the
  // change), so the next drain is told to ask about them directly —
  // owner, 2026-10-02: «краще зайвий раз перепитати ніж щось
  // пропустити».
  const recheck = new Set<string>();
  // ⚠️ WRITE-AHEAD (owner, 2026-10-02): the note goes down BEFORE the
  // drain moves on from the skip, never at the end of the run. Written
  // at the end it would carry a window of its own — a run that reached
  // its epilogue, advanced the pointer and then failed to write the
  // note would forget the skip forever. Record the intent first, clear
  // it once the work is confirmed; the self-update marker and the
  // gitignore migration already work this way.
  const noteRecheck = async (p: string): Promise<void> => {
    recheck.add(p);
    await addRecheckPaths(deps.vault.adapter, selfPluginDir, [p]);
  };
  // What a PREVIOUS run (or the bootloader) asked us to re-check.
  // Read once; the epilogue replaces the file with whatever THIS run
  // still owes, so a consumed request disappears and a repeated skip
  // survives.
  const requestedRecheck = await readRecheckPaths(
    deps.vault.adapter,
    selfPluginDir,
    selfPluginDir,
  );
  if (requestedRecheck.torn) {
    deps.logger?.warn(
      "recheck note unreadable — falling back to our own plugin files",
      { paths: requestedRecheck.paths },
    );
  }
  let finalizedMergeSha: string | null = null;

  // ── PLUGIN-UPDATE-COMPAT Фаза 2 (§5.12) — the ONE gate ────────────
  //
  // A plugin update meant for a NEWER Obsidian than this device runs
  // must not reach the disk at all: the files would land correctly,
  // the plugin would fail to load, and it would keep failing on every
  // restart until the app catches up. Held paths are then invisible to
  // sync in BOTH directions (§5.3) — which is what stops a user's
  // hand-installed (therefore OLDER) copy from travelling back and
  // rolling the update back on healthy devices.
  //
  // The working copy of the record set for THIS run. Mutated in place
  // and persisted through `hot.update`, which is the only writer.
  const held: HeldPluginUpdates = { ...deps.hot.getHeldPluginUpdates() };

  // Lifting comes FIRST, before discovery, and the order is not
  // symmetry: discovery answers with the `base…head` DELTA, and the
  // commit that updated a held plugin sits BEHIND the base — it was
  // skipped while the hold was on. Only the subtree read below can
  // bring it, so it has to happen while there is still a drain to
  // carry the result (§5.12.3).
  const liftHolds = async (
    headHash: string | null,
  ): Promise<DrainResult | null> => {
    for (const id of Object.keys(held)) {
      const record = held[id];
      // Offline, every drain, costs nothing: the condition is a string
      // comparison against the running app's version (§5.6).
      if (!requireApiVersion(record.minAppVersion)) continue;
      if (headHash === null) {
        // Empty repo — nothing to lift from. The record stays; there
        // is no state to reach and no harm in waiting.
        deps.logger?.info("hold not lifted: empty repo", { id });
        continue;
      }
      const folder = `${configDir}/plugins/${id}`;
      // 1. BASELINES FIRST (§5.6 step 1). While the hold was on, the
      //    change detector's Pass 2 deleted every baseline under this
      //    folder ("gitignore is a two-way mute"). Without putting
      //    them back, Pass 1 would read every local file as NEW and
      //    push the OLD version — the §5.4 downgrade.
      if (record.baselines.length > 0) {
        await deps.baselines.setMany(record.baselines);
      }
      // 2. STATE AGAINST STATE, not a delta (§5.12.3). The subtree at
      //    `head` versus the baselines we just restored answers every
      //    shape at once — modified, added, and REMOVED — and has no
      //    base that can become unreachable after months of holding.
      const tree = await deps.retry.run(() =>
        deps.client.getRepoTreeAtCommit(headHash),
      );
      if (tree.error !== null) return statusFromError(tree.error, result);
      if (tree.result!.truncated) {
        // ⚠️ §II.13.2's trap, inherited whole: an incomplete list
        // means "absent from the LIST", never "absent from the repo".
        // Reading it as deletion would wipe the plugin's folder.
        deps.logger?.warn("hold not lifted: tree truncated", { id });
        continue;
      }
      const prefix = `${folder}/`;
      const remote = tree.result!.files.filter((f) =>
        f.path.startsWith(prefix),
      );
      const seen = new Set<string>();
      // Any file of the bundle that could not be applied keeps the
      // whole hold in place. A plugin is not four independent files:
      // lifting on a PARTIAL apply would leave the folder mixed, with
      // nothing left to say so — the record is the only thing that
      // remembers this plugin is waiting.
      let incomplete = false;
      for (const f of remote) {
        seen.add(f.path);
        const live = await deps.vaultFiles.read(f.path);
        // Already right — do not write, and above all do not trigger a
        // plugin reload for a file nobody changed.
        if (live !== null && live.sha === f.sha) continue;
        const isSelf = isOwnPluginRecoverableFile(
          f.path,
          configDir,
          deps.selfPluginId,
        );
        if (isSelf && (await deps.vaultFiles.isSelfUpdateStaged(f.path, f.sha))) {
          continue;
        }
        const blob = await deps.retry.run(() =>
          deps.client.getBlobFromRepo(f.sha),
        );
        if (blob.error !== null) return statusFromError(blob.error, result);
        if (blob.result === null) {
          vaultStepErrors.push({
            path: f.path,
            error: `held update: blob ${f.sha} not in repo`,
          });
          incomplete = true;
          continue;
        }
        if (isSelf) {
          // OUR OWN files are staged even here: the bootloader is the
          // only writer of the file Obsidian loads (owner 2026-10-01),
          // and that rule does not bend because the write happens to
          // come from a lift. The baseline stays OLD for the same
          // reason it does in the Vault-step.
          await deps.vaultFiles.stageSelfUpdate(f.path, blob.result);
          selfUpdateStaged.push(f.path);
          continue;
        }
        await deps.vaultFiles.write(f.path, blob.result);
        vaultStepWrites.push(f.path);
        await deps.baselines.setMany([
          {
            path: f.path,
            baselineSha: f.sha,
            // mtime 0 by the epilogue's convention: a real mtime here
            // can hide a user edit made DURING the drain behind the
            // detector's stat short-circuit (D.15).
            mtime: 0,
            size: f.size ?? blob.result.byteLength,
          },
        ]);
      }
      // 3. DELETION, which only state-against-state can express
      //    (§7.1.2): a file we were holding that is no longer in the
      //    repo goes now, and not a moment earlier — while the hold
      //    was on, the plugin kept working locally on purpose.
      const gone = record.baselines
        .map((b: { path: string }) => b.path)
        .filter((p: string) => !seen.has(p));
      for (const p of gone) {
        if ((await deps.vaultFiles.stat(p)) !== null) {
          await deps.vaultFiles.remove(p);
          vaultStepRemoves.push(p);
        }
      }
      if (gone.length > 0) await deps.baselines.removeMany(gone);
      // 4. The record goes LAST (§5.6). Until this line the paths are
      //    still non-syncable, so a crash anywhere above leaves a
      //    consistent held state and the next drain simply retries.
      //    Dropping it first and failing afterwards would leave live
      //    paths with restored-but-stale baselines — the downgrade
      //    again, in a new wrapper.
      if (incomplete) {
        deps.logger?.warn("hold NOT lifted: the bundle applied only partly", {
          id,
        });
        continue;
      }
      delete held[id];
      await deps.hot.update({ heldPluginUpdates: { ...held } });
      deps.logger?.info("plugin update hold LIFTED", {
        id,
        minAppVersion: record.minAppVersion,
      });
    }
    return null;
  };

  // The gate. Runs after `trackedFiles` is seeded from discovery, so
  // every incoming path is known — and BEFORE any blob is fetched,
  // which is what makes "read the manifest, never the bundle" true
  // (§5.12.2): blobs are pulled lazily at the Vault-step, and a held
  // folder never gets there.
  const applyHolds = async (): Promise<DrainResult | null> => {
    const groups = new Map<string, string[]>();
    for (const path of state.trackedFiles.keys()) {
      const owner = pluginFolderOf(path, configDir);
      if (owner === null) continue;
      if (held[owner.id] !== undefined) continue; // already held
      const list = groups.get(owner.id);
      if (list === undefined) groups.set(owner.id, [path]);
      else list.push(path);
    }
    for (const [id, paths] of groups) {
      const folder = `${configDir}/plugins/${id}`;
      const manifestPath = `${folder}/manifest.json`;
      const manifestTracked = state.trackedFiles.get(manifestPath);
      let manifestText: string | null = null;
      if (
        manifestTracked !== undefined &&
        manifestTracked.remote.sha !== null &&
        manifestTracked.remote.sha !== DELETED_SHA_HASH &&
        manifestTracked.remote.mode !== DELETED
      ) {
        // ONE blob, and the smallest file in the bundle. The decision
        // has to precede `main.js` — which is the whole point: holding
        // after downloading a megabyte would still be correct and
        // still be wasteful, and on a phone that waste is the user's
        // data plan.
        const blob = await deps.retry.run(() =>
          deps.client.getBlobFromRepo(manifestTracked.remote.sha!),
        );
        if (blob.error !== null) return statusFromError(blob.error, result);
        if (blob.result !== null) {
          manifestText = new TextDecoder().decode(blob.result);
        }
      }
      const decision = decideHold(manifestText);
      if (!decision.hold) continue;
      // Save the baselines of the WHOLE folder, not just the paths in
      // this change (§5.4): the hold makes every one of them ignored,
      // and Pass 2 deletes the baseline of every newly-ignored path.
      const baselines = await deps.baselines.listUnder(`${folder}/`);
      held[id] = {
        minAppVersion: decision.minAppVersion,
        heldVersion: decision.heldVersion,
        baselines,
      };
      await deps.hot.update({ heldPluginUpdates: { ...held } });
      // Out of tracking, or the Vault-step would still write them: the
      // predicate keeps new work away, it does not retract work
      // already seeded this run.
      for (const path of paths) state.trackedFiles.delete(path);
      deps.logger?.info("plugin update HELD for this Obsidian", {
        id,
        heldVersion: decision.heldVersion,
        needs: decision.minAppVersion,
        files: paths.length,
      });
    }
    return null;
  };

  // Discovery leaves `remote.mtime` null; the §II.1 п.3.b.e tiebreak
  // and the plugin resolver's fallback both need it, and only the
  // network has it. Hoisted to the run's scope so BOTH callers use the
  // same one — two hand-copied versions of a lazy fill is how only one
  // of them ends up correct (the 2026-09-23 field finding).
  const fillRemoteMtime = async (
    path: string,
    tracked: TrackedFile,
  ): Promise<DrainResult | null> => {
    if (tracked.remote.mtime !== null || headHash === null) return null;
    const info = await deps.retry.run(() =>
      deps.client.getCommitInfoForPath(path, headHash!),
    );
    if (info.error !== null) return statusFromError(info.error, result);
    tracked.remote.mtime = info.result?.committedAtMs ?? tracked.remote.mtime;
    return null;
  };

  // ── §28 — a plugin-core collision is decided by VERSION ──────────
  //
  // Until PLUGIN-UPDATE-COMPAT this was pure mtime: newest wins,
  // remote on ambiguity. That rule is right for ordinary `.obsidian/`
  // files and wrong for a plugin bundle, because here "newer" has a
  // PUBLISHED meaning. `manifest.json` says which version the bytes
  // belong to; a clock says only which device wrote last — and the
  // device that wrote last is routinely the one running the OLDER
  // build (it re-saved a setting, or BRAT reinstalled a pinned
  // version).
  //
  // The clock is kept as the fallback, not deleted: equal versions,
  // or a version we cannot read, say nothing about which bundle is
  // newer, and inventing an answer there would be worse than the
  // honest tiebreak E4 already pins.
  const resolvePluginCollision = async (
    path: string,
    local: FileInfo,
    tracked: TrackedFile,
  ): Promise<{ file: FileInfo } | { abort: DrainResult }> => {
    const root = pluginRootOf(path, configDir);
    const byClock = async (
      reason: string,
    ): Promise<{ file: FileInfo } | { abort: DrainResult }> => {
      // Discovery leaves remote.mtime null — fill it LAZILY or the
      // tiebreak degenerates into "remote always wins" (gate finding,
      // E4).
      const abort = await fillRemoteMtime(path, tracked);
      if (abort !== null) return { abort };
      deps.logger?.info("plugin-core collision resolved by mtime", {
        path,
        reason,
      });
      return { file: pickNewestForObsidian(local, tracked.remote) };
    };
    if (root === null) return byClock("not under a plugin folder");

    const manifestPath = `${root}/manifest.json`;
    const localManifest = await deps.vaultFiles.read(manifestPath);
    const localVersion =
      localManifest === null
        ? null
        : readPluginVersion(new TextDecoder().decode(localManifest.blob));

    // The remote manifest AT HEAD. Preferred from tracking when the
    // same change already carries it (the ordinary case: a plugin
    // update moves manifest.json and the bundle together); otherwise
    // one metadata read, because a collision is rare and a wrong
    // winner is not.
    let remoteManifestSha = state.trackedFiles.get(manifestPath)?.remote.sha ?? null;
    if (remoteManifestSha === null && headHash !== null) {
      const meta = await deps.retry.run(() =>
        deps.client.getContentsMetadataAtRef(manifestPath, headHash!),
      );
      if (meta.error !== null) return { abort: statusFromError(meta.error, result) };
      remoteManifestSha = meta.result?.sha ?? null;
    }
    let remoteVersion: string | null = null;
    if (remoteManifestSha !== null && remoteManifestSha !== DELETED_SHA_HASH) {
      const blob = await deps.retry.run(() =>
        deps.client.getBlobFromRepo(remoteManifestSha!),
      );
      if (blob.error !== null) return { abort: statusFromError(blob.error, result) };
      if (blob.result !== null) {
        remoteVersion = readPluginVersion(new TextDecoder().decode(blob.result));
      }
    }

    if (localVersion === null || remoteVersion === null) {
      return byClock(
        `version unreadable (local=${localVersion ?? "?"}, remote=${remoteVersion ?? "?"})`,
      );
    }
    const cmp = compareSemver(remoteVersion, localVersion);
    if (cmp === null) {
      return byClock(`version not comparable (${localVersion} vs ${remoteVersion})`);
    }
    if (cmp === 0) {
      return byClock(`same version on both sides (${localVersion})`);
    }
    const winner = cmp > 0 ? "remote" : "local";
    deps.logger?.info("plugin-core collision resolved by VERSION", {
      path,
      localVersion,
      remoteVersion,
      winner,
    });
    return { file: cmp > 0 ? tracked.remote : local };
  };

  const result = (status: DrainStatus): DrainResult => ({
    status,
    layer2Corrections,
    conflictVerdicts,
    vaultStepErrors,
    cancelledConflicts,
    newConflictCopies,
    pushedCommits,
    finalizedMergeSha,
    vaultStepWrites,
    vaultStepRemoves,
    selfUpdateStaged,
    pushedPaths: [...pushedPaths],
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

  // §II.19 — a previous run's progress log goes into the baselines
  // BEFORE this run reads or writes any. For a pure-pull run there is no
  // journal, so §IV.2 row 7a cannot help it: these lines are what tell
  // the resume that the files it already wrote are in sync. Replayed
  // first, so no stale line can land after a newer baseline write.
  {
    const n = await replayProgress(deps.vault.adapter, selfPluginDir, deps.baselines);
    if (n > 0) deps.logger?.info("progress log replayed into the baselines", { lines: n });
  }

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

      // §5.12.3 — BEFORE discovery, deliberately: discovery answers
      // with the base…head delta, and the commit that updated a held
      // plugin lies BEHIND the base. Only the subtree read inside
      // liftHolds can bring it.
      {
        const abort = await liftHolds(headHash);
        if (abort !== null) return abort;
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
            // A journal from an interrupted run (cancel, network abort,
            // crash — §IV.2 row 7a) holds the base it had BEFORE its
            // Vault-step, while that step may already have written the
            // remote version it carried. Replacing that remote with a
            // newer one would compare the vault against a stale base:
            // a file this device had just pulled turned into a conflict
            // (owner's field report, 2026-10-10). The vault itself says
            // what happened: it holds exactly the remote version the
            // journal carried → that version IS the common ancestor.
            if (
              !tracked.isManualConflict &&
              tracked.remote.sha !== null &&
              tracked.base.sha !== tracked.remote.sha
            ) {
              const held = await vaultHoldsRemoteOf(tracked);
              if (held.abort !== null) return held.abort;
              if (held.same) tracked.base = { ...tracked.remote, blob: null };
            }
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

      // «Краще зайвий раз перепитати ніж щось пропустити» (owner,
      // 2026-10-02). A path a previous run SKIPPED is invisible to
      // every delta from now on — the pointer advanced past the commit
      // that carried its change — so the only way back is to ask the
      // server about it DIRECTLY. One metadata request per path, and
      // only for paths something already went wrong with.
      if (headHash !== null) {
        for (const p of requestedRecheck.paths) {
          if (state.trackedFiles.has(p)) continue; // the delta brought it anyway
          const meta = await deps.retry.run(() =>
            deps.client.getContentsMetadataAtRef(p, headHash!),
          );
          if (meta.error !== null) return statusFromError(meta.error, result);
          if (meta.result === null) {
            // Absent at head. NOT read as a deletion: this note can
            // name a path that never reached the repo at all, and
            // inventing a delete from "I asked and got nothing" is how
            // a skip would turn into data loss. Dropping the question
            // is safe — the file on disk still matches its baseline.
            continue;
          }
          const baseline = await deps.baselines.get(p);
          state.trackedFiles.set(p, {
            base: {
              ...emptyFileInfo(),
              path: baseline !== undefined ? p : null,
              sha: baseline?.baselineSha ?? null,
              size: baseline?.size ?? null,
              mtime: baseline?.mtime ?? null,
            },
            remote: {
              ...emptyFileInfo(),
              path: p,
              sha: meta.result.sha,
              size: meta.result.size,
            },
            isManualConflict: false,
          });
          deps.logger?.info("re-asking about a previously skipped path", {
            path: p,
          });
        }
      }

      // §5.12.2 — the gate, after seeding and before any blob is
      // fetched. A folder held here never reaches the Vault-step, so
      // "read the manifest, never the bundle" needs no special
      // plumbing: blobs are lazy, and a held path is simply gone.
      {
        const abort = await applyHolds();
        if (abort !== null) return abort;
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
              contentBase64: encodeBase64(bytes),
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
          "Remote check: the repository listing was cut short by GitHub — checking files one by one",
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
      deps.logger?.info("Remote check: repository listing read in one request", {
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
    const conflictCommitEntries: Array<{ path: string; sha: string | null }> =
      [];
    const mainPushTracked: TrackedFile[] = [];
    const mainPushPaths: string[] = [];

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
          content: encodeBase64(local.blob!),
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

      // §5.12.2 — a batch staged BEFORE the hold can still carry the
      // held folder's paths; the predicate cannot retract what is
      // already claimed. Skipped, never pushed (owner, 2026-10-01):
      // under a hold the only version installable by hand is a
      // COMPATIBLE, i.e. OLDER, one, and letting it travel would roll
      // the update back on every healthy device. The batch still
      // completes — the entry counts as disposed of.
      if (isHeldPath(entry.path, configDir, held)) {
        deps.logger?.info("batch entry skipped: plugin update held", {
          path: entry.path,
        });
        continue;
      }

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
          deps.logger?.warn("Remote check: the server's file differs from the change list — corrected", {
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
      // …and the null-as-base form of it (2026-10-05): an empty remote
      // half means "unchanged since base", and Layer 2 has just CONFIRMED
      // that against the live ref — so an entry equal to its own base is
      // already what the server holds; pushing it would make an empty
      // "Sync at…" commit. ⚠️ Only with a head: with headHash null Layer 2
      // is skipped and null means "nothing on the server" — that entry
      // must be pushed (_diff3's 4.5.c returns local, and the push below
      // runs because null !== its sha). In practice an empty repo is
      // seeded above first, so headHash is null here only when seeding
      // could not happen; the guard keeps the rule "skip only what Layer
      // 2 verified" true regardless.
      if (
        headHash !== null &&
        tracked.remote.sha === null &&
        tracked.base.sha !== null &&
        tracked.base.sha === local.sha
      ) {
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
      // §II.20 — NO common record, but the queued local version is exactly
      // what a pull of the remote writes (the user canonicalizes, the repo
      // holds CRLF / a BOM): then the remote IS the common ancestor — this
      // device's own pull would have made `local` from it. Supply that
      // base and let the ordinary rules decide (local changed → the
      // canonical version is pushed: the same normalization commit an
      // ordinary pull of a non-canonical file leads to). Never applied
      // when a real base exists — §6.4 (A) stands for real differences.
      if (
        tracked.base.sha === null &&
        tracked.remote.sha !== null &&
        tracked.remote.mode !== DELETED &&
        tracked.remote.sha !== DELETED_SHA_HASH &&
        local.sha !== null &&
        local.sha !== tracked.remote.sha
      ) {
        const s2 = await samePulledForm(entry.path, tracked.remote.sha, local.sha);
        if (s2.abort !== null) return s2.abort;
        if (s2.same) tracked.base = { ...tracked.remote, blob: null };
      }
      if (needsObsidianMtimeTiebreak(tracked, local)) {
        const abort = await fillRemoteMtime(entry.path, tracked);
        if (abort !== null) return abort;
      }
      let verdict = await _diff3(diff3Deps, tracked, local, headHash);
      if (verdict.kind === "plugin-dispatch") {
        // §28 — the version decides, the clock is only the fallback.
        const r = await resolvePluginCollision(entry.path, local, tracked);
        if ("abort" in r) return r.abort;
        verdict = { kind: "file", file: r.file };
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
          await addFileToTree(
            acc,
            deps.client,
            uploadedBlobs,
            { path: entry.path, sha: D.sha, blob: D.blob, mode: D.mode },
            deps.logger,
          );
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
        mainPushPaths.push(entry.path);
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

    // S1 cancel (push boundary, owner 2026-09-26 — field report). The
    // per-file loop above is LOCAL and finishes in milliseconds; what
    // the user actually waits through is the stretch below: flush →
    // commit → ref move, measured at ~3-4 s on the owner's device. It
    // had no checkpoint, so a click landing there was simply lost and
    // "Sync canceled" never appeared.
    //
    // Safe by the same D.16 argument as the batch boundary: nothing of
    // THIS batch has reached a ref yet, the batch dir is not removed
    // and the journal holds the last COMPLETED batch. Mid-batch
    // flushes may have left dangling trees on GitHub — objects with no
    // ref, which GitHub collects, exactly as a 422 restart leaves them.
    if (deps.cancelRequested?.()) return result("cancelled");

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
      // Counted HERE, after the confirmed push, never earlier.
      for (const p of mainPushPaths) pushedPaths.add(p);
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
    // §II.19 — the paths this batch has settled (pushed, or equal to the
    // remote from the start): the push is confirmed and the journal is on
    // disk, so the lines describe a fact. Without them a run that dies
    // later re-commits these files (field report: 7 pushed files).
    await noteProgress(state.trackedFiles.keys());
    await deps.removeBatchDir(claimed.dir);
  }

  // ── FINALIZE (§II.14) — ONCE, after the batch loop, BEFORE the
  // Vault-step (a per-batch merge would move the main head under the
  // next push). Gate: a branch name exists AND no unresolved tracked
  // conflicts remain. The merge is a REACHABILITY merge: the commit
  // carries the MAIN tree (content no-op) with parents
  // [main, conflict] — POST /merges is never used (a content merge
  // would resurrect the superseded C_n over the user's resolution).
  // S1 cancel (FINALIZE boundary): the merge below is another
  // multi-request stretch — compare, getCommit, createMergeCommit, the
  // main ref move, the branch delete. FINALIZE is idempotent by
  // construction (§II.14 checks reachability first), so skipping it
  // costs nothing: the next drain finds the same branch and merges it.
  if (deps.cancelRequested?.()) return result("cancelled");
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
    // S1 cancel (Vault-step boundary, owner 2026-09-26). THE phase
    // where cancelling matters most: this loop writes every pulled
    // file into the vault and fetches the blobs it needs, so on a big
    // pull it is where the user waits — and until now [Cancel sync]
    // did nothing here.
    //
    // Exiting mid-loop is not a new path to invent: the network abort
    // a few lines down already leaves exactly this state, by an
    // explicit owner decision ("abort, never per-file skip — the
    // journal stays, the next drain repeats the WHOLE Vault-step").
    // The journal survives (only the epilogue clears it), so the next
    // run resumes and finishes.
    //
    // ⚠️ BEFORE countPull: a path we are not going to process must not
    // be counted as processed.
    if (deps.cancelRequested?.()) {
      return result("cancelled");
    }
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
          // The ONE site that notifies (owner's rule — see
          // `DrainResult.cancelledConflicts`). Nothing here retries:
          // the record is deleted deliberately, and what disappeared is
          // something the user was looking at.
          cancelledConflicts.push(path);
          vaultStepErrors.push({
            path,
            error:
              "conflict content vanished from the repo — conflict mode cancelled",
          });
        // 🔴 OUT OF TRACKING, or the epilogue transfers
        // `tracked.remote` into the baseline for a file nothing wrote
        // — and the next scan then reads the user's own copy as an
        // edit and PUSHES it over the repo (found 2026-10-02).
          state.trackedFiles.delete(path);
          await noteRecheck(path);
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
        newConflictCopies.push(path);
        // Every conflict decision is in the log (owner, 2026-10-09 — a
        // field test could not tell from it why a copy stayed).
        deps.logger?.warn("Conflict: the server's version is saved as a conflict copy next to the file", {
          path,
          server: tracked.remote.sha?.slice(0, 7),
          from: tracked.remote.deviceLabel,
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
      // 🔴 OUT OF TRACKING — see the note at the first skip site: a
      // surviving record makes the epilogue claim a baseline the
      // Vault-step never produced.
        state.trackedFiles.delete(path);
        await noteRecheck(path);
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
      // The sha of the bytes ON DISK, not the recorded one: the user may
      // have edited the sibling, and with the recorded sha _diff3 would see
      // "ours unchanged vs the origin" and drop that edit (owner, 2026-10-09).
      const prevWithBlob: FileInfo = {
        ...previousSibling,
        blob: prevBlob,
        sha: await deps.computeSha(prevBlob),
        size: prevBlob.byteLength,
      };
      // The ANCESTOR is the main version the sibling was last made from
      // (owner, 2026-10-09) — NOT conflictBase: that is OUR side, and with
      // it every repeated remote change of the same line appended one more
      // sibling instead of replacing the old one. A fresh remote descends
      // on main from exactly the origin, so diff3 carries main's change
      // onto the sibling and keeps any edit the user made in it. Its bytes
      // come sync_store → GitHub inside _diff3 (owner's choice a).
      const foldAncestor: FileInfo = {
        ...emptyFileInfo(),
        path,
        sha: previousSibling.originSha ?? previousSibling.sha,
        mode: "",
      };
      let foldVerdict;
      try {
        try {
          foldVerdict = await _diff3(
            diff3Deps,
            { base: foldAncestor, remote: tracked.remote },
            prevWithBlob,
            headHash,
          );
        } catch (e) {
          // The origin's bytes are in neither sync_store nor GitHub (history
          // rewritten on GitHub, the local store swept). Only an EDITED copy
          // needs them — an unedited one is decided by sha alone. Without a
          // fallback the fold failed on every sync and the copy froze at its
          // old version (owner, 2026-10-09, choice a): fold the old way, from
          // OUR side — it appends a second copy instead of freezing.
          if (!(e instanceof BaseFileNotInRepoError)) throw e;
          deps.logger?.warn("Conflict copy: its origin version is gone from GitHub — merging from your side instead (a second copy may appear)", {
            path,
            origin: foldAncestor.sha?.slice(0, 7),
          });
          foldVerdict = await _diff3(
            diff3Deps,
            { base: current.conflictBase, remote: tracked.remote },
            prevWithBlob,
            headHash,
          );
        }
      } catch (e) {
        if (e instanceof NetworkError || e instanceof AuthError) {
          return statusFromError(e, result); // abort — journal stays (§II.6 п.8)
        }
        // NOT_FOUND class with siblings ≠ [] → skip only, NO mode
        // cancellation — the other tracked siblings still stand (C.9).
        vaultStepErrors.push({ path, error: String(e) });
        // 🔴 OUT OF TRACKING — see the note at the first skip site: a
        // surviving record makes the epilogue claim a baseline the
        // Vault-step never produced.
        state.trackedFiles.delete(path);
        await noteRecheck(path);
        continue;
      }

      if (foldVerdict.kind === "file") {
        // diff3 OK → REPLACE the last sibling via the §II.11 mark
        // transaction (the only branch that destroys evidence).
        const merged = foldVerdict.file;
        if (merged.sha === prevWithBlob.sha) {
          // No-op fold (the fresh pull equals the sibling — §II.6
          // "якщо тільки послідовно вони не однакові"): nothing to
          // replace. Running the transaction here would be worse than
          // wasteful — old and new derive the SAME file name, so
          // step 4 would delete the file step 2 just wrote.
          // The ORIGIN still moves on to the remote just folded (a copy
          // — `merged` may be previousSibling itself), or the next fold
          // would start from an older ancestor than main has passed.
          conflicts!.entries.set(path, {
            conflictBase: current.conflictBase,
            siblings: [
              ...current.siblings.slice(0, -1),
              { ...previousSibling, originSha: tracked.remote.sha },
            ],
          });
          deps.logger?.info("Conflict copy already holds the newer server version — left as is", {
            path,
            server: tracked.remote.sha?.slice(0, 7),
          });
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
      // 🔴 OUT OF TRACKING — see the note at the first skip site: a
      // surviving record makes the epilogue claim a baseline the
      // Vault-step never produced.
            state.trackedFiles.delete(path);
            await noteRecheck(path);
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
        merged.originSha = tracked.remote.sha; // the next fold's ancestor
        // The OLD sibling as it is ON DISK (sha/size of its bytes): the
        // §II.11 recovery verifies its integrity against this, and a
        // user-edited copy checked against the RECORDED sha would read as
        // torn and fall out of tracking after a crash mid-replace.
        await deps.siblingTx.runReplaceTransaction(
          conflicts!,
          path,
          { ...prevWithBlob, blob: null, originSha: foldAncestor.sha },
          merged,
        );
        deps.logger?.info("Conflict copy updated to the newer server version (old copy replaced)", {
          path,
          from: foldAncestor.sha?.slice(0, 7),
          to: tracked.remote.sha?.slice(0, 7),
        });
        const oldSiblingPath = buildSiblingFilePath(
          path,
          previousSibling.mtime ?? 0,
          previousSibling.deviceLabel,
        );
        try {
          await deps.onConflictCopyReplaced?.(path, oldSiblingPath);
        } catch (err) {
          deps.logger?.warn("Could not forget the replaced conflict copy (tabs / autosave)", {
            path,
            err: String(err),
          });
        }
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
      // 🔴 OUT OF TRACKING — see the note at the first skip site: a
      // surviving record makes the epilogue claim a baseline the
      // Vault-step never produced.
          state.trackedFiles.delete(path);
          await noteRecheck(path);
          continue;
        }
        await saveConflictSiblingFile(deps.vault, {
          path,
          mtime: tracked.remote.mtime ?? 0,
          deviceLabel: tracked.remote.deviceLabel,
          blob: tracked.remote.blob,
        });
        deps.logger?.warn("Conflict: the newer server version clashes with the edits in the conflict copy — a second conflict copy is added", {
          path,
          server: tracked.remote.sha?.slice(0, 7),
          from: tracked.remote.deviceLabel,
        });
        conflicts!.entries.set(path, {
          conflictBase: current.conflictBase,
          siblings: [...current.siblings, siblingInfoFrom(tracked.remote)],
        });
        newConflictCopies.push(path);
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

    // §II.20 — the vault already holds what a pull of the remote writes
    // (its canonical form, when the user canonicalizes): local == remote
    // as the user sees them, so nothing is left to decide, whatever the
    // base — the rule "local == remote → that content" holds for any
    // base. Settled without a write; a raw-vs-canonical difference is
    // then the next commit pass's ordinary normalization, not a conflict.
    if (
      vaultEntry !== null &&
      tracked.remote.sha !== null &&
      tracked.remote.mode !== DELETED &&
      tracked.remote.sha !== DELETED_SHA_HASH &&
      vaultEntry.sha !== tracked.remote.sha
    ) {
      const s3 = await samePulledForm(path, tracked.remote.sha, vaultEntry.sha);
      if (s3.abort !== null) return s3.abort;
      if (s3.same) {
        tracked.base = tracked.remote;
        await noteProgress([path]);
        continue;
      }
    }

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
      // 🔴 OUT OF TRACKING — see the note at the first skip site: a
      // surviving record makes the epilogue claim a baseline the
      // Vault-step never produced.
      state.trackedFiles.delete(path);
      await noteRecheck(path);
      continue;
    }

    if (verdict.kind === "plugin-dispatch") {
      // §28, the same resolver as the batch site — one rule, called
      // twice. The hand-copied second version of the lazy mtime fetch
      // that used to live here is gone with it: two copies of a
      // precondition is how only one of them stays correct (§II.13.1).
      const r = await resolvePluginCollision(path, local, tracked);
      if ("abort" in r) return r.abort;
      verdict = { kind: "file", file: r.file };
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
        // (same effect as "no conflict this drain"), and the next
        // drain retries.
        //
        // ⚠️ This comment used to say "base NOT advanced" and that was
        // only half true: `tracked.base` indeed stayed, but the
        // epilogue transfers `tracked.remote` — so the PERSISTED
        // baseline, which is what the next scan reads, advanced to a
        // version the vault never received. Dropping the record is
        // what makes the sentence true (2026-10-02).
        vaultStepErrors.push({
          path,
          error: `remote blob ${tracked.remote.sha} not in repo (conflict not registered)`,
        });
        state.trackedFiles.delete(path);
        await noteRecheck(path);
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
      newConflictCopies.push(path);
      deps.logger?.warn("Conflict: the server's version is saved as a conflict copy next to the file", {
        path,
        server: tracked.remote.sha?.slice(0, 7),
        from: tracked.remote.deviceLabel,
      });
      tracked.isManualConflict = true;
      conflictVerdicts.push({ path, site: "vault-step" });
      continue;
    }

    const v = verdict.file;
    if (vaultEntry !== null && v.sha === vaultEntry.sha) {
      // The live vault already holds exactly this content.
      tracked.base = tracked.remote;
      await noteProgress([path]);
      continue;
    }
    // ⚠️ OUR OWN plugin's loadable files are STAGED, never written
    // live (owner, 2026-10-01). Asked BEFORE the blob is fetched so an
    // update waiting for the user's next restart is not re-downloaded
    // on every sync — which on a phone is the difference between a
    // pending update and a recurring megabyte.
    const isSelf =
      v.sha !== null &&
      isOwnPluginRecoverableFile(path, configDir, deps.selfPluginId);
    if (isSelf && (await deps.vaultFiles.isSelfUpdateStaged(path, v.sha!))) {
      // 🔴 OUT OF TRACKING, and the same trap as the staging site one
      // branch below — found by the skip matrix, 2026-10-02. The
      // update is STAGED, not applied: the running `main.js` is still
      // the old one. A surviving record makes the epilogue write the
      // new sha as the baseline, and the next scan then reads the
      // RUNNING version as a local edit and pushes it — the
      // self-downgrade the staging path exists to prevent, arriving
      // one drain later.
      state.trackedFiles.delete(path);
      // Still pending, so the question stays open: if the bootloader
      // later refuses these bytes, the next run must know to ask.
      await noteRecheck(path);
      continue;
    }
    if (v.mode === DELETED || v.sha === DELETED_SHA_HASH) {
      if (vaultEntry !== null) {
        await deps.vaultFiles.remove(path);
        vaultStepRemoves.push(path);
      }
      tracked.base = tracked.remote;
      await noteProgress([path]); // AFTER the removal (§II.19)
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
          // 🔴 OUT OF TRACKING — see the note at the first skip site:
          // a surviving record makes the epilogue claim a baseline the
          // Vault-step never produced.
          state.trackedFiles.delete(path);
          await noteRecheck(path);
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
    if (isSelf) {
      await deps.vaultFiles.stageSelfUpdate(path, bytes);
      selfUpdateStaged.push(path);
      deps.logger?.info("self-update staged for the next start", { path });
      // 🔴 THE TRAP, and it is silent without the test that pins it.
      // The live file still holds the OLD bytes, so the baseline must
      // keep saying OLD. Recording the staged (NEW) sha would make the
      // next findChanges read the RUNNING version as a local edit and
      // PUSH it — publishing a downgrade of our own plugin to every
      // device, which is §5.9.1's scenario arriving through another
      // door.
      //
      // ⚠️ Dropping the tracked record is what achieves that, NOT
      // leaving `tracked.base` alone: the epilogue's baseline transfer
      // reads `tracked.remote`, so a record left behind would carry
      // the new sha into the baseline no matter what `base` says.
      // Found by a mutation probe — the version without this line
      // passed every other test in the suite.
      //
      // Losing the record costs nothing: the head has not moved, so
      // the next discovery does not re-report the path, and once the
      // bootloader applies the update the next scan sees disk ==
      // remote and settles the baseline in one no-op pass.
      state.trackedFiles.delete(path);
      await noteRecheck(path);
      continue;
    }
    let writePath = path;
    if (needsSanitization(path)) {
      const canonical = sanitizeFilename(path);
      // A TAKEN canonical name gets the first free " (N)" (owner,
      // 2026-10-10 — the push side's rule). It used to SKIP the file:
      // the user then never saw it at all, which is worse than seeing it
      // under an unusual name. The content now lands locally, so the
      // baseline for P is as true as in a plain sanitize — the next
      // commit pass pushes the rename, nothing is lost.
      const target = await freeNameFor(
        canonical,
        async (p) => (await deps.vaultFiles.stat(p)) !== null,
      );
      if (target !== canonical) {
        deps.logger?.warn(
          "Vault-step: the safe name for a forbidden remote path is taken — writing to a numbered name",
          { remote: path, taken: canonical, to: target },
        );
      } else {
        deps.logger?.info("Vault-step: sanitized remote forbidden path", {
          from: path,
          to: canonical,
        });
      }
      writePath = target;
    }
    await deps.vaultFiles.write(writePath, bytes);
    vaultStepWrites.push(writePath);
    // The bytes we just wrote ARE the remote content (hash-proven on
    // load / by construction): record the proven size so the epilogue
    // writes a TRUE baseline instead of falling back to 0 (which
    // would defeat the change detector's stat short-circuit forever).
    if (tracked.remote.size === null) tracked.remote.size = bytes.byteLength;
    tracked.base = tracked.remote;
    await noteProgress([path]); // AFTER the write (§II.19)
  }

  // ── EPILOGUE (§III steps 1-4; step 5 = the sync_store sweep).
  // Runs ONLY on the fully-completed
  // path — every abort above returns BEFORE it, leaving the journal
  // alive so the next run redoes the Vault-step + epilogue (§IV.2).
  // Order: step 2 MUST precede step 4 (after the journal dies, the
  // durable store is the only conflicts carrier); 1/3 are
  // interchangeable under the same redo umbrella.

  // Clearing is the only half that belongs HERE: a request may be
  // dropped only once the work it asked for is confirmed, and that is
  // what reaching the epilogue means. A run that aborted leaves every
  // request standing, and the next one asks again.
  for (const consumed of requestedRecheck.paths) {
    if (recheck.has(consumed)) continue;
    // Asked and answered — drop it from the note. Done one path at a
    // time rather than by wiping the file, because the bootloader may
    // have added a request WHILE this drain was running.
    await dropRecheckPath(deps.vault.adapter, selfPluginDir, consumed);
  }

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
    await keepProvenStats(deps.baselines, writes);
    if (writes.length > 0) await deps.baselines.setMany(writes);
    if (removals.length > 0) await deps.baselines.removeMany(removals);
    // §II.19 ⚠️ every baseline is written now; a progress line left
    // behind could later roll one of them back. Gone right after step 1.
    await clearProgress(deps.vault.adapter, selfPluginDir);
    if (progressStats.lines > 0) {
      deps.logger?.info("progress log cost", {
        lines: progressStats.lines,
        ms: Math.round(progressStats.ms),
      });
    }
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
// Exported ONLY for the sweep-race tests (tests/sync2/sweep-reuse-races):
// the order of the sources below is a correctness property, and it can
// only be pinned against the real list.
export async function sweepSyncStore(deps: DrainDeps): Promise<void> {
  if (!deps.queueReferencedShas) return;
  try {
    const r = await deps.syncStore.sweep([
      // Source №5 (HISTORY-DELETED §5.2.1): the Deleted bin's pending
      // captures. Their bytes are referenced by NOTHING else until the
      // deletion reaches a batch — miss this and the restore window
      // dies between a delete and its commit.
      //
      // ⚠️ It is read FIRST, before the queue — the order is the fix
      // (COMMIT-PASS-PERF §6, defect A). A concurrent commit hands the
      // sha over by writing the batch metafile and THEN releasing the
      // bin record. Bin read first: a record released before this read
      // means the metafile was already on disk, and the queue source,
      // read later, sees it; a record not yet released is caught here.
      // Bin read LAST, a commit finishing between the queue read and
      // the bin read left the blob named by neither, and it was reaped
      // although the batch still listed it as restorable. Same rule as
      // SyncStore's in-flight pins: whoever releases after the metafile
      // must be read before the metafiles are.
      async () => deps.deletedBinReferencedShas?.() ?? new Set<string>(),
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

  // Over GitHub's limit (queued before the commit-side gate existed, or by
  // an older build): never loaded, never sent — skipped like an
  // unrecoverable entry, so the REST of its batch still ships (owner,
  // 2026-10-11: one 204 MB video failed every drain, and nothing else went
  // out). The commit side no longer re-emits it.
  if ((entry.size ?? 0) > MAX_SYNC_FILE_BYTES) {
    deps.logger?.warn("drain: batch entry over GitHub's size limit — skipped", {
      path: entry.path,
      size: entry.size,
      limit: MAX_SYNC_FILE_BYTES,
    });
    return null;
  }

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
// A sibling is born from a remote version — that version is its origin
// (the next fold's ancestor, §II.6 STEP3 п.4).
function siblingInfoFrom(info: FileInfo): FileInfo {
  return {
    ...info,
    size: info.size ?? info.blob?.byteLength ?? null,
    blob: null,
    originSha: info.sha,
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
//     would make base == local with remote == null. Until 2026-10-05 no
//     rule handled that state at all (it fell through to the merge path
//     — the very hole a canonical write-back later hit in the field;
//     _diff3 now has 4.5.c for it). The condition matters MORE than
//     that: Layer 2 runs after this substitution and, finding the path
//     absent on the server, marks the remote DELETED — and base == local
//     with remote DELETED resolves as a remote deletion: the user's
//     file would be REMOVED. Without the substitution the case is
//     base==null → 4.1.a → "push ours", which is exactly right and
//     must stay.
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
  deps.logger?.info(".gitignore written by this plugin is treated as already in sync (no conflict)", {
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
