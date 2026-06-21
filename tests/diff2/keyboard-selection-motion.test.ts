// @vitest-environment happy-dom
//
// §2.2.6 п.7e KEYBOARD selection MOTION — where Shift+arrow LANDS the head when it
// crosses a diff-group boundary or a collapsed empty ver-block. These are CARET-
// LANDING bugs, NOT legalizer bugs: the legalizer (diff-selection.ts) computes the
// correct selection GIVEN the landed position (proven in diff-selection.test.ts), but
// the V2 nav keymap (diff-pane-v2.ts diffNavKeymap) handles ONLY plain Up/Down/Left/
// Right — Shift+arrow "falls through to defaultKeymap" (diff-pane-v2.ts:374-375),
// which preserves the visual column and skips height:0 empty vers. So the head lands
// INSIDE the group (captures chars → whole group) or PAST a collapsed empty ver
// (captures its terminal → whole group) instead of at the boundary.
//
// These can't be honestly unit-tested in happy-dom: they depend on CM6
// moveVertically's heightmap geometry + the real Shift+arrow keybinding, which the
// fast device loop / Chromium oracle ([[project-diff2-render-oracle]]) verifies, not
// happy-dom. Left as it.todo with the exact spec so the fix has a target. The fix =
// extend diffNavKeymap to handle Shift+Arrow (+ PgUp/PgDn): mirror cursorVertTarget
// but EXTEND the selection (keep anchor, move head to the boundary stop), landing the
// head at position 0 of the next ver-block / normal line, and treating a collapsed
// empty ver as a one-step stop. Then the (correct) legalizer + render do the rest.

import { describe, it } from "vitest";

describe("§2.2.6 п.7e keyboard selection motion (Chromium/device-gated — it.todo)", () => {
  // 7e.i (bug-36 / Screenshot-11): caret on "li|ne 2" (a NON-zero column of a normal
  // line ABOVE a diff-group) + Shift+Down. EXPECT: head lands at position 0 of the
  // first ver1 line → selection = ONLY "line 2" + its \n (normal-only); the diff-
  // group is NOT selected and NOT in the clipboard. ACTUAL: column 2 is preserved →
  // head lands at v1.from+2 → captures ver1 chars → whole group selected + copied.
  it.todo("7e.i: Shift+Down from a normal line lands head at ver1 pos-0 (normal-only, no group)");

  // 7e.ii.c: caret in a NON-empty ver1 whose sibling ver2 is EMPTY (collapsed) +
  // Shift+Down. EXPECT: head lands at position 0 of the (collapsed) empty ver2 =
  // v2.from → ver1-only (legalizer keeps it). Only a FURTHER extension past the group
  // → whole group. ACTUAL: the collapsed empty ver2 is skipped → head lands at v2.to
  // (the normal after) → captures ver2's terminal → whole group selected.
  it.todo("7e.ii.c: Shift+Down with an empty ver2 lands head at empty-ver2 pos-0 (ver1-only)");

  // 7e.ii.d (bug-37): ver1 is EMPTY; start selection there + Shift+Down. EXPECT:
  // NOTHING is selected (ver1 is empty!) — the caret moves to ver2 pos-0 as if a
  // plain Down was pressed, and selection then behaves as if STARTED at ver2 pos-0.
  // ACTUAL: the selection wrongly extends UPWARD onto the normal line ABOVE the empty
  // ver1 (see bug-37.png) and grabs the whole group.
  it.todo("7e.ii.d: Shift+Down starting on an EMPTY ver1 selects nothing (anchor re-bases to ver2 pos-0)");

  // 7e.iii.c: caret at pos-0 of an EMPTY ver2 + Down/Shift+Down. EXPECT: the empty
  // ver2 is NOT included at all — the selection effectively starts at pos-0 of the
  // first normal line after the diff-group. ACTUAL: visual selection grabs ver1+ver2
  // lines and the whole group lands in the clipboard.
  it.todo("7e.iii.c: motion from an EMPTY ver2 ignores it — selection starts at the next normal line");
});
