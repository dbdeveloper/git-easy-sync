// @vitest-environment happy-dom
//
// V2 §2.2.13 step-2 — auto-resolve (VANISH): an in-ver edit that makes
// ver1content === ver2content collapses the group to normal lines. Tested in the
// REAL stack (full filter composition via createDiffPaneState, history() default —
// NOT the gate's isolated newGroupDelay:0 harness) AND end-to-end through the real
// historyFeedListener → serialize → replayWithGuard (advisor: weight tests here).

import { afterEach, describe, expect, it } from "vitest";
import { redo, undo, undoDepth } from "@codemirror/commands";
import { ChangeSet, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { fromRangeSet, readStructure, toRangeSet } from "../../src/diff2/diff-structure";
import { detectVanish } from "../../src/diff2/diff-auto-resolve";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
  type HistoryBlockV2,
} from "../../src/diff2/history-log-v2";
import { ReplayFlag, replayWithGuard, type HistorySink } from "../../src/diff2/history-feed";

const groupCount = (v: EditorView): number =>
  new Set(readStructure(v.state).map((r) => r.group)).size;
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
function live(base: string, sibling: string, hooks?: Parameters<typeof mountDiffPaneV2>[3]) {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling, hooks);
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

describe("detectVanish (pure)", () => {
  it("returns the group whose ver1==ver2 after the edit", () => {
    // model "R\n" both sides at the group, edit already applied in the doc we pass.
    const m = buildModel("R\n", "R\n"); // would be 0 groups; build a real 1-group then fake equality
    void m;
    const base = buildModel("L\n", "R\n"); // 1 group, doc "L\n\nR\n\n"
    const doc = Text.of("R\n\nR\n\n".split("\n")); // ver1 edited L→R so both "R\n"
    const changes = ChangeSet.of({ from: 0, to: 1, insert: "R" }, 6);
    expect(detectVanish(doc, base.ranges, changes)).toBe(0);
  });

  it("returns null when ver1 != ver2 (plain edit, no vanish)", () => {
    const base = buildModel("L\n", "R\n");
    const doc = Text.of("LL\n\nR\n\n".split("\n")); // ver1 "LL" != ver2 "R"
    const changes = ChangeSet.of({ from: 1, insert: "L" }, 6);
    // structure must be mapped through the change for positions; map it:
    const mapped = fromRangeSet(toRangeSet(base.ranges).map(changes));
    expect(detectVanish(doc, mapped, changes)).toBeNull();
  });
});

describe("VANISH in the real stack (full filters, history() default)", () => {
  it("in-ver edit making ver1==ver2 collapses the group; caret stays at edit site; one undo unit", () => {
    const v = live("L\n", "R\n"); // 1 group, doc "L\n\nR\n\n"
    expect(groupCount(v)).toBe(1);

    // type: replace ver1 "L" with "R" (now == ver2 "R") → vanish. selection
    // mimics a real keystroke (caret advances past the inserted "R").
    v.dispatch({
      changes: { from: 0, to: 1, insert: "R" },
      selection: { anchor: 1 },
      userEvent: "input.type",
    });

    expect(groupCount(v)).toBe(0); // group gone → all normal
    expect(v.state.doc.toString()).toBe("R\n"); // collapsed to the converged content
    // caret stays where the user typed (after "R"), now a normal line — NOT dumped
    // at a boundary.
    expect(v.state.selection.main.head).toBe(1);
    expect(undoDepth(v.state)).toBe(1); // ONE undo unit (edit+collapse together)

    // undo restores BOTH the doc and the group (structureHistory/invertedEffects).
    undo(v);
    expect(groupCount(v)).toBe(1);
    expect(v.state.doc.toString()).toBe("L\n\nR\n\n");
    // redo re-vanishes.
    redo(v);
    expect(groupCount(v)).toBe(0);
    expect(v.state.doc.toString()).toBe("R\n");
  });

  it("caret in VER2: edit ver2 to equal ver1 → caret follows into the resolved line", () => {
    const v = live("keep\n", "old\n"); // 1 group; ver1 "keep\n", ver2 "old\n"
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    // replace ver2's "old" (the word, NOT its \n) with "keep" → content "keep\n"
    // equals ver1 "keep\n".
    v.dispatch({
      changes: { from: v2.from, to: v2.from + 3, insert: "keep" },
      selection: { anchor: v2.from + 2 }, // caret mid-word in ver2
      userEvent: "input.type",
    });
    expect(groupCount(v)).toBe(0);
    expect(v.state.doc.toString()).toBe("keep\n");
    // content-offset preserved: caret was 2 into ver2's content → 2 into resolved.
    expect(v.state.selection.main.head).toBe(2);
  });

  it("EOL-less last-group vanish (ver2.to === doc.length)", () => {
    const v = live("a\nb", "a\nc"); // common "a\n", then EOL-less group b/c
    expect(groupCount(v)).toBe(1);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // edit ver1 "b" → "c" (== ver2) → vanish; resolved doc stays EOL-less.
    v.dispatch({ changes: { from: v1.from, to: v1.from + 1, insert: "c" }, userEvent: "input.type" });
    expect(groupCount(v)).toBe(0);
    expect(v.state.doc.toString()).toBe("a\nc");
  });

  it("plain in-ver edit that does NOT converge → no vanish (group survives)", () => {
    const v = live("L\n", "R\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1.from, insert: "Z" }, userEvent: "input.type" }); // "ZL" != "R"
    expect(groupCount(v)).toBe(1); // still a conflict
  });

  it("both sides edited to EMPTY DOES vanish (classic resolution — diff2 never emits both-empty)", () => {
    // delete-vs-modify: ver1 empty (placeholder — only ONE side may be an empty
    // ver-block), ver2 "gone\n". Delete ver2 content → BOTH empty. buildModel can
    // never PRODUCE both-empty (its flush skips ver1===""&&ver2===""), so this is a
    // pure editing artifact = the conflict resolved to nothing → vanish.
    const v = live("a\nb\n", "a\ngone\nb\n"); // ver1 empty, ver2 "gone\n"
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(groupCount(v)).toBe(1);
    // delete ver2's whole content line "gone\n" (NOT the terminal) → ver2 content
    // "" == ver1 "" → both empty.
    v.dispatch({ changes: { from: v2.from, to: v2.from + 5 }, userEvent: "delete.backward" });
    expect(groupCount(v)).toBe(0); // VANISHED (both empty = resolution)
  });
});

describe("VANISH in a MULTI-group doc (the compose + shift-others path)", () => {
  // 3 groups (1/A, 2/B, 3/C) separated by common lines h,i,j,k. Converge the
  // MIDDLE group → it vanishes, the BEFORE and AFTER groups must survive intact at
  // shifted offsets. Single-group tests can't exercise this (remaining is empty).
  const BASE = "h\n1\ni\n2\nj\n3\nk\n";
  const SIB = "h\nA\ni\nB\nj\nC\nk\n";

  it("editing the middle group to converge vanishes ONLY it; neighbours stay resolvable", () => {
    const v = live(BASE, SIB);
    expect(groupCount(v)).toBe(3);
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    // replace ver1 "2" with "B" (== ver2 of the middle group) → vanish middle.
    v.dispatch({
      changes: { from: g1v1.from, to: g1v1.from + 1, insert: "B" },
      selection: { anchor: g1v1.from + 1 },
      userEvent: "input.type",
    });

    expect(groupCount(v)).toBe(2); // middle gone, two survive
    // surviving groups intact at the RIGHT offsets: splitModel round-trips to the
    // logical files with the middle line now common ("B").
    const split = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(split).toEqual({ base: "h\n1\ni\nB\nj\n3\nk\n", sibling: "h\nA\ni\nB\nj\nC\nk\n" });
    // caret landed in the vanished (now-normal) region, not shifted onto a neighbour.
    const head = v.state.selection.main.head;
    expect(v.state.doc.lineAt(head).text).toBe("B");

    // and the surviving groups are still independently resolvable (undo restores all 3).
    undo(v);
    expect(groupCount(v)).toBe(3);
  });

  it("multi-group vanish survives feed → replay", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = live(BASE, SIB, { sink, flag });
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    v.dispatch({
      changes: { from: g1v1.from, to: g1v1.from + 1, insert: "B" },
      selection: { anchor: g1v1.from + 1 },
      userEvent: "input.type",
    });
    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = live(BASE, SIB, { sink: sink2, flag: flag2 });
    expect(replayWithGuard(twin, jsonl, flag2).stoppedAtCorrupt).toBe(false);
    expect(docStruct(twin)).toEqual(docStruct(v));
  });
});

describe("VANISH via DELETE + multi-keystroke granularity", () => {
  it("converge by DELETING chars (not insert) → vanish", () => {
    const v = live("XYZ\n", "YZ\n"); // ver1 "XYZ\n", ver2 "YZ\n"
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // delete the leading "X" → ver1 "YZ\n" == ver2 → vanish.
    v.dispatch({
      changes: { from: v1.from, to: v1.from + 1 },
      selection: { anchor: v1.from },
      userEvent: "delete.backward",
    });
    expect(groupCount(v)).toBe(0);
    expect(v.state.doc.toString()).toBe("YZ\n");
  });

  it("type-type-VANISH across separate dispatches: vanish is its OWN undo step", () => {
    const v = live("x\n", "ab\n"); // converge ver1 "x"→"ab" in two keystrokes
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // op1: x → a  (no vanish: "a\n" != "ab\n")
    v.dispatch({ changes: { from: v1.from, to: v1.from + 1, insert: "a" }, selection: { anchor: v1.from + 1 }, userEvent: "input.type" });
    expect(groupCount(v)).toBe(1);
    // op2: insert b → "ab\n" == ver2 → vanish
    const v1b = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1b.from + 1, insert: "b" }, selection: { anchor: v1b.from + 2 }, userEvent: "input.type" });
    expect(groupCount(v)).toBe(0);

    // undo the VANISH alone → back to the "a\n" conflict (group restored), op1 kept.
    undo(v);
    expect(groupCount(v)).toBe(1);
    const r = readStructure(v.state).find((x) => x.ver === 1)!;
    expect(v.state.doc.sliceString(r.from, r.to - 1)).toBe("a\n");
    // undo again → op1 reverted (back to original "x").
    undo(v);
    const r2 = readStructure(v.state).find((x) => x.ver === 1)!;
    expect(v.state.doc.sliceString(r2.from, r2.to - 1)).toBe("x\n");
  });
});

describe("SPLIT / SHRINK (step 3 — scoped re-diff structure, caret deferred)", () => {
  const split = (v: EditorView) => splitModel(v.state.doc.toString(), readStructure(v.state));

  it("middle line becomes common → group SPLITS into two (count UP), round-trips", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n"); // 1 group, all differ
    expect(groupCount(v)).toBe(1);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // edit ver1 middle "b" → "y" (== ver2 middle) → split.
    v.dispatch({ changes: { from: v1.from + 2, to: v1.from + 3, insert: "y" }, userEvent: "input.type" });
    expect(groupCount(v)).toBe(2);
    expect(split(v)).toEqual({ base: "a\ny\nc\n", sibling: "x\ny\nz\n" });
  });

  it("FIRST line becomes common → SHRINK-front: a normal line BEFORE the group", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1.from, to: v1.from + 1, insert: "x" }, userEvent: "input.type" }); // "a"→"x"
    expect(groupCount(v)).toBe(1); // shrank, not split
    expect(split(v)).toEqual({ base: "x\nb\nc\n", sibling: "x\ny\nz\n" });
    // the freed common line "x" sits BEFORE the surviving group (line 1 is normal).
    const g = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v.state.doc.lineAt(g.from).number).toBeGreaterThan(1);
  });

  it("LAST line becomes common → SHRINK-back: a normal line AFTER the group", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1.from + 4, to: v1.from + 5, insert: "z" }, userEvent: "input.type" }); // "c"→"z"
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nb\nz\n", sibling: "x\ny\nz\n" });
    // the freed common line "z" sits AFTER the group (last doc line is normal).
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v2.to).toBeLessThan(v.state.doc.length);
  });

  it("in-ver edit with NO common line → no restructure (group survives, round-trips)", () => {
    const v = live("a\nb\n", "x\ny\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1.from, to: v1.from + 1, insert: "Q" }, userEvent: "input.type" }); // "a"→"Q"
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "Q\nb\n", sibling: "x\ny\n" });
  });

  it("SPLIT a MIDDLE group in a multi-group doc → neighbours intact at right offsets", () => {
    const v = live("g1a\ng1b\ng1c\nC\ng2a\n", "h1a\nh1b\nh1c\nC\nh2a\n"); // 2 groups, "C" common
    expect(groupCount(v)).toBe(2);
    const g0v1 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 1)!;
    // edit group0 middle "g1b" → "h1b" (common) → group0 splits; group1 must survive.
    const line2 = v.state.doc.lineAt(g0v1.from).number + 1; // "g1b" line
    const l = v.state.doc.line(line2);
    v.dispatch({ changes: { from: l.from, to: l.to, insert: "h1b" }, userEvent: "input.type" });
    expect(groupCount(v)).toBe(3); // group0 → 2, group1 stays
    expect(split(v)).toEqual({
      base: "g1a\nh1b\ng1c\nC\ng2a\n",
      sibling: "h1a\nh1b\nh1c\nC\nh2a\n",
    });
  });

  it("split survives feed → replay (structure)", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = live("a\nb\nc\n", "x\ny\nz\n", { sink, flag });
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({ changes: { from: v1.from + 2, to: v1.from + 3, insert: "y" }, userEvent: "input.type" });
    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = live("a\nb\nc\n", "x\ny\nz\n", { sink: sink2, flag: flag2 });
    expect(replayWithGuard(twin, jsonl, flag2).stoppedAtCorrupt).toBe(false);
    expect(docStruct(twin)).toEqual(docStruct(v));
  });
});

describe("VANISH end-to-end: real feed → replay (recovery)", () => {
  it("captured history.jsonl replays into a fresh view identically; no double-record", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = live("L\n", "R\n", { sink, flag });

    v.dispatch({ changes: { from: 0, to: 1, insert: "R" }, userEvent: "input.type" }); // vanish

    // recorded as ONE structural edit block carrying structure + caret.
    expect(sink.blocks.map((b) => b.kind)).toEqual(["edit"]);
    const block = sink.blocks[0];
    expect(block.kind === "edit" && block.structure).toBeDefined();
    expect(block.kind === "edit" && block.caret).toBeDefined();

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = live("L\n", "R\n", { sink: sink2, flag: flag2 });
    const res = replayWithGuard(twin, jsonl, flag2);

    expect(res.stoppedAtCorrupt).toBe(false);
    expect(sink2.blocks.length, "replay must not re-record").toBe(0);
    expect(docStruct(twin), "recovered == live").toEqual(docStruct(v));
  });
});
