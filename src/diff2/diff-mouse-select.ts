// §2.2.6 п.7c / п.7f — MOUSE drag selection.
//
// Mouse selection is a complete MIRROR of keyboard selection (§2.2.6 п.7e): the only
// difference is that the diff markers (<<<<< / ===== / >>>>>) act as snap/anchor ZONES,
// so an imprecise mouse can still start/end a selection exactly on a block boundary.
//
// The whole feature reduces to: resolve each drag endpoint to a doc position — a marker
// zone snaps to its canonical boundary, plain text uses posAtCoords (in the view layer) —
// then run legalizeSelection (THE SAME function the keyboard uses). legalize, being
// anchor-relative (half-open [lo,hi) capture), then yields normal-only / ver-partial /
// whole-ver / whole-group exactly as for the keyboard. Consequences (all verified against
// the 13 §2.2.6 scenarios):
//   • NO magnetic override — "whole ver1" is not forced; it EMERGES from legalize when the
//     anchor is the block edge (marker-start). An INTERNAL-anchor drag onto a marker stays
//     plain-text-partial (7c.v.a/b, 7c.vi.a/b).
//   • The ===== zone is ATOMIC for a drag — landing anywhere on it (upper or lower half)
//     means "finished on =====" → head at the seam. Whole-group happens only when the mouse
//     EXITS ===== into the opposite block (into ver2 text / onto >>>>>, or up into ver1 /
//     onto <<<<<). The 50% split survives ONLY for the static caret-click on ===== (see
//     diff-pane-v2 verBlockCaretTarget), not for drag.
//   • A ===== START needs no direction latch — anchor = the seam, and the head's side
//     (above→ver1, below→ver2) is resolved by legalize automatically.

import type { VerRange } from "./diff-model";
import { legalizeSelection } from "./diff-selection";

export type MarkerKind = "open" | "mid" | "close"; // <<<<< / ===== / >>>>>

// A drag endpoint: either an exact text position (posAtCoords, resolved in the view) or a
// marker zone (mouse over a block widget — resolved to its boundary here).
export type Zone = { kind: "text"; pos: number } | { kind: "marker"; marker: MarkerKind; group: number };

// The canonical doc boundary a marker zone resolves to (as an anchor at mousedown OR as
// the head during a drag) — the exact position the keyboard lands on, so mouse mirrors
// keyboard:
//   open(<<<<<)  → ver1.from  (pos 0 of ver1's first line)
//   mid(=====)   → the ver1/ver2 seam  (v1.to === v2.from)
//   close(>>>>>) → ver2.to  (pos 0 of the first normal line below the group)
// Returns null if the group/side is absent. Works for empty ver-blocks too (the boundary
// positions are still defined; legalizeSelection's slideAnchor handles the empty-block
// anchor exceptions).
export function markerBoundary(ranges: VerRange[], group: number, marker: MarkerKind): number | null {
  const v1 = ranges.find((r) => r.group === group && r.ver === 1);
  const v2 = ranges.find((r) => r.group === group && r.ver === 2);
  if (!v1 || !v2) return null;
  if (marker === "open") return v1.from;
  if (marker === "mid") return v2.from; // === v1.to (the seam)
  return v2.to; // close
}

function zonePos(z: Zone, ranges: VerRange[]): number | null {
  return z.kind === "text" ? z.pos : markerBoundary(ranges, z.group, z.marker);
}

// Resolve a mouse drag (start endpoint fixed at mousedown, cur endpoint updated each move)
// to a legalized { anchor, head }. Pure → unit-tested against the §2.2.6 scenario table.
// Returns null if either endpoint can't resolve (absent group) — the caller keeps the
// current selection.
export function mouseDragSelection(
  start: Zone,
  cur: Zone,
  ranges: VerRange[],
): { anchor: number; head: number } | null {
  const anchor = zonePos(start, ranges);
  const head = zonePos(cur, ranges);
  if (anchor === null || head === null) return null;
  return legalizeSelection(ranges, anchor, head);
}
