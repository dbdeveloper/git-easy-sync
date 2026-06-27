// §2.2.15 toolbar — pure conflict-navigation helpers.

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import { groupsOf } from "../../src/diff2/diff-selection";
import { conflictCount, firstConflict, nextConflict, prevConflict } from "../../src/diff2/diff-nav";

// two groups: a | [L1/R1] | M | [L2/R2] | b
const m = buildModel("a\nL1\nM\nL2\nb\n", "a\nR1\nM\nR2\nb\n");
const ranges = m.ranges;
const [g0, g1] = groupsOf(ranges);
const noConflict = buildModel("a\nb\n", "a\nb\n").ranges;

describe("diff-nav — conflict navigation (pure)", () => {
  it("conflictCount = number of groups", () => {
    expect(conflictCount(ranges)).toBe(2);
    expect(conflictCount(noConflict)).toBe(0);
  });

  it("firstConflict = the first group (Auto-focus target)", () => {
    expect(firstConflict(ranges)).toEqual(g0);
    expect(firstConflict(noConflict)).toBeNull();
  });

  it("nextConflict: before g0 → g0; inside g0 → g1; inside g1 → null", () => {
    expect(nextConflict(ranges, 0)).toEqual(g0); // caret in leading "a"
    expect(nextConflict(ranges, g0.from + 1)).toEqual(g1); // inside g0 skips it
    expect(nextConflict(ranges, g1.from + 1)).toBeNull(); // inside g1, none below
  });

  it("prevConflict: after g1 → g1; between groups → g0; inside g0 → null", () => {
    expect(prevConflict(ranges, g1.to)).toEqual(g1); // at/after g1 end
    expect(prevConflict(ranges, g0.to)).toEqual(g0); // between the groups
    expect(prevConflict(ranges, g0.from + 1)).toBeNull(); // inside g0, none above
  });

  it("no conflicts → both nav return null", () => {
    expect(nextConflict(noConflict, 0)).toBeNull();
    expect(prevConflict(noConflict, 99)).toBeNull();
  });
});
