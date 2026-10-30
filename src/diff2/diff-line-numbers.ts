// V2 per-side gutter numbering (DIFF-EDITOR-V2.md §2.2.10, "sibling-wins").
//
// The diff-document is numbered as if it were resolved toward ver2 (sibling):
//   - normal + ver2 lines carry the SIBLING file's line numbers (a continuous
//     sequence); ver2 lines are prefixed `+`.
//   - ver1 lines carry the BASE file's line numbers, prefixed `−` (a separate
//     sequence — they are the "deletions" relative to sibling-wins).
//   - bare terminal `\n` lines (a normal block's hidden line, or an empty
//     ver-block's only line) carry NO number — they are internal, in neither file.
//     An EOL-less last line (terminal that doubles as a content line) DOES carry a
//     number (it's real content).
//
// `computeLineLabels` is the pure §2.2.10 logic as a full walk (caret-independent
// ⇒ the gutter never renumbers as the cursor moves) — the tests' oracle. The CM6
// gutter uses the per-line §2.2.10 formula over an index built once per structure
// change (lineNumberIndex): O(log groups) per visible line.

import { type EditorState, type Extension, type Text } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { VerRange } from "./diff-model";
import { fromRangeSet, structureField } from "./diff-structure";

export type LineSide = "normal" | "ver1" | "ver2";
export interface LineLabel {
  text: string; // e.g. "12", "−4", "+7"
  side: LineSide;
}

export function computeLineLabels(doc: Text, ranges: VerRange[]): Map<number, LineLabel> {
  // classify each ver-block line: which side, and whether it's the BARE terminal
  // (an empty terminal line — gets no number). EOL-less terminal lines have
  // content ⇒ not bare ⇒ numbered.
  const role = new Map<number, { ver: 1 | 2; bareTerminal: boolean }>();
  for (const r of ranges) {
    const firstLine = doc.lineAt(r.from).number;
    const termLine = doc.lineAt(r.to - 1).number;
    for (let n = firstLine; n <= termLine; n++) {
      const isTerminal = n === termLine;
      const bareTerminal = isTerminal && doc.line(n).length === 0;
      role.set(n, { ver: r.ver, bareTerminal });
    }
  }
  // §1.10 / §2.2.10 "sibling-wins": ONE through-counter advanced by normal + ver2
  // (the sibling sequence); a ver1 (local-only) line is numbered in PARALLEL,
  // continuing from the line above (through + offset) WITHOUT advancing through.
  // (My earlier base-file `ours` counter was a divergence — §1.10 numbers ver1 as
  // through+offset = CM6-line# − ver1-lines-above, NOT the base file's own #.) The
  // text carries NO sign here; the −/+ side glyph is rendered by the gutter marker.
  const out = new Map<number, LineLabel>();
  let through = 0; // last normal/ver2 number emitted
  let ver1Offset = 0; // parallel position within the current ver1 run
  for (let n = 1; n <= doc.lines; n++) {
    const r = role.get(n);
    if (r?.bareTerminal) continue; // hidden terminal — no number, counters unchanged
    if (r?.ver === 1) {
      ver1Offset += 1;
      out.set(n, { text: String(through + ver1Offset), side: "ver1" });
    } else {
      // normal or ver2 → advance the through-counter; end any ver1 run.
      through += 1;
      ver1Offset = 0;
      out.set(n, { text: String(through), side: r?.ver === 2 ? "ver2" : "normal" });
    }
  }
  return out;
}

// ── §2.2.10 per-line formula (the "almost-pure" fast lookup) ─────────────────
// getDiffLineNumber(doc, ranges, cm6) → the diff line number + side for ONE CM6
// line, WITHOUT walking from line 1 (§2.2.10: the gutter computes each visible
// line directly). Depends only on (doc, RangeSet) — same scheme as the §1.10
// full walk, proven equal by a property test (formula === computeLineLabels).
//
// Block geometry per range (terminal-inside): a non-empty block's lines are all
// numbered (the terminal `\n` ends the last CONTENT line); an EMPTY ver block is
// a single bare line (no number). Detect bare via the terminal line being empty
// (covers the empty-block AND trailing-blank-content edge the size-1 test missed).
interface BlockGeom {
  ver: 1 | 2;
  firstLine: number;
  termLine: number;
  bare: boolean; // terminal line is empty → that one line carries no number
  numbered: number; // numbered (content) lines = span − (bare ? 1 : 0)
}
function blockGeoms(doc: Text, ranges: VerRange[]): BlockGeom[] {
  return ranges.map((r) => {
    const firstLine = doc.lineAt(r.from).number;
    const termLine = doc.lineAt(r.to - 1).number;
    const bare = doc.line(termLine).length === 0;
    return { ver: r.ver, firstLine, termLine, bare, numbered: termLine - firstLine + 1 - (bare ? 1 : 0) };
  });
}

// The index over the block geometry (owner, 2026-10-30). The §2.2.10 note below
// assumed "1-10 groups above, often ≤2 — no precompute", so the lookup scanned
// EVERY block for each visible line; a History diff with 1648 groups (~3300
// blocks) then cost ~0.5 s per scroll step. Built once per structure: blocks in
// document order (ranges never overlap), their first lines for a binary search,
// and prefix sums of the two corrections the formula subtracts.
export interface LineNumberIndex {
  blocks: BlockGeom[];
  firstLines: number[];
  ver1Before: number[]; // numbered ver1 lines in blocks[0..i-1]
  bareBefore: number[]; // bare blocks in blocks[0..i-1]
}
export function lineNumberIndex(doc: Text, ranges: VerRange[]): LineNumberIndex {
  const blocks = blockGeoms(doc, ranges);
  const firstLines: number[] = [];
  const ver1Before: number[] = [0];
  const bareBefore: number[] = [0];
  for (const b of blocks) {
    firstLines.push(b.firstLine);
    ver1Before.push(ver1Before[ver1Before.length - 1] + (b.ver === 1 ? b.numbered : 0));
    bareBefore.push(bareBefore[bareBefore.length - 1] + (b.bare ? 1 : 0));
  }
  return { blocks, firstLines, ver1Before, bareBefore };
}

// How many blocks start at or above `cm6` (binary search).
function blocksStartingBy(ix: LineNumberIndex, cm6: number): number {
  let lo = 0;
  let hi = ix.firstLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ix.firstLines[mid] <= cm6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// §2.2.10: the diff line number = the CM6 line number − the ver1 lines above it −
// the bare lines above it. Every block before the last one starting at or above
// `cm6` ends above it; that last one is either `own` or wholly above too.
// Returns null for a bare-terminal line (no number) — same as the walk skipping it.
function diffLineNumberAt(ix: LineNumberIndex, cm6: number): LineLabel | null {
  const k = blocksStartingBy(ix, cm6);
  if (k === 0) return { text: String(cm6), side: "normal" };
  const last = ix.blocks[k - 1];
  const own = cm6 <= last.termLine ? last : null;
  if (own && own.bare && cm6 === own.termLine) return null; // bare terminal → no number
  const bareAbove = ix.bareBefore[k - 1] + (last.bare && last.termLine < cm6 ? 1 : 0);
  if (own && own.ver === 1) {
    // ver1: parallel from the line above ⇒ only ver1 blocks STRICTLY ABOVE this one.
    return { text: String(cm6 - ix.ver1Before[k - 1] - bareAbove), side: "ver1" };
  }
  // normal or ver2: the through number ⇒ ALL ver1 numbered lines above.
  const ver1Above = ix.ver1Before[k - 1] + (last.ver === 1 && last.termLine < cm6 ? last.numbered : 0);
  return { text: String(cm6 - ver1Above - bareAbove), side: own ? "ver2" : "normal" };
}

// The "almost-pure" §2.2.10 lookup the user named — getDiffLineNumber(cm6) over a
// RangeSet. Pure (rebuilds the index each call), so the property test can pin
// it EQUAL to the §1.10 full walk (computeLineLabels). The gutter uses the cached
// index below; this is the canonical/tested definition.
export function getDiffLineNumber(doc: Text, ranges: VerRange[], cm6: number): LineLabel | null {
  return diffLineNumberAt(lineNumberIndex(doc, ranges), cm6);
}

// The gutter cell for one CM6 line: the numbered label, OR — for a ver-block's
// bare-terminal line (an empty ver-block, or a non-empty block's hidden terminal)
// — an EMPTY-text label carrying the block's SIDE, so the cell still gets the
// ours/theirs tint. Without this a FOCUSED (expanded) empty ver-block showed a
// WHITE gutter cell (getDiffLineNumber returns null for bare terminals → no
// marker). Numbering is unchanged (empty text consumes no number). Pure → tested.
export function gutterCellAt(ix: LineNumberIndex, cm6: number): LineLabel | null {
  const label = diffLineNumberAt(ix, cm6);
  if (label) return label;
  // null only on a bare terminal line — the last block starting at or above it.
  const b = ix.blocks[blocksStartingBy(ix, cm6) - 1];
  return { text: "", side: b.ver === 1 ? "ver1" : "ver2" };
}
export function gutterCell(doc: Text, ranges: VerRange[], cm6: number): LineLabel | null {
  return gutterCellAt(lineNumberIndex(doc, ranges), cm6);
}

// Gutter cache: the index keyed by the structure RangeSet (stable per state), so
// it is built ONCE per structure change, not once per visible gutter line; each
// line is then a binary search.
const indexCache = new WeakMap<object, LineNumberIndex>();
function cachedIndex(state: EditorState): LineNumberIndex {
  const set = state.field(structureField) as unknown as object;
  let ix = indexCache.get(set);
  if (!ix) {
    ix = lineNumberIndex(state.doc, fromRangeSet(state.field(structureField)));
    indexCache.set(set, ix);
  }
  return ix;
}

// Tint the whole gutter CELL to the line's side colour (elementClass → the
// .cm-gutterElement), and render the number + a `−`/`+` side glyph (§6.5, TODO #18
// keep colours + ± while standardising alignment). Reuses the §1 styles.css.
class LineLabelMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly side: LineSide,
  ) {
    super();
    this.elementClass =
      side === "ver1"
        ? "diff2-gutter-ours"
        : side === "ver2"
          ? "diff2-gutter-theirs"
          : "diff2-gutter-normal"; // faint, like Obsidian's own line numbers
  }
  eq(other: LineLabelMarker): boolean {
    return other.text === this.text && other.side === this.side;
  }
  toDOM(): Node {
    const cell = document.createElement("span");
    cell.className = "diff2-gutter-cell";
    // NUMBER first (right-aligned in its own column → numbers form one clean right
    // column across every row), then the +/− glyph in a fixed-width slot AFTER it
    // (always present, empty for normal) so the glyph never shifts the number.
    const num = cell.appendChild(document.createElement("span"));
    num.className = "diff2-gutter-num";
    num.textContent = this.text;
    const g = cell.appendChild(document.createElement("span"));
    g.className = "diff2-gutter-glyph";
    // No number (text === "") ⇒ a bare-terminal ver-block (e.g. an empty block):
    // keep the side TINT (elementClass) but show NO −/+ glyph — there's no line.
    g.textContent =
      this.text === "" ? "" : this.side === "ver1" ? "−" : this.side === "ver2" ? "+" : "";
    return cell;
  }
}

// #3 — tint the gutter cell beside a marker block-widget the same side band
// (<<<<<=ours, >>>>>=theirs, =====-split). Duck-typed on `diff2MarkerKind` so this
// module needn't import the MarkerWidget class (which would cycle with diff-pane-v2).
class MarkerGutterMarker extends GutterMarker {
  constructor(readonly kind: "open" | "mid" | "close") {
    super();
    this.elementClass =
      kind === "open"
        ? "diff2-gutter-ours-marker"
        : kind === "close"
          ? "diff2-gutter-theirs-marker"
          : "diff2-gutter-split-marker";
  }
  eq(other: MarkerGutterMarker): boolean {
    return other.kind === this.kind;
  }
  toDOM(): Node {
    return document.createTextNode("");
  }
}

// The per-side gutter. Each line computed directly via getDiffLineNumber (§2.2.10),
// not a full re-walk. Right-aligned + coloured by styles.css. Replaces lineNumbers().
export const diffLineNumbersGutter: Extension = gutter({
  class: "diff2-line-number-gutter",
  lineMarker(view, line) {
    const cm6 = view.state.doc.lineAt(line.from).number;
    const label = gutterCellAt(cachedIndex(view.state), cm6);
    return label ? new LineLabelMarker(label.text, label.side) : null;
  },
  widgetMarker(_view, widget) {
    const kind = (widget as { diff2MarkerKind?: "open" | "mid" | "close" }).diff2MarkerKind;
    return kind ? new MarkerGutterMarker(kind) : null;
  },
  lineMarkerChange: (update) =>
    update.docChanged ||
    update.startState.field(structureField) !== update.state.field(structureField),
});

export const diffLineNumbers: Extension = diffLineNumbersGutter;
