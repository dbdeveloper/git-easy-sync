// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy.
//
// Phase 7 / 9b (HISTORY-DELETED.md §4.5.3) — the EPHEMERAL session lifecycle for
// History + Deleted editors. Unlike a conflict (a REAL, on-disk conflict whose
// `.diff2-autosave/<id>/` dir persists for crash-recovery), a History/Deleted editor
// is a transient view; its session dir must "follow the tab" and never accumulate on
// disk as the user browses versions.
//
// This module is the PURE core. The Obsidian glue (list dirs, collect live editor
// ids, rmdir) lives in main.ts.
//
// B1 = the onload orphan-sweep (the accumulation GUARANTEE): after layout-ready (once
// Obsidian's native restore + our own reopen have run), any history-/deleted- autosave
// dir NOT claimed by a live editor tab is wiped. Conflict dirs (tracked-/synthetic-)
// keep their existing §4.2 sweep — the prefix is what protects them.

// The autosaveId prefixes `deriveAutosaveId("history"|"deleted", …)` produces. ONLY
// these are ephemeral (subject to the orphan-sweep). `tracked-`/`synthetic-` (conflict)
// and `compare-` are never touched by it.
const EPHEMERAL_PREFIXES = ["history-", "deleted-"] as const;

/** True iff `id` names a History/Deleted (ephemeral) autosave session. */
export function isEphemeralAutosaveId(id: string): boolean {
  return EPHEMERAL_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * B1 orphan-sweep (pure). Given every autosave dir name (each equals its autosaveId)
 * and the set of ids claimed by a currently-open diff2-editor, return the ephemeral
 * (history/deleted) ids with NO live tab → to be wiped. Order-preserving; NEVER
 * returns a conflict/compare id (those are the §4.2 sweep's job).
 */
export function historyDeletedOrphans(
  autosaveIds: readonly string[],
  liveEditorIds: ReadonlySet<string>,
): string[] {
  return autosaveIds.filter(
    (id) => isEphemeralAutosaveId(id) && !liveEditorIds.has(id),
  );
}

/**
 * §4.5.3 layout-restore TTL check (pure). The onunload marker holds `savedAt`; on the
 * next onload we replay the layout ONLY if the gap is small — i.e. it was a fast
 * RELOAD (self-update / BRAT / disable+enable, seconds), not a deliberate long disable
 * (minutes / months). A future/nonsensical `savedAt` (clock skew) reads as NOT fresh.
 */
export function isLayoutRestoreFresh(
  savedAtMs: number,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs >= savedAtMs && nowMs - savedAtMs < ttlMs;
}
