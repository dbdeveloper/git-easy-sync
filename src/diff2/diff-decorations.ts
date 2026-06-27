// V2 decoration DECISIONS — the pure §2.2.8 rules that say, given the doc +
// structure + caret, which ver-block lines collapse (height:0), which show the
// `↵` glyph, and where the `≪`/`==`/`≫` markers anchor. These are the
// spec-encoding (unit-tested here); turning them into CM6 `Decoration` objects +
// the geometry (height:0 actually rendering 0px, markers not stealing
// `Decoration.line`) is the diff-pane.ts view layer, already validated by the 1a
// browser gate.
//
// Terminal-inside reminder: a ver range [from, to) covers content + the terminal
// `\n` at index `to-1`; the terminal `\n` is its own (empty) line — the LAST line
// of the range (`doc.lineAt(to-1)`).
//
// §2.2.8 collapse / glyph rules:
//   1. unfocused empty ver-block → NOT shown (height:0);
//   2. focused empty ver-block ("|\n") → shown full height;
//   3. the terminal (last) line never shows the `↵` glyph;
//   4. a non-empty ver-block's terminal line → ALWAYS hidden (height:0).
//   NOTE: `↵` shows on every ver-block line EXCEPT the terminal; never on normals.

import type { Text } from "@codemirror/state";
import type { VerRange } from "./diff-model";

export interface LineDecision {
  line: number; // CM6 line number (1-indexed)
  from: number; // line.from (anchor for Decoration.line)
  ver: 1 | 2;
  group: number;
  collapsed: boolean; // height:0
  glyph: boolean; // show the `↵` end-of-line glyph
  isTerminal: boolean; // the terminal (last) line of the range
}

// One decision per ver-block line, in document order. `caret` is the selection
// head (so a focused empty ver-block expands). Normal lines produce nothing.
export function verLineDecisions(doc: Text, ranges: VerRange[], caret: number): LineDecision[] {
  const out: LineDecision[] = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const firstLine = doc.lineAt(r.from).number;
    const termLine = doc.lineAt(r.to - 1).number; // last line of the range = terminal `\n`
    const empty = r.to - r.from === 1;
    for (let n = firstLine; n <= termLine; n++) {
      const line = doc.line(n);
      const isTerminal = n === termLine;
      // §2.2.8 / §2.2.12(a): collapse ONLY a BARE terminal `\n` line — i.e. the
      // terminal line when it is EMPTY (a normal block's separate hidden line, or an
      // empty ver-block's only line). Any line WITH content stays visible: content
      // empty-lines (non-terminal blanks) AND an EOL-less last line (the terminal
      // `\n` doubles as that content line's terminator — `firstLine === termLine`,
      // line has text). The `↵` glyph is suppressed on the terminal line either way,
      // which correctly shows an EOL-less line as having no trailing newline.
      const bareTerminal = isTerminal && line.length === 0;
      let collapsed = false;
      if (bareTerminal) {
        // §2.2.8(2): a focused EMPTY ver-block expands. "Focused" = caret EXACTLY at
        // range.from (the block's single caret slot). NOT `caret <= range.to`: an
        // empty ver1's `to` equals the adjacent ver2's `from` (shared boundary), so
        // `<= to` wrongly kept ver1 expanded when the caret moved into ver2 (bug-18:
        // ver1 didn't collapse / re-opened when caret was in ver2). Spec §2.2.8
        // pseudocode: `cursor.position == range.from`.
        collapsed = empty ? caret !== r.from : true;
      }
      out.push({
        line: n,
        from: line.from,
        ver: r.ver,
        group: r.group,
        collapsed,
        glyph: !isTerminal, // §2.2.8(3): never on the terminal line (incl. an EOL-less last line)
        isTerminal,
      });
    }
  }
  return out;
}

// §2.2.12(a) — the trailing-newline diff glyph. The last diff-group can be EOL-less on
// ONE side (its ver content ends with a real `\n` on one side but not the other — the
// files genuinely differ only by a trailing newline, bug-50). That `↵` is a real diff but
// the editor sees the glyph only as a CSS `::after` (a visual artifact, not a doc char), so
// it can't be a content mark — we flag its LINE instead. Returns the `.from` of the line
// whose `↵` should render as a diff (the side that HAS the trailing `\n`) — but ONLY for the
// genuinely-last group (nothing, not even a normal line, after it; bug-51: never on a middle
// group). An empty side IS a legitimate asymmetry (empty ver1 vs ver2 "\n" → mark ver2's `↵`).
// null when not the last group or both sides agree on the trailing `\n`. Pure.
export function glyphDiffLine(doc: Text, v1: VerRange, v2: VerRange): number | null {
  // ONLY the genuinely LAST group — nothing (not even a normal line) after it. ver2.to points
  // just past its protected terminal `\n`; for the last group that's the doc's final (empty)
  // line ⇒ === doc.length. A non-last group has a normal line after ⇒ ver2.to < doc.length.
  // (bug-51: the `↵`-diff must never appear on a middle group.)
  if (v2.to !== doc.length) return null;
  // content = the ver range minus its protected terminal `\n` (at to-1); may itself end in a
  // real `\n` (the file's trailing newline). An EMPTY side is "" (never ends in `\n`), which is
  // a LEGITIMATE asymmetry vs a side that has a `\n` (empty ver1 vs ver2 "\n" → ver2's `↵` IS
  // the diff — user). The side WITHOUT the `\n` is never picked as `side`, so no empty-side
  // underflow on to-2.
  const oursNl = doc.sliceString(v1.from, v1.to - 1).endsWith("\n");
  const theirsNl = doc.sliceString(v2.from, v2.to - 1).endsWith("\n");
  if (oursNl === theirsNl) return null;
  const side = oursNl ? v1 : v2; // the side WITH the trailing `\n` owns the diff `↵`
  return doc.lineAt(side.to - 2).from; // to-1 = protected terminal; to-2 = the file `\n` it ends on
}

// §2.2.6 п.7 — marker-row selection appearance. A ver-block's marker rows light up
// as "selected" ONLY when the ENTIRE block — its content AND its terminal `\n` — is
// inside the selection [lo,hi]: `lo <= V.from && hi >= V.to`. A plain content
// selection stops at `to-1` (terminal excluded by §2.2.4(5)), so `hi >= to` is
// FALSE → markers stay unlit (this is the bug-34/33 case: head sits at the next
// group's `from`, nothing of THAT block is selected). The terminal is only included
// when the selection starts from the marker rows (п.7c/d/e/f) or spans the group
// (group-atomic `[v1.from, v2.to]` → both blocks' `to` covered → whole group lights,
// п.7c). open(`<<<<<`) + the `=====` top-half key off ver1; the `=====` bottom-half
// + close(`>>>>>`) key off ver2.
export interface MarkerSelectionState {
  group: number;
  ver1: boolean; // ver1 block (content + terminal \n) fully within the selection
  ver2: boolean; // ver2 block fully within the selection
}

export function selectionAppearance(
  ranges: VerRange[],
  lo: number,
  hi: number,
): Map<number, MarkerSelectionState> {
  const by = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  const out = new Map<number, MarkerSelectionState>();
  for (const [group, { v1, v2 }] of by) {
    if (!v1 || !v2) continue;
    out.set(group, {
      group,
      ver1: lo <= v1.from && hi >= v1.to,
      ver2: lo <= v2.from && hi >= v2.to,
    });
  }
  return out;
}

export type MarkerKind = "open" | "mid" | "close"; // ≪ / == / ≫

export interface MarkerSpec {
  pos: number; // anchor position for the block widget
  side: number; // -1 → render ABOVE the line at pos (the TODO #1-safe choice); 1 → below
  kind: MarkerKind;
  group: number;
}

// Block-widget marker anchors (§2.2.2 layout). `side:-1` anchors the widget to a
// line START so it renders ABOVE that line — the TODO #1 fix (the old `side:1`
// bottom marker stole the next line's Decoration.line). ALL THREE markers use
// side:-1, including the close marker: buildModel always ends ver2 with a terminal
// `\n`, so the doc always has a trailing final line AFTER v2.to — `>>>>>` must sit
// ABOVE it (bug-22: side:1 wrongly rendered `>>>>>` BELOW the trailing empty line).
export function markerSpecs(doc: Text, ranges: VerRange[]): MarkerSpec[] {
  const byGroup: Record<number, Partial<Record<1 | 2, VerRange>>> = {};
  for (const r of ranges) (byGroup[r.group] ??= {})[r.ver] = r;
  const out: MarkerSpec[] = [];
  for (const g of Object.keys(byGroup)
    .map(Number)
    .sort((a, b) => a - b)) {
    const v1 = byGroup[g][1];
    const v2 = byGroup[g][2];
    if (!v1 || !v2) continue; // a group always has both; defensive
    out.push({ pos: doc.lineAt(v1.from).from, side: -1, kind: "open", group: g });
    out.push({ pos: doc.lineAt(v2.from).from, side: -1, kind: "mid", group: g });
    const anchor = v2.to; // start of the line AFTER ver2 (a normal line or the trailing final line)
    out.push({
      pos: doc.lineAt(anchor).from,
      side: -1, // ABOVE that line — the trailing final line stays below `>>>>>` (bug-22)
      kind: "close",
      group: g,
    });
  }
  return out;
}
