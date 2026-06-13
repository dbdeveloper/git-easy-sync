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
  Prec,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { buildModel } from "./diff-model";
import {
  cursorHistory,
  cursorVertTarget,
  readStructure,
  resolveCaret,
  structureField,
  structureHistory,
  terminalProtectionFilter,
  toRangeSet,
} from "./diff-structure";
import { type MarkerKind, markerSpecs, verLineDecisions } from "./diff-decorations";
import { autoNewlineFilter, externalGuardFilter } from "./diff-edits";
import { selectionLegalizeFilter } from "./diff-selection";
import { diffLineNumbers } from "./diff-line-numbers";
import { type ResolveChoice, type ResolveOpts, diffResolveKeymap, resolveClickHandler } from "./diff-resolve";
import { type HistorySink, type ReplayFlag, historyFeedListener } from "./history-feed";
import type { CursorActivity } from "./cursor-timer";

// §0.5.6 step-2 — OPTIONAL persistence wiring. When the owner (Phase-6 DiffPaneOwner)
// supplies a sink + the SHARED ReplayFlag, a historyFeedListener is appended so
// every live transaction is fed to history.jsonl. Omitted in pure-CM6 unit tests,
// so the render/nav/resolution spine stays testable without a vault.
export interface DiffPaneV2Hooks {
  sink: HistorySink;
  flag: ReplayFlag; // SAME instance the owner passes to replayWithGuard
  // P6.3 — join deviceLabel/date threaded into the in-editor diff-group buttons
  // (resolveClickHandler) and the resolve hotkeys (diffResolveKeymap) so a "Join"
  // produces the `> Changes from <label> at <date>` header. Undefined → defaults.
  resolveOpts?: ResolveOpts;
  // P6.3 — cursor-cadence tap (§2.9). historyFeedListener does NOT poke the
  // cursor timer (it only records edits), so a SEPARATE listener calls this on
  // every transaction: docChanged → "typing", pure caret move → "nav". The owner
  // gates it on !flag.replaying so a replay's re-dispatches don't schedule flushes.
  onActivity?: (activity: CursorActivity) => void;
}

// ── markers ────────────────────────────────────────────────────────────────
const MARKER_GLYPH: Record<MarkerKind, string> = {
  open: "≪",
  mid: "==",
  close: "≫",
};

// Resolution buttons per marker row (§1.9 / TODO #6.3). `↓`/`↑` hint which side
// the action acts on. Each maps to a ResolveChoice handled by resolveClickHandler.
const MARKER_BUTTONS: Record<MarkerKind, { label: string; choice: ResolveChoice }[]> = {
  open: [
    { label: "Keep ↓", choice: "keep1" }, // keep ver1 (ours)
    { label: "Remove ↓", choice: "keep2" }, // drop ver1 → keep ver2
  ],
  mid: [
    { label: "Apply Both ↓↑", choice: "both" },
    { label: "Remove Both ↓↑", choice: "neither" },
    { label: "Join", choice: "join" },
  ],
  close: [
    { label: "Apply ↑", choice: "keep2" }, // keep ver2 (theirs)
    { label: "Remove ↑", choice: "keep1" }, // drop ver2 → keep ver1
  ],
};

class MarkerWidget extends WidgetType {
  constructor(
    readonly kind: MarkerKind,
    readonly group: number,
  ) {
    super();
  }
  eq(other: MarkerWidget): boolean {
    return other.kind === this.kind && other.group === this.group;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `diff2-marker diff2-marker-${this.kind}`;
    const glyph = document.createElement("span");
    glyph.className = "diff2-marker-glyph";
    glyph.textContent = MARKER_GLYPH[this.kind];
    el.appendChild(glyph);
    for (const b of MARKER_BUTTONS[this.kind]) {
      const btn = document.createElement("button");
      btn.className = "diff2-marker-btn";
      btn.textContent = b.label;
      btn.setAttribute("data-diff2-resolve", b.choice);
      btn.setAttribute("data-diff2-group", String(this.group));
      el.appendChild(btn);
    }
    return el;
  }
  get estimatedHeight(): number {
    return 18;
  }
}

// ── decorations ──────────────────────────────────────────────────────────────
// Build the CM6 DecorationSet from the pure §2.2.8/§2.2.2 decisions. Markers are
// block widgets (side from markerSpecs); ver lines get a colour class +
// `diff2-collapsed` (height:0) + `diff2-eol-glyph` (CSS renders the `↵`).
export function buildDecorations(state: EditorState): DecorationSet {
  const ranges = readStructure(state);
  const caret = state.selection.main.head;
  const all = [];
  for (const m of markerSpecs(state.doc, ranges)) {
    all.push(
      Decoration.widget({
        widget: new MarkerWidget(m.kind, m.group),
        block: true,
        side: m.side,
      }).range(m.pos),
    );
  }
  for (const d of verLineDecisions(state.doc, ranges, caret)) {
    const cls = [d.ver === 1 ? "diff2-v1" : "diff2-v2"];
    if (d.collapsed) cls.push("diff2-collapsed");
    if (d.glyph) cls.push("diff2-eol-glyph");
    all.push(Decoration.line({ class: cls.join(" ") }).range(d.from));
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

export const diffNavKeymap: Extension = Prec.highest(
  keymap.of([
    { key: "ArrowDown", run: (v) => vertical(v, true) },
    { key: "ArrowUp", run: (v) => vertical(v, false) },
  ]),
);

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
  return EditorState.create({
    doc: m.doc,
    extensions: [
      diffLineNumbers, // §2.2.10 per-side −/+ gutter (replaces lineNumbers())
      history(),
      structureField.init(() => toRangeSet(m.ranges)),
      structureHistory, // version the structure field across undo/redo (resolution)
      cursorHistory, // §2.2.9 carry the resolveCaret marker across undo/redo
      cursorRestoreListener, // §2.2.9 apply before/after caret on undo/redo
      decorationsField,
      terminalProtectionFilter,
      externalGuardFilter, // §2.2.5(1) — changeFilter (runs before transactionFilters)
      autoNewlineFilter, // §2.2.4(2) — transactionFilter (appends normalization)
      selectionLegalizeFilter, // §2.2.4(5)/§2.2.6 — transactionFilter (legalize selection)
      resolveClickHandler(hooks?.resolveOpts), // §2.2.9 marker-button clicks (join deviceLabel/date)
      diffResolveKeymap(hooks?.resolveOpts), // §1.9 hotkeys — resolve current group (Mod-Enter etc.)
      diffNavKeymap,
      keymap.of([...historyKeymap, ...defaultKeymap]),
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
