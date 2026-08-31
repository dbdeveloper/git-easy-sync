// _diff3(tracked, local, head_hash) — the new drain's resolution core
// (NEW-DRAIN §II.1 rules 2-4 + the §III pseudocode, Phase 4 step 1).
// Faithful to the spec's control flow; comments cite rule numbers.
//
// Outcome model: the winning/merged FileInfo, MANUAL_CONFLICT (a
// VERDICT, not an error), or PLUGIN_DISPATCH (§II.1 п.3.a — the
// plugins-core-files branch is a dispatch STUB in Phase 4; the real
// rules arrive with PLUGIN-UPDATE-COMPAT in Phase 7). The four
// per-path domain errors (CompareWrongFiles / LocalFileNotFound /
// RemoteFileNotInRepo / BaseFileNotInRepo) THROW, as do
// NetworkError/AuthError from the injected network deps — the drain
// loop owns per-path skip semantics and the token latch; this
// function never swallows either.
//
// §VI.0 (decided, not new): the RULES below are cheap SHA logic and
// run on the main thread; the BYTE merge goes through the injected
// `mergeBlobs` — production wires the worker three-way-merge, tests
// wire the main-thread mergeText (same algorithm, same CRLF
// restore-local's-EOL behaviour — §VIII A.27-29 pin it end-to-end).
//
// Normative subtlety (§III comment at rules 3/4): when one side is
// unchanged the OTHER side is returned VERBATIM, never routed through
// diff3() "for symmetry" — a re-merge yields semantically identical
// content with a DIFFERENT sha (EOL normalisation), and everything in
// this algorithm keys on shas.

import {
  BaseFileNotInRepoError,
  CompareWrongFilesError,
  LocalFileNotFoundError,
  RemoteFileNotInRepoError,
} from "../errors";
import { hasTextExtension } from "../utils";
import { DELETED_SHA_HASH } from "./discovery";
import SyncStore from "./sync-store";
import { utf8RoundTrip } from "./text-normalize";
import { mergeText } from "./three-way-merge";

// The spec's DELETED mode sentinel. `mode: ""` = ordinary file;
// `mode: null` = unknown/empty FileInfo.
export const DELETED = "DELETED" as const;

// §III FileInfo — one side of a resolution. `blob` is lazily filled
// (sync_store → network) only on the paths that truly merge.
export interface FileInfo {
  path: string | null;
  size: number | null;
  mtime: number | null;
  sha: string | null;
  blob: ArrayBuffer | null;
  mode: "" | typeof DELETED | null;
  // Device that produced THIS content — populated lazily via
  // getCommitInfoForPath at the conflict-birth sites only (§III);
  // base/local never carry it.
  deviceLabel: string | null;
}

export function emptyFileInfo(): FileInfo {
  return {
    path: null,
    size: null,
    mtime: null,
    sha: null,
    blob: null,
    mode: null,
    deviceLabel: null,
  };
}

export type Diff3Result =
  // The resolved side (or the fresh merge product). The drain loop
  // decides push/pull/no-op by comparing its sha to the sides.
  | { kind: "file"; file: FileInfo }
  // A real collision only the user can resolve (STEP1 registration —
  // Phase 5; in Phase 4 the loop surfaces these as verdicts-as-data).
  | { kind: "manual-conflict" }
  // §II.1 п.3.a: plugins/<id>/{manifest.json,main.js,styles.css} —
  // the decision space is freeze/pass/resolve, rules land in Phase 7.
  | { kind: "plugin-dispatch" };

export interface Diff3Deps {
  syncStore: SyncStore;
  // Caller-owned hash-on-load trust scope (per-drain) — same
  // ownership rule as everywhere else in Phase 2+.
  verifiedShas: Set<string>;
  // Git Blobs API fetch: bytes, or null when GitHub has no such blob.
  // Throws NetworkError/AuthError — propagated, never swallowed.
  getBlobFromRepo(sha: string): Promise<ArrayBuffer | null>;
  // Layer-2 metadata call for the ONE gap where remote.size is
  // legitimately unknown (rule 7's lazy fetch, §III). null = the path
  // vanished from remote between discovery and now.
  getContentsMetadataAtRef(
    path: string,
    ref: string,
  ): Promise<{ sha: string; size: number } | null>;
  // Settings live-getter: maximum_auto_merge_file_size (rule 4.7).
  maxAutoMergeFileSize(): number;
  // Byte merge seam (§VI.0). "conflict" covers both marker-conflicts
  // and any merge failure (spec: ANY_DIFF3_ERROR → MANUAL_CONFLICT).
  mergeBlobs(
    path: string,
    base: ArrayBuffer,
    ours: ArrayBuffer,
    theirs: ArrayBuffer,
  ): Promise<{ kind: "clean"; merged: ArrayBuffer } | { kind: "conflict" }>;
  computeSha(bytes: ArrayBuffer): Promise<string>;
}

const PLUGIN_CORE_FILE = /^\.obsidian\/plugins\/[^/]+\/(manifest\.json|main\.js|styles\.css)$/;

export async function _diff3(
  deps: Diff3Deps,
  tracked: { base: FileInfo; remote: FileInfo } | null,
  localIn: FileInfo | null,
  // null = empty repo (no branch yet). Legitimate for every sha-only
  // rule; reaching the rule-7 lazy size fetch with it is a caller bug
  // and throws LOUDLY (an empty repo cannot hold remote content).
  headHash: string | null,
): Promise<Diff3Result> {
  // Shallow copies — the DELETED-sentinel substitution and lazy
  // size/blob fills below must never mutate the caller's records.
  const base: FileInfo = { ...(tracked?.base ?? emptyFileInfo()) };
  const remote: FileInfo = { ...(tracked?.remote ?? emptyFileInfo()) };
  const local: FileInfo = { ...(localIn ?? emptyFileInfo()) };

  // Path coherence — a mismatch is a caller bug (COMPARE_WRONG_FILES).
  const paths = [base.path, local.path, remote.path].filter(
    (p): p is string => p !== null,
  );
  if (new Set(paths).size > 1) {
    throw new CompareWrongFilesError(
      `_diff3: sides disagree on path: ${paths.join(" vs ")}`,
    );
  }

  // DELETED sentinel substitution — makes every later rule a pure
  // sha comparison (the "ДОВЕДЕННЯ" block below relies on it).
  if (local.mode === DELETED) local.sha = DELETED_SHA_HASH;
  if (remote.mode === DELETED) remote.sha = DELETED_SHA_HASH;

  // 2.a — base equality rule (covers both-deleted: equal sentinels).
  if (local.sha !== null && remote.sha !== null && local.sha === remote.sha) {
    return { kind: "file", file: local };
  }
  // 2.b — neither side exists → base (null-as-base semantics).
  if (local.sha === null && remote.sha === null) {
    return { kind: "file", file: base };
  }

  const path = base.path ?? local.path ?? remote.path;
  if (path === null) {
    // Unreachable: at least one sha is non-null past 2.b, and a side
    // with content always carries its path.
    throw new CompareWrongFilesError("_diff3: no side carries a path");
  }

  // ── §II.1 п.3 — the .obsidian/ special branch ───────────────────
  if (path.startsWith(".obsidian/")) {
    if (
      PLUGIN_CORE_FILE.test(path) &&
      local.sha !== null &&
      remote.sha !== null
    ) {
      // 3.a — plugin core files route to their own rules
      // (SYNC2-PLUGIN-UPDATE-COMPAT). ⚠️ NARROWED at THE SWITCH gate
      // (2026-08-31, gate finding): the seam fires ONLY on a genuine
      // two-sided collision (both exist, differ — equality returned
      // at 2.a). One-sided cases (new plugin file, deletion, plain
      // pull/push) are ordinary 3.b traffic — the old wide seam made
      // drainOnce skip them, so plugin files never synced AT ALL
      // (integration I2). Semver/bundle-atomicity (§28 class) returns
      // with PLUGIN-UPDATE-COMPAT; until then the drain resolves the
      // dispatch by pickNewestForObsidian below.
      return { kind: "plugin-dispatch" };
    }
    // 3.b — MANUAL_CONFLICT never happens here; every collision
    // resolves silently. No separate base=null case needed: when
    // base.sha==null, (remote.sha == base.sha) narrows to
    // (remote.sha == null) by itself.
    if (
      (remote.sha === null || remote.sha === base.sha) &&
      local.sha !== null
    ) {
      return { kind: "file", file: local }; // 3.b.1.a / 3.b.2.a
    }
    if (
      (local.sha === null || local.sha === base.sha) &&
      remote.sha !== null
    ) {
      return { kind: "file", file: remote }; // 3.b.1.b / 3.b.2.b
    }
    // Real collision, delete-vs-edit → the LIVE side wins, mtime not
    // consulted (3.b.*.c/d) — deliberately NO 4.6.b asymmetry here.
    if (local.mode === DELETED) return { kind: "file", file: remote };
    if (remote.mode === DELETED) return { kind: "file", file: local };
    // 3.b.*.e — THE ONLY place in the whole algorithm where mtimes
    // are compared ("зроблено СВІДОМО"). Fallback semantics (owner):
    // ambiguity → remote wins. local.mtime==0 (legacy batch, stat
    // null) and remote.mtime==null (§II.12 tree-fallback) must BOTH
    // land in the remote branch — hence the explicit null guard: a
    // bare `>` would coerce null to 0 in JS and hand `5 > null` to
    // local, silently inverting the owner's fallback rule.
    return { kind: "file", file: pickNewestForObsidian(local, remote) };
  }

  // ── §II.1 п.4 — standard resolution ─────────────────────────────
  if (base.sha === null) {
    if (local.sha !== null && remote.sha === null) {
      return { kind: "file", file: local }; // 4.1.a
    }
    if (local.sha === null && remote.sha !== null) {
      return { kind: "file", file: remote }; // 4.1.b
    }
    if (remote.mode === DELETED) return { kind: "file", file: local }; // 4.1.c
    if (local.mode === DELETED) return { kind: "file", file: remote }; // 4.1.d
    // 4.2 — both created the same path independently with different
    // content; without a base there is nothing to merge against.
    return { kind: "manual-conflict" };
  }

  // base != null. Rules 3/4 return the side VERBATIM — normative, see
  // the header comment (sha stability under EOL normalisation).
  if (
    remote.sha !== null &&
    local.sha === base.sha &&
    remote.sha !== base.sha
  ) {
    return { kind: "file", file: remote }; // 4.3 — clean pull
  }
  if (
    local.sha !== null &&
    local.sha !== base.sha &&
    remote.sha === base.sha
  ) {
    return { kind: "file", file: local }; // 4.4 — clean push
  }
  if (local.sha !== null && local.sha !== base.sha && remote.sha === null) {
    return { kind: "file", file: local }; // 4.5.a — null-as-base
  }
  if (local.sha === null && remote.sha !== null && remote.sha !== base.sha) {
    return { kind: "file", file: remote }; // 4.5.b — null-as-base
  }
  if (local.sha !== base.sha && remote.mode === DELETED) {
    return { kind: "file", file: local }; // 4.6.a — edit beats delete
  }
  if (remote.sha !== base.sha && local.mode === DELETED) {
    // 4.6.b — the deliberate ASYMMETRY of 4.6.a: a locally-deleted,
    // remotely-edited file is only resolvable by a human.
    return { kind: "manual-conflict" };
  }

  // ДОВЕДЕННЯ (§III): no side can be DELETED here — every DELETED
  // combination already returned in rules 2.a/4.3/4.4/4.6. So both
  // sides are ordinary files, and an ordinary local always has a size
  // (batch metafile / live stat). A violation is a bug in the rules
  // above, not a data condition.
  if (local.size === null) {
    throw new CompareWrongFilesError(
      `_diff3: local.size missing past rule 6 for ${path} — rules 1-6 bug`,
    );
  }

  // Rule 7's ONE legitimate size gap (§III): the path changed only on
  // remote (no batch entry → Layer 2 never ran) while the user edited
  // it in the vault uncommitted → Vault-step lands here with
  // remote.size == null. LAZY fetch — pay the network only for an
  // actual divergence, never per changed remote file.
  if (remote.size === null) {
    // Free first (MASTER-PLAN free-size inventory): the bytes may
    // already be in hand, or the blob may already sit in the
    // content-addressed store from pull-folding / a previous drain /
    // a Layer-2 inline fetch. Either way the size costs nothing and
    // the ~300 ms round-trip below is skipped — on exactly the paths
    // where a conflict already lives.
    // PREFERENCE ORDER (owner, 2026-08-31): in-memory bytes FIRST —
    // they are already hash-proven (getBlobFromSyncStore verifies on
    // load; a freshly fetched/merged blob is the content by
    // construction), so `byteLength` is not just free but STRONGER
    // than any stat: it cannot be wrong. The store's stat is the
    // weaker second choice (it trusts the file name, see
    // SyncStore.sizeOf), and the network is the last resort.
    if (remote.blob !== null) {
      remote.size = remote.blob.byteLength;
    } else if (remote.sha !== null) {
      const stored = await deps.syncStore.sizeOf(remote.sha);
      if (stored !== null) remote.size = stored;
    }
  }
  if (remote.size === null) {
    if (headHash === null) {
      // Unreachable-but-loud (advisor 2026-08-30): an empty repo has
      // no remote content, so no side can need a live size fetch —
      // a null ref here means the caller fed inconsistent sides, and
      // a garbage URL would fail silently where this fails loudly.
      throw new CompareWrongFilesError(
        `_diff3: rule-7 size fetch for ${path} with no head ref — caller bug`,
      );
    }
    const live = await deps.getContentsMetadataAtRef(path, headHash);
    if (live === null) {
      // Vanished from remote between discovery and now.
      throw new RemoteFileNotInRepoError(
        `_diff3: ${path} disappeared from remote before the size fetch`,
      );
    }
    remote.size = live.size;
  }
  // 4.7 — the size gate. maximum_auto_merge_file_size = 0 disables
  // diff3 entirely: every differing pair becomes a manual conflict.
  if (deps.maxAutoMergeFileSize() < Math.max(local.size, remote.size)) {
    return { kind: "manual-conflict" };
  }

  // ── blob acquisition (§II.9 semantics throughout) ───────────────
  if (local.blob === null) {
    local.blob = await deps.syncStore.getBlobFromSyncStore(
      local.sha!,
      deps.verifiedShas,
    );
    if (local.blob === null) {
      throw new LocalFileNotFoundError(
        `_diff3: local blob for ${path} (${local.sha}) not found in sync_store`,
      );
    }
  }
  if (remote.blob === null) {
    remote.blob = await deps.syncStore.getBlobFromSyncStore(
      remote.sha!,
      deps.verifiedShas,
    );
    if (remote.blob === null) {
      remote.blob = await deps.getBlobFromRepo(remote.sha!);
      if (remote.blob === null) {
        throw new RemoteFileNotInRepoError(
          `_diff3: remote blob for ${path} (${remote.sha}) missing from repo`,
        );
      }
      if (!(await deps.syncStore.existInSyncStore(remote.sha!))) {
        await deps.syncStore.saveBlobToSyncStore(remote.sha!, remote.blob);
      }
    }
  }
  if (base.blob === null) {
    base.blob = await deps.syncStore.getBlobFromSyncStore(
      base.sha!,
      deps.verifiedShas,
    );
    if (base.blob === null) {
      base.blob = await deps.getBlobFromRepo(base.sha!);
      if (base.blob === null) {
        throw new BaseFileNotInRepoError(
          `_diff3: base blob for ${path} (${base.sha}) missing from repo`,
        );
      }
      if (!(await deps.syncStore.existInSyncStore(base.sha!))) {
        await deps.syncStore.saveBlobToSyncStore(base.sha!, base.blob);
      }
    }
  }

  // ── the actual 3-way merge (spec: ANY_DIFF3_ERROR → conflict) ───
  let merged: ArrayBuffer;
  try {
    const outcome = await deps.mergeBlobs(
      path,
      base.blob,
      local.blob,
      remote.blob,
    );
    if (outcome.kind === "conflict") return { kind: "manual-conflict" };
    merged = outcome.merged;
  } catch {
    return { kind: "manual-conflict" };
  }

  const mergedSha = await deps.computeSha(merged);
  const mergedFile: FileInfo = {
    path,
    size: merged.byteLength,
    mtime: null, // not committed, not written to the vault yet (§II.6)
    sha: mergedSha,
    blob: merged,
    mode: "",
    deviceLabel: null,
  };
  if (!(await deps.syncStore.existInSyncStore(mergedSha))) {
    await deps.syncStore.saveBlobToSyncStore(mergedSha, merged);
  }
  return { kind: "file", file: mergedFile };
}

// §II.1 п.3.b.e — the ONE place mtimes are compared. Shared by the
// 3.b fallback above and the drain's INTERIM plugin-dispatch
// resolution (gate decision 2026-08-31): newest wins, ambiguity
// (either mtime null/0-legacy) → remote — with the explicit null
// guard, because a bare `>` would coerce `5 > null` to local and
// silently invert the owner's fallback rule.
export function pickNewestForObsidian(
  local: FileInfo,
  remote: FileInfo,
): FileInfo {
  const localWins =
    remote.mtime !== null && local.mtime !== null && local.mtime > remote.mtime;
  return localWins ? local : remote;
}

// Default main-thread merge seam — the REAL mergeText (with its
// restore-local's-EOL behaviour, bug-59 algorithm) behind the
// Diff3Deps.mergeBlobs contract. Production (Phase 4 step 5) wires
// the worker mirror instead; tests use this one so §VIII A.27-29
// exercise the true merge path.
//
// Text-only: a non-text extension can't be line-merged → conflict.
// Round-trip gate (same rule as §II.15's inline gate): if decoding
// and re-encoding ANY input changes its bytes (invalid UTF-8 under a
// text extension — the cp1251 .csv class), a text merge would
// silently corrupt content → conflict instead.
export async function mergeBlobsWithMainThreadDiff3(
  path: string,
  base: ArrayBuffer,
  ours: ArrayBuffer,
  theirs: ArrayBuffer,
): Promise<{ kind: "clean"; merged: ArrayBuffer } | { kind: "conflict" }> {
  if (!hasTextExtension(path)) return { kind: "conflict" };
  const baseText = utf8RoundTrip(base);
  const oursText = utf8RoundTrip(ours);
  const theirsText = utf8RoundTrip(theirs);
  if (baseText === null || oursText === null || theirsText === null) {
    return { kind: "conflict" };
  }
  const outcome = mergeText(oursText, baseText, theirsText);
  if (outcome.kind === "conflict") return { kind: "conflict" };
  const encoded = new TextEncoder().encode(outcome.content);
  return {
    kind: "clean",
    merged: encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer,
  };
}

// The production mirror (Phase 5.5 step 2b): same gates, same shape,
// but the merge itself routes through the worker orchestra
// (WorkerClient.mergeText — CPU pool above its size threshold, inline
// fallback below it; both run the SAME node-diff3 call as mergeText,
// so the two variants are behaviourally one function). The round-trip
// gate stays on the main thread deliberately: it is a decode+encode
// pass the worker boundary would pay for in transfer costs anyway.
export function makeWorkerMergeBlobs(worker: {
  mergeText(
    ours: string,
    base: string,
    theirs: string,
  ): Promise<
    | { kind: "clean"; content: string }
    | { kind: "conflict"; conflictMarkedContent: string }
  >;
}): Diff3Deps["mergeBlobs"] {
  return async (path, base, ours, theirs) => {
    if (!hasTextExtension(path)) return { kind: "conflict" };
    const baseText = utf8RoundTrip(base);
    const oursText = utf8RoundTrip(ours);
    const theirsText = utf8RoundTrip(theirs);
    if (baseText === null || oursText === null || theirsText === null) {
      return { kind: "conflict" };
    }
    const outcome = await worker.mergeText(oursText, baseText, theirsText);
    if (outcome.kind === "conflict") return { kind: "conflict" };
    const encoded = new TextEncoder().encode(outcome.content);
    return {
      kind: "clean",
      merged: encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer,
    };
  };
}
