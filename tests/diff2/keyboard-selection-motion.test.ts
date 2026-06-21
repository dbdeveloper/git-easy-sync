// §2.2.6 п.7e KEYBOARD selection MOTION (Shift+Up/Down).
//
// SPLIT by what's testable where (the lesson from 4 lost rounds — happy-dom can't see
// CM6 moveVertically geometry, so the INTEGRATION is browser-verified, only the pure
// landing-DECISION is unit-tested):
//   - selectionVertTarget (pure): given the native moveVertically landing, snap the
//     head to the first region boundary in the travel direction. Unit-tested here
//     against the EXACT native landings OBSERVED in the browser harness.
//   - the integration (does Shift+Down actually produce that native landing + does
//     the legalizer/clipboard agree) is verified in the real Chromium harness
//     (harness/diff-pane-harness.html via browser MCP) — see the browser-verified
//     log in the commit. happy-dom CANNOT simulate it.

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import { selectionVertTarget } from "../../src/diff2/diff-structure";

// The harness model: "line 1\nline 2\nL1\nL2\nbelow\n" / "...R1...".
// doc "line 1\nline 2\nL1\nL2\n\nR1\n\nbelow\n"; ver1[14,21] ver2[21,25]; normal "below"[25,31].
const M = buildModel("line 1\nline 2\nL1\nL2\nbelow\n", "line 1\nline 2\nR1\nbelow\n");
const R = M.ranges;

describe("selectionVertTarget — boundary-stop (browser-observed native landings)", () => {
  it("col-0 normal → ver1: native already at v1.from → stays (7e.i OK)", () => {
    // OBSERVED: Shift+Down from idx 7 (col 0 of 'line 2') native-lands at 14.
    expect(selectionVertTarget(R, 7, 14, true)).toBe(14);
  });

  it("col-2 normal → OVERSHOOT past the group: snap to first boundary v1.from (7e.i bug→fix)", () => {
    // OBSERVED: Shift+Down from idx 9 (col 2) native-OVERSHOOTS to 25 (the normal
    // after the whole collapsed group). Snap to 14 = v1.from → normal-only selection.
    expect(selectionVertTarget(R, 9, 25, true)).toBe(14);
  });

  it("within multi-line ver1 (no boundary crossed) → native preserved", () => {
    // OBSERVED: from idx 14 (L1) native-lands at 17 (L2) — same ver1, no snap.
    expect(selectionVertTarget(R, 14, 17, true)).toBe(17);
  });

  it("ver1 last line → ver2: snap to v2.from (7e.ii.a)", () => {
    // OBSERVED: from idx 17 (L2) Shift+Down → head 21 = v2.from.
    expect(selectionVertTarget(R, 17, 21, true)).toBe(21);
    expect(selectionVertTarget(R, 17, 25, true)).toBe(21); // even if native overshoots
  });

  it("ver2 → exit the group: snap to v2.to (7e.iii.a)", () => {
    // OBSERVED: from idx 21 (R1) Shift+Down → head 25 = v2.to (the normal after).
    expect(selectionVertTarget(R, 21, 25, true)).toBe(25);
    expect(selectionVertTarget(R, 21, 31, true)).toBe(25); // overshoot → still v2.to
  });

  it("normal → normal (no group between) → native preserved (column kept)", () => {
    expect(selectionVertTarget(R, 0, 7, true)).toBe(7); // line 1 → line 2, no boundary
  });

  it("backward (Shift+Up) snaps to the nearest boundary above curHead", () => {
    // from ver2.from (21) up, overshooting to 7 → first boundary above is v1.from 14.
    expect(selectionVertTarget(R, 21, 7, false)).toBe(14);
  });

  it("empty ver2: its .from is a boundary (7e.ii.c)", () => {
    // ver1="L1\nL2", ver2 EMPTY: doc "a\nL1\nL2\n\n\nb\n"; ver1[2,9] ver2[9,10].
    const m = buildModel("a\nL1\nL2\nb\n", "a\nb\n");
    const r = m.ranges;
    // from idx 5 (L2) down, native overshoots to 10+ → snap to v2.from = 9.
    expect(selectionVertTarget(r, 5, 11, true)).toBe(9);
  });
});
