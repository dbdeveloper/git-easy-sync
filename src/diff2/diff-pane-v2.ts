// V2 DiffPane view assembly — ties the structure spine (diff-structure.ts), the
// decoration decisions (diff-decorations.ts) and the model (diff-model.ts) into
// a live CM6 editor (DIFF-EDITOR-V2.md §2.2). This MIRRORS the prototype that the
// 1a Playwright gate validated in real Chromium (markers side:-1 don't steal
// Decoration.line, height:0 hides terminals, native moveVertically skips them,
// inclusive RangeSet grows, changeFilter protects the terminal \n, cursorVert
// stops at empty vers).
//
// New file during migration: the old `diff-pane.ts` is the §1 Segment[] model
// still consumed by diff-edit-view.ts; this becomes `diff-pane.ts` (old deleted)
// at the Phase-3 wiring step.
//
// Scope of this increment: the render + navigation spine. The editing-behaviour
// filters (auto-\n §2.2.4(2), external guards §2.2.5, selection-legalization
// §2.2.6, shift+arrow selection) and the marker action buttons (§1.9 / §2.2.9
// resolution) land in the next increments.

import {
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateField,
  type Text,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, deleteToLineEnd, history, historyKeymap, redoDepth, undoDepth } from "@codemirror/commands";
// §2.2.17 search. Pinned to 6.5.6 (declares view/state `^6.0.0`, so it runs on the project's
// device-verified CM6 6.36.2 / 6.6.0); package.json `pnpm.overrides` force-dedup view+state to
// those. Do NOT bump search (6.7.x needs view ≥6.43) without re-verifying diff2 selection/geometry.
import { search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { buildModel, type VerRange } from "./diff-model";
import {
  caretOffTerminal,
  cursorHistory,
  cursorVertTarget,
  emptyVerStartSelection,
  selectionVertTarget,
  horizontalSkip,
  isTouchOnly,
  isWordLevel,
  readStructure,
  resolveCaret,
  touchOnlyFacet,
  wordLevelFacet,
  structureField,
  structureHistory,
  terminalProtectionFilter,
  toRangeSet,
} from "./diff-structure";
import { type MarkerKind, glyphDiffLine, markerSpecs, selectionAppearance, verLineDecisions } from "./diff-decorations";
import { type Zone, mouseDragSelection } from "./diff-mouse-select";
import { nextConflict, prevConflict } from "./diff-nav";
import {
  autoNewlineFilter,
  diffBackspace,
  diffDelete,
  diffDeleteLine,
  externalGuardFilter,
} from "./diff-edits";
import { groupsOf, selectionLegalizeFilter } from "./diff-selection";
import { autoResolveFilter, diffSelectionDelete } from "./diff-auto-resolve";
import { diffClipboardCopy, diffClipboardPaste } from "./diff-clipboard";
import { computeWordDiff } from "./word-level-diff";
import { diffLineNumbers } from "./diff-line-numbers";
import { type ResolveChoice, type ResolveOpts, applyResolve, diffResolveKeymap } from "./diff-resolve";
import { type HistorySink, type ReplayFlag, historyFeedListener } from "./history-feed";
import type { CursorActivity } from "./cursor-timer";

// §0.5.6 step-2 — OPTIONAL persistence wiring. When the owner (Phase-6 DiffPaneOwner)
// supplies a sink + the SHARED ReplayFlag, a historyFeedListener is appended so
// every live transaction is fed to history.jsonl. Omitted in pure-CM6 unit tests,
// so the render/nav/resolution spine stays testable without a vault.
export interface DiffPaneV2Hooks {
  // sink+flag are paired (the live history feed); omit BOTH for a config-only hooks
  // (e.g. the touch-only harness / a read-only mount with no recording).
  sink?: HistorySink;
  flag?: ReplayFlag; // SAME instance the owner passes to replayWithGuard
  // P6.3 — view config threaded into the marker decorations (device labels +
  // Join-button visibility) AND derived into ResolveOpts {label: remoteLabel,
  // date} for the in-editor buttons + resolve hotkeys (so a "Join" produces the
  // `> Changes from <label> at <date>` header). Undefined → DEFAULT_VIEW_CONFIG.
  config?: DiffViewConfig;
  // P6.3 — cursor-cadence tap (§2.9). historyFeedListener does NOT poke the
  // cursor timer (it only records edits), so a SEPARATE listener calls this on
  // every transaction: docChanged → "typing", pure caret move → "nav". The owner
  // gates it on !flag.replaying so a replay's re-dispatches don't schedule flushes.
  onActivity?: (activity: CursorActivity) => void;
  // §2.2.15 — fired on every doc/selection change so the toolbar can refresh its live state
  // (conflict count, ↑/↓ + undo/redo disabled). Cheap; the handler patches, not re-renders.
  onUpdate?: () => void;
  // bug-56 monitoring — fired on every undo/redo with the before/after undoDepth + doc length
  // so debit=credit can be watched over time (the owner logs it). Undo: depth −1; redo: +1.
  onUndoRedo?: (info: {
    kind: "undo" | "redo";
    undoDepthBefore: number;
    undoDepthAfter: number;
    redoDepthBefore: number;
    redoDepthAfter: number;
    docLenBefore: number;
    docLenAfter: number;
  }) => void;
}

// View-level config the marker decorations need (and from which ResolveOpts is
// derived). localLabel = ver1/ours device (top marker), remoteLabel = ver2/theirs
// device (bottom marker + Join header/tooltip), date = Join header date,
// isMarkdown gates the Join button (a blockquote join would corrupt non-markdown).
export interface DiffViewConfig {
  localLabel: string;
  remoteLabel: string;
  date: string;
  isMarkdown: boolean;
  // §2.2.14 — touch-only / read-only mode: the editor blocks edits (typing/delete/paste) but
  // keeps resolve buttons, selection, copy, and undo/redo; the marker glyph-click (caret into
  // a block) is disabled. Optional (default false); set from the "Interface" setting at open.
  touchOnly?: boolean;
  // Intra-chunk diff highlight: true → whole changed WORDS (diffWords); false/undefined →
  // per-CHARACTER (default). Large blocks auto-fall-back to word regardless. Settings-driven.
  wordLevelDiff?: boolean;
}

export const DEFAULT_VIEW_CONFIG: DiffViewConfig = {
  localLabel: "local",
  remoteLabel: "remote",
  date: "",
  isMarkdown: true,
  touchOnly: false,
  wordLevelDiff: false,
};

// Facet carrying the config into buildDecorations (a StateField update only gets
// `state`, so the config must live IN state). Constant per view — seeded once in
// createDiffPaneState; combine takes the seeded value (or the default).
export const diffViewConfigFacet = Facet.define<DiffViewConfig, DiffViewConfig>({
  combine: (values) => values[0] ?? DEFAULT_VIEW_CONFIG,
});

// ── markers (§1 visual layer, ported) ────────────────────────────────────────
// REUSE the §1 markers.ts rendering: top/middle/bottom CSS classes, the 5-ASCII
// glyph (<<<<< / ===== / >>>>>; the Unicode ≪/==/≫ are reserved for the clipboard
// format §2.2.7), the `.diff2-marker-buttons` wrapper, and the
// `diff2-btn diff2-marker-btn diff2-marker-btn-<choice>` button classes — so the
// polished styles.css applies unchanged. Internal MarkerKind stays open/mid/close
// (the §2.2.2 spec); only the emitted class maps to top/middle/bottom.
const MARKER_CLASS: Record<MarkerKind, string> = { open: "top", mid: "middle", close: "bottom" };
const MARKER_GLYPH: Record<MarkerKind, string> = {
  open: "<<<<<",
  mid: "=====",
  close: ">>>>>",
};

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

// "Ctrl-Shift-Enter" → "⌃⇧Enter" (mac, LITERAL Ctrl per §1.9) / "Ctrl+Shift+Enter"
// (other). For the button tooltips (the keyboard affordance, §1.9).
function fmtHotkey(spec: string): string {
  return spec.replace("Ctrl", IS_MAC ? "⌃" : "Ctrl").replace("Shift", IS_MAC ? "⇧" : "Shift").replace(/-/g, IS_MAC ? "" : "+");
}

// Short button label + descriptive tooltip + the §1.9 hotkey (PER BUTTON, not per
// choice: apply/remove are context-sensitive, so [Keep ↓] and [Apply ↑] share
// Ctrl+Enter = "apply this block"). `desc` undefined → built from the remote label
// at render time (Join only).
interface BtnSpec {
  label: string;
  choice: ResolveChoice;
  hotkey: string; // §1.9 CM6 key spec (matches diffResolveKeymap)
  desc?: string;
}
const MARKER_BUTTONS: Record<MarkerKind, BtnSpec[]> = {
  open: [
    { label: "Keep ↓", choice: "keep1", hotkey: "Ctrl-Enter", desc: "Keep this local change" },
    { label: "Remove ↓", choice: "keep2", hotkey: "Ctrl-Backspace", desc: "Remove this local change" },
  ],
  mid: [
    { label: "Apply ↓↑", choice: "both", hotkey: "Ctrl-Shift-Enter", desc: "Apply both local and remote changes" },
    { label: "Remove ↓↑", choice: "neither", hotkey: "Ctrl-Shift-Backspace", desc: "Remove both local and remote changes" },
    { label: "> Join ↓", choice: "join", hotkey: "Ctrl-Shift-." }, // desc built from remoteLabel
  ],
  close: [
    { label: "Apply ↑", choice: "keep2", hotkey: "Ctrl-Enter", desc: "Apply this remote change" },
    { label: "Remove ↑", choice: "keep1", hotkey: "Ctrl-Backspace", desc: "Remove this remote change" },
  ],
};

// Caret target for clicking a marker glyph (§2.2.4.9 mouse/tap entry into a block — the
// only way to reach an EMPTY ver-block, collapsed/height:0, not directly clickable).
// `end` picks WHICH end of the block, chosen so the caret lands at the line NEAREST the
// clicked marker:
//   open(<<<<<) above ver1 → ver1 "first";  mid(=====) below ver1 → ver1 "last";
//   mid(=====) above ver2  → ver2 "first";  close(>>>>>) below ver2 → ver2 "last".
// "first" = the block's first line, col 0 (= range.from); "last" = its last CONTENT line,
// col 0 (skipping the terminal `\n`). An EMPTY block (width-1, terminal only) → its single
// caret slot (`from`) either way (focus expands it). Returns null if the group/side is
// absent. Pure → unit-tested.
export function verBlockCaretTarget(
  doc: Text,
  ranges: VerRange[],
  group: number,
  ver: 1 | 2,
  end: "first" | "last",
): number | null {
  const r = ranges.find((x) => x.group === group && x.ver === ver);
  if (!r) return null;
  if (end === "first" || r.to - r.from <= 1) return r.from; // first line / empty caret slot
  return doc.lineAt(r.to - 2).from; // last content line col 0
}

class MarkerWidget extends WidgetType {
  // Duck-type tag read by diff-line-numbers.ts's gutter widgetMarker for the #3
  // marker-row gutter tint, WITHOUT importing this class (which would cycle).
  readonly diff2MarkerKind: MarkerKind;
  constructor(
    readonly kind: MarkerKind,
    readonly group: number,
    readonly config: DiffViewConfig,
    // §2.2.6 п.7 marker-row selection overlay. open/close use both=its ver; mid
    // splits: top=ver1, bottom=ver2. MUST be in eq() or CM6 reuses stale DOM and the
    // overlay won't repaint on a selection-only change.
    readonly selTop = false,
    readonly selBottom = false,
  ) {
    super();
    this.diff2MarkerKind = kind;
  }
  eq(other: MarkerWidget): boolean {
    return (
      other.kind === this.kind &&
      other.group === this.group &&
      other.selTop === this.selTop &&
      other.selBottom === this.selBottom &&
      other.config.localLabel === this.config.localLabel &&
      other.config.remoteLabel === this.config.remoteLabel &&
      other.config.isMarkdown === this.config.isMarkdown
    );
  }
  // CM6 passes the live EditorView to a widget's toDOM — we use it to wire DIRECT
  // button listeners (the §1 pattern). The earlier domEventHandlers mousedown-
  // delegation did NOT fire for block-widget buttons (bug: buttons didn't resolve);
  // a direct addEventListener + stopPropagation is reliable. "Don't reinvent §1".
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = `diff2-marker diff2-marker-${MARKER_CLASS[this.kind]}`;
    el.dataset.group = String(this.group); // §2.2.6 п.7c — read by zoneAt for drag selection
    // §2.2.6 п.7 — translucent selection overlay (::before in styles.css) over the
    // OPAQUE marker row; full row for open/close, half-row for the split mid.
    if (this.selTop && this.selBottom) el.classList.add("diff2-marker-sel-full");
    else if (this.selTop) el.classList.add("diff2-marker-sel-top");
    else if (this.selBottom) el.classList.add("diff2-marker-sel-bottom");

    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent = MARKER_GLYPH[this.kind];
    // §2.2.4.9 — wrap EVERY marker glyph in a hit div that stretches to the marker's FULL
    // HEIGHT (CSS `.diff2-marker-glyph-hit` → align-self:stretch) and is the click/tap
    // target — an easy target that stops at the first button (NOT the whole row: a click
    // drops the caret at the NEAREST line's col 0, so the zone stays near the start). It
    // moves the caret INTO a ver-block (the only way to reach an EMPTY, collapsed one):
    //   open(<<<<<)  → ver1 first line; close(>>>>>) → ver2 last line.
    //   mid(=====) is DUAL — it borders BOTH blocks: a click in the TOP half → ver1 LAST
    //     line; the BOTTOM half → ver2 FIRST line.
    // §2.2.6 п.7c — uses DOM `click` (fires ONLY on a clean click, never after a drag) and
    // NO mousedown/preventDefault/stopPropagation, so a click+drag from this zone instead
    // starts a mouse SELECTION via mouseSelectionStyle. Same for the buttons below.
    const hit = document.createElement("div");
    hit.className = "diff2-marker-glyph-hit diff2-marker-clickable";
    hit.appendChild(glyph);
    hit.addEventListener("click", (e) => {
      if (isTouchOnly(view.state)) return; // §2.2.14(3) — no caret-into-block in read-only mode
      const d = view.state.doc;
      const rs = readStructure(view.state);
      let target: number | null;
      if (this.kind === "open") target = verBlockCaretTarget(d, rs, this.group, 1, "first");
      else if (this.kind === "close") target = verBlockCaretTarget(d, rs, this.group, 2, "last");
      else {
        const rect = hit.getBoundingClientRect();
        const topHalf = e.clientY - rect.top < rect.height / 2;
        target = topHalf
          ? verBlockCaretTarget(d, rs, this.group, 1, "last") // ===== top → ver1 last line
          : verBlockCaretTarget(d, rs, this.group, 2, "first"); // ===== bottom → ver2 first line
      }
      if (target !== null) {
        view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
        view.focus();
      }
    });
    el.appendChild(hit);

    const resolveOpts = { label: this.config.remoteLabel, date: this.config.date };
    const buttons = document.createElement("span");
    buttons.className = "diff2-marker-buttons";
    for (const b of MARKER_BUTTONS[this.kind]) {
      // Join is markdown-only (a blockquote join corrupts non-markdown files).
      if (b.choice === "join" && !this.config.isMarkdown) continue;
      const btn = document.createElement("button");
      btn.className = `diff2-btn diff2-marker-btn diff2-marker-btn-${b.choice}`;
      btn.textContent = b.label;
      const desc =
        b.choice === "join"
          ? `Keep local changes and join changes from "${this.config.remoteLabel}"`
          : (b.desc ?? "");
      btn.title = `${desc} (${fmtHotkey(b.hotkey)})`;
      btn.setAttribute("data-diff2-resolve", b.choice);
      btn.setAttribute("data-diff2-group", String(this.group));
      // §2.2.9 — pointer resolve (caret synthesized at ver1.from). §2.2.6 п.7c: DOM `click`
      // (fires ONLY on a clean click, never after a drag) + NO preventDefault/stopPropagation,
      // so a click+drag from a button starts a mouse SELECTION (the button sits on a marker
      // row → that marker's drag zone) instead of resolving.
      btn.addEventListener("click", () => {
        applyResolve(view, this.group, b.choice, resolveOpts, "pointer");
      });
      buttons.appendChild(btn);
    }
    el.appendChild(buttons);

    // Device label on top/bottom only (R7.2): top = local (ver1), bottom = remote
    // (ver2); the middle separator stays unlabeled.
    const label =
      this.kind === "open"
        ? this.config.localLabel
        : this.kind === "close"
          ? this.config.remoteLabel
          : "";
    if (label) {
      const lab = document.createElement("span");
      lab.className = "diff2-marker-label";
      lab.textContent = `(${label})`;
      el.appendChild(lab);
    }
    return el;
  }
  // bug-47 — a selection-only change flips selTop/selBottom → eq() returns false. WITHOUT
  // this, CM6 DESTROYS + RECREATES this block-widget marker, and a freshly-created block
  // widget's height is re-estimated (estimatedHeight is approximate — the buttons can
  // wrap) before it's measured. That momentary mislayout shifts the lines around the
  // marker, so drawSelection measures the selection rects against the WRONG line tops →
  // the band shifts / gaps and the screen doesn't repaint (bug-47-1..4; phantom-adjacent
  // but distinct). Updating ONLY the overlay class IN PLACE + returning true makes CM6
  // KEEP the already-measured DOM → no reflow → no shift. The button listeners close over
  // the same view + group/config (unchanged), so reusing the DOM is safe.
  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    if (!dom.classList.contains(`diff2-marker-${MARKER_CLASS[this.kind]}`)) return false;
    dom.classList.toggle("diff2-marker-sel-full", this.selTop && this.selBottom);
    dom.classList.toggle("diff2-marker-sel-top", this.selTop && !this.selBottom);
    dom.classList.toggle("diff2-marker-sel-bottom", !this.selTop && this.selBottom);
    return true;
  }
  get estimatedHeight(): number {
    // The marker row is a glyph + wrapping action buttons + device label ≈ one text
    // line of padding + button height (~36px), NOT 18. A too-small estimate mislays the
    // lines below until the real measure lands (bug-47). updateDOM above keeps it from
    // mattering after the first render, but the first render should still be close.
    return 36;
  }
  // §2.2.6 п.7c — FALSE so the marker's mouse events reach CM6's input pipeline (the
  // mouseSelectionStyle that drives marker-zone drag selection). Clean clicks are still
  // handled by the DOM `click` listeners on the glyph zone / buttons (which fire only on a
  // clean click); buttons no longer stopPropagation, so a drag from them selects instead.
  ignoreEvent(): boolean {
    return false;
  }
}

// §1.6.a.1 — the ghost `↵` marking a ver line's real newline is rendered via a
// CSS `::after` on the line decoration (styles.css .diff2-glyph-line), NOT a
// widget. A widget at line.to went stale on the EOL-less [Delete] (the line text
// was unchanged so CM6 reused the line DOM and never removed it). The line class
// is part of CM6 per-line dirty tracking, so it toggles reliably. On EMPTY lines
// CM6 inserts a `<br>` that would push the pseudo to a 2nd row — styles.css hides
// that `<br>` on .diff2-glyph-line so the ↵ stays inline (bug-25).
// §R7.4 / §1.11 — changed word fragments inside a ver line get the STRONGER side
// tint (.diff2-word-changed), so they stand out from the subtle line tint.
const wordMark = Decoration.mark({ class: "diff2-word-changed" });

// ── decorations ──────────────────────────────────────────────────────────────
// Build the CM6 DecorationSet (§1 visual layer ported): block-widget markers, ver
// line colour bands (diff2-line-ours/theirs) + `diff2-collapsed` (height:0 bare
// terminals) + the `↵` newline widget, and word-level diff marks per group.
export function buildDecorations(state: EditorState): DecorationSet {
  const ranges = readStructure(state);
  const caret = state.selection.main.head;
  const config = state.facet(diffViewConfigFacet);
  const all = [];
  const sel = state.selection.main;
  const appear = selectionAppearance(ranges, Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head));
  for (const m of markerSpecs(state.doc, ranges)) {
    const st = appear.get(m.group);
    const v1sel = st?.ver1 ?? false;
    const v2sel = st?.ver2 ?? false;
    // open(<<<<<)=ver1 full row, close(>>>>>)=ver2 full row, mid(=====) split top/bottom.
    const selTop = m.kind === "close" ? v2sel : v1sel;
    const selBottom = m.kind === "open" ? v1sel : v2sel;
    all.push(
      Decoration.widget({
        widget: new MarkerWidget(m.kind, m.group, config, selTop, selBottom),
        block: true,
        side: m.side,
      }).range(m.pos),
    );
  }
  for (const d of verLineDecisions(state.doc, ranges, caret)) {
    // §1.11 ver-block colour band (reuses styles.css .diff2-line-ours/theirs);
    // diff2-collapsed gives the bare terminal `\n` line height:0.
    const cls = [d.ver === 1 ? "diff2-line-ours" : "diff2-line-theirs"];
    if (d.collapsed) cls.push("diff2-collapsed");
    // §1.6.a.1 ↵ marking the line's real newline. HYBRID rendering:
    //   - line WITH text → CSS `::after` on the line class `diff2-glyph-line`. A
    //     line-decoration class is part of CM6 per-line dirty tracking, so it is
    //     added/removed reliably — fixes the EOL-less [Delete] staleness where a
    //     widget at line.to lingered (the line's text was unchanged).
    //   - EMPTY line → a WIDGET. On an empty line CM6 inserts a `<br>`, so a CSS
    //     `::after` wraps onto a 2nd visual row (bug-25); a widget draws inline.
    //     As soon as the line gets text it switches to the `::after` branch (the
    //     text change re-renders the line, dropping the widget).
    if (d.glyph) cls.push("diff2-glyph-line");
    all.push(Decoration.line({ class: cls.join(" ") }).range(d.from));
  }
  // §R7.4 word-level diff per group — overlay the changed fragments on each side.
  for (const g of groupsOf(ranges)) {
    const v1 = ranges.find((r) => r.group === g.group && r.ver === 1);
    const v2 = ranges.find((r) => r.group === g.group && r.ver === 2);
    if (!v1 || !v2) continue;
    const ours = state.doc.sliceString(v1.from, v1.to - 1); // content (drop terminal \n)
    const theirs = state.doc.sliceString(v2.from, v2.to - 1);
    const wd = computeWordDiff(ours, theirs, isWordLevel(state)); // live facet (toolbar-toggleable)
    for (const s of wd.oursSpans) all.push(wordMark.range(v1.from + s.start, v1.from + s.end));
    for (const s of wd.theirsSpans) all.push(wordMark.range(v2.from + s.start, v2.from + s.end));
    // §2.2.12(a) bug-50 — a trailing-`\n` difference (last EOL-less group) → mark that side's
    // `↵` glyph as a diff via a line class (the glyph is CSS-only, not a doc char).
    const gl = glyphDiffLine(state.doc, v1, v2);
    if (gl !== null) all.push(Decoration.line({ class: "diff2-glyph-diff" }).range(gl));
  }
  return Decoration.set(all, true);
}

export const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (_value, tr) => buildDecorations(tr.state),
  provide: (f) => EditorView.decorations.from(f),
});

// ── navigation (§2.2.4(9) empty-ver stop) ────────────────────────────────────
// Plain Up/Down: native vertical motion (heightmap skips height:0) + stop at the
// first empty ver in the jumped span. Shift+arrow (selection extend) and
// PgUp/PgDn (jump-page, decided 2026-06-12) fall through to defaultKeymap.
function vertical(view: EditorView, forward: boolean): boolean {
  const cur = view.state.selection.main;
  const native = view.moveVertically(cur, forward);
  const target = cursorVertTarget(readStructure(view.state), cur.head, native.head, forward);
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
  return true;
}

// §2.2.4(9b/9f) — plain Left/Right step OVER a non-empty ver-block's hidden
// terminal `\n` line (the caret must never rest there). Move one char natively,
// then skip. Plain caret only; Shift+Left/Right (selection) falls through.
function horizontal(view: EditorView, forward: boolean): boolean {
  const cur = view.state.selection.main;
  if (!cur.empty) return false; // collapse/extend selection → default
  const native = view.moveByChar(cur, forward);
  const target = horizontalSkip(view.state.doc, readStructure(view.state), native.head, forward);
  view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true });
  return true;
}

// bug-45/46 — Obsidian's bundled CM6 drawSelection keeps a STALE-WIDTH node in its
// rect pool when a keyboard selection SHRINKS across collapsed (height:0) lines: it
// repositions the trailing rect (top) but never resizes it (frozen at the previous
// word's width) → a phantom highlight on the wrong line. Confirmed from the live DOM:
// exactly ONE view / ONE selectionLayer / 3 rects, rect-3's width frozen at w55 across
// gestures (so NOT a stray range — CM6 enforces a single selection — and NOT a dup
// view). CM6 6.36.2 (the harness) recomputes it correctly; Obsidian's version doesn't.
// A plain `reconfigure(drawSelection())` is a NO-OP (same module-level ViewPlugin), so
// we TEAR THE LAYER DOWN (reconfigure to []) then RE-ADD it in a second synchronous
// dispatch: the destroy() drops the stale pool, the re-add builds fresh nodes. Both
// dispatches run before the next paint → no empty-flash. Reverts cleanly if it doesn't
// hold up (the alternative is bundling a known-good CM6, ~450KB).
const drawSelectionComp = new Compartment();

// §2.2.15 — touch-only / word-level modes are LIVE-reconfigurable from the toolbar (the
// owner reconfigures these). createDiffPaneState seeds them from the view config; the editor
// reads the underlying facets (changeFilter/guards/marker-click → touchOnlyFacet;
// buildDecorations → wordLevelFacet).
export const touchOnlyComp = new Compartment();
export const wordLevelComp = new Compartment();

// TODO §15/§17 — tweak the default CM6 search panel when it opens. The buttons live in the
// panel DOM under the view (`.cm-search button[name="…"]`), already mounted by the time the
// updateListener fires; the panel's DOM is stable for its lifetime (rebuilt only on
// close/reopen), so doing this once per open is enough. Two tweaks:
//   1. Tag next/prev (relabeled ">>"/"<<" via phrases, no native tooltip) with their
//      find-again hotkeys so the glyphs are self-explanatory.
//   2. Hide the [All] button (name="select" → selectMatches). It selects every match as a
//      MULTI-selection, but diff2 never enables allowMultipleSelections (multi-cursor would
//      fight the resolve/merge cascade), so CM6 collapses it to one range — the button does
//      nothing useful. Hidden to avoid a dead control.
export const configureSearchPanel: Extension = EditorView.updateListener.of((u) => {
  if (!searchPanelOpen(u.state) || searchPanelOpen(u.startState)) return;
  const panel = u.view.dom.querySelector(".cm-search");
  panel
    ?.querySelector('button[name="next"]')
    ?.setAttribute("title", "Next match (F3)");
  panel
    ?.querySelector('button[name="prev"]')
    ?.setAttribute("title", "Previous match (⇧F3)");
  const selectAll = panel?.querySelector('button[name="select"]');
  if (selectAll instanceof HTMLElement) selectAll.style.display = "none";
});

// §2.2.15 — scroll to a conflict group (2-line lead) + caret at ver1.from (its `from`). The
// caret-cadence/structure handle the rest. Shared by the toolbar ↑/↓ and the Ctrl+[/] keys.
export function scrollToConflict(view: EditorView, from: number): void {
  view.dispatch({
    selection: EditorSelection.cursor(from),
    effects: EditorView.scrollIntoView(from, { y: "start", yMargin: view.defaultLineHeight * 2 }),
  });
  view.focus();
}

// §2.2.15 — move to the next/prev conflict relative to the caret. Returns false (no-op,
// keymap falls through) when there is none. Used by both the toolbar buttons and Ctrl+[/].
export function gotoAdjacentConflict(view: EditorView, forward: boolean): boolean {
  const ranges = readStructure(view.state);
  const caret = view.state.selection.main.head;
  const g = forward ? nextConflict(ranges, caret) : prevConflict(ranges, caret);
  if (!g) return false;
  scrollToConflict(view, g.from);
  return true;
}

function dispatchSel(view: EditorView, anchor: number, head: number): void {
  // Tear the drawSelection layer DOWN then re-add it in a second synchronous dispatch
  // (the []→drawSelection() round-trip — a plain reconfigure is a no-op) so its stale
  // rect-node pool is dropped + rebuilt fresh. (Removing this did NOT help the bug-47
  // marker gaps — those are fixed in styles.css by extending the marker ::before — so
  // the teardown stays for the phantom.)
  view.dispatch({ effects: drawSelectionComp.reconfigure([]) });
  view.dispatch({
    selection: EditorSelection.range(anchor, head),
    effects: drawSelectionComp.reconfigure(drawSelection()),
    scrollIntoView: true,
  });
}

// §2.2.6 п.7e — Shift+Up/Down EXTEND the selection with the same diff-aware stops:
// keep the anchor, move the head to the first region boundary (selectionVertTarget).
// Without this, Shift+arrow fell through to defaultKeymap → native column-preserving
// motion overshot the collapsed group (browser-observed). Horizontal Shift+Left/Right
// already lands correctly (one-char step hits the boundary) → left to the default.
function verticalSelect(view: EditorView, forward: boolean): boolean {
  const cur = view.state.selection.main;
  const ranges = readStructure(view.state);
  const native = view.moveVertically(cur, forward);
  // §2.2.6 п.7e.ii.d / п.7e.iii.c — a selection STARTING on an EMPTY ver-block: the
  // empty block is transparent → rebase the anchor to the seam toward the adjacent
  // non-empty block and select from there (Shift+Down → caret at ver2 start; a big
  // Shift+PgDn landing inside ver2 → [ver2.start, landing]).
  if (cur.empty) {
    const ev = emptyVerStartSelection(ranges, cur.head, native.head, forward);
    if (ev) {
      dispatchSel(view, ev.anchor, ev.head);
      return true;
    }
  }
  const head = selectionVertTarget(ranges, cur.anchor, cur.head, native.head, forward);
  dispatchSel(view, cur.anchor, head);
  return true;
}

// §2.2.6 п.7e — Shift+Left/Right EXTEND. Without this, Shift+Right fell through to
// defaultKeymap → its one-char step landed the head ON a non-empty ver-block's hidden
// terminal line (`to-1`), where caretOffTerminalListener can't reach it (it only
// nudges EMPTY selections) — bug-40. Fix: move one char natively, skip a hidden
// terminal (horizontalSkip), then apply the SAME anchor-aware atomic/stadial snap as
// vertical (so Shift+Left out of a whole-selected group jumps the WHOLE group, and
// Shift+Right into one selects it atomically). The skip-then-snap feeds the shared
// selectionVertTarget — it is position-only, not vertical-specific.
function horizontalSelect(view: EditorView, forward: boolean): boolean {
  const cur = view.state.selection.main;
  const ranges = readStructure(view.state);
  const native = view.moveByChar(cur, forward);
  if (cur.empty) {
    const ev = emptyVerStartSelection(ranges, cur.head, native.head, forward);
    if (ev) {
      dispatchSel(view, ev.anchor, ev.head);
      return true;
    }
  }
  const skipped = horizontalSkip(view.state.doc, ranges, native.head, forward);
  const head = selectionVertTarget(ranges, cur.anchor, cur.head, skipped, forward);
  dispatchSel(view, cur.anchor, head);
  return true;
}

export const diffNavKeymap: Extension = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => vertical(v, true) },
    { key: "ArrowUp", run: (v) => vertical(v, false) },
    { key: "ArrowRight", run: (v) => horizontal(v, true) },
    { key: "ArrowLeft", run: (v) => horizontal(v, false) },
    { key: "Shift-ArrowDown", run: (v) => verticalSelect(v, true) },
    { key: "Shift-ArrowUp", run: (v) => verticalSelect(v, false) },
    { key: "Shift-ArrowRight", run: (v) => horizontalSelect(v, true) },
    { key: "Shift-ArrowLeft", run: (v) => horizontalSelect(v, false) },
  ]),
);

// §2.2.4(9) caret invariant backstop — after ANY update, if the (collapsed) caret
// landed on a non-empty ver-block's hidden terminal line, nudge it off (Enter,
// mouse, programmatic — anything the directional nav above didn't catch). Selection-
// only follow-up, not in history; re-entrancy is safe (the nudged position is no
// longer a terminal, so the next update is a no-op) — same pattern as
// cursorRestoreListener.
export const caretOffTerminalListener: Extension = EditorView.updateListener.of((u) => {
  if (!u.selectionSet && !u.docChanged) return;
  const sel = u.state.selection.main;
  if (!sel.empty) return;
  const target = caretOffTerminal(u.state.doc, readStructure(u.state), sel.head);
  if (target !== sel.head) {
    u.view.dispatch({ selection: { anchor: target }, annotations: Transaction.addToHistory.of(false) });
  }
});

// ── §2.2.9 explicit resolution-caret restore ─────────────────────────────────
// `resolveCaret` rides the forward resolution and (via cursorHistory) every undo/
// redo hop. On undo restore `before`, on redo restore `after` — a selection-only
// follow-up dispatch (NOT in history), since CM6's native selection mapping drifts
// for a caret inside a replaced region. Re-entrancy (dispatch from updateListener)
// validated on a real view in v2-cursor-history-view-probe.
export const cursorRestoreListener: Extension = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    const e = tr.effects.find((x) => x.is(resolveCaret));
    if (!e) continue;
    let pos: number | null = null;
    if (tr.isUserEvent("undo")) pos = e.value.before;
    else if (tr.isUserEvent("redo")) pos = e.value.after;
    if (pos !== null) {
      u.view.dispatch({
        selection: { anchor: pos },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }
});

// ── cursor cadence (§2.9) ─────────────────────────────────────────────────────
// A thin updateListener that maps each transaction to a cursor-flush cadence: a
// doc change is "typing", a pure selection move is "nav" (the historyFeedListener
// records edits but never pokes the cursor timer — P6.3 gotcha). The owner gates
// the callback on !flag.replaying so a replay's re-dispatches schedule nothing.
function cursorCadenceListener(onActivity: (activity: CursorActivity) => void): Extension {
  return EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      if (tr.docChanged) onActivity("typing");
      else if (tr.selection) onActivity("nav");
    }
  });
}

// bug-56 monitoring — report every undo/redo's depth + doc length before/after, so debit=credit
// can be watched over time (the owner forwards it to the log).
function undoRedoLogListener(cb: NonNullable<DiffPaneV2Hooks["onUndoRedo"]>): Extension {
  return EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      const kind = tr.isUserEvent("undo") ? "undo" : tr.isUserEvent("redo") ? "redo" : null;
      if (!kind) continue;
      cb({
        kind,
        undoDepthBefore: undoDepth(tr.startState),
        undoDepthAfter: undoDepth(tr.state),
        redoDepthBefore: redoDepth(tr.startState),
        redoDepthAfter: redoDepth(tr.state),
        docLenBefore: tr.startState.doc.length,
        docLenAfter: tr.state.doc.length,
      });
    }
  });
}

// §2.2.6 п.7c — map mouse coords to a selection ZONE: over a marker block-widget → that
// marker's zone (read from its class + `data-group`); otherwise the nearest text position
// (posAtCoords precise:false never returns null). Drives the mouse-drag selection.
function zoneAt(view: EditorView, clientX: number, clientY: number): Zone {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const mk = el?.closest(".diff2-marker") as HTMLElement | null;
  if (mk) {
    const m = /diff2-marker-(top|middle|bottom)/.exec(mk.className);
    const group = Number(mk.dataset.group);
    if (m && Number.isFinite(group)) {
      const marker = m[1] === "top" ? "open" : m[1] === "middle" ? "mid" : "close";
      return { kind: "marker", marker, group };
    }
  }
  return { kind: "text", pos: view.posAtCoords({ x: clientX, y: clientY }, false) };
}

// ── assembly ─────────────────────────────────────────────────────────────────
// Build the initial EditorState for a (base, sibling) pair. The structure field
// is seeded via `.init()` from the model's ranges (no post-create dispatch).
export function createDiffPaneState(base: string, sibling: string, hooks?: DiffPaneV2Hooks): EditorState {
  const m = buildModel(base, sibling);
  const config = hooks?.config ?? DEFAULT_VIEW_CONFIG;
  // Derive the resolve-domain opts (join header) from the view config — ONE source
  // of truth for the remote label + date.
  const resolveOpts: ResolveOpts = { label: config.remoteLabel, date: config.date };
  return EditorState.create({
    doc: m.doc,
    extensions: [
      diffViewConfigFacet.of(config), // marker decorations read this (device labels, Join gate)
      // §2.2.14/§2.2.15 — touch-only + word-level modes via Compartments so the toolbar can
      // toggle them live; seeded from the view config.
      touchOnlyComp.of(touchOnlyFacet.of(config.touchOnly ?? false)),
      wordLevelComp.of(wordLevelFacet.of(config.wordLevelDiff ?? false)),
      // §2.2.17 — mark the editor while touch-only so styles.css can drop the search panel's
      // replace UI (replace is blocked anyway). Declarative via editorAttributes so CM6 keeps it
      // across focus/updates (a manual classList.add gets wiped when CM6 rewrites view.dom's class)
      // and it stays reactive to the touchOnly compartment.
      EditorView.editorAttributes.compute([touchOnlyFacet], (state) => ({
        class: state.facet(touchOnlyFacet) ? "diff2-touch-search" : "",
      })),
      // §2.2.14 touch-only — block user EDITS (typing/delete/paste) but NOT undo/redo/
      // resolve/copy/selection. readOnly would have done it but it ALSO blocks undo (spec
      // п.5 needs undo); editable=false blocks ALL keyboard incl Ctrl+C/Z. So: a changeFilter
      // that rejects input/delete userEvents (native typing, the fall-through of guarded
      // delete keymaps, native paste). undo/redo carry "undo"/"redo" userEvents; resolve
      // carries none → both pass. Custom edit keymaps additionally no-op (return false) so
      // they don't consume a key like Ctrl+Y (= redo).
      EditorState.changeFilter.of((tr) => {
        if (!tr.startState.facet(touchOnlyFacet)) return true;
        return !(tr.isUserEvent("input") || tr.isUserEvent("delete"));
      }),
      diffLineNumbers, // §2.2.10 per-side −/+ gutter (replaces lineNumbers())
      history(),
      // §2.2.17 — standard CM6 search panel (the same engine Obsidian's editor uses), opened
      // with Mod+F. selectionLegalizeFilter skips the `select.search` userEvent so find-next/prev
      // lands on the real match instead of a group-atomic selection.
      search({ top: true }),
      // §2.2.17 — relabel the search panel's controls (CM6 routes every label through
      // state.phrase, so this is the clean way; order is the panel's own).
      EditorState.phrases.of({
        next: ">>",
        previous: "<<",
        all: "All",
        "match case": "Aa",
        regexp: ".*",
        "by word": "word",
      }),
      structureField.init(() => toRangeSet(m.ranges)),
      structureHistory, // version the structure field across undo/redo (resolution)
      cursorHistory, // §2.2.9 carry the resolveCaret marker across undo/redo
      cursorRestoreListener, // §2.2.9 apply before/after caret on undo/redo
      caretOffTerminalListener, // §2.2.4(9) caret never rests on a hidden terminal line
      decorationsField,
      terminalProtectionFilter,
      externalGuardFilter, // §2.2.5(1) — changeFilter (runs before transactionFilters)
      autoNewlineFilter, // §2.2.4(2) — transactionFilter (appends normalization)
      selectionLegalizeFilter, // §2.2.4(5)/§2.2.6 — transactionFilter (legalize selection)
      autoResolveFilter, // §2.2.13 VANISH — edit makes ver1==ver2 → collapse group to normal lines
      // §2.2.9 marker-button clicks are wired as DIRECT listeners in MarkerWidget.
      // toDOM (the §1 pattern) — the old domEventHandlers delegation didn't fire
      // for block-widget buttons (bug: buttons didn't resolve).
      diffResolveKeymap(resolveOpts), // §1.9 hotkeys — resolve current group (Ctrl-Enter etc.)
      // §2.2.4 p5c/§2.2.6/§2.2.9 — a terminal-spanning selection delete (incl.
      // Ctrl+A) rebuilds via setStructure; Prec.highest so it beats both the
      // boundary keymap and defaultKeymap. Returns false for empty/within-block →
      // falls through to the boundary keymap below.
      Prec.highest(
        keymap.of([
          { key: "Backspace", run: diffSelectionDelete },
          { key: "Delete", run: diffSelectionDelete },
        ]),
      ),
      // §2.2.4(6,7)/§2.2.5 — boundary Backspace/Delete consumed (caret stays put);
      // Prec.high so it beats defaultKeymap's deleteChar*. Returns false off-boundary.
      Prec.high(
        keymap.of([
          { key: "Backspace", run: diffBackspace },
          { key: "Delete", run: diffDelete },
          // §2.2.5(3) delete-line (merge trigger): Ctrl+Y + Shift-Mod-k →
          // terminal-safe diffDeleteLine (CM6's deleteLine eats the upper group's
          // terminal). Ctrl+K → deleteToLineEnd (emacs-style; not in defaultKeymap;
          // [pos,lineEnd) never touches a terminal).
          { key: "Ctrl-y", run: diffDeleteLine },
          { key: "Shift-Mod-k", run: diffDeleteLine },
          { key: "Ctrl-k", run: deleteToLineEnd },
        ]),
      ),
      diffNavKeymap,
      // §2.2.15 — Ctrl+[ / Ctrl+] jump to the prev/next conflict (toolbar ↑/↓ equivalent).
      // Return false when there's none → the key falls through.
      keymap.of([
        { key: "Ctrl-[", run: (v) => gotoAdjacentConflict(v, false) },
        { key: "Ctrl-]", run: (v) => gotoAdjacentConflict(v, true) },
      ]),
      diffClipboardCopy, // §2.2.7 — copy a group-spanning selection as a fenced block
      diffClipboardPaste, // §2.2.7 п.3a — paste fenced groups into normal → materialize + cascade
      // §2.2.17 / TODO §15 — Mod+F open, Esc close, and BOTH find-again pairs next/prev:
      // Mod+G / Shift+Mod+G AND F3 / Shift+F3. The F3 pair already ships inside searchKeymap
      // (@codemirror/search 6.5.6, the pinned version — scope "editor search-panel" is active
      // in the editor too), so no extra binding is needed; search-gate.test.ts locks it.
      // HISTORY-DELETED.md §4.6 relies on F3 for phrase carry-over.
      keymap.of(searchKeymap),
      configureSearchPanel, // TODO §15/§17 — hotkey tooltips on << / >>; hide dead [All]
      keymap.of([...historyKeymap, ...defaultKeymap]),
      // §1.11 / TODO §6.9 — draw the selection ourselves so its background extends
      // to the END of the line, INCLUDING the trailing `↵` glyph widget (native
      // browser selection stops at the text content and leaves the ↵ outside).
      drawSelectionComp.of(drawSelection()), // bug-45/46 — rebuilt per Shift gesture
      EditorView.lineWrapping,
      // §2.2.6 п.7c/п.7f — mouse drag selection. ONE style for EVERY left single drag, so
      // a drag that ENDS on a marker (7c.i/ii) is caught even when it STARTED on content.
      // A drag resolves both endpoints to zones (marker block-widget → its zone; else text
      // pos) and feeds mouseDragSelection → legalizeSelection (keyboard mirror). A clean
      // click (no move) is left to the DOM `click` handlers (marker glyph → caret, button →
      // resolve); on content it just places the caret. detail>1 (double/triple) → null so
      // CM6 keeps word/line select.
      EditorView.mouseSelectionStyle.of((view, startEvent) => {
        if (startEvent.button !== 0 || startEvent.detail > 1) return null;
        const start = zoneAt(view, startEvent.clientX, startEvent.clientY);
        const sx = startEvent.clientX;
        const sy = startEvent.clientY;
        return {
          get: (event: MouseEvent) => {
            const moved = Math.abs(event.clientX - sx) > 2 || Math.abs(event.clientY - sy) > 2;
            if (!moved) {
              return start.kind === "marker"
                ? view.state.selection // clean marker click → DOM `click` does caret/resolve
                : EditorSelection.single(start.pos); // clean content click → caret
            }
            const cur = zoneAt(view, event.clientX, event.clientY);
            const sel = mouseDragSelection(start, cur, readStructure(view.state));
            return sel ? EditorSelection.single(sel.anchor, sel.head) : view.state.selection;
          },
          update: () => false,
        };
      }),
      // §0.5.6 step-2 — live history feed (optional; off in pure-CM6 unit tests). Guard on
      // `sink` (not `hooks`) so a config-only hooks — e.g. {config:{touchOnly}} — is valid.
      ...(hooks?.sink && hooks.flag ? [historyFeedListener(hooks.sink, hooks.flag)] : []),
      // P6.3 — cursor-cadence tap (§2.9), separate from the history feed.
      ...(hooks?.onActivity ? [cursorCadenceListener(hooks.onActivity)] : []),
      // §2.2.15 — toolbar live-refresh tap (count + disabled states).
      ...(hooks?.onUpdate
        ? [
            EditorView.updateListener.of((u) => {
              if (u.docChanged || u.selectionSet) hooks.onUpdate!();
            }),
          ]
        : []),
      // bug-56 monitoring — permanent undo/redo depth/length log.
      ...(hooks?.onUndoRedo ? [undoRedoLogListener(hooks.onUndoRedo)] : []),
    ],
  });
}

// Mount a DiffPane into `parent` and return the view. (Geometry validated by the
// 1a gate; full browser validation of THIS bundled module is the device gate.)
export function mountDiffPaneV2(
  parent: HTMLElement,
  base: string,
  sibling: string,
  hooks?: DiffPaneV2Hooks,
): EditorView {
  const view = new EditorView({ state: createDiffPaneState(base, sibling, hooks), parent });
  // §2.2.14 — touch-only suppresses the mobile soft keyboard via inputmode="none". The
  // editor stays focusable (contentEditable=true) so selection / Ctrl+C / undo-redo still
  // work; the edits themselves are blocked by the changeFilter, not by editability.
  if (hooks?.config?.touchOnly) view.contentDOM.inputMode = "none";
  return view;
}
