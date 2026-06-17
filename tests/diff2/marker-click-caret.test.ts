// @vitest-environment happy-dom
//
// §2.2.4.9 mouse/tap entry into a ver-block: clicking the <<<<< / >>>>> marker glyph
// drops the caret INTO ver1 / ver2 — the ONLY way to reach an EMPTY ver-block (it's
// collapsed/height:0, so not directly clickable). open → ver1 first line col 0 (as
// [down] from above); close → ver2 last content line col 0 (as [up] from below);
// empty block → its caret slot (focus expands it).

import { afterEach, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { buildModel } from "../../src/diff2/diff-model";
import { mountDiffPaneV2, verBlockCaretTarget } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";

function model(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  return { doc: Text.of(m.doc.split("\n")), ranges: m.ranges };
}

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

const tap = (el: Element) =>
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

describe("verBlockCaretTarget (pure)", () => {
  it("ver1 → first line col 0 (= ver1.from)", () => {
    const { doc, ranges } = model("a\nL1\nL2\nc\n", "a\nR1\nR2\nc\n");
    const v1 = ranges.find((r) => r.ver === 1)!;
    expect(verBlockCaretTarget(doc, ranges, v1.group, 1)).toBe(v1.from);
    expect(doc.lineAt(v1.from).text).toBe("L1"); // first content line
  });

  it("ver2 → LAST content line col 0", () => {
    const { doc, ranges } = model("a\nL1\nL2\nc\n", "a\nR1\nR2\nc\n");
    const v2 = ranges.find((r) => r.ver === 2)!;
    const target = verBlockCaretTarget(doc, ranges, v2.group, 2)!;
    expect(target).toBe(doc.lineAt(v2.to - 2).from);
    expect(doc.lineAt(target).text).toBe("R2"); // last content line, not the terminal
  });

  it("EMPTY ver-block → its caret slot (from)", () => {
    const { doc, ranges } = model("a\nb\n", "a\nX\nb\n"); // ver1 empty, ver2 "X"
    const v1 = ranges.find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1); // empty
    expect(verBlockCaretTarget(doc, ranges, v1.group, 1)).toBe(v1.from);
  });

  it("absent group/side → null", () => {
    const { doc, ranges } = model("a\nL\nc\n", "a\nR\nc\n");
    expect(verBlockCaretTarget(doc, ranges, 99, 1)).toBeNull();
  });
});

describe("marker glyph click → caret into the block", () => {
  it("<<<<< drops the caret into ver1 (first line)", () => {
    const v = mount("a\nL1\nL2\nc\n", "a\nR1\nR2\nc\n");
    tap(v.dom.querySelector(".diff2-marker-top .diff2-marker-glyph")!);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v.state.selection.main.head).toBe(v1.from);
  });

  it(">>>>> drops the caret into ver2 (last content line)", () => {
    const v = mount("a\nL1\nL2\nc\n", "a\nR1\nR2\nc\n");
    tap(v.dom.querySelector(".diff2-marker-bottom .diff2-marker-glyph")!);
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v.state.selection.main.head).toBe(v.state.doc.lineAt(v2.to - 2).from);
  });

  it("<<<<< on an EMPTY ver1 activates it (caret at its slot)", () => {
    const v = mount("a\nb\n", "a\nX\nb\n"); // ver1 EMPTY
    tap(v.dom.querySelector(".diff2-marker-top .diff2-marker-glyph")!);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1); // still empty
    expect(v.state.selection.main.head).toBe(v1.from); // caret landed in it (caretOffTerminal skips empty)
  });

  it(">>>>> on an EMPTY ver2 activates it (caret at its slot)", () => {
    const v = mount("a\nX\nb\n", "a\nb\n"); // ver2 EMPTY
    tap(v.dom.querySelector(".diff2-marker-bottom .diff2-marker-glyph")!);
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v2.to - v2.from).toBe(1);
    expect(v.state.selection.main.head).toBe(v2.from);
  });
});
