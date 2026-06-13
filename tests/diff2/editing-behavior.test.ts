// @vitest-environment happy-dom
//
// EMPIRICAL editing-behavior probe (§2.2.4 boundary rules + §2.2.5 external guard
// + empty↔non-empty transitions). Drives the REAL keymap commands
// (deleteCharBackward = Backspace, deleteCharForward = Delete, typed inserts)
// through the REAL createDiffPaneState pipeline in happy-dom and asserts the
// resulting doc + structure — so the filters are tested as the user experiences
// them, not just their pure helpers. Observed behavior, not derivation.

import { afterEach, describe, expect, it } from "vitest";
import { deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";

const parents: HTMLElement[] = [];
function mount(base: string, sibling: string): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling);
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

const at = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });
const type = (v: EditorView, pos: number, s: string) =>
  v.dispatch({ changes: { from: pos, insert: s }, selection: { anchor: pos + s.length }, userEvent: "input.type" });

// conflict A: base "a\nL\nc\n" vs sibling "a\nR\nc\n"
//   doc "a\nL\n\nR\n\nc\n": a0 \n1 L2 \n3 \n4 R5 \n6 \n7 c8 \n9
//   ver1 [2,5) "L\n\n" (content "L\n", terminal idx4); ver2 [5,8) "R\n\n" (terminal idx7)
describe("§2.2.4/§2.2.5 boundary protection (real keymap commands)", () => {
  it("Backspace at the group's leading boundary does NOT delete the separator \\n (§2.2.4.6/§2.2.5.1)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 2); // ver1.from — caret at start of "L"
    deleteCharBackward(v);
    expect(v.state.doc.toString()).toBe(before); // separator \n at idx1 survives
    expect(readStructure(v.state).length).toBe(2); // group intact
  });

  it("Delete on the normal line before the group does NOT delete the separator \\n (§2.2.5.1)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 1); // end of "a", before the separator \n
    deleteCharForward(v);
    expect(v.state.doc.toString()).toBe(before);
  });

  it("Backspace at ver2.from does NOT delete ver1's terminal \\n (§2.2.4.6)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 5); // ver2.from == ver1.to
    deleteCharBackward(v);
    expect(v.state.doc.toString()).toBe(before);
    expect(readStructure(v.state).length).toBe(2);
  });

  it("Delete at a ver-block terminal \\n is blocked (§2.2.4.7)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 4); // ver1 terminal idx
    deleteCharForward(v);
    expect(v.state.doc.toString()).toBe(before);
  });

  it("Backspace on the normal line after the group does NOT delete ver2's terminal \\n (§2.2.5.2)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 8); // start of "c" (== ver2.to)
    deleteCharBackward(v);
    expect(v.state.doc.toString()).toBe(before);
  });
});

// conflict B: base "a\nb\n" vs sibling "a\nX\nb\n"
//   doc "a\n\nX\n\nb\n": ver1 [2,3) "\n" EMPTY; ver2 [3,6) "X\n\n"
describe("§2.2.4 empty ↔ non-empty ver-block transitions", () => {
  it("typing into an empty ver-block grows it to a valid '.*\\n\\n' (§2.2.4.1,2)", () => {
    const v = mount("a\nb\n", "a\nX\nb\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1); // empty
    at(v, v1.from);
    type(v, v1.from, "w");
    const nv1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v.state.doc.sliceString(nv1.from, nv1.to)).toBe("w\n\n"); // content "w\n" + terminal
  });

  it("deleting ALL content (selection) collapses the block to the empty '\\n', NOT '\\n\\n' (§2.2.4.4/8)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!; // [2,5) content "L\n"
    v.dispatch({ changes: { from: v1.from, to: v1.to - 1 }, selection: { anchor: v1.from } });
    const nv1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(nv1.to - nv1.from).toBe(1); // collapsed to empty "\n"
    expect(v.state.doc.sliceString(nv1.from, nv1.to)).toBe("\n");
  });

  it("Backspacing the content down to empty lands on '\\n' (not stuck at '\\n\\n')", () => {
    const v = mount("a\nX\nb\n", "a\nb\n"); // ver1 non-empty "X\n\n", ver2 empty
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!; // content "X\n"
    // caret after "X" (content char), backspace twice to clear content
    at(v, v1.from + 1);
    deleteCharBackward(v); // delete "X"
    let cur = readStructure(v.state).find((r) => r.ver === 1)!;
    // keep backspacing the remaining content \n until only the terminal remains
    at(v, cur.from);
    deleteCharForward(v); // delete the content \n (forward, not the terminal)
    cur = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(cur.to - cur.from).toBe(1); // empty "\n"
    expect(v.state.doc.sliceString(cur.from, cur.to)).toBe("\n");
  });
});
