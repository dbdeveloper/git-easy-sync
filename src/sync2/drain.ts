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

import { type Vault } from "obsidian";
import { NewTreeRequestItem } from "../github/client";
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
  Diff3Deps,
  FileInfo,
  _diff3,
  emptyFileInfo,
} from "./diff3";
import {
  RemoteFileChange,
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
  // Creates the commit on a READY tree and moves the branch ref.
  // Throws ValidationError on 422 (someone else moved the head).
  pushCommitFromTree(args: {
    treeSha: string;
    parent: string | null;
    message: string;
  }): Promise<{ sha: string; committedAt: number }>;
  // Layer 2 transport (§II.13 — the HEAD method in production).
  getContentsMetadataAtRef(
    path: string,
    ref: string,
  ): Promise<{ sha: string; size: number } | null>;
  getBlobFromRepo(sha: string): Promise<ArrayBuffer | null>;
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
  // metadata.files (Phase 1 cold buckets) — the diff3 base source.
  baselines: {
    get(
      path: string,
    ): Promise<{ baselineSha: string; mtime: number; size: number } | undefined>;
  };
  // Discovery Layer 1 (§II.12) — wired to discovery.ts in production,
  // a two-eyed fake in tests (P.8-13, truth vs discoveryAnswer).
  discoverChangedFiles(
    base: string | null,
    head: string,
  ): Promise<RemoteFileChange[]>;
  hot: { getLastSyncCommitSha(): string | null };
  tokenExpired(): Promise<boolean>;
  vaultFiles: VaultFileReader;
  mergeBlobs: Diff3Deps["mergeBlobs"];
  computeSha(bytes: ArrayBuffer): Promise<string>;
  maxAutoMergeFileSize(): number;
  deviceLabel(): string;
  commitMessage(): string;
  now(): number;
  onProgress?: (processed: number, total: number) => void;
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
  | "too-many-concurrent-pushes";

export interface DrainResult {
  status: DrainStatus;
  layer2Corrections: Layer2Correction[];
  conflictVerdicts: ConflictVerdict[];
  vaultStepErrors: Array<{ path: string; error: string }>;
  pushedCommits: string[]; // main-branch commit shas, in order
}

const ERROR_422_CAP = 5;

export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  // Drain-scoped state (§II.9 / §II.13 ownership: dies with this run).
  const verifiedShas = new Set<string>();
  const layer2Corrections: Layer2Correction[] = [];
  const conflictVerdicts: ConflictVerdict[] = [];
  const vaultStepErrors: Array<{ path: string; error: string }> = [];
  const pushedCommits: string[] = [];

  const result = (status: DrainStatus): DrainResult => ({
    status,
    layer2Corrections,
    conflictVerdicts,
    vaultStepErrors,
    pushedCommits,
  });

  // PHASE5: recoverSiblingTransactionIfNeeded() — the §II.11 mark
  // transaction recovery runs here, ONCE per drain, before the loop.
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

  while (true) {
    if (restartBatch) {
      // PHASE5: conflicts = process_conflicts() — the FS scan of
      // sibling files merged with the durable store. In Phase 4 the
      // only conflict source is the restored journal below.

      if (await deps.tokenExpired()) return result("token-expired");

      const baseHash = deps.hot.getLastSyncCommitSha();
      // base==null IS the cold-start signal — no separate flag, no
      // NEED_BOOTSTRAP: discovery step 0 reacts to it directly.

      // Restore the whole drain journal (one ping-pong blob, §V) or
      // start fresh. Re-restored on EVERY 422 restart — the failed
      // batch's in-memory mutations are discarded wholesale, which is
      // exactly the "batch is a transaction" rule.
      state = (await deps.journal.load()) ?? emptyDrainState();
      // PHASE5: RECONCILE — is_manual_conflict paths missing from the
      // fresh FS scan get the flag reset here (user resolved between
      // drains).

      {
        const r = await deps.retry.run(() => deps.client.getGuardedHead());
        if (r.error !== null) return statusFromError(r.error, result);
        headHash = r.result;
      }

      let remoteFiles: RemoteFileChange[] = [];
      if (headHash !== null && headHash !== baseHash) {
        const r = await deps.retry.run(() =>
          deps.discoverChangedFiles(baseHash, headHash!),
        );
        if (r.error !== null) return statusFromError(r.error, result);
        remoteFiles = r.result!;
      }
      // headHash == null: empty repo, nothing to read — the whole run
      // is one-directional (push local). headHash == baseHash: remote
      // did not move, the answer is known without the network call.

      if (state.conflictBranchName === null) {
        // Persist BEFORE any network call that would touch the branch
        // (§II.7) — the name must survive a crash even if this drain
        // never pushes to it. PHASE5 uses it; recording it now keeps
        // the §II.7 ordering true from day one.
        state.conflictBranchName = buildConflictBranchName(
          deps.deviceLabel(),
          deps.now(),
        );
        await deps.journal.persist(state);
      }

      // PHASE5: conflict_head_hash live read — only conflict pushes
      // consume it, none exist in Phase 4.

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
            // PHASE5: lazy getCommitInfoForPath refresh for
            // is_manual_conflict paths (device_label + mtime).
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
    // PHASE5: conflict_commit — the plain blob-list for the conflict
    // branch. Nothing collects into it in Phase 4.
    const mainPushTracked: TrackedFile[] = [];

    const total = claimed.meta.entries.length;
    let processed = 0;

    let batchAborted: DrainResult | null = null;
    let restartFromFlush = false;

    for (const entry of claimed.meta.entries) {
      // §4.1: progress by file count, numbers already in hand — the
      // progress bar is not worth a single extra request.
      processed += 1;
      deps.onProgress?.(processed, total);

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
        // PHASE5 (STEP2): shouldPushToConflictBranch + conflict-branch
        // blob push + conflictBase refresh. Phase 4 records the
        // verdict and keeps the spec's base advance.
        conflictVerdicts.push({ path: entry.path, site: "step2-existing" });
        tracked.base = tracked.remote;
        continue;
      }

      // ── Layer 2 (§II.13) — BEFORE the short-circuit ──────────────
      // Guard (2026-08-30): empty repo → the ref doesn't exist, there
      // is nothing to verify against, and a discovery blindspot is
      // impossible where the server holds nothing.
      if (headHash !== null) {
        const r = await deps.retry.run(() =>
          deps.client.getContentsMetadataAtRef(entry.path, headHash!),
        );
        if (r.error !== null) return statusFromError(r.error, result);
        const live = r.result;
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

      const verdict = await _diff3(diff3Deps, tracked, local, headHash);
      if (verdict.kind === "plugin-dispatch") {
        // PHASE7 seam (§II.1 п.3.a): plugin core files get their own
        // rules with PLUGIN-UPDATE-COMPAT. Until then: skip the path
        // loudly, advance nothing.
        deps.logger?.warn(
          "plugin-dispatch path skipped (rules arrive in Phase 7)",
          { path: entry.path },
        );
        continue;
      }
      if (verdict.kind === "manual-conflict") {
        // STEP1 — a NEW manual conflict. PHASE5: conflict-branch push
        // (shouldPushToConflictBranch + saveBlobToGitHub) + lazy
        // getCommitInfoForPath(device_label, mtime). Phase 4 keeps the
        // STATE half exactly per spec: without the flag the next batch
        // of this path would run rule 4.4 and clobber remote (the
        // I2/G9 class); Vault-step below needs it too.
        conflictVerdicts.push({ path: entry.path, site: "step1" });
        state.conflicts.set(entry.path, {
          conflictBase: local,
          siblings: [],
        });
        tracked.isManualConflict = true;
        tracked.base = tracked.remote;
        continue;
      }

      const D = verdict.file;
      if (tracked.remote.sha !== D.sha) {
        // Push D. Ensure bytes (D may be a sha-only side verdict).
        if (D.blob === null && D.mode !== DELETED) {
          D.blob = await deps.syncStore.getBlobFromSyncStore(
            D.sha!,
            verifiedShas,
          );
          if (D.blob === null) {
            const r = await deps.retry.run(() =>
              deps.client.getBlobFromRepo(D.sha!),
            );
            if (r.error !== null) return statusFromError(r.error, result);
            D.blob = r.result;
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
        await deps.journal.persist(state);
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
          await deps.journal.persist(state);
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
          message: deps.commitMessage(),
        }),
      );
      if (r.error !== null) {
        if (r.error instanceof ValidationError) {
          // 422: someone pushed while we were building. 422-CAP (I6):
          // give up cleanly after 5 in a row without a success —
          // journal already holds the last completed batch's state.
          error422Count += 1;
          if (error422Count >= ERROR_422_CAP) {
            await deps.journal.persist(state);
            return result("too-many-concurrent-pushes");
          }
          restartBatch = true;
          continue; // batch dir NOT removed — reprocessed with fresh remote state
        }
        return statusFromError(r.error, result);
      }
      const { sha, committedAt } = r.result!;
      headHash = sha; // MANDATORY: the next batch pushes against THIS head
      pushedCommits.push(sha);
      // mtime invariant: one authoritative GitHub date per batch,
      // stamped only after the CONFIRMED push.
      for (const t of mainPushTracked) t.remote.mtime = committedAt;
      error422Count = 0;
    }

    // PHASE5: conflict_commit push into the conflict branch (plain
    // blob list, its own 3-attempt loop) — nothing to push in Phase 4.
    // FINALIZE deliberately NOT here (per-batch merge would move the
    // main head under the next push) — it lives after the loop.

    // BATCH ОБРОБЛЕНО! One ping-pong journal write, then the dir.
    await deps.journal.persist(state);
    await deps.removeBatchDir(claimed.dir);
  }

  // PHASE5: FINALIZE (merge conflict branch → main, tree-of-main,
  // ancestor-check idempotency, 422 = defer).

  // ── Vault-step (non-conflict half; §II.3/II.4/II.5 endings) ──────
  for (const [path, tracked] of state.trackedFiles) {
    if (tracked.isManualConflict) {
      // PHASE5 (STEP3): sibling create/replace via the §II.11 mark
      // transaction. Phase 4 records that the path awaits STEP3.
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

    let verdict;
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
      deps.logger?.warn(
        "plugin-dispatch path skipped in Vault-step (Phase 7)",
        { path },
      );
      continue;
    }
    if (verdict.kind === "manual-conflict") {
      // A conflict born ON the Vault-step (delete-vs-modify or
      // edit-vs-modify discovered just now). PHASE5: blob +
      // getCommitInfoForPath + conflicts.set + sibling file. Phase 4:
      // verdict recorded, base NOT advanced — the next drain retries.
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
      if (vaultEntry !== null) await deps.vaultFiles.remove(path);
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
    await deps.vaultFiles.write(path, bytes);
    tracked.base = tracked.remote;
  }

  // PHASE6: the epilogue (baselines write-back → durable conflicts →
  // hot anchor → journal clear) is deliberately absent. Persist the
  // post-Vault-step state so a resumed run sees the advanced bases.
  await deps.journal.persist(state);

  return result("ok");
}

// Batch entry → local FileInfo, §III "for each local in batch" prologue:
// mtime from the batch METAFILE (enqueue-time, canonical-writeback-safe;
// 0 = owner's ambiguity-loses-to-remote fallback), bytes from
// sync_store with the live-vault repair fallback (§12.5.B: changed or
// gone → skip, next detection re-emits).
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

function statusFromError(
  error: unknown,
  result: (s: DrainStatus) => DrainResult,
): DrainResult {
  if (error instanceof AuthError) {
    // PHASE5.5 (cutover): saveTokenExpiredMark() — the live token
    // latch belongs to the manager; the module reports the status.
    return result("token-expired");
  }
  if (error instanceof NetworkError) {
    return result("network-error");
  }
  throw error; // domain errors and bugs propagate loudly
}
