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
// `computeLineLabels` is the pure §2.2.10 logic (caret-independent ⇒ the gutter
// never renumbers as the cursor moves). The CM6 gutter caches it in a StateField
// (O(lines) per change, O(1) per line lookup) rather than the per-line on-the-fly
// formula — same result; the formula is a future optimisation for huge docs.

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

// Pure core over precomputed block geometry — the gutter caches `blocks` per
// structure (below) so a 25k-line file does NOT rebuild them per visible line.
// Returns null for a bare-terminal line (no number) — same as the walk skipping it.
function diffLineNumberFromBlocks(blocks: BlockGeom[], cm6: number): LineLabel | null {
  const own = blocks.find((b) => cm6 >= b.firstLine && cm6 <= b.termLine);
  if (own && own.bare && cm6 === own.termLine) return null; // bare terminal → no number
  // Bare lines strictly above (both sides) — they consume a CM6 line but no number.
  const bareAbove = blocks.filter((b) => b.bare && b.termLine < cm6).length;
  if (own && own.ver === 1) {
    // ver1: parallel from the line above ⇒ subtract only ver1 numbered lines in
    // ver1 blocks STRICTLY ABOVE this block (this block's own lines excluded).
    const ver1Prior = blocks
      .filter((b) => b.ver === 1 && b.termLine < own.firstLine)
      .reduce((s, b) => s + b.numbered, 0);
    return { text: String(cm6 - ver1Prior - bareAbove), side: "ver1" };
  }
  // normal or ver2: the through number ⇒ subtract ALL ver1 numbered lines above
  // (cm6 is not in a ver1 block, so ver1 blocks are wholly above or below).
  const ver1Above = blocks
    .filter((b) => b.ver === 1 && b.termLine < cm6)
    .reduce((s, b) => s + b.numbered, 0);
  const side: LineSide = own ? "ver2" : "normal";
  return { text: String(cm6 - ver1Above - bareAbove), side };
}

// The "almost-pure" §2.2.10 lookup the user named — getDiffLineNumber(cm6) over a
// RangeSet. Pure (rebuilds block geometry each call), so the property test can pin
// it EQUAL to the §1.10 full walk (computeLineLabels). The gutter uses the cached
// path below; this is the canonical/tested definition.
export function getDiffLineNumber(doc: Text, ranges: VerRange[], cm6: number): LineLabel | null {
  return diffLineNumberFromBlocks(blockGeoms(doc, ranges), cm6);
}

// The gutter cell for one CM6 line: the numbered label, OR — for a ver-block's
// bare-terminal line (an empty ver-block, or a non-empty block's hidden terminal)
// — an EMPTY-text label carrying the block's SIDE, so the cell still gets the
// ours/theirs tint. Without this a FOCUSED (expanded) empty ver-block showed a
// WHITE gutter cell (getDiffLineNumber returns null for bare terminals → no
// marker). Numbering is unchanged (empty text consumes no number). Pure → tested.
function gutterCellFromBlocks(blocks: BlockGeom[], cm6: number): LineLabel | null {
  const label = diffLineNumberFromBlocks(blocks, cm6);
  if (label) return label;
  const bare = blocks.find((b) => b.bare && b.termLine === cm6);
  return bare ? { text: "", side: bare.ver === 1 ? "ver1" : "ver2" } : null;
}
export function gutterCell(doc: Text, ranges: VerRange[], cm6: number): LineLabel | null {
  return gutterCellFromBlocks(blockGeoms(doc, ranges), cm6);
}

// Gutter cache: block geometry keyed by the structure RangeSet (stable per state),
// so a 25k-line file computes the geometry ONCE per structure change, not once per
// visible gutter line. The viewport renders ~tens of lines → O(viewport × #ranges).
const blockCache = new WeakMap<object, BlockGeom[]>();
function cachedBlocks(state: EditorState): BlockGeom[] {
  const set = state.field(structureField) as unknown as object;
  let blocks = blockCache.get(set);
  if (!blocks) {
    blocks = blockGeoms(state.doc, fromRangeSet(state.field(structureField)));
    blockCache.set(set, blocks);
  }
  return blocks;
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
    const label = gutterCellFromBlocks(cachedBlocks(view.state), cm6);
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
