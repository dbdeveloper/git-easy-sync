// @vitest-environment happy-dom
//
// §2.2.17 — the Ctrl/Cmd+F search panel drives its own match selection (find next/prev). The
// selectionLegalizeFilter MUST skip the `select.search` userEvent, or a match that spans the
// ver1/ver2 boundary would be snapped to a whole-group selection and the highlighted match would
// jump off the found text. This pins the gate (the one real integration risk).

import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { SearchQuery, findNext, setSearchQuery } from "@codemirror/search";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";

function mount(base: string, sibling: string): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  return mountDiffPaneV2(p, base, sibling);
}

describe("§2.2.17 search — selectionLegalizeFilter gate", () => {
  it("a region-spanning select.search selection passes through UNMANGLED (control: plain select IS legalized)", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    const ranges = readStructure(v.state);
    const v1 = ranges.find((r) => r.ver === 1)!;
    const v2 = ranges.find((r) => r.ver === 2)!;
    const anchor = v1.from + 1; // inside ver1
    const head = v2.from + 1; // inside ver2 → spans the group boundary

    // CONTROL — a plain selection spanning ver1→ver2 is legalized (snapped, so it changes).
    v.dispatch({ selection: EditorSelection.range(anchor, head) });
    const plain = v.state.selection.main;
    expect(plain.anchor === anchor && plain.head === head).toBe(false);

    // GATED — the SAME selection carrying `select.search` is left exactly as the search set it.
    v.dispatch({ selection: EditorSelection.cursor(0) }); // reset
    v.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: "select.search" });
    const searched = v.state.selection.main;
    expect(searched.anchor).toBe(anchor);
    expect(searched.head).toBe(head);
  });

  it("a single-region select.search match is preserved too", () => {
    const v = mount("x\nAAAAAA\ny\n", "x\nBBB\ny\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    const anchor = v1.from + 1;
    const head = v1.from + 4; // wholly inside ver1 — a literal single-line match
    v.dispatch({ selection: EditorSelection.range(anchor, head), userEvent: "select.search" });
    expect(v.state.selection.main.anchor).toBe(anchor);
    expect(v.state.selection.main.head).toBe(head);
  });

  it("a real findNext lands the selection exactly on the literal match (inside a ver-block)", () => {
    const v = mount("x\nFINDME\ny\n", "x\nother\ny\n");
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "FINDME" })) });
    findNext(v);
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe("FINDME"); // the match, NOT the whole group
  });
});
