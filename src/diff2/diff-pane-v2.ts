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
  Transaction,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
import { type MarkerKind, markerSpecs, verLineDecisions } from "./diff-decorations";
import { autoNewlineFilter, diffBackspace, diffDelete, externalGuardFilter } from "./diff-edits";
import { groupsOf, selectionLegalizeFilter } from "./diff-selection";
import { computeWordDiff } from "./word-level-diff";
import { diffLineNumbers } from "./diff-line-numbers";
import { type ResolveChoice, type ResolveOpts, applyResolve, diffResolveKeymap } from "./diff-resolve";
import { type HistorySink, type ReplayFlag, historyFeedListener } from "./history-feed";
import type { CursorActivity } from "./cursor-timer";
import type Logger from "../logger";

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
  // TEMP diagnostic (bug: last-group EOL-less [Delete] reported broken in Obsidian
  // but works in happy-dom + real Chromium). When set, a keydown handler logs the
  // last diff-group's ver1/ver2 content + caret before & after EVERY keystroke.
  logger?: Logger;
}

// TEMP diagnostic — last diff-group ver1/ver2 snapshot for the keydown logger.
function lastGroupSnapshot(state: EditorState): string {
  const ranges = readStructure(state);
  if (ranges.length === 0) return "no-ranges";
  const head = state.selection.main.head;
  const lg = Math.max(...ranges.map((r) => r.group));
  const v1 = ranges.find((r) => r.group === lg && r.ver === 1);
  const v2 = ranges.find((r) => r.group === lg && r.ver === 2);
  // Where is the caret RELATIVE to a block? terminal = head===to-1 (the protected
  // \n the caret must never rest on); content-end = head===to-2 (just before it,
  // where Delete should strip the trailing \n); inside / from / outside otherwise.
  const where = (r?: VerRange): string => {
    if (!r) return "-";
    if (head < r.from || head > r.to) return "outside";
    if (head === r.to - 1) return "ON-TERMINAL"; // Delete blocked here
    if (head === r.to - 2) return "content-end"; // Delete strips trailing \n here
    if (head === r.from) return "from";
    return `inside(+${head - r.from})`;
  };
  const desc = (r?: VerRange) =>
    r ? `[${r.from},${r.to})=${JSON.stringify(state.doc.sliceString(r.from, r.to))} caret:${where(r)}` : "none";
  const ln = state.doc.lineAt(head);
  return `head=${head} (line ${ln.number} "${ln.text}") g=${lg} | v1=${desc(v1)} | v2=${desc(v2)}`;
}

// TEMP diagnostic — keydown OBSERVER that logs the last group around every key.
// Observers (not handlers) fire for EVERY event regardless of whether a keymap
// consumes it — so Backspace/Delete/Enter (eaten by the higher-prec keymaps) are
// captured too, unlike a plain domEventHandler.
function diffDebugKeyListener(logger: Logger): Extension {
  return EditorView.domEventObservers({
    keydown: (e, view) => {
      const key = e.key;
      if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return;
      logger.info("diff2-key BEFORE", { key, snap: lastGroupSnapshot(view.state) });
      // log the resulting state after CM6 processes the key (post keymap + filters)
      setTimeout(() => {
        try {
          logger.info("diff2-key AFTER ", { key, snap: lastGroupSnapshot(view.state) });
        } catch {
          /* view may be torn down */
        }
      }, 0);
    },
  });
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
    { label: "Join ↓↓", choice: "join", hotkey: "Ctrl-Shift-." }, // desc built from remoteLabel
  ],
  close: [
    { label: "Apply ↑", choice: "keep2", hotkey: "Ctrl-Enter", desc: "Apply this remote change" },
    { label: "Remove ↑", choice: "keep1", hotkey: "Ctrl-Backspace", desc: "Remove this remote change" },
  ],
};

class MarkerWidget extends WidgetType {
  // Duck-type tag read by diff-line-numbers.ts's gutter widgetMarker for the #3
  // marker-row gutter tint, WITHOUT importing this class (which would cycle).
  readonly diff2MarkerKind: MarkerKind;
  constructor(
    readonly kind: MarkerKind,
    readonly group: number,
    readonly config: DiffViewConfig,
  ) {
    super();
    this.diff2MarkerKind = kind;
  }
  eq(other: MarkerWidget): boolean {
    return (
      other.kind === this.kind &&
      other.group === this.group &&
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

    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent = MARKER_GLYPH[this.kind];
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

// §1.6.a.1 — a ghost `↵` after a ver line's content marking its real newline
// (line-wrap is always on, so this disambiguates a hard break from a soft wrap).
// Ported from §1 markers/decorations as a WIDGET (the §1 visual layer the user
// asked to reuse): the class `diff2-newline-glyph` is tinted to the side colour by
// styles.css. A line CLASS won't render it (no ::after) — it must be a widget.
class NewlineGlyphWidget extends WidgetType {
  eq(): boolean {
    return true; // identical instances → CM6 reuses the DOM
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "diff2-newline-glyph";
    el.textContent = "↵";
    return el;
  }
}
const newlineGlyph = new NewlineGlyphWidget();
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
  for (const m of markerSpecs(state.doc, ranges)) {
    all.push(
      Decoration.widget({
        widget: new MarkerWidget(m.kind, m.group, config),
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
    all.push(Decoration.line({ class: cls.join(" ") }).range(d.from));
    // §1.6.a.1 ↵ at the end of the line's CONTENT (before the real `\n`).
    if (d.glyph) {
      all.push(Decoration.widget({ widget: newlineGlyph, side: 1 }).range(state.doc.line(d.line).to));
    }
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
      // §2.2.9 marker-button clicks are wired as DIRECT listeners in MarkerWidget.
      // toDOM (the §1 pattern) — the old domEventHandlers delegation didn't fire
      // for block-widget buttons (bug: buttons didn't resolve).
      diffResolveKeymap(resolveOpts), // §1.9 hotkeys — resolve current group (Ctrl-Enter etc.)
      // §2.2.4(6,7)/§2.2.5 — boundary Backspace/Delete consumed (caret stays put);
      // Prec.high so it beats defaultKeymap's deleteChar*. Returns false off-boundary.
      Prec.high(
        keymap.of([
          { key: "Backspace", run: diffBackspace },
          { key: "Delete", run: diffDelete },
        ]),
      ),
      diffNavKeymap,
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
      // TEMP diagnostic keydown logger (bug: last-group EOL-less Delete).
      ...(hooks?.logger ? [diffDebugKeyListener(hooks.logger)] : []),
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
