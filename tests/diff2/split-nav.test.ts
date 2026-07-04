// Ctrl/⌘-open-to-the-right placement geometry (§ user request 2026-07-04). The pure resolver
// picks the window immediately to the right of the origin, in the same horizontal band.

import { describe, expect, it } from "vitest";
import { findRightNeighborIndex, type Rect } from "../../src/diff2/split-nav";

const r = (left: number, top = 0, width = 100, height = 100): Rect => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
});

describe("findRightNeighborIndex", () => {
  it("no candidates → -1", () => {
    expect(findRightNeighborIndex(r(0), [])).toBe(-1);
  });

  it("only a window to the LEFT / same column → -1 (no right neighbour)", () => {
    // left neighbour + a window stacked BELOW the origin (same left) — neither is to the right.
    expect(findRightNeighborIndex(r(200), [r(0), r(200, 200)])).toBe(-1);
  });

  it("one window to the right → its index", () => {
    expect(findRightNeighborIndex(r(0), [r(200)])).toBe(0);
  });

  it("many windows to the right → the CLOSEST (smallest left edge)", () => {
    // origin at 0; candidates at 400, 100(closest), 250 → index 1.
    expect(findRightNeighborIndex(r(0), [r(400), r(100), r(250)])).toBe(1);
  });

  it("a further-right window in a DIFFERENT row is ignored (no vertical overlap)", () => {
    // origin occupies rows 0..100. A window to the right but in the bottom band (top 200) is not
    // a right neighbour; the one overlapping the row wins even if further left is absent.
    expect(findRightNeighborIndex(r(0), [r(150, 200)])).toBe(-1);
    expect(findRightNeighborIndex(r(0), [r(150, 200), r(300, 0)])).toBe(1);
  });

  it("a window at the same left edge (stacked) is not 'to the right'", () => {
    expect(findRightNeighborIndex(r(100), [r(100, 200)])).toBe(-1);
  });
});
