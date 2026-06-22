// V2 structure layer — the CM6 `StateField<RangeSet>` that holds the ver-block
// ranges and maps them through every transaction (DIFF-EDITOR-V2.md §2.2.2 NOTE;
// terminal-inside, validated by the 1a/1b geometry gates).
//
// This is the spine of the new DiffPane: decorations (Phase 3b) and the
// commit-time split (diff-model.ts) DERIVE from this field; the pure data shape
// is `VerRange` (diff-model.ts). The field uses an INCLUSIVE `RangeValue` so an
// edit at a ver-block's edge grows THAT block — which is what lets an empty
// ver-block (its protected terminal `\n`) grow when the user types into it,
// with NO external `activeEmptyVer` hint (the old §1 model's complexity).
//
// All exports here are pure / state-level (no EditorView, no DOM), so they are
// unit-testable in vitest. The view wiring (decorations, keymap, the cursorVert
// command) lands in diff-pane.ts and is validated in the browser harness.

import {
  EditorState,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Text,
} from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { VerRange } from "./diff-model";

// RangeValue sides (CM6 reads these in RangeSet.map):
//   startSide = -1  → an insert AT `from` grows the range (so typing into an empty
//                     ver-block at its single caret slot grows it; 1a-validated).
//   endSide   = -1  → an insert AT `to` does NOT grow the range. `to` is the SHARED
//                     boundary with the next block (empty ver1.to == ver2.from), and
//                     it sits AFTER the block's terminal `\n` — never a caret slot of
//                     THIS block. endSide=1 (the old value) made BOTH ver1 and ver2
//                     claim an insert at the boundary → overlapping ranges, text
//                     landing in ver1 (bug-18b). Interior inserts (incl. the auto-\n
//                     at to-1) are strictly < to, so they still grow regardless.
export class VerRangeValue extends RangeValue {
  startSide = -1;
  endSide = -1;
  point = false;
  constructor(
    readonly ver: 1 | 2,
    readonly group: number,
  ) {
    super();
  }
  eq(other: RangeValue): boolean {
    return (
      other instanceof VerRangeValue &&
      other.ver === this.ver &&
      other.group === this.group
    );
  }
}

export type StructureSet = RangeSet<VerRangeValue>;

export function toRangeSet(ranges: VerRange[]): StructureSet {
  return RangeSet.of(
    ranges
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((r) => new VerRangeValue(r.ver, r.group).range(r.from, r.to)),
  );
}

export function fromRangeSet(set: StructureSet): VerRange[] {
  const out: VerRange[] = [];
  const it = set.iter();
  while (it.value) {
    out.push({ from: it.from, to: it.to, ver: it.value.ver, group: it.value.group });
    it.next();
  }
  return out;
}

// Replace the whole structure (session start, replay, resolution). The field
// uses the carried RangeSet verbatim instead of mapping the previous one.
export const setStructure = StateEffect.define<StructureSet>();

export const structureField = StateField.define<StructureSet>({
  create() {
    return RangeSet.empty as StructureSet;
  },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStructure)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

export function readStructure(state: EditorState): VerRange[] {
  return fromRangeSet(state.field(structureField));
}

// Version the structure field across undo/redo. CM6 history reverts the DOC TEXT
// but does NOT auto-invert custom StateEffects — so undoing a `setStructure`
// transaction (a resolution) would revert the text yet leave the structure stale
// (the group returns as plain text with no ver1/ver2 ranges — a desync; the
// diff-group's boundary lives only in the RangeSet, never in the raw doc text).
// We record the PRE-tx structure as the effect attached to the INVERSE (undo)
// transaction; CM6 inverts it again on redo. Free edits carry no `setStructure`
// (RangeSet.map derives them from the inverse change), so they need no inversion.
// (For DISK replay the same boundary is carried as §2.2.7-text — Phase 5; this is
// only the in-memory Ctrl+Z path.)
export const structureHistory = invertedEffects.of((tr) => {
  for (const e of tr.effects) {
    if (e.is(setStructure)) {
      const prev = tr.startState.field(structureField, false);
      return prev ? [setStructure.of(prev)] : [];
    }
  }
  return [];
});

// §2.2.9 explicit cursor handling. A resolution caret must land at the END of the
// inserted text live/redo, and return to a SPECIFIC point on undo (keyboard: where
// the hotkey was pressed; pointer: the group start). CM6's native history restores
// selection by MAPPING through the change geometry, which is lossy for a caret
// inside a replaced region — across an undo→redo round-trip it drifts to a boundary
// (proven by the v2-cm6-paste-undo-probe). So we carry the exact positions as
// immutable data and apply them ourselves.
//
// `resolveCaret` rides the forward resolution; `cursorHistory` propagates it onto
// the undo AND redo transactions (so the marker survives every hop — exactly like
// `structureHistory`). The VIEW-level `cursorRestoreListener` (diff-pane.ts) reads
// it and dispatches the right caret (before on undo, after on redo). Validated on a
// real view in v2-cursor-history-view-probe.
export const resolveCaret = StateEffect.define<{ before: number; after: number }>();

export const cursorHistory = invertedEffects.of((tr) => {
  for (const e of tr.effects) if (e.is(resolveCaret)) return [resolveCaret.of(e.value)];
  return [];
});

// §2.2.4(1,3) terminal protection: the terminal `\n` (the char at index
// `range.to-1`) must never be deleted, so a ver-block never collapses below
// width-1. Returns false (reject the transaction) if any change would delete a
// terminal `\n`. Deleting a ver-block's *content* (everything before its
// terminal) is allowed — that maps the range to width-1 (a proper empty ver),
// validated by the delete-to-empty probe.
export function terminalProtected(ranges: VerRange[], changes: ChangeDesc): boolean {
  const terminals = new Set(ranges.map((r) => r.to - 1));
  let ok = true;
  // iterChangedRanges (on ChangeDesc) gives the replaced spans [fromA,toA) on the
  // OLD doc — exactly the chars a change deletes/overwrites.
  changes.iterChangedRanges((fromA: number, toA: number) => {
    for (let p = fromA; p < toA; p++) if (terminals.has(p)) ok = false;
  });
  return ok;
}

export const terminalProtectionFilter = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true;
  // resolution / replay carry a setStructure effect and replace whole group spans
  // (incl. their terminals) on purpose — they drive doc + structure together.
  if (tr.effects.some((e) => e.is(setStructure))) return true;
  return terminalProtected(readStructure(tr.startState), tr.changes);
});

// §2.2.4(9)/§1.8.a empty-ver keyboard ENTRY — Up/Down only (PgUp/PgDn jump-page,
// decided 2026-06-12). Geometry (where native vertical motion lands) is CM6's
// heightmap, which already accounts for the height:0 hidden terminal lines; this
// pure helper only adds the STOP: the first empty-ver (width-1 range) strictly
// between the caret and the native landing, else the native landing unchanged.
// The empty-ver line then expands (decoration reacts to caret-present).
export function cursorVertTarget(
  ranges: VerRange[],
  curHead: number,
  nativeHead: number,
  forward: boolean,
): number {
  const empties = ranges.filter((r) => r.to - r.from === 1).map((r) => r.from);
  if (forward) {
    const skipped = empties.filter((f) => f > curHead && f < nativeHead).sort((a, b) => a - b);
    return skipped.length ? skipped[0] : nativeHead;
  }
  const skipped = empties.filter((f) => f < curHead && f > nativeHead).sort((a, b) => b - a);
  return skipped.length ? skipped[0] : nativeHead;
}

// §2.2.6 п.7e — KEYBOARD SELECTION extend-target (Shift+Up/Down AND, after the
// hidden-terminal skip, Shift+Left/Right). Browser-observed (harness): native motion
// preserves the visual COLUMN, so a Shift+arrow from a non-zero column OVERSHOOTS the
// whole collapsed diff-group instead of stopping at a region boundary. This snaps the
// head to the correct STOP. The (correct) legalizer + render then visualize. Pure
// (the native landing is the input); the gesture itself is browser/device-verified.
//
// The model is ANCHOR-AWARE (the fix for bug-3 shrink + bug-4):
//   • A group the anchor is OUTSIDE is ATOMIC (§2.2.6 п.2/п.3): the head may only rest
//     at its outer edges v1.from / v2.to, never the internal `=====` seam. When the
//     head sits exactly on the near edge and crosses, it jumps the WHOLE group to the
//     far edge — UNCLAMPED (a collapsed group's native step is short, so clamping to
//     the native landing would strand the head inside → the legalizer re-expands to
//     whole → shrinking gets STUCK; that was bug-3/bug-4).
//   • The group the anchor is INSIDE is STADIAL (§2.2.6 п.7e.ii/iii): the head stops
//     at the seam (ver1-only ↔ ver2-only) then the outer edge (whole), clamped to the
//     native landing (free intra-block motion otherwise).
// Anchor membership is DIRECTION-AWARE: a boundary position belongs to the region the
// selection grows TOWARD (the "24-as-start ≠ 24-as-end" rule applied to the anchor) —
// forward [v1.from, v2.to), backward (v1.from, v2.to] — so anchor==v2.to selecting UP
// is ver2-stadial, while anchor==v2.to selecting DOWN is normal-below (atomic).
interface GroupBound {
  v1from: number;
  v2from: number;
  v2to: number;
}
function groupBounds(ranges: VerRange[]): GroupBound[] {
  const by = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  const out: GroupBound[] = [];
  for (const { v1, v2 } of by.values()) {
    if (v1 && v2) out.push({ v1from: v1.from, v2from: v2.from, v2to: v2.to });
  }
  return out.sort((a, b) => a.v1from - b.v1from);
}

export function selectionVertTarget(
  ranges: VerRange[],
  anchor: number,
  curHead: number,
  nativeHead: number,
  forward: boolean,
): number {
  const groups = groupBounds(ranges);
  // Atomic cross: the head is exactly on an outside-group's near edge → jump the
  // whole group to the far edge, UNCLAMPED (so a short native step can't strand it).
  for (const g of groups) {
    const insideF = anchor >= g.v1from && anchor < g.v2to;
    const insideB = anchor > g.v1from && anchor <= g.v2to;
    if (forward && !insideF && curHead === g.v1from) return g.v2to;
    if (!forward && !insideB && curHead === g.v2to) return g.v1from;
  }
  if (forward) {
    let best = nativeHead;
    for (const g of groups) {
      const inside = anchor >= g.v1from && anchor < g.v2to;
      if (inside) {
        // stadial: seam (ver1-only) then outer edge (whole), clamped to native.
        for (const s of [g.v2from, g.v2to]) if (s > curHead && s <= nativeHead) best = Math.min(best, s);
      } else if (curHead < g.v1from && nativeHead > g.v1from) {
        best = Math.min(best, g.v1from); // stop at the group's top edge (not yet entered)
      }
    }
    return best;
  }
  let best = nativeHead;
  for (const g of groups) {
    const inside = anchor > g.v1from && anchor <= g.v2to;
    if (inside) {
      for (const s of [g.v2from, g.v1from]) if (s < curHead && s >= nativeHead) best = Math.max(best, s);
    } else if (curHead > g.v2to && nativeHead < g.v2to) {
      best = Math.max(best, g.v2to); // stop at the group's bottom edge (not yet entered)
    }
  }
  return best;
}

// §2.2.4(9b/9f) — Left/Right must STEP OVER a non-empty ver-block's hidden terminal
// `\n` line (the height:0 line at `to-1` that exists when the content ends with a
// `\n`). forward → `to` (next block/normal); backward → `to-2` (end of the block's
// last visible content line). Empty blocks (to-from===1) are exempt — their single
// line IS the caret slot (it expands on focus). Returns `pos` unchanged otherwise.
export function horizontalSkip(
  doc: Text,
  ranges: VerRange[],
  pos: number,
  forward: boolean,
): number {
  for (const r of ranges) {
    if (r.to - r.from <= 1) continue; // empty block — caret slot, not a hidden terminal
    if (pos === r.to - 1 && doc.sliceString(r.to - 2, r.to - 1) === "\n") {
      return forward ? r.to : r.to - 2;
    }
  }
  return pos;
}

// Universal caret invariant (backstop for bug-20/21 across ANY vector — Enter,
// mouse, programmatic): a caret must never rest on a non-empty ver-block's hidden
// terminal line (position `to-1` when the content ends with `\n`). Nudge it BACK to
// the end of the last visible content line (`to-2`). Directional nav (horizontalSkip)
// handles Left/Right forward-skip BEFORE this fires, so this only catches residuals.
export function caretOffTerminal(doc: Text, ranges: VerRange[], pos: number): number {
  for (const r of ranges) {
    if (r.to - r.from <= 1) continue;
    if (pos === r.to - 1 && doc.sliceString(r.to - 2, r.to - 1) === "\n") return r.to - 2;
  }
  return pos;
}
