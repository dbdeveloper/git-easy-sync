// §2.2.15 toolbar — conflict NAVIGATION helpers (pure; the view layer scrolls + sets the
// caret). A "conflict" = a diff-group; `groupsOf` returns them sorted by start. Navigation
// and Auto-focus are expressed relative to the caret as group spans, so the view just maps
// the result to a scroll + caret-at-ver1.from.

import type { VerRange } from "./diff-model";
import { type GroupSpan, groupsOf } from "./diff-selection";

// How many unresolved conflicts (diff-groups) remain. Drives the toolbar `NNN` count and the
// all-disabled state.
export function conflictCount(ranges: VerRange[]): number {
  return groupsOf(ranges).length;
}

// The NEXT conflict strictly after the caret — the first group whose start is past `caret`.
// A caret INSIDE group N (N.from < caret) skips N → returns N+1. null if none below ([↓] disabled).
export function nextConflict(ranges: VerRange[], caret: number): GroupSpan | null {
  return groupsOf(ranges).find((g) => g.from > caret) ?? null;
}

// The PREVIOUS conflict strictly before the caret — the last group that ENDS at/before `caret`
// (`to <= caret`). A caret INSIDE group N (caret < N.to) excludes N → returns N-1. null if none
// above ([↑] disabled).
export function prevConflict(ranges: VerRange[], caret: number): GroupSpan | null {
  const gs = groupsOf(ranges);
  for (let i = gs.length - 1; i >= 0; i--) {
    if (gs[i].to <= caret) return gs[i];
  }
  return null;
}

// The FIRST conflict in the document (Auto-focus target on every resolve). null if none.
export function firstConflict(ranges: VerRange[]): GroupSpan | null {
  return groupsOf(ranges)[0] ?? null;
}
