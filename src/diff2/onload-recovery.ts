// Onload recovery driver for the diff2 autosave subsystem
// (DIFF-EDITOR.md §5.0.a / §4.2 — the Phase-11 "onload sweep" unification
// point). Runs at plugin startup, and MUST run BEFORE sync2's
// `AtomicWriteRecovery.sweep`: `commit7Step` stages the resolved base+sibling
// through the SAME `.sync-tmp`/`.sync-bak` suffixes the naive sweep scans, so
// only `recoverCommit`'s `done.json`-coordinated A–K dispatch can restore the
// PAIR atomically. The naive sweep would forward-recover each side
// independently and break pair-atomicity (SYNC2 §10 / DIFF-EDITOR §5.0.b).
//
// FILESYSTEM-DRIVEN — it iterates the actual `.diff2-autosave/` directory
// entries (dir name = the autosave id) and NEVER re-derives ids from the live
// ConflictStore. So a tracked conflict whose record was resolved/removed
// between crash and restart still recovers: the dir is self-contained
// (meta.json carries the base/sibling paths recoverCommit needs).
//
// Two steps, honouring the §4.2-vs-§5.0.a precedence:
//   1. `sweepAll` — rmdir the §4.2-condemned stale sessions, and surface the
//      `done.json` dirs as `defer-to-commit` (it deliberately never sweeps
//      those — a commit-in-progress is recoverCommit's, not cleanup's).
//   2. `recoverCommit` on each deferred dir — finish (roll-forward) or abandon
//      (roll-back) the interrupted `[←]` commit per the disk state.

import type { Vault } from "obsidian";
import { sweepAll } from "./autosave-cleanup";
import { recoverCommit, type RecoverResult } from "./exit-commit";
import { recoverHistoryRewrite } from "./history-rewrite";

export interface OnloadRecoveryResult {
  // Total `.diff2-autosave/*` dirs seen this sweep.
  dirs: number;
  // §4.2-condemned dirs rmdir'd by sweepAll (stale/orphaned sessions).
  swept: number;
  // `done.json` dirs handed to recoverCommit (interrupted commits).
  recovered: number;
  // Per-recovered-dir outcome, for logging / assertions.
  results: Array<{ conflictId: string; recover: RecoverResult }>;
}

export async function recoverAutosaveDirs(
  vault: Vault,
): Promise<OnloadRecoveryResult> {
  const sweepResults = await sweepAll(vault);
  const results: Array<{ conflictId: string; recover: RecoverResult }> = [];
  for (const r of sweepResults) {
    // §0.5.5 — finish/roll-back any interrupted history compaction-swap first, so a
    // crash mid-rewrite leaves a consistent history.jsonl before anything reads it.
    // Independent of the done.json/commit recovery below (different files).
    await recoverHistoryRewrite(vault, r.conflictId);
    if (r.decision.action === "defer-to-commit") {
      const recover = await recoverCommit(vault, r.conflictId);
      results.push({ conflictId: r.conflictId, recover });
    }
  }
  return {
    dirs: sweepResults.length,
    swept: sweepResults.filter((r) => r.decision.action === "sweep").length,
    recovered: results.length,
    results,
  };
}
