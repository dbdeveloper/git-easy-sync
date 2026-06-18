// Stage 2.1 — the `[← back]` 7-step pair-atomic commit + crash recovery
// (DIFF-EDITOR.md §5.0–§5.0.e).
//
// `[← back]` commits BOTH sides of a conflict back to the vault at once:
// the resolved base and the resolved sibling (from `split(fromEditorModel)`,
// surfaced by DiffPane.getResolved()). A naive "two sequential
// atomicWriteFile" loses ver2 edits on a crash between the two writes (and the
// onload sync pulse runs BEFORE the user can reopen, so a half-committed pair
// would be pushed to the remote). This protocol records the expected SHAs in a
// `done.json` commit barrier FIRST, then stages + promotes both files, so
// recovery on the next launch is a deterministic function of what's on disk —
// it can always roll forward to the committed state or cleanly roll back to the
// autosave session, atomically for the PAIR, before the engine touches the vault.
//
// WRITE STRATEGY (bug3): the promote writes IN PLACE via `vault.modifyBinary`
// when the target is an existing TFile — the editor-friendly path that
// PRESERVES an open tab's cursor/scroll. The previous safeRename swap made
// Obsidian see the file vanish and closed the tab. modifyBinary is NOT atomic
// (a crash can leave a torn final), but the done.json + clean `.sync-tmp` make
// recovery deterministic anyway: a torn final WITH our clean tmp is OUR write →
// roll forward from the tmp; a non-matching final WITHOUT our clean tmp is a
// genuine external edit → fall back. The original is never renamed aside, so
// there is no `.sync-bak` (rollback only happens before any modify, when the
// originals are still intact). New files (no TFile) atomically rename the tmp.
//
// SCOPE: this module is the commit engine + TOCTOU detector + per-dir
// recovery. WIRED into the view as of W1: `commit7Step` is the `[←]` save
// (DiffEditView.exitDetailView), `classifyToctou` gates it, and `recoverCommit`
// runs at onload via `onload-recovery.ts` (before AtomicWriteRecovery.sweep).
// The §5.0.e symmetric exit-TOCTOU is WIRED as of W5: commitUnchangedSide
// (one side changed → silent) + commitToAlt (both changed → SaveToAltModal).
// Still Phase-6 polish: the `committing` UI guard (Step 0) and Step 8
// (detachLeaf + historyClear). The naive `exit-protocol.ts` is deleted.
//
// Canonical spec: docs/tasks/DIFF-EDITOR.md §5.0 (7 steps), §5.0.a/b
// (recovery sweep + A–K matrix), §5.0.c (orphan discrimination), §5.0.e
// (TOCTOU). atomic-write.ts staging-path convention (SYNC2 §2.4 / PSEUDO-
// MERGE-MODE §9.2/§9.3).

import { normalizePath, TFile, type Vault } from "obsidian";
import { atomicWriteFile, stagingPathFor } from "../sync2/atomic-write";
import { safeRename } from "../sync2/cross-platform";
import { buildSiblingPath } from "../sync2/conflict-store";
import { calculateGitBlobSHA } from "../utils";
import { autosaveDir, readMeta, type AutosaveMeta } from "./autosave-store";

const utf8 = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

// git-blob SHA of zero bytes — the well-known empty blob. Both commit and
// recovery use it to recognise an empty-resolved base. (Verified === a live
// calculateGitBlobSHA("") in exit-commit.test.ts so a library change can't
// silently drift it.)
export const GIT_EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const donePath = (autosaveId: string): string =>
  `${autosaveDir(autosaveId)}/done.json`;

// What bytes does an EMPTY resolved side commit as? (R3.3, 2026-06-18.) SHA("")
// alone can't tell "delete" from "keep a genuine empty file", so the base's
// session-start state decides — and the SAME representation is applied to BOTH
// sides so two empty sides hash identically and Step 6.5 can unify them:
//   - base absent at start (delete-vs-modify)  → 0 bytes (and baseCommitAction
//     also flags DELETE so the base file is never materialised)
//   - base existed as a genuine 0-byte file    → 0 bytes (SYNC2 §2.9 lets a
//     0-byte file through when snapshot.size===0, so it sticks)
//   - base existed WITH content, user emptied it → row-3 case: DELETE iff the
//     user confirmed via the empty-delete modal (confirmedDelete); otherwise
//     "\n" (a benign 1-byte file, NOT a §2.9-resurrectable 0-byte one).
function emptyRepBytes(meta: AutosaveMeta, confirmedDelete = false): ArrayBuffer {
  if (!meta.baseExistedAtStart) return utf8("");
  if (meta.baseShaAtStart === GIT_EMPTY_BLOB_SHA) return utf8("");
  return confirmedDelete ? utf8("") : utf8("\n"); // case 4 — modal-gated
}

// Empty-base commit decision. A non-empty base writes its bytes verbatim. An
// empty base DELETEs when:
//   - absent at session start (delete-vs-modify resolved to the deleted side) —
//     recoverCommit re-derives this from (expectedBaseSha===SHA("") &&
//     !baseExistedAtStart); OR
//   - it had content and the user CONFIRMED deletion in the empty-delete modal
//     (case 4) — meta can't tell case-4-delete from a genuine 0-byte file, so
//     commit7Step records deleteBase in done.json for recovery (authoritative).
// A delete writes 0 bytes (the file is then removed); otherwise the shared empty
// representation (0 bytes / "\n").
export function baseCommitAction(
  resolvedBase: string,
  meta: AutosaveMeta,
  confirmedDelete = false,
): { delete: boolean; bytes: ArrayBuffer } {
  if (resolvedBase !== "") return { delete: false, bytes: utf8(resolvedBase) };
  const del =
    !meta.baseExistedAtStart ||
    (confirmedDelete && meta.baseShaAtStart !== GIT_EMPTY_BLOB_SHA);
  return { delete: del, bytes: emptyRepBytes(meta, confirmedDelete) };
}

// done.json — commit barrier with pre-computed expected SHAs (§5.0).
// Present ⇒ "commit in progress, roll forward via recovery". Absent ⇒
// "no commit started" (the dir is a plain autosave session — Stage 3 owns it).
export interface DoneJson {
  v: 1;
  writtenAt: string;
  expectedBaseSha: string;
  expectedSiblingSha: string;
  // Committed base end-state is ABSENT (delete). Written ONLY when true. Lets
  // recoverCommit complete a had-content-base deletion (case 4) it could not
  // otherwise infer from meta (expectedBaseSha===SHA("") matches a genuine 0-byte
  // file too). A delete-vs-modify (case 1) sets it too but recovery would infer
  // that one anyway.
  deleteBase?: boolean;
}

// ── Step 1.5 — TOCTOU detection (§5.0 Step 1.5) ──────────────────────

// Did the input files change externally since session start? DETECTION ONLY.
// The caller (DiffEditView.exitDetailView) runs this before commit7Step; on
// "mismatch" it applies the §5.0.e symmetric rule via commitUnchangedSide
// (exactly one side changed → silent) or commitToAlt (both changed → modal).
// `baseChanged`/`siblingChanged` are exactly the discriminant the caller needs.
// Throws if a file was deleted externally (readBinary rejects); the caller
// handles that like classifyReopen's input-missing case.
export type ToctouStatus =
  | { kind: "ok" }
  | {
      kind: "mismatch";
      currentBaseSha: string;
      currentSiblingSha: string;
      baseChanged: boolean;
      siblingChanged: boolean;
    };

export async function classifyToctou(
  vault: Vault,
  meta: AutosaveMeta,
): Promise<ToctouStatus> {
  // Read each side defensively: an ABSENT file hashes as SHA("") rather than
  // letting readBinary throw ENOENT (bug-29 — the exit mirror of the startSession
  // fix). For a delete-vs-modify session the base is legitimately absent and
  // hashes to baseShaAtStart=SHA("") ⇒ baseChanged=false (no TOCTOU). A file that
  // HAD content but is now gone hashes to SHA("")≠its start SHA ⇒ changed ⇒ the
  // §5.0.e mismatch path, which is the correct response to an out-of-band delete.
  const currentBaseSha = await calculateGitBlobSHA(
    await readOrEmpty(vault, meta.basePath),
  );
  const currentSiblingSha = await calculateGitBlobSHA(
    await readOrEmpty(vault, meta.siblingPath),
  );
  const baseChanged = currentBaseSha !== meta.baseShaAtStart;
  const siblingChanged = currentSiblingSha !== meta.siblingShaAtStart;
  if (!baseChanged && !siblingChanged) return { kind: "ok" };
  return {
    kind: "mismatch",
    currentBaseSha,
    currentSiblingSha,
    baseChanged,
    siblingChanged,
  };
}

// ── §5.0 — the 7-step commit ─────────────────────────────────────────

export interface ResolvedSides {
  base: string;
  sibling: string;
}

export interface Commit7Options {
  // Target paths default to the conflict's real paths (meta.basePath /
  // siblingPath); Step 4 self-skips for any target that doesn't pre-exist, so a
  // brand-new file commits uniformly. NOTE: the §5.0.e save-to-alt branch does
  // NOT use these — it goes through commitToAlt (plain atomicWriteFile), because
  // recoverCommit classifies by meta paths and can't roll an alt-path commit
  // forward. These options remain for new-file commits onto the real paths.
  targetBasePath?: string;
  targetSiblingPath?: string;
  now?: string; // injectable for deterministic tests
  // The user confirmed deletion of a had-content base they emptied (case 4 /
  // empty-delete modal). Promotes the "\n" benign-stub default to a real delete.
  // Ignored unless the resolved base is empty AND it had content at start.
  confirmedDelete?: boolean;
}

export interface Commit7Result {
  basePath: string;
  siblingPath: string;
  expectedBaseSha: string;
  expectedSiblingSha: string;
  // Step 6.5 fired: the resolved sides were byte-identical AND we committed
  // onto the real conflict sibling, so the now-redundant sibling was removed.
  siblingRemoved: boolean;
}

// Assumes the caller already ran classifyToctou (this does NOT re-check) and,
// for a mismatch, resolved it via the §5.0.e modal. `resolved` carries the RAW
// resolved sides ("" for an empty side); commit7Step applies the empty-base
// semantics itself (baseCommitAction) using meta — so done.json hashes exactly
// the buffers we stage/write, keeping every recovery SHA-match valid. An empty
// base whose session-start state means "delete" (delete-vs-modify) is NOT
// written: the file stays absent and recovery infers the same from meta.
export async function commit7Step(
  vault: Vault,
  autosaveId: string,
  meta: AutosaveMeta,
  resolved: ResolvedSides,
  opts: Commit7Options = {},
): Promise<Commit7Result> {
  const now = opts.now ?? new Date().toISOString();
  const targetBase = opts.targetBasePath ?? meta.basePath;
  const targetSibling = opts.targetSiblingPath ?? meta.siblingPath;

  const baseAction = baseCommitAction(resolved.base, meta, opts.confirmedDelete);
  const deleteBase = baseAction.delete;
  const baseBytes = baseAction.bytes;
  // The sibling never deletes (Step 6.5 removes it when it converges with base);
  // an empty sibling uses the SAME empty representation as the base (= baseAction
  // .bytes when the base is also empty) so two empty sides hash identically and
  // 6.5 unifies them — incl. the case-4 delete, where both become 0 bytes.
  const siblingBytes =
    resolved.sibling === ""
      ? resolved.base === ""
        ? baseAction.bytes
        : emptyRepBytes(meta, opts.confirmedDelete)
      : utf8(resolved.sibling);
  // expectedBaseSha is the empty-blob SHA for a delete — it keeps Step 6.5's
  // equality check working and lets recovery recognise the delete via meta.
  const expectedBaseSha = await calculateGitBlobSHA(baseBytes);
  const expectedSiblingSha = await calculateGitBlobSHA(siblingBytes);

  // Step 2 — write done.json (commit barrier) BEFORE any file write, atomic.
  // Record deleteBase so recovery can complete a case-4 deletion it can't infer
  // from meta (omitted when false to keep the barrier minimal).
  const done: DoneJson = {
    v: 1,
    writtenAt: now,
    expectedBaseSha,
    expectedSiblingSha,
    ...(deleteBase ? { deleteBase: true } : {}),
  };
  await atomicWriteFile(vault, donePath(autosaveId), utf8(JSON.stringify(done)));

  const baseTmp = stagingPathFor(targetBase, "tmp");
  const siblingTmp = stagingPathFor(targetSibling, "tmp");

  // Step 3 — stage new versions in .sync-tmp. A delete-base stages nothing (its
  // committed end-state is "absent", there is no roll-forward source to stage).
  await Promise.all([
    deleteBase
      ? Promise.resolve()
      : vault.adapter.writeBinary(baseTmp, baseBytes),
    vault.adapter.writeBinary(siblingTmp, siblingBytes),
  ]);

  // Step 4 — promote each side IN PLACE (bug3). modifyBinary keeps an open
  // editor's tab/cursor/scroll; a new file (no TFile) atomically renames the
  // tmp. The original is NEVER renamed aside → no .sync-bak. The commit point
  // is reached the moment the first modifyBinary lands; before that, originals
  // are intact and recovery rolls back. SEQUENTIAL by design (base then
  // sibling) so recovery reasons over one linear sequence — DIFF-EDITOR.md
  // §5.0.b. Do not Promise.all. A delete-base removes the target instead of
  // promoting (no-op when it is already absent — the delete-vs-modify case).
  if (deleteBase) await removeIfExists(vault, targetBase);
  else await promoteInPlace(vault, baseTmp, targetBase, baseBytes);
  await promoteInPlace(vault, siblingTmp, targetSibling, siblingBytes);

  // Step 5 — drop the staging tmps. modify-in-place leaves the tmp behind; a
  // new-file rename already consumed its tmp → removeIfExists is a no-op there.
  await Promise.all([removeIfExists(vault, baseTmp), removeIfExists(vault, siblingTmp)]);

  // Step 6.5 — R7.11 proactive sibling cleanup. Only when we committed onto
  // the REAL conflict sibling (not a save-to-alt fresh path) AND both sides
  // resolved to identical bytes: the sibling is now redundant. adapter-level
  // remove (not vault.delete) so it covers .obsidian/* and bypasses TrashStore.
  let siblingRemoved = false;
  if (
    targetSibling === meta.siblingPath &&
    expectedBaseSha === expectedSiblingSha &&
    (await vault.adapter.exists(meta.siblingPath))
  ) {
    await vault.adapter.remove(meta.siblingPath);
    siblingRemoved = true;
  }

  // Step 7 — tear down the autosave dir (meta + history + cursor + done.json).
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);

  return {
    basePath: targetBase,
    siblingPath: targetSibling,
    expectedBaseSha,
    expectedSiblingSha,
    siblingRemoved,
  };
}

// Promote staged `bytes` to `targetPath` (bug3). If the target is an existing
// TFile and the runtime exposes modifyBinary (production Obsidian, desktop +
// mobile), write IN PLACE so any open editor on that file keeps its tab,
// cursor, and scroll. Otherwise — a brand-new file, or the unit-test mock that
// doesn't expose modifyBinary — atomically rename the staged tmp into place
// (there is no open editor to preserve in either case). The tmp is LEFT for the
// caller to clean up in the modify case (the real file already has the bytes);
// it is CONSUMED by the rename in the new-file case. Mirrors the
// atomicWriteFile fast-path gate so behaviour is identical across the engine.
async function promoteInPlace(
  vault: Vault,
  tmpPath: string,
  targetPath: string,
  bytes: ArrayBuffer,
): Promise<void> {
  const getter = (
    vault as { getAbstractFileByPath?: (p: string) => unknown }
  ).getAbstractFileByPath;
  const modBin = (
    vault as { modifyBinary?: (f: TFile, b: ArrayBuffer) => Promise<void> }
  ).modifyBinary;
  if (typeof getter === "function" && typeof modBin === "function") {
    const existing = getter.call(vault, targetPath);
    if (existing instanceof TFile) {
      await modBin.call(vault, existing, bytes);
      return;
    }
  }
  await safeRename(vault.adapter, tmpPath, targetPath);
}

// ── exit decision: commit vs discard (§5.0 + §4.1 zero-edit invariant) ─

export type ExitOutcome =
  // §4.1: the session recorded ZERO edits → no recovery value AND nothing to
  // commit. The dir was wiped; base/sibling were NOT touched.
  | { kind: "discarded" }
  // recordCount > 0, vault unchanged → the 7-step pair-atomic commit ran.
  | { kind: "committed"; result: Commit7Result }
  // recordCount > 0, vault changed under the session → caller runs the §5.0.e modal.
  | { kind: "toctou"; toctou: Extract<ToctouStatus, { kind: "mismatch" }> }
  // case-4: the user emptied a had-content base and DECLINED the delete modal →
  // nothing committed, dir intact, caller stays in the editor.
  | { kind: "cancelled" };

// case-4 predicate: the resolved base is empty AND it had real content at session
// start (so emptying it means deletion, not a genuine empty file). Pure.
export function isHadContentEmptied(
  resolved: ResolvedSides,
  meta: AutosaveMeta,
): boolean {
  return (
    resolved.base === "" &&
    meta.baseExistedAtStart &&
    meta.baseShaAtStart !== GIT_EMPTY_BLOB_SHA
  );
}

// The `[← back]` exit decision, extracted from the view so the END STATE is
// unit-testable (the view glue is not). Encodes the §4.1 zero-edit invariant:
//
//   recordCount === 0 → the session holds NO recorded edits, so it has no
//     recovery value AND nothing to commit — split(fromEditorModel) reproduces
//     the inputs byte-for-byte (§1.5). Wipe the dir WITHOUT touching base/sibling
//     and WITHOUT the safeRename swap (strictly safer: a byte-identical commit
//     would still yank an editor tab that has an input file open). → "discarded".
//   recordCount  >  0 → classifyToctou; "ok" → commit7Step → "committed";
//     "mismatch" → "toctou" (the caller resolves it via the §5.0.e modal — that
//     path is view-coupled and stays in the view).
//
// confirmEmptyDelete: invoked ONLY on the ok-commit path when the resolution
// empties a had-content base (case 4) — i.e. AFTER the TOCTOU check, so the
// delete modal never shows for a commit that won't happen. Returns false ⇒
// "cancelled" (stay in editor); true ⇒ commit with confirmedDelete. Absent ⇒
// case 4 falls back to the benign "\n" stub.
export async function commitOrDiscardExit(
  vault: Vault,
  conflictId: string,
  meta: AutosaveMeta,
  resolved: ResolvedSides,
  recordCount: number,
  confirmEmptyDelete?: () => Promise<boolean>,
): Promise<ExitOutcome> {
  if (recordCount === 0) {
    const dir = autosaveDir(conflictId);
    if (await vault.adapter.exists(dir)) {
      await vault.adapter.rmdir(dir, true);
    }
    return { kind: "discarded" };
  }
  const toctou = await classifyToctou(vault, meta);
  if (toctou.kind === "mismatch") return { kind: "toctou", toctou };

  let confirmedDelete = false;
  if (confirmEmptyDelete && isHadContentEmptied(resolved, meta)) {
    confirmedDelete = await confirmEmptyDelete();
    if (!confirmedDelete) return { kind: "cancelled" };
  }
  const result = await commit7Step(vault, conflictId, meta, resolved, {
    confirmedDelete,
  });
  return { kind: "committed", result };
}

// ── §5.0.e — symmetric exit-TOCTOU writers ───────────────────────────
//
// When `[← back]` finds the vault changed under the session (classifyToctou →
// mismatch), the SAME symmetric rule as §3.2.a-reopen applies: the resolved
// content lands ONLY on the side whose vault file did NOT change. Two shapes:
//   - exactly ONE side changed  → commitUnchangedSide (silent, single write)
//   - BOTH sides changed        → commitToAlt (user picks a fresh name)
// Neither routes through commit7Step: there is no pair to keep atomic (one
// write each), and the both-changed alt path CANNOT use commit7Step because
// recoverCommit classifies by meta.basePath/siblingPath, so an alt-path commit
// is structurally unrecoverable (it'd treat the external originals as foreign
// and clean the wrong staging slots). Plain atomicWriteFile is independently
// crash-safe, and the externally-changed originals are untouched either way.

// §5.0.e one-side-changed: write the resolved content of the UNCHANGED side
// onto its (unchanged) vault path — a legitimate §4.2 sibling mutation — then
// tear the session down. The changed side keeps its new bytes; the conflict
// simply continues (the caller logs; no Notice). No done.json barrier: a single
// atomicWriteFile is already crash-safe. Step-6.5 is NOT duplicated here — if
// the write makes SHA(base)==SHA(sibling), the next Phase A drops the conflict.
export async function commitUnchangedSide(
  vault: Vault,
  autosaveId: string,
  meta: AutosaveMeta,
  resolved: ResolvedSides,
  changedSide: "base" | "sibling",
): Promise<{ writtenPath: string }> {
  // changed base → keep the user's edit on the (unchanged) sibling, and vice
  // versa. The path we write is always the side that did NOT change.
  const writtenPath =
    changedSide === "base" ? meta.siblingPath : meta.basePath;
  const writeStr =
    changedSide === "base" ? resolved.sibling : resolved.base;
  // §5.0.e is a single write (no commit7Step delete machinery, no recoverCommit
  // roll-forward) — keep the empty→"\n" guard so an emptied side stays a benign
  // 1-byte file rather than a §2.9-resurrectable 0-byte one.
  await atomicWriteFile(vault, writtenPath, utf8(guardEmpty(writeStr)));
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);
  return { writtenPath };
}

// empty→"\n" guard for SINGLE-write resolved-content paths (the resolvedFromView
// guard moved into commit7Step's baseCommitAction; paths that write one resolved
// side directly — commitUnchangedSide, commitToAlt, and the §3.2.a reopen
// restore-unchanged-side write — keep it locally so an emptied side stays a
// benign 1-byte file rather than a §2.9-resurrectable 0-byte one).
export const guardEmpty = (s: string): string => (s === "" ? "\n" : s);

// Thrown by commitToAlt when the chosen name (or its derived sibling) already
// exists. FAIL-CLOSED: the §5.0.e editbox prefill IS meta.basePath, so an
// un-edited Save would otherwise clobber the externally-changed original —
// exactly the force-overwrite §5.0.e removed. The modal pre-validates for UX;
// this is the load-bearing invariant ("we NEVER overwrite a changed original").
export class AltTargetExistsError extends Error {
  constructor(public readonly path: string) {
    super(`Save-to-alt target already exists: ${path}`);
    this.name = "AltTargetExistsError";
  }
}

// §5.0.e both-changed save-to-alt: both inputs changed externally; the user
// chose to save the resolution under a fresh name. Converged resolution
// (base==sibling) → ONE file at newBasePath. Partial → newBasePath PLUS a
// sibling derived from it (so the synthetic conflict-pair continues under the
// new name). The externally-changed originals are NEVER touched. base is
// written FIRST so a crash leaves the named file, not an orphan sibling.
export async function commitToAlt(
  vault: Vault,
  autosaveId: string,
  newBasePath: string,
  resolved: ResolvedSides,
  deviceLabel: string,
  ts: number,
): Promise<{ basePath: string; siblingPath?: string }> {
  // Single disk boundary — the user's typed name must be normalizePath'd before
  // it touches the adapter (CLAUDE.md path rule; mobile pastes stray slashes).
  // The modal normalizes too, so its collision pre-check and this write agree.
  const target = normalizePath(newBasePath);
  // String equality ⟺ byte equality ⟺ SHA equality (utf8 is injective here).
  // Compare RAW (both empty ⟹ converged); each write applies the empty→"\n"
  // guard below (§5.0.e single-write paths keep it locally).
  const converged = resolved.base === resolved.sibling;

  // Fail-closed: resolve + check BOTH targets BEFORE any write — never overwrite
  // an existing file, and never leave an orphan base if the derived sibling
  // collides (both checks, then both writes).
  if (await vault.adapter.exists(target)) {
    throw new AltTargetExistsError(target);
  }
  let siblingPath: string | undefined;
  if (!converged) {
    siblingPath = buildSiblingPath(target, deviceLabel, ts, "modify-vs-modify");
    if (await vault.adapter.exists(siblingPath)) {
      throw new AltTargetExistsError(siblingPath);
    }
  }

  // base FIRST — a crash leaves the named file, not an orphan sibling.
  await atomicWriteFile(vault, target, utf8(guardEmpty(resolved.base)));
  if (siblingPath) {
    await atomicWriteFile(vault, siblingPath, utf8(guardEmpty(resolved.sibling)));
  }
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);
  return { basePath: target, siblingPath };
}

// ── §5.0.a / §5.0.b — per-dir crash recovery ─────────────────────────

export type RecoverResult =
  | { kind: "no-commit" } // done.json absent — a plain autosave dir (Stage 3 owns it)
  | { kind: "rolled-forward"; siblingRemoved: boolean } // D–K: completed the commit
  | { kind: "rolled-back" } // A–C: abandoned the commit, session preserved
  | { kind: "fallback"; reason: string }; // foreign/corrupt: session destroyed, vault intact

// SHA-classified state of one file's three slots (DIFF-EDITOR.md §5.0.b
// columns). Each is a PURE function of disk bytes — recovery never needs to
// know "which step crashed", only what's on disk now.
type FinalState = "absent" | "old" | "new" | "foreign";
type TmpState = "absent" | "tmpNew" | "tmpTorn";

interface SideState {
  finalPath: string;
  tmpPath: string;
  bakPath: string;
  final: FinalState;
  tmp: TmpState;
  bak: boolean;
}

// Recover one `.diff2-autosave/<autosaveId>/` dir per §5.0.a/b. Returns the
// action taken. Iterating over all dirs at onload (and merging with §4.2
// autosave cleanup) is Phase 11; this is the single-dir unit the sweep calls.
// Per §5.0.c we only ever touch `.sync-{tmp,bak}` files derived from THIS
// dir's meta paths — orphans without a matching meta are sync2's sweep.
export async function recoverCommit(
  vault: Vault,
  autosaveId: string,
): Promise<RecoverResult> {
  const done = await readDoneJson(vault, autosaveId);
  if (!done) return { kind: "no-commit" }; // §5.0.a: no commit started

  const meta = await readMeta(vault, autosaveId);
  if (!meta) {
    // done.json without meta is unrecoverable (no paths to resolve). Drop the
    // dir; any vault-level staging orphans fall to sync2's sweep (§5.0.c).
    await vault.adapter.rmdir(autosaveDir(autosaveId), true);
    return { kind: "fallback", reason: "meta-missing" };
  }

  // Is the committed base end-state ABSENT (a delete)? done.deleteBase is
  // authoritative (commit7Step records it for case-4 had-content deletions meta
  // can't otherwise distinguish from a genuine 0-byte file). Fallback for a
  // done.json without the field (delete-vs-modify written before the field
  // existed): infer from meta — empty committed base + absent at start. Mirror of
  // baseCommitAction.
  const deleteBase =
    done.deleteBase ??
    (done.expectedBaseSha === GIT_EMPTY_BLOB_SHA && !meta.baseExistedAtStart);

  const base = await classifySide(
    vault,
    meta.basePath,
    meta.baseShaAtStart,
    done.expectedBaseSha,
    deleteBase,
  );
  const sibling = await classifySide(
    vault,
    meta.siblingPath,
    meta.siblingShaAtStart,
    done.expectedSiblingSha,
  );

  // A final slot that matches NEITHER the session-start bytes NOR the committed
  // bytes is EITHER (a) our own torn modifyBinary (bug3 modify-in-place is not
  // atomic), OR (b) an external write (another device's sync, a manual edit).
  // The discriminator is OUR clean tmp: a torn final WITH `tmp === "tmpNew"` is
  // our half-written commit → roll forward from the clean tmp. A non-matching
  // final WITHOUT our clean tmp is a genuine external edit → fall back (never
  // clobber it). Under the old safeRename promote a torn final was impossible,
  // so "foreign" alone meant external; modify-in-place adds the torn case, hence
  // the `&& tmp !== "tmpNew"` qualifier (§5.0.b). Residual risk: an external
  // edit of this exact file in the crash→onload window WHILE our clean tmp sits
  // staged → we roll forward over it. Same risk class atomicWriteFile already
  // accepts; not engineered around. Post-commit rows still have final === "new"
  // (not foreign) and roll forward as before.
  if (
    (base.final === "foreign" && base.tmp !== "tmpNew") ||
    (sibling.final === "foreign" && sibling.tmp !== "tmpNew")
  ) {
    await cleanupStagingAndDir(vault, autosaveId, base, sibling);
    return { kind: "fallback", reason: "external-modification" };
  }

  // For a delete-base, any non-foreign final is a roll-FORWARD state: "new" =
  // already absent (committed), "old" = present-but-recoverable (finish by
  // removing). The foreign case already bailed above. The dispatch still gates
  // on the sibling, so a not-yet-committed sibling rolls the pair back safely.
  const baseHasNew =
    deleteBase || base.final === "new" || base.tmp === "tmpNew";
  const siblingHasNew = sibling.final === "new" || sibling.tmp === "tmpNew";

  if (baseHasNew && siblingHasNew) {
    // ROLL FORWARD (rows D–K): a committed version of each side exists.
    await rollForwardSide(vault, base, deleteBase);
    await rollForwardSide(vault, sibling);
    // Step 6.5 — proactive sibling cleanup if both sides committed identical.
    let siblingRemoved = false;
    if (
      done.expectedBaseSha === done.expectedSiblingSha &&
      (await vault.adapter.exists(meta.siblingPath))
    ) {
      await vault.adapter.remove(meta.siblingPath);
      siblingRemoved = true;
    }
    await vault.adapter.rmdir(autosaveDir(autosaveId), true); // step 7
    return { kind: "rolled-forward", siblingRemoved };
  }

  // ROLL BACK (rows A–C): the commit never produced a usable version of both
  // sides (pre-write, or a torn .sync-tmp). Originals are untouched at their
  // final paths (.sync-bak only ever appears once both tmp✓, i.e. in the
  // forward states). Drop the partial staging + done.json; the autosave
  // session survives so the user can re-resolve.
  //
  // CLOSURE: this branch is provably correct only over crash-REACHABLE states
  // — for every real crash, a .sync-bak implies both tmps completed ⇒ both
  // hasNew ⇒ forward, so a rollback state can never carry a bak. We therefore
  // leave any bak untouched (it still holds the original — no data loss even
  // in an externally-corrupted, unreachable shape; the file is just at .bak).
  // We do NOT attempt restore-from-bak for such shapes (speculative; would add
  // code for a state no crash produces).
  await removeIfExists(vault, base.tmpPath);
  await removeIfExists(vault, sibling.tmpPath);
  await removeIfExists(vault, donePath(autosaveId));
  return { kind: "rolled-back" };
}

// Bring one side to its committed end-state from any forward (D–K) disk state.
// Idempotent and crash-safe — re-running after a crash mid-recovery converges.
// deleteIntent: the committed end-state is ABSENT (an empty-resolved base that
// was absent at session start). classifySide already mapped absent→"new" for it;
// any present final is a not-yet-completed delete (final="old") which we finish
// by removing. There is no tmp to roll forward from (a delete stages nothing).
async function rollForwardSide(
  vault: Vault,
  s: SideState,
  deleteIntent = false,
): Promise<void> {
  if (deleteIntent) {
    if (s.final !== "new") await removeIfExists(vault, s.finalPath); // finish the delete
    await removeIfExists(vault, s.tmpPath); // defensive (none staged)
    await removeIfExists(vault, s.bakPath);
    return;
  }
  if (s.final !== "new") {
    // hasNew && final≠new ⇒ tmp is tmpNew. safeRename removes the (old/absent)
    // final then promotes the tmp — mobile-safe.
    await safeRename(vault.adapter, s.tmpPath, s.finalPath);
  } else {
    // final already committed; drop any stray tmp defensively.
    await removeIfExists(vault, s.tmpPath);
  }
  await removeIfExists(vault, s.bakPath); // step 6 cleanup
}

async function cleanupStagingAndDir(
  vault: Vault,
  autosaveId: string,
  base: SideState,
  sibling: SideState,
): Promise<void> {
  // §5.0.b default fallback: remove our staging files + the session dir; leave
  // the (foreign) final bytes in place. Vault stays consistent; session lost.
  await removeIfExists(vault, base.tmpPath);
  await removeIfExists(vault, base.bakPath);
  await removeIfExists(vault, sibling.tmpPath);
  await removeIfExists(vault, sibling.bakPath);
  await vault.adapter.rmdir(autosaveDir(autosaveId), true);
}

// ── internals ────────────────────────────────────────────────────────

async function classifySide(
  vault: Vault,
  finalPath: string,
  oldSha: string,
  newSha: string,
  expectedAbsent = false,
): Promise<SideState> {
  const tmpPath = stagingPathFor(finalPath, "tmp");
  const bakPath = stagingPathFor(finalPath, "bak");

  // expectedAbsent (delete-base): the committed end-state is "file absent".
  //   absent  → "new" (committed — the delete is done)
  //   present & start-bytes → "old" (delete not yet completed; roll forward removes it)
  //   present & other       → "foreign" (external write; never clobber → fallback)
  let final: FinalState = expectedAbsent ? "new" : "absent";
  if (await vault.adapter.exists(finalPath)) {
    const sha = await calculateGitBlobSHA(await vault.adapter.readBinary(finalPath));
    final = expectedAbsent
      ? sha === oldSha
        ? "old"
        : "foreign"
      : sha === newSha
        ? "new"
        : sha === oldSha
          ? "old"
          : "foreign";
  }

  let tmp: TmpState = "absent";
  if (await vault.adapter.exists(tmpPath)) {
    const sha = await calculateGitBlobSHA(await vault.adapter.readBinary(tmpPath));
    tmp = sha === newSha ? "tmpNew" : "tmpTorn";
  }

  const bak = await vault.adapter.exists(bakPath);
  return { finalPath, tmpPath, bakPath, final, tmp, bak };
}

async function readDoneJson(vault: Vault, autosaveId: string): Promise<DoneJson | null> {
  const p = donePath(autosaveId);
  if (!(await vault.adapter.exists(p))) return null;
  try {
    return JSON.parse(await vault.adapter.read(p)) as DoneJson;
  } catch {
    return null; // corrupt barrier → treat as no commit started
  }
}

async function removeIfExists(vault: Vault, path: string): Promise<void> {
  if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
}

// Read a file's bytes, or 0 bytes if it does not exist — so an absent conflict
// side (delete-vs-modify base) hashes to SHA("") instead of throwing ENOENT.
async function readOrEmpty(vault: Vault, path: string): Promise<ArrayBuffer> {
  return (await vault.adapter.exists(path))
    ? vault.adapter.readBinary(path)
    : (new ArrayBuffer(0) as ArrayBuffer);
}
