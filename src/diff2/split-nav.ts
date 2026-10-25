// Open-to-the-right placement (Ctrl/⌘ + click or Enter on a list row). Pure geometry so it's
// unit-testable and doesn't depend on Obsidian's counter-intuitive WorkspaceSplit `direction`
// terminology: given the ORIGIN (panel/history) window rectangle and the visible candidate
// windows' rectangles, pick the window IMMEDIATELY to the right (smallest left-edge among those
// that start to the right of the origin and overlap it vertically = "same row"). main.ts feeds
// real getBoundingClientRect()s; the caller opens a tab in that window's group, or — when there
// is none — splits the origin to the right.

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// Tolerance (px) so sub-pixel rounding / a shared divider doesn't misclassify a right neighbour.
const TOL = 1;

// Index of the closest right-neighbour rect, or -1 when the origin has no window to its right.
export function findRightNeighborIndex(
  origin: Rect,
  candidates: readonly Rect[],
): number {
  let best = -1;
  let bestLeft = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const startsToTheRight = c.left > origin.left + TOL;
    // vertical overlap → the same horizontal band (a window stacked below the origin, or in a
    // different row, is NOT a right neighbour even if it happens to be further right).
    const sameRow = c.top < origin.bottom - TOL && c.bottom > origin.top + TOL;
    if (startsToTheRight && sameRow && c.left < bestLeft) {
      bestLeft = c.left;
      best = i;
    }
  }
  return best;
}

// The leaf an open-to-the-right starts from (owner, 2026-10-25): the one
// the keyboard is in — the Ctrl+Enter / Ctrl+click just happened there.
// Obsidian's active leaf is only the fallback: after a tab is torn off
// into its own window it is often still a tab in the main window, and the
// editor opened THERE.
export function openOriginLeaf<L>(leaves: readonly L[], holdsFocus: (l: L) => boolean, active: L | null): L | null {
  return leaves.find(holdsFocus) ?? active;
}

// The candidate right-hand neighbours: the leaves in the origin's OWN
// window (a pop-out has a root of its own; the main window's used to be
// the only one looked at).
export function sameWindowLeaves<L extends { getRoot(): unknown }>(origin: L, leaves: readonly L[]): L[] {
  const root = origin.getRoot();
  return leaves.filter((l) => l !== origin && l.getRoot() === root);
}
