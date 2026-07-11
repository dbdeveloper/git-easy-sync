// @vitest-environment happy-dom
//
// §2.2.17 — the Ctrl/Cmd+F search panel drives its own match selection (find next/prev). The
// selectionLegalizeFilter MUST skip the `select.search` userEvent, or a match that spans the
// ver1/ver2 boundary would be snapped to a whole-group selection and the highlighted match would
// jump off the found text. This pins the gate (the one real integration risk).

import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { SearchQuery, findNext, openSearchPanel, setSearchQuery } from "@codemirror/search";
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

// TODO §15 — F3 / Shift+F3 find-again keys. The keymap runs findNext/findPrevious (pure
// state, no view geometry → works under happy-dom, unlike Shift-motion). Behavioural: with
// a query set, F3 cycles matches forward, Shift+F3 backward. Falls through (no-op) when no
// query is active.
describe("§2.2.17 / TODO §15 — F3 / Shift+F3 next/prev", () => {
  function press(v: EditorView, key: string, shift = false): void {
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key, code: key, shiftKey: shift, bubbles: true, cancelable: true }),
    );
  }

  it("F3 advances forward through matches; Shift+F3 goes back", () => {
    // Three "FOO" matches on one ver1 line; findNext wraps, so relative motion is what matters.
    const v = mount("x\nFOO a FOO b FOO\ny\n", "x\nother\ny\n");
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "FOO" })) });

    press(v, "F3");
    const first = v.state.selection.main.from;
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe("FOO");

    press(v, "F3");
    const second = v.state.selection.main.from;
    expect(second).toBeGreaterThan(first); // moved forward to the next match

    press(v, "F3", true); // Shift+F3 → back to the first
    expect(v.state.selection.main.from).toBe(first);
  });

  it("F3 with no active query is a no-op (selection unchanged)", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    v.dispatch({ selection: EditorSelection.cursor(0) });
    press(v, "F3");
    expect(v.state.selection.main.from).toBe(0);
  });

  it("opening the search panel tags the << / >> buttons with their F3 hotkeys", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    openSearchPanel(v);
    const panel = v.dom.querySelector(".cm-search")!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('button[name="next"]')?.getAttribute("title")).toBe(
      "Next match (F3)",
    );
    expect(panel.querySelector('button[name="prev"]')?.getAttribute("title")).toBe(
      "Previous match (⇧F3)",
    );
  });

  it("hides the [All] button (selectMatches is a dead multi-cursor control here)", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    openSearchPanel(v);
    const selectAll = v.dom.querySelector('.cm-search button[name="select"]') as HTMLElement | null;
    expect(selectAll).not.toBeNull(); // still in the DOM (default panel) …
    expect(selectAll!.style.display).toBe("none"); // … but hidden
  });
});

// §2.2.17 — the opt-in "replace" checkbox. Replace is rare in a conflict editor, so the whole
// replace row is CSS-hidden until this box is ticked (and the editor is editable). The box drives
// no CM6 state — only the `.diff2-replace-on` class on the panel that the CSS keys off.
describe("§2.2.17 — opt-in 'replace' checkbox", () => {
  it("opening the panel injects an unchecked 'replace' box right after the 'by word' toggle", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    openSearchPanel(v);
    const panel = v.dom.querySelector(".cm-search")!;
    const toggle = panel.querySelector(".diff2-replace-toggle");
    expect(toggle).not.toBeNull();
    // positioned immediately after the "by word" label
    const wordLabel = panel.querySelector('[name="word"]')!.closest("label")!;
    expect(wordLabel.nextElementSibling).toBe(toggle);
    // its checkbox is unchecked, and the panel is not yet in replace mode
    const cb = toggle!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(panel.classList.contains("diff2-replace-on")).toBe(false);
  });

  it("carries NO name attr (must not collide with the [name=\"replace\"] hide selector)", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    openSearchPanel(v);
    const cb = v.dom.querySelector('.diff2-replace-toggle input[type="checkbox"]') as HTMLInputElement;
    expect(cb.getAttribute("name")).toBeNull();
  });

  it("ticking the box toggles .diff2-replace-on on the panel (drives the CSS gate)", () => {
    const v = mount("x\nAAA\ny\n", "x\nBBB\ny\n");
    openSearchPanel(v);
    const panel = v.dom.querySelector(".cm-search")!;
    const cb = panel.querySelector('.diff2-replace-toggle input[type="checkbox"]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    expect(panel.classList.contains("diff2-replace-on")).toBe(true);
    cb.checked = false;
    cb.dispatchEvent(new Event("change"));
    expect(panel.classList.contains("diff2-replace-on")).toBe(false);
  });
});
