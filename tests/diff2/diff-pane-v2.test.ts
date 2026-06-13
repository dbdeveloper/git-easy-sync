// @vitest-environment happy-dom
//
// Phase 3 — V2 DiffPane view assembly. State-level: the decorations field
// assembles markers + ver-line classes from the decision functions. Mount-level
// (happy-dom): the extension bundle composes + renders without error and applies
// the classes to the DOM. (Real geometry — height:0=0px, marker non-stealing,
// nav — is the 1a Chromium gate; happy-dom has no layout.)

import { describe, expect, it } from "vitest";
import { createDiffPaneState, decorationsField, mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { redo, undo } from "@codemirror/commands";
import {
  applyResolve,
  applyResolveAll,
  createBulkToolbar,
  resolveCurrentGroup,
} from "../../src/diff2/diff-resolve";

interface Deco {
  from: number;
  isWidget: boolean;
  cls?: string;
  kind?: string;
}

function readDecos(state: ReturnType<typeof createDiffPaneState>): Deco[] {
  const set = state.field(decorationsField);
  const out: Deco[] = [];
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as { class?: string; widget?: { kind?: string } };
    out.push({ from: it.from, isWidget: !!spec.widget, cls: spec.class, kind: spec.widget?.kind });
    it.next();
  }
  return out;
}

describe("diff-pane-v2 — decorations field assembly", () => {
  // base "a\nL1\nb\n" vs "a\nR1\nb\n" ⇒ doc "a\nL1\n\nR1\n\nb\n"
  //   line2 "L1" ver1 content, line3 "" ver1 terminal, line4 "R1" ver2 content,
  //   line5 "" ver2 terminal, line6 "b" normal.
  const state = createDiffPaneState("a\nL1\nb\n", "a\nR1\nb\n");

  it("emits open/mid/close marker widgets for the group", () => {
    // filter to the MARKER widgets (kind set); the ↵ newline widgets have no kind.
    const widgets = readDecos(state).filter((d) => d.isWidget && d.kind);
    expect(widgets.map((w) => w.kind).sort()).toEqual(["close", "mid", "open"]);
  });

  it("ver content lines get the side colour band; bare terminal lines collapse", () => {
    const lines = readDecos(state).filter((d) => !d.isWidget && d.cls?.startsWith("diff2-line-"));
    const byFrom = Object.fromEntries(lines.map((l) => [l.from, l.cls]));
    // offsets: L1 line.from=2, ver1 terminal line.from=5, R1 line.from=6, ver2 terminal line.from=9
    expect(byFrom[2]).toContain("diff2-line-ours");
    expect(byFrom[2]).not.toContain("diff2-collapsed");
    expect(byFrom[5]).toContain("diff2-line-ours");
    expect(byFrom[5]).toContain("diff2-collapsed");
    expect(byFrom[6]).toContain("diff2-line-theirs");
    expect(byFrom[9]).toContain("diff2-collapsed");
  });

  it("a ↵ newline widget sits at the end of each ver CONTENT line (not the terminal)", () => {
    // §1.6.a.1 — ↵ widgets are non-marker widgets (no kind). For "a\nL1\n\nR1\n\nb\n"
    // they sit at the content-line ends (L1 end=4, R1 end=8), NOT the bare terminals.
    const glyphs = readDecos(state).filter((d) => d.isWidget && !d.kind).map((d) => d.from);
    expect(glyphs.sort((a, b) => a - b)).toEqual([4, 8]);
  });

  it("word-level diff marks the changed fragments on each side", () => {
    const s = createDiffPaneState("a\nhello world\nc\n", "a\nhello mars\nc\n");
    const marks = readDecos(s).filter((d) => !d.isWidget && d.cls === "diff2-word-changed");
    expect(marks.length).toBeGreaterThanOrEqual(2); // "world" (ours) + "mars" (theirs)
  });

  it("focusing an empty ver-block (caret on it) un-collapses that line", () => {
    // delete-vs-modify ⇒ empty ver1. With caret on it, its terminal line is not collapsed.
    const s0 = createDiffPaneState("a\nb\n", "a\nX\nb\n");
    const emptyFrom = 2; // doc "a\n\nX\n\nb\n": ver1 terminal \n at index 2
    const focused = s0.update({ selection: { anchor: emptyFrom } }).state;
    const line2 = readDecos(focused).find((d) => !d.isWidget && d.from === emptyFrom)!;
    expect(line2.cls).not.toContain("diff2-collapsed");
    const line2unfocused = readDecos(s0).find((d) => !d.isWidget && d.from === emptyFrom)!;
    expect(line2unfocused.cls).toContain("diff2-collapsed");
  });
});

describe("diff-pane-v2 — mounts without error (happy-dom)", () => {
  it("renders the doc + applies ver classes + marker elements to the DOM", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL1\nb\n", "a\nR1\nb\n");
    try {
      expect(view.state.doc.toString()).toBe("a\nL1\n\nR1\n\nb\n");
      expect(view.dom.querySelectorAll(".diff2-marker").length).toBe(3);
      expect(view.dom.querySelectorAll(".cm-line.diff2-line-ours").length).toBeGreaterThanOrEqual(1);
      expect(view.dom.querySelectorAll(".cm-line.diff2-line-theirs").length).toBeGreaterThanOrEqual(1);
      expect(view.dom.querySelectorAll(".cm-line.diff2-collapsed").length).toBeGreaterThanOrEqual(2);
      expect(view.dom.querySelectorAll(".diff2-newline-glyph").length).toBeGreaterThanOrEqual(2); // ↵ on L1, R1
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("marker buttons carry the resolve data-attributes; applyResolve resolves the group", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL\nc\n", "a\nR\nc\n");
    try {
      // §2.2.9 buttons present with data-diff2-resolve + data-diff2-group
      const keep = view.dom.querySelector<HTMLElement>('[data-diff2-resolve="keep1"]');
      expect(keep).not.toBeNull();
      expect(keep!.getAttribute("data-diff2-group")).toBe("0");
      expect(
        Array.from(view.dom.querySelectorAll("[data-diff2-resolve]")).map((b) =>
          b.getAttribute("data-diff2-resolve"),
        ),
      ).toEqual(expect.arrayContaining(["keep1", "keep2", "both", "neither", "join"]));
      // the action the click handler invokes (the DOM click→handler path is
      // browser-validated; the handler logic is this call).
      applyResolve(view, 0, "keep1");
      expect(view.state.doc.toString()).toBe("a\nL\nc\n"); // resolved to ver1
      expect(readStructure(view.state)).toEqual([]); // conflict gone
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("resolveCurrentGroup resolves the group the caret is in (§1.9 hotkey)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL\nc\n", "a\nR\nc\n");
    try {
      view.dispatch({ selection: { anchor: 3 } }); // caret inside the group
      expect(resolveCurrentGroup(view, "keep2")).toBe(true);
      expect(view.state.doc.toString()).toBe("a\nR\nc\n");
      expect(readStructure(view.state)).toEqual([]);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("§2.2.9 POINTER: resolve→END; undo→group start (synthesized); redo→END", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL\nc\n", "a\nR\nc\n"); // group ver1[2,5) ver2[5,8)
    try {
      view.dispatch({ selection: { anchor: 0 } }); // button click → caret is wherever (irrelevant)
      applyResolve(view, 0, "keep1", {}, "pointer"); // synthesizes caret at group start (2)
      expect(view.state.doc.toString()).toBe("a\nL\nc\n");
      expect(view.state.selection.main.head).toBe(4); // FORWARD = END of "L\n" (copy-paste)

      undo(view); // ONE undo reverts the whole resolution (selection-tx is not a history step)
      expect(view.state.doc.toString()).toBe("a\nL\n\nR\n\nc\n"); // group back
      expect(readStructure(view.state)).toHaveLength(2); // structure restored
      expect(view.state.selection.main.head).toBe(2); // BACKWARD = group start (synthesized before-sel)

      redo(view);
      expect(view.state.doc.toString()).toBe("a\nL\nc\n");
      expect(view.state.selection.main.head).toBe(4); // FORWARD again = END (NOT 0)
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("§2.2.9 KEYBOARD: resolve→END; undo→where the hotkey was pressed (NOT group start)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL\nc\n", "a\nR\nc\n"); // group [2,8)
    try {
      view.dispatch({ selection: { anchor: 3 } }); // caret INSIDE ver1-block, where user hits Ctrl+Enter
      expect(resolveCurrentGroup(view, "keep1")).toBe(true); // keyboard path
      expect(view.state.doc.toString()).toBe("a\nL\nc\n");
      expect(view.state.selection.main.head).toBe(4); // FORWARD = END of resolution

      undo(view);
      expect(view.state.doc.toString()).toBe("a\nL\n\nR\n\nc\n"); // group back
      expect(view.state.selection.main.head).toBe(3); // BACKWARD = where the hotkey fired (NOT 2)

      redo(view);
      expect(view.state.selection.main.head).toBe(4); // FORWARD = END again
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("bulk toolbar: 3 buttons; applyResolveAll resolves every group", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = mountDiffPaneV2(parent, "a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    try {
      const bar = createBulkToolbar(view);
      expect(bar.querySelectorAll(".diff2-toolbar-btn").length).toBe(3);
      applyResolveAll(view, "keep2"); // apply all remote
      expect(view.state.doc.toString()).toBe("a\nR1\nb\nR2\nc\n");
      expect(readStructure(view.state)).toEqual([]);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});
