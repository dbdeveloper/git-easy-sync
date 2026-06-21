// Phase 3 — V2 selection legalization (§2.2.4(5) intra-block + §2.2.6 group-atomic).
// Pure legalizeSelection across the case matrix + dispatch-level (the filter in
// the createDiffPaneState pipeline).

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import { groupsOf, legalizeSelection } from "../../src/diff2/diff-selection";
import { createDiffPaneState } from "../../src/diff2/diff-pane-v2";

// two groups: doc "a\nL1\n\nR1\n\nb\nL2\n\nR2\n\nc\n"
//   group0 ver1[2,6) ver2[6,10)  (span [2,10))
//   group1 ver1[12,16) ver2[16,20) (span [12,20))
//   normals "a\n"[0,2) "b\n"[10,12) "c\n"[20,22); docLength 22
const M = buildModel("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
const R = M.ranges;

describe("diff-selection — groupsOf", () => {
  it("pairs ver1/ver2 into group spans, sorted", () => {
    expect(groupsOf(R)).toEqual([
      { group: 0, from: 2, to: 10 },
      { group: 1, from: 12, to: 20 },
    ]);
  });
});

describe("diff-selection — legalizeSelection (§2.2.4(5) intra-block)", () => {
  it("keeps a plain selection within one ver-block unchanged", () => {
    expect(legalizeSelection(R, 2, 4)).toEqual({ anchor: 2, head: 4 }); // inside ver1 content
  });
  it("allows selecting up to (not including) the terminal \\n", () => {
    // ver1 [2,6): content [2,5)="L1\n", terminal \n at index 5. position 5 is the
    // last selectable (before the terminal char) → stays plain.
    expect(legalizeSelection(R, 2, 5)).toEqual({ anchor: 2, head: 5 });
  });
  it("a cursor (anchor===head) is never expanded", () => {
    expect(legalizeSelection(R, 3, 3)).toEqual({ anchor: 3, head: 3 });
    expect(legalizeSelection(R, 0, 0)).toEqual({ anchor: 0, head: 0 });
  });
});

describe("diff-selection — legalizeSelection (§2.2.6 group-atomic)", () => {
  it("crossing from ver1 into its sibling ver2 selects the WHOLE group", () => {
    expect(legalizeSelection(R, 3, 7)).toEqual({ anchor: 2, head: 10 }); // group0 span
  });
  it("a normal-anchored selection that touches a group includes the whole group", () => {
    expect(legalizeSelection(R, 0, 4)).toEqual({ anchor: 0, head: 10 });
  });
  it("preserves direction (upward selection)", () => {
    expect(legalizeSelection(R, 7, 3)).toEqual({ anchor: 10, head: 2 }); // anchor=hi, head=lo
  });
  it("spanning two groups includes both fully", () => {
    expect(legalizeSelection(R, 0, 14)).toEqual({ anchor: 0, head: 20 });
  });
  it("Ctrl+A (whole doc) needs no expansion — groups already contained", () => {
    expect(legalizeSelection(R, 0, 22)).toEqual({ anchor: 0, head: 22 });
  });
  it("a selection ending exactly at a group boundary does NOT pull the group in", () => {
    expect(legalizeSelection(R, 0, 2)).toEqual({ anchor: 0, head: 2 }); // touches no group char
  });
});

// §2.2.6 п.7e STRICT boundary — the cases the old symmetric rule got wrong. group0:
// ver1[2,6) ver2[6,10); boundary v2.from=6 (=v1.to), v2.to=10, v1.from=2.
describe("diff-selection — legalizeSelection (§2.2.6 п.7e STRICT boundary)", () => {
  it("7e.ii: anchor in ver1, head AT v2.from (pos-0-of-ver2) → ver1-only (NOT whole group)", () => {
    // [2,6) covers indices 2..5 = all ver1 incl its terminal \n; ZERO ver2 chars.
    expect(legalizeSelection(R, 2, 6)).toEqual({ anchor: 2, head: 6 });
    expect(legalizeSelection(R, 4, 6)).toEqual({ anchor: 4, head: 6 }); // partial ver1 too
  });

  it("7e.ii crossing: anchor in ver1, head PAST v2.from (≥1 ver2 char) → WHOLE group", () => {
    expect(legalizeSelection(R, 2, 7)).toEqual({ anchor: 2, head: 10 }); // index 6 = ver2 char
  });

  it("7e.i: anchor in normal above, head AT v1.from → normal-only; PAST → whole group", () => {
    expect(legalizeSelection(R, 0, 2)).toEqual({ anchor: 0, head: 2 }); // pos-0-of-ver1, 0 group chars
    expect(legalizeSelection(R, 0, 3)).toEqual({ anchor: 0, head: 10 }); // index 2 = ver1 char → whole
  });

  it("7e.iii: anchor in ver2, head AT v2.to (pos-0 of next normal) → ver2-only; PAST → whole", () => {
    expect(legalizeSelection(R, 6, 10)).toEqual({ anchor: 6, head: 10 }); // all ver2, 0 chars after
    expect(legalizeSelection(R, 8, 10)).toEqual({ anchor: 8, head: 10 }); // partial ver2
    expect(legalizeSelection(R, 6, 11)).toEqual({ anchor: 2, head: 11 }); // index 10 = normal-after → group in, the normal char stays
  });

  it("upward ver2-only: anchor v2.to, head v2.from → ver2-only, direction kept", () => {
    expect(legalizeSelection(R, 10, 6)).toEqual({ anchor: 10, head: 6 });
  });

  it("full ver1 incl terminal [v1.from, v2.from] stays ver1-only (lights ver1 markers)", () => {
    expect(legalizeSelection(R, 2, 6)).toEqual({ anchor: 2, head: 6 });
  });
});

describe("diff-selection — legalizeSelection (§2.2.6 п.7e empty ver-blocks)", () => {
  it("empty ver1: head at pos-0 of empty ver1 → normal-only; extend into ver2 → whole", () => {
    const m = buildModel("a\nb\n", "a\nX\nb\n"); // ver1 empty
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    expect(v1.to - v1.from).toBe(1); // empty (terminal only)
    // head at v1.from = pos-0 of empty ver1, 0 group chars captured → normal-only.
    expect(legalizeSelection(m.ranges, 0, v1.from)).toEqual({ anchor: 0, head: v1.from });
    // extend to v2.from (=v1.to): now ver1's terminal is captured → whole group.
    expect(legalizeSelection(m.ranges, 0, v2.from)).toEqual({ anchor: 0, head: v2.to });
  });

  it("empty ver2: anchor in ver1, head at pos-0 of empty ver2 → ver1-only; past → whole", () => {
    const m = buildModel("a\nX\nb\n", "a\nb\n"); // ver2 empty
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    expect(v2.to - v2.from).toBe(1); // empty
    // anchor v1.from, head v2.from (=v1.to): all ver1, 0 ver2 chars → ver1-only.
    expect(legalizeSelection(m.ranges, v1.from, v2.from)).toEqual({ anchor: v1.from, head: v2.from });
    // head at v2.to (past the empty ver2's terminal) → ver2 char captured → whole.
    expect(legalizeSelection(m.ranges, v1.from, v2.to)).toEqual({ anchor: v1.from, head: v2.to });
  });
});

describe("diff-selection — dispatch-level (filter in createDiffPaneState)", () => {
  const state = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");

  it("a selection from a normal line into a group expands to the whole group", () => {
    const s1 = state.update({ selection: { anchor: 0, head: 4 } }).state;
    expect(s1.selection.main.anchor).toBe(0);
    expect(s1.selection.main.head).toBe(10);
  });
  it("a plain in-block selection passes through unchanged", () => {
    const s1 = state.update({ selection: { anchor: 2, head: 4 } }).state;
    expect(s1.selection.main.anchor).toBe(2);
    expect(s1.selection.main.head).toBe(4);
  });
  it("crossing ver1→ver2 selects the whole group", () => {
    const s1 = state.update({ selection: { anchor: 3, head: 7 } }).state;
    expect([s1.selection.main.from, s1.selection.main.to]).toEqual([2, 10]);
  });
  it("STRICT: head landing AT v2.from (Shift+Down out of ver1) stays ver1-only", () => {
    const s1 = state.update({ selection: { anchor: 2, head: 6 } }).state;
    expect([s1.selection.main.anchor, s1.selection.main.head]).toEqual([2, 6]); // not expanded
  });
});
