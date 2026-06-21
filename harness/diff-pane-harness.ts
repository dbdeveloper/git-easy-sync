// Browser-MCP observation harness for the V2 diff-pane (DIFF-EDITOR-V2 §2.2.6 п.7e
// keyboard selection motion). happy-dom cannot simulate CM6 moveVertically geometry
// / Shift+arrow landing, so we mount the REAL pane in a real Chromium (via browser
// MCP) and observe where the caret actually lands. NOT shipped — a dev observation
// tool. Build: pnpm exec esbuild harness/diff-pane-harness.ts --bundle --format=iife
// --outfile=harness/diff-pane-harness.js
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../src/diff2/diff-pane-v2";
import { readStructure } from "../src/diff2/diff-structure";
import { copyClipboardText } from "../src/diff2/diff-clipboard";

let view: EditorView;

const H = {
  // (re)mount with the given base/sibling; returns the structure for confirmation.
  mount(base: string, sibling: string) {
    const root = document.getElementById("editor")!;
    root.innerHTML = "";
    const host = document.createElement("div");
    host.className = "diff2-edit-view-root";
    root.appendChild(host);
    view = mountDiffPaneV2(host, base, sibling);
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
  // observe the RAW native moveVertically landing (no dispatch) — to design motion.
  peek(forward: boolean) {
    const cur = view.state.selection.main;
    return { anchor: cur.anchor, head: cur.head, native: view.moveVertically(cur, forward).head };
  },
};
(window as unknown as { H: typeof H }).H = H;
