// @vitest-environment happy-dom
//
// §2.2.7 п.3a — PASTE fenced groups into normal text (step 6b). pasteSpec(state,
// text) is the pure, testable core (the DOM paste event is device-gate). The
// load-bearing case is §2.2.12.1 case 4: pasting text bracketed by groups between
// two existing groups makes TWO adjacencies in one transaction — that test leads,
// so the first-run-only limitation can't hide.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { readStructure, structureField, toRangeSet } from "../../src/diff2/diff-structure";
import { pasteSpec, serializeGroup } from "../../src/diff2/diff-clipboard";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
  type HistoryBlockV2,
} from "../../src/diff2/history-log-v2";
import { ReplayFlag, replayWithGuard, type HistorySink } from "../../src/diff2/history-feed";

const groupCount = (s: { doc: { toString(): string } } & EditorState): number =>
  new Set(readStructure(s).map((r) => r.group)).size;
const split = (s: EditorState) => splitModel(s.doc.toString(), readStructure(s));

// pasteSpec is pure: build a real state, apply the spec, return the new state.
function st(base: string, sibling: string, sel: { anchor: number; head: number }) {
  const m = buildModel(base, sibling);
  return EditorState.create({
    doc: m.doc,
    selection: sel,
    extensions: [structureField, structureField.init(() => toRangeSet(m.ranges))],
  });
}
function paste(s: EditorState, text: string): EditorState | null {
  const spec = pasteSpec(s, text);
  return spec ? s.update(spec).state : null;
}

const G = (c1: string, c2: string) => serializeGroup(c1, c2); // fenced block for a group

describe("§2.2.12.1 case 4 — paste a group BETWEEN two groups → TWO adjacencies (multi-run)", () => {
  it("paste groupX bracketed-adjacent between existing group0 and group1 merges BOTH sides", () => {
    // doc: group0 (A/X) then a normal separator we caret into, then group1 (C/Z).
    // base "A\nsep\nC\n" vs "X\nsep\nZ\n" → 2 groups, normal "sep".
    const s0 = st("A\nsep\nC\n", "X\nsep\nZ\n", { anchor: 0, head: 0 });
    expect(groupCount(s0)).toBe(2);
    // caret onto the separator line "sep" and select it whole, then paste a group
    // that has NO surrounding normal → it abuts group0 (above) AND group1 (below).
    const g0v2 = readStructure(s0).find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = readStructure(s0).find((r) => r.group === 1 && r.ver === 1)!;
    const sel = st("A\nsep\nC\n", "X\nsep\nZ\n", { anchor: g0v2.to, head: g1v1.from });
    const s1 = paste(sel, G("B\n", "Y\n"))!; // paste group B/Y replacing "sep\n"
    // group0+pasted+group1 all adjacent → ONE merged+re-diffed group (A,B,C / X,Y,Z).
    expect(split(s1)).toEqual({ base: "A\nB\nC\n", sibling: "X\nY\nZ\n" });
  });

  it("paste 'groupX + normal + groupY' between two groups → TWO separate merges", () => {
    // existing: g0(A/X) sep g1(C/Z). Paste a clipboard that is groupB + "mid" +
    // groupD with NO leading/trailing normal → B abuts g0, D abuts g1, "mid" keeps
    // B and D apart. Result: (g0+B) merged, then "mid", then (D+g1) merged → 2 groups.
    const sel = st("A\nsep\nC\n", "X\nsep\nZ\n", {
      anchor: readStructure(st("A\nsep\nC\n", "X\nsep\nZ\n", { anchor: 0, head: 0 })).find(
        (r) => r.group === 0 && r.ver === 2,
      )!.to,
      head: readStructure(st("A\nsep\nC\n", "X\nsep\nZ\n", { anchor: 0, head: 0 })).find(
        (r) => r.group === 1 && r.ver === 1,
      )!.from,
    });
    const clip = G("B\n", "Y\n") + "mid\n" + G("D\n", "W\n");
    const s1 = paste(sel, clip)!;
    expect(groupCount(s1)).toBe(2); // (A,B/X,Y) and (D,C/W,Z) — NOT one un-merged tail
    expect(split(s1)).toEqual({ base: "A\nB\nmid\nD\nC\n", sibling: "X\nY\nmid\nW\nZ\n" });
  });
});

describe("§2.2.7 п.3a — paste into normal (case 3)", () => {
  it("paste a single group into a plain normal region → materializes a group", () => {
    const s0 = st("one\ntwo\n", "one\ntwo\n", { anchor: 4, head: 4 }); // identical → 0 groups, caret after "one\n"
    expect(groupCount(s0)).toBe(0);
    const s1 = paste(s0, G("L\n", "R\n"))!;
    expect(groupCount(s1)).toBe(1);
    expect(split(s1)).toEqual({ base: "one\nL\ntwo\n", sibling: "one\nR\ntwo\n" });
  });

  it("paste group with surrounding normal → group + normal, no spurious merge", () => {
    const s0 = st("one\ntwo\n", "one\ntwo\n", { anchor: 4, head: 4 });
    const s1 = paste(s0, "pre\n" + G("L\n", "R\n") + "post\n")!;
    expect(split(s1)).toEqual({ base: "one\npre\nL\npost\ntwo\n", sibling: "one\npre\nR\npost\ntwo\n" });
  });

  it("plain text clipboard (no fence) → pasteSpec returns null (default paste)", () => {
    const s0 = st("a\nb\n", "a\nb\n", { anchor: 0, head: 0 });
    expect(pasteSpec(s0, "just text\n")).toBeNull();
  });

  it("paste INTO a ver-block → null (§3b as-is, default paste)", () => {
    const s0base = st("a\nL\nc\n", "a\nR\nc\n", { anchor: 0, head: 0 });
    const v1 = readStructure(s0base).find((r) => r.ver === 1)!;
    const s0 = st("a\nL\nc\n", "a\nR\nc\n", { anchor: v1.from, head: v1.from });
    expect(pasteSpec(s0, G("L\n", "R\n"))).toBeNull();
  });
});

// view-level undo/redo + crash→replay (the resolveCaret/setStructure path).
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
const dview = (v: EditorView) => ({ doc: v.state.doc.toString(), struct: readStructure(v.state) });

describe("paste undo/redo + crash→replay (incl. paste-that-triggers-merge)", () => {
  it("a merge-triggering paste: undo restores, redo re-applies, replay reproduces", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = mount("A\nsep\nC\n", "X\nsep\nZ\n", { sink, flag });
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    const before = dview(v);
    v.dispatch({ selection: { anchor: g0v2.to, head: g1v1.from } });
    const spec = pasteSpec(v.state, serializeGroup("B\n", "Y\n"))!;
    v.dispatch(spec);
    const afterPaste = dview(v);
    expect(splitModel(v.state.doc.toString(), readStructure(v.state))).toEqual({
      base: "A\nB\nC\n",
      sibling: "X\nY\nZ\n",
    });

    undo(v);
    expect(dview(v)).toEqual(before); // doc + structure fully restored
    redo(v);
    expect(dview(v)).toEqual(afterPaste);

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = mount("A\nsep\nC\n", "X\nsep\nZ\n", { sink: sink2, flag: flag2 });
    expect(replayWithGuard(twin, jsonl, flag2).stoppedAtCorrupt).toBe(false);
    expect(dview(twin)).toEqual(afterPaste); // recovered == live
  });
});
