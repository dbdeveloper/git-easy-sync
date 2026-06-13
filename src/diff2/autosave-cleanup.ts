// Stage 3c — autosave cleanup sweep (DIFF-EDITOR.md §4.2).
//
// History-logs live as long as they're relevant (§4.1). On plugin onload we
// sweep `.diff2-autosave/<id>/` dirs that are unusable. Per-dir decision:
//
//   done.json present  → commit-in-progress: DEFER to §5.0.a recoverCommit
//                        (NOT §4.2). Only if recovery falls through to its
//                        default fallback does §4.2 then apply.
//   else, sweep if ANY of (§4.2 conditions 1–7 + §4.1 empty):
//     1 no meta.json (or unparseable)   2 no history.jsonl   3 no cursor-a/b.json (neither slot)
//     2b history.jsonl holds ZERO trustworthy records (§4.1 zero-edit invariant —
//        a session that recorded no edit has no recovery value; the controlled
//        exits already wipe these, so this only catches crash-survivors)
//     4 no base.snapshot / sibling.snapshot
//     5 snapshot SHA ≠ meta (sha(read snapshot) ≠ meta.*ShaAtStart) — corruption
//     6 an input file (basePath / siblingPath) missing in the vault
//     7 SHA(vault[base]) === SHA(vault[sibling]) — conflict self-resolved
//   else → keep.
//
// NOTE (§4.2): "input SHA ≠ meta.*ShaAtStart" is NOT a sweep trigger — a
// vault-changed-but-valid session is §3 recovery-dialog territory (classifyReopen
// → vault-changed), not silent wipe. The snapshots are the ground truth we keep.
//
// SCOPE (tested core): classifySweep (decision) + sweepAll (list + rmdir the
// sweeps, return the defer-to-commit ids for the caller). Wiring the onload
// trigger and running recoverCommit on the deferred ids is Phase 11.

import type { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import {
  AUTOSAVE_ROOT,
  autosaveDir,
  cursorSlotPath,
  readMeta,
} from "./autosave-store";
import { assessHistoryV2 } from "./history-replay-v2";

export type SweepDecision =
  | { action: "keep" }
  | { action: "sweep"; reason: SweepReason }
  | { action: "defer-to-commit" }; // done.json present → recoverCommit owns it

export type SweepReason =
  | "no-meta"
  | "no-history"
  | "empty-history"
  | "no-cursor"
  | "no-snapshot"
  | "snapshot-sha-mismatch"
  | "input-missing"
  | "self-resolved";

const p = (id: string, name: string): string => `${autosaveDir(id)}/${name}`;

export async function classifySweep(
  vault: Vault,
  conflictId: string,
): Promise<SweepDecision> {
  const a = vault.adapter;

  // Pre-check (§4.2 precedence): a commit is in progress → recoverCommit, not us.
  if (await a.exists(p(conflictId, "done.json"))) return { action: "defer-to-commit" };

  const meta = await readMeta(vault, conflictId); // null on missing/unparseable
  if (!meta) return { action: "sweep", reason: "no-meta" }; // cond 1
  if (!(await a.exists(p(conflictId, "history.jsonl")))) {
    return { action: "sweep", reason: "no-history" }; // cond 2
  }
  // cond 2b (§4.1 zero-edit invariant) — history.jsonl exists but holds ZERO
  // trustworthy records → the session never recorded an edit → no recovery value
  // (it would only ever reopen as a "0 edits saved" resume). `empty` excludes a
  // corrupt-first-block log (that one is kept: there WAS user activity → §3.5
  // corrupt-recovery modal). Cheap single read.
  if (assessHistoryV2(await a.read(p(conflictId, "history.jsonl"))).empty) {
    return { action: "sweep", reason: "empty-history" };
  }
  // cond 3 — §2.9 ping-pong: sweep only when NEITHER slot exists (a live
  // session always has at least the survivor slot).
  const hasCursorA = await a.exists(cursorSlotPath(conflictId, "a"));
  const hasCursorB = await a.exists(cursorSlotPath(conflictId, "b"));
  if (!hasCursorA && !hasCursorB) {
    return { action: "sweep", reason: "no-cursor" };
  }
  const hasBaseSnap = await a.exists(p(conflictId, "base.snapshot"));
  const hasSibSnap = await a.exists(p(conflictId, "sibling.snapshot"));
  if (!hasBaseSnap || !hasSibSnap) return { action: "sweep", reason: "no-snapshot" }; // cond 4

  // cond 5 — snapshot integrity (meta and snapshots must agree).
  const baseSnapSha = await calculateGitBlobSHA(await a.readBinary(p(conflictId, "base.snapshot")));
  const sibSnapSha = await calculateGitBlobSHA(await a.readBinary(p(conflictId, "sibling.snapshot")));
  if (baseSnapSha !== meta.baseShaAtStart || sibSnapSha !== meta.siblingShaAtStart) {
    return { action: "sweep", reason: "snapshot-sha-mismatch" };
  }

  // cond 6 — an input file vanished from the vault.
  if (!(await a.exists(meta.basePath)) || !(await a.exists(meta.siblingPath))) {
    return { action: "sweep", reason: "input-missing" };
  }

  // cond 7 — the conflict self-resolved (both inputs now byte-identical).
  const baseSha = await calculateGitBlobSHA(await a.readBinary(meta.basePath));
  const sibSha = await calculateGitBlobSHA(await a.readBinary(meta.siblingPath));
  if (baseSha === sibSha) return { action: "sweep", reason: "self-resolved" };

  return { action: "keep" };
}

export interface SweepResult {
  conflictId: string;
  decision: SweepDecision;
}

// Sweep every `.diff2-autosave/<id>/` dir: rmdir the ones §4.2 condemns, leave
// the keepers, and RETURN the defer-to-commit ids (the Phase-11 caller runs
// recoverCommit on those — keeping the §4.2-vs-§5.0.a precedence honest).
// Idempotent (§4.3): a second run over the survivors decides the same way.
export async function sweepAll(vault: Vault): Promise<SweepResult[]> {
  const a = vault.adapter;
  if (!(await a.exists(AUTOSAVE_ROOT))) return [];
  const { folders } = await a.list(AUTOSAVE_ROOT);
  const out: SweepResult[] = [];
  for (const folder of folders) {
    const conflictId = folder.slice(folder.lastIndexOf("/") + 1);
    const decision = await classifySweep(vault, conflictId);
    if (decision.action === "sweep") {
      await a.rmdir(autosaveDir(conflictId), true);
    }
    out.push({ conflictId, decision });
  }
  return out;
}
