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
