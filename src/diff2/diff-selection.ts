// V2 selection legalization (DIFF-EDITOR-V2.md §2.2.6 п.7 — STRICT boundary).
// Applied to every selection-setting transaction. A diff-group behaves as ONE atomic
// unit, BUT — per the user's §2.2.6 п.7e refinement (2026-06-21) — the group is pulled
// in only when the selection captures ≥1 real CHARACTER of a region the anchor is NOT
// in (half-open [lo,hi) capture). Landing exactly on a region boundary (= position 0
// of the next region, having selected the current region incl. its terminal `\n`)
// keeps the selection in the CURRENT region: normal-only / ver1-only / ver2-only.
// This corrects the old SYMMETRIC overlap rule that over-expanded at the boundary.
// See legalizeSelection below for the full per-case rule; the render layer
// (diff-decorations.ts selectionAppearance) visualizes the legalized result.
//
// Mouse marker-zone gestures (п.7c/п.7f) are a SEPARATE production mechanism (pointer
// handlers on the markers) that feed positions INTO this same legalizer — not here.
// Multi-cursor is disabled (§2.2.4(10)), so only the main selection is legalized.
// Pure `legalizeSelection` (unit-tested) + a thin transactionFilter.

import { EditorSelection, EditorState } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure, setStructure } from "./diff-structure";

export interface GroupSpan {
  group: number;
  from: number; // ver1.from
  to: number; // ver2.to
}

export function groupsOf(ranges: VerRange[]): GroupSpan[] {
  const by = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  const out: GroupSpan[] = [];
  for (const [group, { v1, v2 }] of by) {
    if (v1 && v2) out.push({ group, from: v1.from, to: v2.to });
  }
  return out.sort((a, b) => a.from - b.from);
}

interface GroupExtent {
  v1from: number;
  v1to: number;
  v2from: number;
  v2to: number;
}
function groupExtents(ranges: VerRange[]): GroupExtent[] {
  const by = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  const out: GroupExtent[] = [];
  for (const { v1, v2 } of by.values()) {
    if (v1 && v2) out.push({ v1from: v1.from, v1to: v1.to, v2from: v2.from, v2to: v2.to });
  }
  return out.sort((a, b) => a.v1from - b.v1from);
}

// §2.2.6 п.7 — STRICT, anchor-relative group-atomic expansion. A diff-group is pulled
// into the selection ONLY when the selection captures ≥1 real CHARACTER of a region
// OTHER than the one the anchor sits in. "Captured chars" = the HALF-OPEN interval
// [lo,hi): so a boundary position is region-membership-disambiguated by role —
// `anchor=B` (covers index B+ = the next region) captures it, but `head=B` (covers up
// to B-1 = the previous region) does NOT. This is the user's "24-as-start ≠
// 24-as-end" — and the fix for the old bug where `blockAt(v2.from)` resolved the
// boundary to ver2 and over-expanded (7e.ii: head at v2.from = ver1-only).
//
// Per group {v1, v2}, with the selection covering chars [lo, hi):
//   ver1cap = ≥1 ver1 char (incl its terminal \n) captured
//   ver2cap = ≥1 ver2 char captured
//   before  = ≥1 char ABOVE the group captured
//   after   = ≥1 char BELOW the group captured
// WHOLE-group ⟺ it crosses the ===== seam (ver1cap && ver2cap), enters from a normal
// above (ver1cap && before), exits to a normal below (ver2cap && after), or spans it
// outright (before && after). Otherwise the selection stays within the single region
// it touched: normal-only / ver1-only-incl-terminal (7e.ii) / ver2-only (7e.iii) /
// plain intra-block (§2.2.4(5)). Verified against every п.7e/п.2/3/4 case.
export function legalizeSelection(
  ranges: VerRange[],
  anchor: number,
  head: number,
): { anchor: number; head: number } {
  if (anchor === head) return { anchor, head }; // a cursor captures no chars → never expands
  let lo = Math.min(anchor, head);
  let hi = Math.max(anchor, head);
  const groups = groupExtents(ranges);
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of groups) {
      const ver1cap = lo < g.v1to && hi > g.v1from;
      const ver2cap = lo < g.v2to && hi > g.v2from;
      const before = lo < g.v1from;
      const after = hi > g.v2to;
      const whole =
        (ver1cap && ver2cap) || (ver1cap && before) || (ver2cap && after) || (before && after);
      if (whole) {
        if (g.v1from < lo) {
          lo = g.v1from;
          changed = true;
        }
        if (g.v2to > hi) {
          hi = g.v2to;
          changed = true;
        }
      }
    }
  }
  return head >= anchor ? { anchor: lo, head: hi } : { anchor: hi, head: lo };
}

// Legalize the main selection of any pure selection-setting transaction (shift+
// arrow, mouse drag, Ctrl+A). Edits (docChanged) set a single caret, which
// legalizeSelection leaves untouched, so they're skipped. setStructure
// transactions (resolution/replay) drive the selection themselves.
export const selectionLegalizeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged) return tr;
  if (tr.effects.some((e) => e.is(setStructure))) return tr;
  const ranges = readStructure(tr.startState);
  const sel = tr.selection.main;
  const legal = legalizeSelection(ranges, sel.anchor, sel.head);
  if (legal.anchor === sel.anchor && legal.head === sel.head) return tr;
  return {
    selection: EditorSelection.single(legal.anchor, legal.head),
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
});
