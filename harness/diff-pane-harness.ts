// Browser-MCP observation harness for the V2 diff-pane (DIFF-EDITOR-V2 §2.2.6 п.7e
// keyboard selection motion). happy-dom cannot simulate CM6 moveVertically geometry
// / Shift+arrow landing, so we mount the REAL pane in a real Chromium (via browser
// MCP) and observe where the caret actually lands. NOT shipped — a dev observation
// tool. Build: pnpm exec esbuild harness/diff-pane-harness.ts --bundle --format=iife
// --outfile=harness/diff-pane-harness.js
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2, scrollToConflict, touchOnlyComp, wordLevelComp } from "../src/diff2/diff-pane-v2";
import { readStructure, touchOnlyFacet, wordLevelFacet } from "../src/diff2/diff-structure";
import { groupsOf } from "../src/diff2/diff-selection";
import { copyClipboardText } from "../src/diff2/diff-clipboard";
import { renderDiffToolbar } from "../src/diff2/diff-toolbar";

let view: EditorView;

const H = {
  // (re)mount with the given base/sibling; returns the structure for confirmation.
  // touchOnly=true → §2.2.14 read-only mode (config-only hooks).
  mount(base: string, sibling: string, touchOnly = false, wordLevel = false) {
    const root = document.getElementById("editor")!;
    root.innerHTML = "";
    const host = document.createElement("div");
    host.className = "diff2-edit-view-root";
    root.appendChild(host);
    view = mountDiffPaneV2(
      host,
      base,
      sibling,
      touchOnly || wordLevel
        ? {
            config: {
              localLabel: "local",
              remoteLabel: "remote",
              date: "",
              isMarkdown: true,
              touchOnly,
              wordLevelDiff: wordLevel,
            },
          }
        : undefined,
    );
    view.focus();
    return H.struct();
  },
  setCaret(pos: number) {
    view.dispatch({ selection: EditorSelection.cursor(pos) });
    view.focus();
    return H.sel();
  },
  setSel(anchor: number, head: number) {
    view.dispatch({ selection: EditorSelection.range(anchor, head) });
    view.focus();
    return H.sel();
  },
  sel() {
    const s = view.state.selection.main;
    return { anchor: s.anchor, head: s.head, from: s.from, to: s.to };
  },
  struct() {
    return readStructure(view.state).map((r) => ({ from: r.from, to: r.to, ver: r.ver, group: r.group }));
  },
  doc() {
    return view.state.doc.toString();
  },
  copy() {
    return copyClipboardText(view.state);
  },
  focus() {
    view.focus();
  },
  // §2.2.15 — live mode reconfigure (the owner does this from the toolbar).
  setTouch(on: boolean) {
    view.dispatch({ effects: touchOnlyComp.reconfigure(touchOnlyFacet.of(on)) });
  },
  setWord(on: boolean) {
    view.dispatch({ effects: wordLevelComp.reconfigure(wordLevelFacet.of(on)) });
  },
  // diagnostic — does scrollToConflict(firstGroup.from) throw? returns the resulting selection.
  testScroll() {
    try {
      const g = groupsOf(readStructure(view.state))[0];
      scrollToConflict(view, g.from);
      return { ok: true, target: g.from, sel: H.sel(), scrollTop: Math.round(view.scrollDOM.scrollTop) };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  },
  // §2.2.15 — render JUST the toolbar (in a .diff2-detail-toolbar container, as DiffEditView
  // does) so its layout can be screenshotted with the real styles.css. `count` drives NNN.
  toolbar(count = 4) {
    const root = document.getElementById("editor")!;
    root.innerHTML = "";
    // wrap in .diff2-edit-view-root — it defines the --diff2-* colour vars (as the real view does)
    const viewRoot = document.createElement("div");
    viewRoot.className = "diff2-edit-view-root";
    root.appendChild(viewRoot);
    const tb = document.createElement("div");
    tb.className = "diff2-detail-toolbar";
    viewRoot.appendChild(tb);
    const noop = () => {};
    const h = renderDiffToolbar(
      tb,
      { localLabel: "Macbook", remoteLabel: "Pixel 6", isMarkdown: true, touchOn: false, autoFocusOn: true, diffMode: "characters" },
      {
        onBack: noop, onKeepAll: noop, onApplyAll: noop, onJoinAll: noop,
        onPrev: noop, onNext: noop, onUndo: noop, onRedo: noop,
        onToggleTouch: noop, onToggleAutoFocus: noop, onSetDiffMode: noop,
      },
    );
    h.update({ conflictCount: count, hasPrev: false, hasNext: true, canUndo: true, canRedo: false });
  },
  // observe the RAW native moveVertically landing (no dispatch) — to design motion.
  peek(forward: boolean) {
    const cur = view.state.selection.main;
    return { anchor: cur.anchor, head: cur.head, native: view.moveVertically(cur, forward).head };
  },
};
(window as unknown as { H: typeof H }).H = H;
