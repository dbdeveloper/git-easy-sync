// §2.2.6 п.7c / п.7f — mouse drag selection (pure). Verifies that mapping each drag
// endpoint to a doc position (marker zone → boundary; text → exact) and running the SAME
// legalizeSelection the keyboard uses reproduces the §2.2.6 scenario table. happy-dom can't
// drive real drag geometry — that's harness-only; this pins the pure model.

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import { type Zone, markerBoundary, mouseDragSelection } from "../../src/diff2/diff-mouse-select";

function model(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  const v1 = m.ranges.find((r) => r.ver === 1 && r.group === 0)!;
  const v2 = m.ranges.find((r) => r.ver === 2 && r.group === 0)!;
  return { ranges: m.ranges, v1, v2 };
}
const T = (pos: number): Zone => ({ kind: "text", pos });
const M = (marker: "open" | "mid" | "close"): Zone => ({ kind: "marker", marker, group: 0 });

describe("markerBoundary — zone → canonical doc position", () => {
  const { ranges, v1, v2 } = model("A\nL1\nL2\nB\n", "A\nR1\nR2\nB\n");
  it("open(<<<<<) → ver1.from", () => expect(markerBoundary(ranges, 0, "open")).toBe(v1.from));
  it("mid(=====) → seam (v1.to === v2.from)", () => {
    expect(markerBoundary(ranges, 0, "mid")).toBe(v2.from);
    expect(v2.from).toBe(v1.to);
  });
  it("close(>>>>>) → ver2.to (pos 0 of normal below)", () => expect(markerBoundary(ranges, 0, "close")).toBe(v2.to));
  it("absent group → null", () => expect(markerBoundary(ranges, 99, "open")).toBeNull());
});

describe("mouseDragSelection — §2.2.6 scenario table (start × current)", () => {
  const { ranges, v1, v2 } = model("A\nL1\nL2\nB\n", "A\nR1\nR2\nB\n");
  const seam = v2.from; // === v1.to
  const above = 0; // inside normal "A"
  const v1in = v1.from + 1; // inside ver1 text
  const v2in = v2.from + 1; // inside ver2 text
  const below = v2.to + 1; // inside normal "B"
  const run = (s: Zone, c: Zone) => mouseDragSelection(s, c, ranges);

  it("1. normal-above → on <<<<< : normal-only", () => {
    expect(run(T(above), M("open"))).toEqual({ anchor: above, head: v1.from });
  });
  it("2. normal-above → on ===== : whole-group", () => {
    expect(run(T(above), M("mid"))).toEqual({ anchor: above, head: v2.to });
  });
  it("3. start <<<<< → in ver1 text : ver1-partial (plain)", () => {
    expect(run(M("open"), T(v1in))).toEqual({ anchor: v1.from, head: v1in });
  });
  it("4. start <<<<< → on ===== : WHOLE-ver1", () => {
    expect(run(M("open"), M("mid"))).toEqual({ anchor: v1.from, head: v1.to });
  });
  it("5. start <<<<< → in ver2 text : whole-group", () => {
    expect(run(M("open"), T(v2in))).toEqual({ anchor: v1.from, head: v2.to });
  });
  it("6. ver1 internal → on <<<<< : ver1-partial (begin)", () => {
    expect(run(T(v1in), M("open"))).toEqual({ anchor: v1in, head: v1.from });
  });
  it("7. ver1 internal → on ===== : ver1-partial (end)", () => {
    expect(run(T(v1in), M("mid"))).toEqual({ anchor: v1in, head: v1.to });
  });
  it("8. start ===== → on <<<<< : WHOLE-ver1 (range v1.from..v1.to)", () => {
    const r = run(M("mid"), M("open"))!;
    expect(Math.min(r.anchor, r.head)).toBe(v1.from);
    expect(Math.max(r.anchor, r.head)).toBe(v1.to);
  });
  it("9. start ===== → on >>>>> : WHOLE-ver2 (range v2.from..v2.to)", () => {
    const r = run(M("mid"), M("close"))!;
    expect(Math.min(r.anchor, r.head)).toBe(v2.from);
    expect(Math.max(r.anchor, r.head)).toBe(v2.to);
  });
  it("10. start >>>>> → on ===== : WHOLE-ver2", () => {
    const r = run(M("close"), M("mid"))!;
    expect(Math.min(r.anchor, r.head)).toBe(v2.from);
    expect(Math.max(r.anchor, r.head)).toBe(v2.to);
  });
  it("11. start >>>>> → on <<<<< : whole-group", () => {
    const r = run(M("close"), M("open"))!;
    expect(Math.min(r.anchor, r.head)).toBe(v1.from);
    expect(Math.max(r.anchor, r.head)).toBe(v2.to);
  });
  it("12. normal-below → on >>>>> : normal-only (below)", () => {
    expect(run(T(below), M("close"))).toEqual({ anchor: below, head: v2.to });
  });
  it("13. ver2 internal → on >>>>> : ver2-partial (end)", () => {
    expect(run(T(v2in), M("close"))).toEqual({ anchor: v2in, head: v2.to });
  });

  // ===== is atomic for a drag (no 50% split) — the seam head is the same regardless of
  // where on ===== the mouse stopped; whole-group needs EXITING ===== into the far block.
  it("start <<<<< → on ===== stays WHOLE-ver1 (not group) — exit needed for group", () => {
    expect(run(M("open"), M("mid"))).toEqual({ anchor: v1.from, head: v1.to });
    // one step into ver2 (exited =====) → group
    expect(run(M("open"), T(v2in))).toEqual({ anchor: v1.from, head: v2.to });
  });
});

// Empty-ver marker-drag is an edge case: the empty block has no chars and its slot
// coincides with the seam, so legalizeSelection's slideAnchor (the keyboard's empty-block
// exception, §2.2.6 п.7e.ii.d/iii.c) governs it. The EXACT result is therefore the keyboard
// mirror — pinned in the harness against the live keyboard, not hard-coded here. Here we
// only assert it resolves sanely (non-null, inside the group).
describe("mouseDragSelection — empty ver-blocks resolve within the group (exact = keyboard mirror, harness-verified)", () => {
  it("empty ver1: start <<<<< → on =====", () => {
    const { ranges, v1, v2 } = model("A\nB\n", "A\nX\nB\n"); // ver1 EMPTY, ver2 "X"
    expect(v1.to - v1.from).toBe(1);
    const r = mouseDragSelection(M("open"), M("mid"), ranges)!;
    expect(r).not.toBeNull();
    expect(Math.min(r.anchor, r.head)).toBeGreaterThanOrEqual(v1.from);
    expect(Math.max(r.anchor, r.head)).toBeLessThanOrEqual(v2.to);
  });
  it("empty ver2: start >>>>> → on =====", () => {
    const { ranges, v1, v2 } = model("A\nX\nB\n", "A\nB\n"); // ver2 EMPTY
    expect(v2.to - v2.from).toBe(1);
    const r = mouseDragSelection(M("close"), M("mid"), ranges)!;
    expect(r).not.toBeNull();
    expect(Math.min(r.anchor, r.head)).toBeGreaterThanOrEqual(v1.from);
    expect(Math.max(r.anchor, r.head)).toBeLessThanOrEqual(v2.to);
  });
});
