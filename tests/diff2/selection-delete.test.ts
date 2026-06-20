// @vitest-environment happy-dom
//
// §2.2.4 p5c / p8a + §2.2.6 + §2.2.9 "neither" — VIEW-LEVEL selection-delete.
// The gap that let the "Ctrl+A, Delete does nothing" bug ship: every prior
// selection test was model/legalization-level (buildModel + pure legalize); NONE
// drove a real Ctrl+A keydown → real Delete → asserted the doc. These drive REAL
// keystrokes through createDiffPaneState so the filters are tested as the user
// experiences them.
//
// Rule (user 2026-06-20): a selection that contains a diff-group wholly (group-
// atomic, §2.2.6) is deletable — the group is removed from BOTH sides (= §2.2.9
// "neither"). A terminal \n never enters the selection (§2.2.4 p5a), so deleting a
// group-spanning selection collapses each group's content but keeps its terminal,
// then re-diff drops the now-both-empty group. Ctrl+A is the maximal case → empty
// doc.

import { afterEach, describe, expect, it } from "vitest";
import { undo, undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { splitModel } from "../../src/diff2/diff-model";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
  type HistoryBlockV2,
} from "../../src/diff2/history-log-v2";
import { ReplayFlag, replayWithGuard, type HistorySink } from "../../src/diff2/history-feed";

const groupCount = (v: EditorView): number =>
  new Set(readStructure(v.state).map((r) => r.group)).size;
const split = (v: EditorView) => splitModel(v.state.doc.toString(), readStructure(v.state));
const docStruct = (v: EditorView) => ({ doc: v.state.doc.toString(), struct: readStructure(v.state) });

function arraySink(): HistorySink & { blocks: HistoryBlockV2[] } {
  const blocks: HistoryBlockV2[] = [];
  let seq = 0;
  return {
    blocks,
    recordEdit(change, effects, delta, at, sel) {
      blocks.push(buildEditBlock(++seq, at, change, effects, delta, sel));
    },
    recordCommand(kind, at) {
      blocks.push(buildCommandBlock(kind, ++seq, at));
    },
  };
}

const parents: HTMLElement[] = [];
function mount(base: string, sibling: string, hooks?: Parameters<typeof mountDiffPaneV2>[3]) {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling, hooks);
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

// REAL keydown through the full keymap stack.
const press = (v: EditorView, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
  v.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: mods.ctrl, shiftKey: mods.shift, bubbles: true, cancelable: true }),
  );
const selectAll = (v: EditorView) => {
  // Mod-a; happy-dom won't run the browser default, so set the full selection the
  // way selectAll would, then assert legalization kept it whole-doc.
  v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
};

describe("§2.2.4 p5c / §2.2.6(1) — Ctrl+A then Delete clears the whole document", () => {
  it("Ctrl+A keeps the whole doc selected (legalizer doesn't shrink it)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    selectAll(v);
    expect(v.state.selection.main.from).toBe(0);
    expect(v.state.selection.main.to).toBe(v.state.doc.length);
  });

  it("Ctrl+A + Delete → document cleared to empty (was the silent-no-op bug)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    selectAll(v);
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe("");
    expect(groupCount(v)).toBe(0);
    expect(v.state.selection.main.head).toBe(0);
  });

  it("Ctrl+A + Backspace → also cleared", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    selectAll(v);
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe("");
  });

  it("Ctrl+A + Delete with multiple groups + normals → all cleared in one step", () => {
    const v = mount("h\n1\ni\n2\nj\n", "h\nA\ni\nB\nj\n"); // 2 groups + normals h,i,j
    selectAll(v);
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe("");
  });
});

describe("§2.2.6 / §2.2.9 'neither' — deleting a selection that wholly contains group(s)", () => {
  it("selection over ONE whole group (+ surrounding normals) deletes it from both sides", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n"); // 1 group between normals a, c
    // select from end of "a\n" through start of "c" — group-atomic covers the group.
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    v.dispatch({ selection: { anchor: v1.from, head: v2.to } });
    press(v, "Delete");
    expect(groupCount(v)).toBe(0);
    // group gone from both sides → both files are just "a\nc\n".
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "a\nc\n" });
  });

  it("selection spanning a middle group + its surrounding normals merges the neighbours", () => {
    // 3 groups; select group1 + the normals around it → group1 gone, group0/group2
    // become adjacent and re-diff (seam cascade).
    const v = mount("1\nA\n2\nB\n3\nC\n4\n", "1\nX\n2\nY\n3\nZ\n4\n"); // groups A/X, B/Y, C/Z
    expect(groupCount(v)).toBe(3);
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    const g1v2 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 2)!;
    // select the middle group's whole span (group-atomic).
    v.dispatch({ selection: { anchor: g1v1.from, head: g1v2.to } });
    press(v, "Delete");
    expect(groupCount(v)).toBe(2); // middle gone; neighbours survive
    expect(split(v)).toEqual({ base: "1\nA\n2\n3\nC\n4\n", sibling: "1\nX\n2\n3\nZ\n4\n" });
  });
});

describe("selection-delete UNDO + crash→replay (the setStructure/resolveCaret path)", () => {
  it("one-group delete: UNDO restores doc+structure (one undo unit); REDO re-deletes", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    const before = docStruct(v);
    v.dispatch({ selection: { anchor: v1.from, head: v2.to } });
    press(v, "Delete");
    expect(groupCount(v)).toBe(0);
    expect(undoDepth(v.state)).toBe(1); // ONE undo unit
    undo(v);
    expect(docStruct(v)).toEqual(before); // doc + structure restored together
    expect(undoDepth(v.state)).toBe(0);
  });

  it("Ctrl+A clear survives crash → replay (whole-doc-replace-to-'' block)", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = mount("a\nL\nc\n", "a\nR\nc\n", { sink, flag });
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe("");

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = mount("a\nL\nc\n", "a\nR\nc\n", { sink: sink2, flag: flag2 });
    expect(replayWithGuard(twin, jsonl, flag2).stoppedAtCorrupt).toBe(false);
    expect(sink2.blocks.length, "replay must not re-record").toBe(0);
    expect(docStruct(twin), "recovered == live (empty doc, no groups)").toEqual(docStruct(v));
    expect(twin.state.doc.toString()).toBe("");
  });
});

describe("within-block selection delete (NOT terminal-spanning) keeps the group", () => {
  it("deleting ALL content inside one ver-block leaves it empty (group survives)", () => {
    const v = mount("a\nWORD\nc\n", "a\nR\nc\n"); // ver1 content "WORD\n"
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // select the WHOLE content [from, to-1) — excludes the terminal \n (§2.2.4 p5a).
    v.dispatch({ selection: { anchor: v1.from, head: v1.to - 1 } });
    press(v, "Delete");
    expect(groupCount(v)).toBe(1); // still a conflict (ver1 empty, ver2 "R")
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "a\nR\nc\n" });
  });

  it("deleting PART of content inside a ver-block leaves a (blank) line, group survives", () => {
    const v = mount("a\nWORD\nc\n", "a\nR\nc\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ selection: { anchor: v1.from, head: v1.from + 4 } }); // "WORD" only
    press(v, "Delete");
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\n\nc\n", sibling: "a\nR\nc\n" }); // blank line remains
  });
});
