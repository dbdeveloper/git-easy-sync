// @vitest-environment happy-dom
//
// Every gesture that should (or must NOT) trigger a group merge, driven through
// the real keymap / commands — the cases the user hit as bugs:
//   - Delete / Backspace ON a lone empty separator → merge (§2.2.5 п.3, BOTH keys).
//   - Backspace at a group START (Range.from) → NO-OP (§2.2.4 п.6 — editing keys
//     can't leave a ver-block); the OLD code wrongly merged here.
//   - Ctrl+Y (diffDeleteLine) on a separator → merge (CM6 deleteLine ate the upper
//     terminal → "nothing deleted, caret jumps"; fixed by terminal-safe forward).
//   - select normal line(s) between groups + Delete/Backspace → merge.
//   - merge caret: join-point in ver1, OR ver2 first line when the lower group's
//     ver1 is empty (§6.1 + user 2026-06-20).
//   - Ctrl+K → deleteToLineEnd (within-line, never a terminal).
//
// Commands are called directly where the keymap match is unreliable in happy-dom
// (advisor) — diffDeleteLine/diffBackspace/diffDelete are exported pure-ish.

import { afterEach, describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { deleteToLineEnd } from "@codemirror/commands";
import { diffBackspace, diffDelete, diffDeleteLine } from "../../src/diff2/diff-edits";

const groupCount = (v: EditorView): number =>
  new Set(readStructure(v.state).map((r) => r.group)).size;
const split = (v: EditorView) => splitModel(v.state.doc.toString(), readStructure(v.state));

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
// lone empty separator position between group0 and group1.
const sepPos = (v: EditorView) =>
  readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!.from - 1;

// two groups separated by ONE empty normal line: "a\n\nc\n" / "x\n\nz\n".
const LONE: [string, string] = ["a\n\nc\n", "x\n\nz\n"];

describe("§2.2.5 п.3 — Delete/Backspace ON the lone separator both merge", () => {
  it("Delete on the separator → merge", () => {
    const v = mount(...LONE);
    at(v, sepPos(v));
    expect(diffDelete(v)).toBe(false); // not consumed → default deleteCharForward merges
  });

  it("Backspace ON the separator → merge (bug 1: previously no-op'd on the terminal)", () => {
    const v = mount(...LONE);
    expect(groupCount(v)).toBe(2);
    at(v, sepPos(v));
    expect(diffBackspace(v)).toBe(true); // consumes + deletes forward → merge
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });
});

describe("§2.2.4 п.6 — Backspace at a group START is a NO-OP (cannot leave a ver-block)", () => {
  it("bug 2: Backspace at the lower group's ver1.from does NOT merge", () => {
    const v = mount(...LONE);
    const before = v.state.doc.toString();
    const g1from = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!.from;
    at(v, g1from);
    expect(diffBackspace(v)).toBe(true); // consumed (no-op)
    expect(v.state.doc.toString()).toBe(before); // separator NOT deleted
    expect(groupCount(v)).toBe(2); // NOT merged
  });
});

describe("§2.2.5(3) Ctrl+Y (diffDeleteLine) — terminal-safe delete-line merges", () => {
  it("diffDeleteLine on a lone empty separator → merge (CM6 deleteLine would no-op)", () => {
    const v = mount(...LONE);
    at(v, sepPos(v));
    expect(diffDeleteLine(v)).toBe(true);
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("diffDeleteLine on a NON-empty normal line between groups → line gone, merge", () => {
    const v = mount("a\nmid\nc\n", "x\nmid\nz\n"); // normal "mid" between groups
    const midLine = v.state.doc.lineAt(readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!.from - 1);
    at(v, midLine.from);
    expect(diffDeleteLine(v)).toBe(true);
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("diffDeleteLine on a normal line NOT between groups → line deleted, no merge", () => {
    const v = mount("a\nL\nkeep\n", "a\nR\nkeep\n"); // group then normal "keep"
    const line = v.state.doc.lineAt(v.state.doc.length - 1); // the "keep" line region
    at(v, line.from);
    const before = groupCount(v);
    expect(diffDeleteLine(v)).toBe(true);
    expect(groupCount(v)).toBe(before); // unchanged (still 1 group)
    // the "keep" line is actually GONE (not a silent no-op).
    expect(splitModel(v.state.doc.toString(), readStructure(v.state)).base).toBe("a\nL\n");
  });
});

describe("Ctrl+K — deleteToLineEnd (within-line, never a terminal)", () => {
  it("deletes from the caret to the end of a ver content line; terminal survives", () => {
    const v = mount("a\nHELLO\nc\n", "a\nR\nc\n"); // ver1 "HELLO\n"
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    at(v, v1.from + 2); // caret after "HE"
    deleteToLineEnd(v); // removes "LLO" up to line end (before the content \n)
    expect(splitModel(v.state.doc.toString(), readStructure(v.state)).base).toBe("a\nHE\nc\n");
  });

  it("emptying a ver content line via deleteToLineEnd leaves a valid structure", () => {
    const v = mount("a\nWORD\nc\n", "a\nR\nc\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    at(v, v1.from); // start of "WORD"
    deleteToLineEnd(v); // → ver1 content "" (empty), terminal kept
    // structure stays valid: splitModel round-trips and the group survives (1 group).
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(buildModel(sp.base, sp.sibling).doc).toBe(v.state.doc.toString());
    expect(groupCount(v)).toBe(1);
  });
});

describe("select normal line(s) between groups + Delete/Backspace → merge", () => {
  it("select ONE normal line + Delete merges", () => {
    const v = mount("a\nmid\nc\n", "x\nmid\nz\n");
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    v.dispatch({ selection: { anchor: g0v2.to, head: g1v1.from } }); // select "mid\n"
    // selection is normal-only (no terminal) → diffSelectionDelete returns null →
    // default delete handles it. Simulate the default delete of the selection.
    expect(diffDelete(v)).toBe(false); // not consumed → default deletes selection
    v.dispatch({ changes: { from: g0v2.to, to: g1v1.from }, userEvent: "delete" });
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("select MULTIPLE normal lines + delete merges", () => {
    const v = mount("a\nm1\nm2\nc\n", "x\nm1\nm2\nz\n"); // two normal lines between
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    v.dispatch({ changes: { from: g0v2.to, to: g1v1.from }, userEvent: "delete" });
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });
});

describe("§6.1 merge caret — join-point, or ver2 first line when lower ver1 empty", () => {
  it("non-empty lower ver1 → caret on the join line (first line of lower group's ver1)", () => {
    const v = mount("a\n\nC1\nC2\n", "x\n\nZ1\nZ2\n"); // g0(a/x), sep, g1(C1\nC2 / Z1\nZ2)
    at(v, sepPos(v));
    diffBackspace(v); // merge
    // merged base "a\nC1\nC2\n"; join = first line of g1's ver1 = "C1".
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("C1");
  });

  it("EMPTY lower ver1 (delete-vs-modify) → caret on ver2 first line", () => {
    // g1 has empty ver1: base has nothing there, sibling has "Z1". Build so group1's
    // ver1 is empty: base "a\n\nc\n" vs sibling "x\n\nZ1\nc\n" → g1 ver1 empty, ver2 "Z1".
    const v = mount("a\n\nc\n", "x\n\nZ1\nc\n");
    // confirm g1 ver1 empty
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    expect(g1v1.to - g1v1.from).toBe(1);
    at(v, sepPos(v));
    diffBackspace(v); // merge
    // lower ver1 empty → caret drops to ver2 first line "Z1".
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("Z1");
  });
});
