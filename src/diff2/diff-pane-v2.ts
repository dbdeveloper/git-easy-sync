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
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateField,
  type Text,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, deleteToLineEnd, history, historyKeymap } from "@codemirror/commands";
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
  horizontalSkip,
  readStructure,
  resolveCaret,
  structureField,
  structureHistory,
  terminalProtectionFilter,
  toRangeSet,
} from "./diff-structure";
import { type MarkerKind, markerSpecs, selectionAppearance, verLineDecisions } from "./diff-decorations";
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
  sink: HistorySink;
  flag: ReplayFlag; // SAME instance the owner passes to replayWithGuard
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
}

export const DEFAULT_VIEW_CONFIG: DiffViewConfig = {
  localLabel: "local",
  remoteLabel: "remote",
  date: "",
  isMarkdown: true,
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

// Caret target for clicking a marker glyph (§2.2.4.9 mouse/tap entry into a block —
// the only way to reach an EMPTY ver-block, which is collapsed/height:0 and not
// directly clickable). open(<<<<<) → ver1's FIRST line, col 0 (as [down] from the
// normal line above); close(>>>>>) → ver2's LAST content line, col 0 (as [up] from
// the line below). An EMPTY block → its single caret slot (`from`), which focus
// expands. Returns null if the group/side is absent. Pure → unit-tested.
export function verBlockCaretTarget(
  doc: Text,
  ranges: VerRange[],
  group: number,
  ver: 1 | 2,
): number | null {
  const r = ranges.find((x) => x.group === group && x.ver === ver);
  if (!r) return null;
  if (ver === 1) return r.from; // first line col 0 (empty → the caret slot)
  return r.to - r.from <= 1 ? r.from : doc.lineAt(r.to - 2).from; // ver2 last content line col 0
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
    // §2.2.6 п.7 — translucent selection overlay (::before in styles.css) over the
    // OPAQUE marker row; full row for open/close, half-row for the split mid.
    if (this.selTop && this.selBottom) el.classList.add("diff2-marker-sel-full");
    else if (this.selTop) el.classList.add("diff2-marker-sel-top");
    else if (this.selBottom) el.classList.add("diff2-marker-sel-bottom");

    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent = MARKER_GLYPH[this.kind];
    // Click/tap the <<<<< / >>>>> glyph → move the caret INTO the block — the only
    // way to reach an EMPTY ver-block (collapsed/height:0, not directly clickable).
    // open → ver1, close → ver2; the === separator is not a target. mousedown (not
    // click) + preventDefault/stopPropagation, matching the resolve buttons (so CM6
    // doesn't move the selection first and focus is kept). Touch taps emulate
    // mousedown, so this covers tap too.
    if (this.kind === "open" || this.kind === "close") {
      const ver: 1 | 2 = this.kind === "open" ? 1 : 2;
      glyph.classList.add("diff2-marker-glyph-clickable");
      glyph.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = verBlockCaretTarget(view.state.doc, readStructure(view.state), this.group, ver);
        if (target !== null) {
          view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
          view.focus();
        }
      });
    }
    el.appendChild(glyph);

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
      // §2.2.9 — pointer resolve (caret synthesized at ver1.from). mousedown (not
      // click) so CM6 doesn't move the selection first; stopPropagation keeps the
      // event out of CM6's own handling, preventDefault avoids focus loss.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
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
  get estimatedHeight(): number {
    return 18;
  }
  // R7.8 — the marker is NOT a doc line; keep its events out of CM6's own editing/
  // selection handling (our direct button listeners do the work).
  ignoreEvent(): boolean {
    return true;
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
    const wd = computeWordDiff(ours, theirs);
    for (const s of wd.oursSpans) all.push(wordMark.range(v1.from + s.start, v1.from + s.end));
    for (const s of wd.theirsSpans) all.push(wordMark.range(v2.from + s.start, v2.from + s.end));
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

export const diffNavKeymap: Extension = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => vertical(v, true) },
    { key: "ArrowUp", run: (v) => vertical(v, false) },
    { key: "ArrowRight", run: (v) => horizontal(v, true) },
    { key: "ArrowLeft", run: (v) => horizontal(v, false) },
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
      diffLineNumbers, // §2.2.10 per-side −/+ gutter (replaces lineNumbers())
      history(),
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
      diffClipboardCopy, // §2.2.7 — copy a group-spanning selection as a fenced block
      diffClipboardPaste, // §2.2.7 п.3a — paste fenced groups into normal → materialize + cascade
      keymap.of([...historyKeymap, ...defaultKeymap]),
      // §1.11 / TODO §6.9 — draw the selection ourselves so its background extends
      // to the END of the line, INCLUDING the trailing `↵` glyph widget (native
      // browser selection stops at the text content and leaves the ↵ outside).
      drawSelection(),
      EditorView.lineWrapping,
      // §0.5.6 step-2 — live history feed (optional; off in pure-CM6 unit tests).
      ...(hooks ? [historyFeedListener(hooks.sink, hooks.flag)] : []),
      // P6.3 — cursor-cadence tap (§2.9), separate from the history feed.
      ...(hooks?.onActivity ? [cursorCadenceListener(hooks.onActivity)] : []),
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
  return new EditorView({ state: createDiffPaneState(base, sibling, hooks), parent });
}
