// §2.2.6 п.7e KEYBOARD selection MOTION (Shift+Up/Down/Left/Right).
//
// SPLIT by what's testable where (the lesson from 4 lost rounds — happy-dom can't see
// CM6 moveVertically geometry, so the INTEGRATION is browser-verified, only the pure
// landing-DECISION is unit-tested):
//   - selectionVertTarget (pure): given the native landing, snap the head to the
//     correct STOP. ANCHOR-AWARE: a group the anchor is OUTSIDE is atomic (head jumps
//     the whole group, unclamped); the group the anchor is INSIDE is stadial (seam →
//     edge, clamped to native). Unit-tested here against the EXACT native landings
//     OBSERVED in the browser harness.
//   - the integration (does Shift+arrow produce that native landing + does the
//     legalizer/clipboard agree) is verified in the real Chromium harness
//     (harness/diff-pane-harness.html via browser MCP). happy-dom CANNOT simulate it.

import { describe, expect, it } from "vitest";
import { buildModel } from "../../src/diff2/diff-model";
import {
  emptyVerStartSelection,
  selectionVertTarget,
  slideAnchor,
} from "../../src/diff2/diff-structure";

// The harness model: "line 1\nline 2\nL1\nL2\nbelow\n" / "...R1...".
// doc "line 1\nline 2\nL1\nL2\n\nR1\n\nbelow\n"; ver1[14,21] ver2[21,25]; normal "below"[25,31].
const M = buildModel("line 1\nline 2\nL1\nL2\nbelow\n", "line 1\nline 2\nR1\nbelow\n");
const R = M.ranges;

describe("selectionVertTarget — anchor OUTSIDE the group (ATOMIC, §2.2.6 п.2/п.3)", () => {
  it("anchor in normal above, col-0 down → native at v1.from → stays (7e.i OK)", () => {
    // OBSERVED: Shift+Down from idx 7 native-lands at 14 = v1.from. anchor=7 (normal).
    expect(selectionVertTarget(R, 7, 7, 14, true)).toBe(14);
  });

  it("anchor in normal above, col-2 OVERSHOOT past the group → snap to v1.from (7e.i bug→fix)", () => {
    // OBSERVED: native-OVERSHOOTS to 25 (the normal after the collapsed group). The
    // group is atomic (anchor outside) → stop at the TOP edge 14 → normal-only.
    expect(selectionVertTarget(R, 9, 9, 25, true)).toBe(14);
  });

  it("anchor above, head AT v1.from, next Down → ATOMIC CROSS to v2.to (whole group, п.2)", () => {
    // curHead === v1.from(14), anchor outside → jump the WHOLE group to v2.to=25,
    // UNCLAMPED even though native (say 17) undershoots into the collapsed group.
    expect(selectionVertTarget(R, 7, 14, 17, true)).toBe(25);
    expect(selectionVertTarget(R, 7, 14, 25, true)).toBe(25);
  });

  it("anchor above, whole group selected (head at v2.to), Shift+Up SHRINKS → v1.from (bug-4)", () => {
    // curHead === v2.to(25), anchor outside → atomic cross UP to v1.from=14 → the group
    // de-selects in one step (normal-above stays). native undershoots (21) — UNCLAMPED.
    expect(selectionVertTarget(R, 7, 25, 21, false)).toBe(14);
    expect(selectionVertTarget(R, 7, 25, 7, false)).toBe(14);
  });

  it("anchor in normal BELOW, first Shift+Up → stop at v2.to (bottom edge), normal-only", () => {
    // anchor=28 (in "below"); native up into the collapsed group (21) → snap to v2.to=25.
    expect(selectionVertTarget(R, 28, 28, 21, false)).toBe(25);
  });

  it("anchor below, head AT v2.to, next Up → ATOMIC CROSS to v1.from (whole group)", () => {
    expect(selectionVertTarget(R, 28, 25, 21, false)).toBe(14);
  });

  it("normal → normal (no group between) → native preserved (column kept)", () => {
    expect(selectionVertTarget(R, 0, 0, 7, true)).toBe(7); // line 1 → line 2, no boundary
  });
});

describe("selectionVertTarget — anchor INSIDE the group (STADIAL, §2.2.6 п.7e.ii/iii)", () => {
  it("anchor at v1.from, within multi-line ver1 (no boundary crossed) → native preserved", () => {
    expect(selectionVertTarget(R, 14, 14, 17, true)).toBe(17); // L1 → L2, same ver1
  });

  it("anchor in ver1, last line → ver2 seam: snap to v2.from = ver1-only (7e.ii.a)", () => {
    expect(selectionVertTarget(R, 14, 17, 21, true)).toBe(21);
    expect(selectionVertTarget(R, 14, 17, 25, true)).toBe(21); // even if native overshoots
  });

  it("anchor in ver1, head at seam, next Down → v2.to = whole group (7e.ii.b)", () => {
    expect(selectionVertTarget(R, 14, 21, 25, true)).toBe(25);
  });

  it("anchor at v2.from selecting UP → v1.from (ver1-only upward)", () => {
    expect(selectionVertTarget(R, 21, 21, 7, false)).toBe(14);
  });

  it("empty ver2: its .from is the seam (7e.ii.c)", () => {
    // ver1="L1\nL2", ver2 EMPTY: doc "a\nL1\nL2\n\n\nb\n"; ver1[2,9] ver2[9,10].
    const m = buildModel("a\nL1\nL2\nb\n", "a\nb\n");
    const r = m.ranges;
    // anchor at v1.from(2); from idx 5 (L2) down, native overshoots to 11 → snap to seam 9.
    expect(selectionVertTarget(r, 2, 5, 11, true)).toBe(9);
  });
});

describe("selectionVertTarget — BACKWARD mirror stadiality (anchor in ver2, browser-verified)", () => {
  // multi-line ver2: "a\nL1\nb\n" / "a\nR1\nR2\nR3\nb\n" → ver1[2,6] ver2[6,16] (R1@6,
  // R2@9, R3@12); normal "b"[16,18]. Browser-verified: Shift+Up from R3 steps R3→R2→R1
  // (ver2-only), then crossing into ver1 → whole group. Anchor at v2.to=16 (bottom of
  // ver2) — direction-aware membership: anchor==v2.to selecting UP is INSIDE ver2.
  const m = buildModel("a\nL1\nb\n", "a\nR1\nR2\nR3\nb\n");
  const r = m.ranges;

  it("within multi-line ver2: native steps line-by-line (no boundary crossed) → preserved", () => {
    expect(selectionVertTarget(r, 16, 12, 9, false)).toBe(9); // R3 → R2, no snap
    expect(selectionVertTarget(r, 16, 9, 6, false)).toBe(6); // R2 → R1 (v2.from), no snap
  });

  it("ver2.from → ver1: snap to v1.from (whole group when the legalizer expands)", () => {
    expect(selectionVertTarget(r, 16, 6, 2, false)).toBe(2); // R1 (v2.from) up → v1.from
  });

  it("overshoot from R3 past v2.from → snap to v2.from (ver2-only, not whole)", () => {
    expect(selectionVertTarget(r, 16, 12, 2, false)).toBe(6); // native jumps to ver1 → snap seam
  });

  it("normal-below first Shift+Up (anchor below) → stop at v2.to (atomic bottom edge)", () => {
    // "below" at 16; anchor=17 (normal below). native up into ver2 (12) → v2.to=16.
    expect(selectionVertTarget(r, 17, 17, 12, false)).toBe(16);
  });
});

describe("selectionVertTarget — SHRINK stadiality (2026-06-23, atom model, multi-line both sides)", () => {
  // ver1 "A1\nA2\nA3" multi-line, ver2 "B1\nB2\nB3" multi-line → ver1[3,13] ver2[13,23].
  const m = buildModel("N1\nA1\nA2\nA3\nN2\n", "N1\nB1\nB2\nB3\nN2\n");
  const r = m.ranges;
  const v1 = r.find((x) => x.ver === 1)!; // [3,13]
  const v2 = r.find((x) => x.ver === 2)!; // [13,23]

  it("anchor at v1.from, shrink UP from whole-group → jumps to v2.from = ver1-only, UNCLAMPED across multi-line ver2", () => {
    // native lands INSIDE the multi-line ver2 (undershoot, e.g. 19); the seam stop must
    // still be reached in ONE press — the bug the clamped model got stuck on.
    expect(selectionVertTarget(r, v1.from, v2.to, 19, false)).toBe(v2.from);
    expect(selectionVertTarget(r, v1.from, v2.to, v2.from, false)).toBe(v2.from); // even shorter native
  });

  it("anchor at v1.from, then free char/line selection INSIDE ver1 (native preserved)", () => {
    expect(selectionVertTarget(r, v1.from, v2.from, 9, false)).toBe(9); // into ver1, free
    expect(selectionVertTarget(r, v1.from, 9, 6, false)).toBe(6);
  });

  it("anchor at v1.from, shrink past the home outer edge → stop at v1.from (collapse), then normal above", () => {
    expect(selectionVertTarget(r, v1.from, 6, 0, false)).toBe(v1.from); // homeOuter clamp
    expect(selectionVertTarget(r, v1.from, v1.from, 0, false)).toBe(0); // anchor flips to HI → normal-only
  });

  it("MIRROR anchor at v2.to, shrink DOWN from whole-group → jumps to v2.from = ver2-only, UNCLAMPED across multi-line ver1", () => {
    expect(selectionVertTarget(r, v2.to, v1.from, 9, true)).toBe(v2.from); // native inside ver1 (undershoot)
    expect(selectionVertTarget(r, v2.to, v1.from, v2.from, true)).toBe(v2.from);
  });

  it("MIRROR anchor at v2.to, then free char/line selection INSIDE ver2 (native preserved)", () => {
    expect(selectionVertTarget(r, v2.to, v2.from, 16, true)).toBe(16); // into ver2, free
    expect(selectionVertTarget(r, v2.to, 16, 19, true)).toBe(19);
  });

  it("MIRROR anchor at v2.to, shrink past the home outer edge → stop at v2.to (collapse), then normal below", () => {
    expect(selectionVertTarget(r, v2.to, 19, 26, true)).toBe(v2.to); // homeOuter clamp
    expect(selectionVertTarget(r, v2.to, v2.to, 26, true)).toBe(26); // anchor flips to LO → normal-only
  });

  it("curHead==anchor at v2.to, GROW up → ver2-home (free), NOT whole-group atomic (lo/hi by direction)", () => {
    // backward from a collapsed caret at v2.to: anchor is HI (home=ver2) → free into ver2,
    // must NOT jump the whole group to v1.from.
    expect(selectionVertTarget(r, v2.to, v2.to, 19, false)).toBe(19);
  });
});

describe("emptyVerStartSelection — caret STARTING on an empty ver-block (п.7e.ii.d/iii.c)", () => {
  // empty ver1[3,4], multi-line ver2[4,10].
  const m = buildModel("a\nc\n", "a\nR1\nR2\nc\n");
  const r = m.ranges;
  const v1 = r.find((x) => x.ver === 1)!; // [3,4] empty (here a\n=2, ver1 empty terminal)
  const v2 = r.find((x) => x.ver === 2)!;

  it("empty ver1, Down ONE line → caret at v2.from, NO selection (rebase to ver2 start)", () => {
    // native lands at v2.from (collapsed empty ver1, plain Down → ver2 col0).
    expect(emptyVerStartSelection(r, v1.from, v2.from, true)).toEqual({ anchor: v2.from, head: v2.from });
  });

  it("empty ver1, PgDn landing INSIDE ver2 → [v2.from, landing] ver2 plain text", () => {
    const landing = v2.from + 2;
    expect(emptyVerStartSelection(r, v1.from, landing, true)).toEqual({ anchor: v2.from, head: landing });
  });

  it("empty ver1, PgDn landing PAST ver2 → clamped to v2.to (whole ver2, not beyond)", () => {
    expect(emptyVerStartSelection(r, v1.from, v2.to + 5, true)).toEqual({ anchor: v2.from, head: v2.to });
  });

  it("empty ver1, Up → into normal above (anchor at v1.from, head = native)", () => {
    expect(emptyVerStartSelection(r, v1.from, 0, false)).toEqual({ anchor: v1.from, head: 0 });
  });

  it("returns null when the caret is NOT on an empty ver-block slot", () => {
    expect(emptyVerStartSelection(r, v2.from, 7, true)).toBeNull(); // caret in ver2, not empty
  });

  it("MIRROR — empty ver2, Up ONE line → caret at v2.from (rebase to ver1 end); PgUp inside ver1 → [native, v2.from]", () => {
    const m2 = buildModel("a\nA1\nA2\nc\n", "a\nc\n"); // ver1[3,9] multi, ver2[9,10] empty (approx)
    const r2 = m2.ranges;
    const e1 = r2.find((x) => x.ver === 1)!;
    const e2 = r2.find((x) => x.ver === 2)!;
    // caret on empty ver2 slot (e2.from), Up: into ver1, clamped [e1.from, e2.from].
    expect(emptyVerStartSelection(r2, e2.from, e2.from, false)).toEqual({ anchor: e2.from, head: e2.from });
    expect(emptyVerStartSelection(r2, e2.from, e1.from + 1, false)).toEqual({ anchor: e2.from, head: e1.from + 1 });
  });
});

describe("selectionVertTarget — empty-block EXCEPTION (2026-06-23 transparent empty block)", () => {
  // empty ver1, multi-line ver2: ver1[2,3] (terminal only) ver2[3,10] (R1\nR2 + terminal).
  const m = buildModel("a\nc\n", "a\nR1\nR2\nc\n");
  const r = m.ranges;
  const v1 = r.find((x) => x.ver === 1)!; // [2,3] empty
  const v2 = r.find((x) => x.ver === 2)!; // [3,10]

  it("empty ver1 IS width-1 (terminal only), ver2 holds the remote content", () => {
    expect(v1.to - v1.from).toBe(1);
    expect(v2.to - v2.from).toBeGreaterThan(1);
  });

  it("slideAnchor: anchor at empty ver1's slot (v1.from) with head below → slides to seam v2.from", () => {
    expect(slideAnchor(r, v1.from, v2.to)).toBe(v2.from); // head below → slide
    expect(slideAnchor(r, v1.from, v1.from)).toBe(v1.from); // head not below → no slide (no whole-group context)
  });

  it("empty ver1, shrink UP from whole-group → ver2 plain text (begin slid to v2.from), NOT collapse", () => {
    // anchorIn = v1.from (legalizer parked it there); slideAnchor → v2.from, home = ver2
    // (free), so the head steps freely DOWN-from-top inside ver2 — begin = v2.from.
    const belowNative = 7; // native lands inside ver2 (free movement)
    expect(selectionVertTarget(r, v1.from, v2.to, belowNative, false)).toBe(belowNative);
  });

  it("empty ver1 shrink does NOT stick (the old bug-3): it steps, never re-expands to whole", () => {
    // from inside ver2 keep shrinking up — always returns the native (free), never v2.to.
    expect(selectionVertTarget(r, v1.from, 7, 5, false)).toBe(5);
  });

  // MIRROR — empty ver2, multi-line ver1: ver1[2,9] ver2[9,10] (empty).
  const m2 = buildModel("a\nA1\nA2\nc\n", "a\nc\n");
  const r2 = m2.ranges;
  const e2v1 = r2.find((x) => x.ver === 1)!; // [2,9]
  const e2v2 = r2.find((x) => x.ver === 2)!; // [9,10] empty

  it("slideAnchor mirror: anchor at empty ver2's slot (v2.to) with head above → slides to seam v2.from", () => {
    expect(slideAnchor(r2, e2v2.to, e2v1.from)).toBe(e2v2.from); // head above → slide
    expect(slideAnchor(r2, e2v2.to, e2v2.to)).toBe(e2v2.to); // not above → no slide
  });

  it("empty ver2, shrink DOWN from whole-group → ver1 plain text (begin slid to v2.from), NOT collapse", () => {
    const insideVer1Native = 6;
    expect(selectionVertTarget(r2, e2v2.to, e2v1.from, insideVer1Native, true)).toBe(insideVer1Native);
  });
});
