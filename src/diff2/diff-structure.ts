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
  Facet,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Text,
} from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { VerRange } from "./diff-model";

// §2.2.14 touch-only / read-only mode. A view-level boolean facet (lives here — the
// foundational module — so the edit commands in diff-edits/diff-clipboard/diff-selection can
// read it without importing diff-pane-v2, which would cycle). createDiffPaneState provides it
// from the view config; commands + the marker-click gate on it.
export const touchOnlyFacet = Facet.define<boolean, boolean>({
  combine: (vs) => vs[0] ?? false,
});
export function isTouchOnly(state: EditorState): boolean {
  return state.facet(touchOnlyFacet);
}

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
// hidden-terminal skip, Shift+Left/Right/PgUp/PgDn). Browser-observed (harness): native
// motion preserves the visual COLUMN, so a Shift+arrow OVERSHOOTS the collapsed group
// instead of stopping at a region boundary. This snaps the head to the correct STOP;
// the (correct) legalizer + render then visualize. Pure (the native landing is the
// input); the gesture itself is browser/device-verified.
//
// The model is the "ATOM" model (DIFF-EDITOR-V2.md §2.2.6 п.7e + the 2026-06-23
// shrink-stadiality rule). Relative to the anchor, the doc is a sequence of FREE zones
// (normal text + the anchor's HOME ver-block, where the head moves char/line-by-line)
// and ATOMS (spans the head may only rest at the EDGES of, jumping across them
// UNCLAMPED in one keypress):
//   • every group the anchor is NOT in  → a whole-group atom [v1.from, v2.to];
//   • the anchor's own group → only the NON-HOME ver-block is an atom; the HOME block
//     (the one the anchor sits in) is FREE, with its OUTER edge a clamped stop
//     (transition to the normal above/below). So shrinking a whole-group selection
//     whose anchor sits at the group start (v1.from, after the legalizer pulled it
//     there) goes: jump head to the seam = whole-ver1 (one press, UNCLAMPED across a
//     multi-line ver2), then free char/line selection inside ver1 — and the mirror for
//     anchor at v2.to. The earlier "stadial-but-clamped" model got STUCK here on a
//     multi-line non-home block (native lands inside it, the clamped seam stop is
//     rejected, the legalizer re-expands to whole). UNCLAMPED atom-cross fixes it.
//   • an EMPTY home block (width-1, just its terminal) has no free interior → the whole
//     group is an atom (preserves the empty-ver shrink: head jumps the whole group).
// Anchor membership is endpoint-aware: the anchor is the LO endpoint when the head is
// (or, at curHead==anchor, will be) on its HIGH side — `forward ? curHead>=anchor :
// curHead>anchor` — so anchor==v2.to selecting DOWN is normal-below (atomic) but
// selecting UP is ver2-home (free); LO covers index `anchor`, HI covers `anchor-1`.
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

// §2.2.6 п.7e (2026-06-23 empty-block exception) — an EMPTY ver-block is TRANSPARENT:
// it has no selectable content, so an ANCHOR sitting exactly on its outer slot, with the
// head on the far (non-empty) side, "slides" to the seam (v2.from = the ver1/ver2
// boundary). Then the selection is plain text of the NON-empty block (begin = the seam),
// NOT the whole group — e.g. shrinking a whole-group selection whose ver1 is empty steps
// into ver2 plain text with begin=v2.from (the empty ver1's terminal `\n` is NOT copied —
// clipboard correctness), and the mirror for empty ver2. The slide is GATED on the
// anchor being EXACTLY at the slot AND the head being on the far side, so it does NOT
// fire when the empty block is merely SPANNED by a larger selection (anchor above/below
// it → whole group stays, Screenshot-9/10). Pure; applied in BOTH the motion target here
// and the legalizer (diff-selection.ts) so head + stored begin stay consistent.
export function slideAnchor(ranges: VerRange[], anchor: number, head: number): number {
  for (const g of groupBounds(ranges)) {
    if (g.v2from - g.v1from <= 1 && anchor === g.v1from && head > anchor) return g.v2from; // empty ver1
    if (g.v2to - g.v2from <= 1 && anchor === g.v2to && head < anchor) return g.v2from; // empty ver2
  }
  return anchor;
}

// §2.2.6 п.7e.ii.d / п.7e.iii.c — a selection STARTING on an EMPTY ver-block (a caret
// on its single collapsed slot). The empty block is TRANSPARENT (no content), so the
// first Shift+arrow rebases the ANCHOR to the seam toward the adjacent NON-empty block
// and selects FROM there into it — NOT a whole-group jump. The head follows the motion,
// CLAMPED into the sibling block: a one-line/one-char step lands the caret at the seam
// (no selection yet, then plain-text selection of the sibling begins); a big Shift+PgDn
// that lands inside the sibling gives [seam, landing] in one gesture (user 2026-06-23).
// Going the OTHER way (empty ver1 up / empty ver2 down) leaves the group into the normal
// text — anchor at the group edge, head = the native landing. Returns null when the
// caret is not on an empty ver-block. Pure → unit-tested; the view (verticalSelect /
// horizontalSelect) dispatches the result.
export function emptyVerStartSelection(
  ranges: VerRange[],
  caret: number,
  nativeHead: number,
  forward: boolean,
): { anchor: number; head: number } | null {
  const ev = ranges.find((r) => r.to - r.from === 1 && r.from === caret);
  if (!ev) return null;
  const v1 = ranges.find((r) => r.group === ev.group && r.ver === 1);
  const v2 = ranges.find((r) => r.group === ev.group && r.ver === 2);
  if (!v1 || !v2) return null;
  const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(x, hi));
  if (ev.ver === 1) {
    if (forward) return { anchor: v2.from, head: clamp(nativeHead, v2.from, v2.to) }; // into ver2 below
    return { anchor: v1.from, head: nativeHead }; // up → normal above
  }
  if (!forward) return { anchor: v2.from, head: clamp(nativeHead, v1.from, v2.from) }; // into ver1 above
  return { anchor: v2.to, head: nativeHead }; // empty ver2 down → normal below
}

export function selectionVertTarget(
  ranges: VerRange[],
  anchorIn: number,
  curHead: number,
  nativeHead: number,
  forward: boolean,
): number {
  const anchor = slideAnchor(ranges, anchorIn, curHead);
  const anchorIsLo = forward ? curHead >= anchor : curHead > anchor;
  const atoms: { a: number; b: number }[] = [];
  let homeOuter: number | null = null; // the home block's outer (non-seam) edge, a clamped stop
  for (const g of groupBounds(ranges)) {
    const inV1 = anchorIsLo
      ? anchor >= g.v1from && anchor < g.v2from
      : anchor > g.v1from && anchor <= g.v2from;
    const inV2 = anchorIsLo
      ? anchor >= g.v2from && anchor < g.v2to
      : anchor > g.v2from && anchor <= g.v2to;
    const ver1Empty = g.v2from - g.v1from <= 1;
    const ver2Empty = g.v2to - g.v2from <= 1;
    if (inV1 && !ver1Empty) {
      atoms.push({ a: g.v2from, b: g.v2to }); // non-home = ver2
      homeOuter = g.v1from;
    } else if (inV2 && !ver2Empty) {
      atoms.push({ a: g.v1from, b: g.v2from }); // non-home = ver1
      homeOuter = g.v2to;
    } else {
      atoms.push({ a: g.v1from, b: g.v2to }); // anchor outside, or empty home → whole-group atom
    }
  }
  // Atomic cross: head exactly on an atom's near edge → jump to the far edge, UNCLAMPED.
  for (const at of atoms) {
    if (forward && curHead === at.a) return at.b;
    if (!forward && curHead === at.b) return at.a;
  }
  // Otherwise: nearest stop in the travel direction, clamped to the native landing
  // (atom entry edges + the home block's outer edge). Free zones fall through to native.
  if (forward) {
    let best = nativeHead;
    for (const at of atoms) if (curHead < at.a && nativeHead > at.a) best = Math.min(best, at.a);
    if (homeOuter !== null && curHead < homeOuter && nativeHead > homeOuter) best = Math.min(best, homeOuter);
    return best;
  }
  let best = nativeHead;
  for (const at of atoms) if (curHead > at.b && nativeHead < at.b) best = Math.max(best, at.b);
  if (homeOuter !== null && curHead > homeOuter && nativeHead < homeOuter) best = Math.max(best, homeOuter);
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
