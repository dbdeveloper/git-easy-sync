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
import { caretInSubDoc, detectVanish } from "../../src/diff2/diff-auto-resolve";
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

// REAL keydown so the §2.2.5(3) boundary keymap (diffDelete/diffBackspace) runs —
// a direct v.dispatch({changes}) would bypass the keymap+changeFilter the trigger
// must survive (advisor).
const press = (v: EditorView, key: string) =>
  v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const at = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });

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

describe("caretInSubDoc (pure §6.1 probe — follow the edited line through re-diff)", () => {
  // helper: the char at the mapped offset (what line the caret lands on).
  const at = (c1: string, c2: string, side: 1 | 2, sideOffset: number) => {
    const sub = buildModel(c1, c2);
    const off = caretInSubDoc(sub.doc, sub.ranges, side, sideOffset);
    return { off, doc: sub.doc, line: sub.doc.slice(0, off).split("\n").length - 1, lineText: () => {
      const lines = sub.doc.split("\n");
      return lines[sub.doc.slice(0, off).split("\n").length - 1];
    } };
  };

  it("split-middle: edited line became COMMON → caret lands on the normal line (ver1)", () => {
    // c1 "a\ny\nc\n" (middle edited to "y" == c2 middle) vs c2 "x\ny\nz\n".
    const r = at("a\ny\nc\n", "x\ny\nz\n", 1, 2); // offset 2 = start of "y" in c1
    expect(r.lineText()).toBe("y"); // landed on the now-normal "y"
  });

  it("split-middle from VER2 side also lands on the common line", () => {
    const r = at("a\ny\nc\n", "x\ny\nz\n", 2, 2); // "y" in c2
    expect(r.lineText()).toBe("y");
  });

  it("shrink-front: caret on a line that STAYED in the ver-block (not the freed common line)", () => {
    // c1 "x\nb\nc\n" (first edited to "x" == c2 first) vs c2 "x\ny\nz\n".
    // "x" frees to a normal line BEFORE; caret on "b" stays in ver1 sub-block.
    const r = at("x\nb\nc\n", "x\ny\nz\n", 1, 2); // "b"
    expect(r.lineText()).toBe("b");
  });

  it("shrink-back: caret on a line still in the ver-block", () => {
    const r = at("a\nb\nz\n", "x\ny\nz\n", 1, 2); // "b"; "z" frees AFTER
    expect(r.lineText()).toBe("b");
  });

  it("preserves COLUMN on a multi-char moving line (mid-line caret)", () => {
    // "yy" line moves to normal; caret at col 1 (between the y's) must stay col 1.
    const sub = buildModel("aa\nyy\ncc\n", "xx\nyy\nzz\n");
    const off = caretInSubDoc(sub.doc, sub.ranges, 1, 4); // "aa\n"=0-3, "yy" col1 = 4
    const lineStart = sub.doc.lastIndexOf("\n", off - 1) + 1;
    expect(sub.doc.slice(lineStart).startsWith("yy")).toBe(true); // on the "yy" line
    expect(off - lineStart).toBe(1); // column preserved
  });
});

describe("SPLIT / SHRINK (step 3 — scoped re-diff structure + caret)", () => {
  const split = (v: EditorView) => splitModel(v.state.doc.toString(), readStructure(v.state));

  it("middle line becomes common → group SPLITS into two (count UP), round-trips", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n"); // 1 group, all differ
    expect(groupCount(v)).toBe(1);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // edit ver1 middle "b" → "y" (== ver2 middle) → split. caret after "y".
    v.dispatch({
      changes: { from: v1.from + 2, to: v1.from + 3, insert: "y" },
      selection: { anchor: v1.from + 3 },
      userEvent: "input.type",
    });
    expect(groupCount(v)).toBe(2);
    expect(split(v)).toEqual({ base: "a\ny\nc\n", sibling: "x\ny\nz\n" });
    // §6.1 caret follows the edited line → the now-common normal "y".
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("y");
  });

  it("FIRST line becomes common → SHRINK-front: a normal line BEFORE the group", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({
      changes: { from: v1.from, to: v1.from + 1, insert: "x" },
      selection: { anchor: v1.from + 1 },
      userEvent: "input.type",
    }); // "a"→"x"
    expect(groupCount(v)).toBe(1); // shrank, not split
    expect(split(v)).toEqual({ base: "x\nb\nc\n", sibling: "x\ny\nz\n" });
    // the freed common line "x" sits BEFORE the surviving group (line 1 is normal).
    const g = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v.state.doc.lineAt(g.from).number).toBeGreaterThan(1);
    // §6.1 caret follows the edited line → the freed normal "x".
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("x");
  });

  it("LAST line becomes common → SHRINK-back: a normal line AFTER the group", () => {
    const v = live("a\nb\nc\n", "x\ny\nz\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    v.dispatch({
      changes: { from: v1.from + 4, to: v1.from + 5, insert: "z" },
      selection: { anchor: v1.from + 5 },
      userEvent: "input.type",
    }); // "c"→"z"
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nb\nz\n", sibling: "x\ny\nz\n" });
    // the freed common line "z" sits AFTER the group (last doc line is normal).
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v2.to).toBeLessThan(v.state.doc.length);
    // §6.1 caret follows the edited line → the freed normal "z".
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("z");
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

  it("split caret survives UNDO/REDO and REPLAY (the resolveCaret/invertedEffects walk)", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = live("a\nb\nc\n", "x\ny\nz\n", { sink, flag });
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    const before = v1.from + 2; // caret on "b" BEFORE the edit
    v.dispatch({ selection: { anchor: before } });
    // edit "b"→"y" (split); caret advances past the inserted "y".
    v.dispatch({
      changes: { from: v1.from + 2, to: v1.from + 3, insert: "y" },
      selection: { anchor: v1.from + 3 },
      userEvent: "input.type",
    });
    const after = v.state.selection.main.head;
    expect(v.state.doc.lineAt(after).text).toBe("y"); // forward: on the moved line

    // UNDO → caret at the edit site (before), on the restored "b" in the restored group.
    undo(v);
    expect(groupCount(v)).toBe(1);
    expect(v.state.selection.main.head).toBe(before);
    expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe("b");
    // REDO → caret back on the moved "y" line.
    redo(v);
    expect(v.state.selection.main.head).toBe(after);
    expect(v.state.doc.lineAt(after).text).toBe("y");

    // REPLAY: the recorded resolveCaret lands the twin's caret identically.
    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = live("a\nb\nc\n", "x\ny\nz\n", { sink: sink2, flag: flag2 });
    replayWithGuard(twin, jsonl, flag2);
    expect(docStruct(twin)).toEqual(docStruct(v));
    expect(twin.state.selection.main.head).toBe(after); // caret recovered
    undo(twin); // replayed undo → before, like live
    expect(twin.state.selection.main.head).toBe(before);
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

describe("MERGE (step 4 — §2.2.12 cases 1&2 + §2.2.5(3), REAL keypress)", () => {
  // group0(a/x), a LONE EMPTY normal line "\n", group1(c/z). doc:
  // "a\n\nx\n\n\nc\n\nz\n\n"; separator (empty line) between the groups.
  const LONE = ["a\n\nc\n", "x\n\nz\n"] as const;
  const split = (v: EditorView) => splitModel(v.state.doc.toString(), readStructure(v.state));
  const sep = (v: EditorView) => readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!.from - 1;

  it("case 1 — DELETE on the lone empty separator merges the groups (real keydown)", () => {
    const v = live(...LONE);
    expect(groupCount(v)).toBe(2);
    at(v, sep(v)); // caret ON the empty separator line
    press(v, "Delete"); // §2.2.5(3): NOT consumed → deletes the \n → merge
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("case 1 — BACKSPACE ON the separator line merges (NOT at the group start — §2.2.4 п.6)", () => {
    // §2.2.4 п.6: Backspace at the lower group's ver1.from must be a NO-OP (editing
    // keys can't leave a ver-block). The merge trigger is Backspace ON the separator.
    const v = live(...LONE);
    const g1from = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!.from;
    at(v, g1from); // at the group start
    press(v, "Backspace");
    expect(groupCount(v)).toBe(2); // NO-OP — not merged (§2.2.4 п.6)

    at(v, g1from - 1); // ON the lone separator line
    press(v, "Backspace");
    expect(groupCount(v)).toBe(1); // merged
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("a single Delete on a NON-empty separator is still BLOCKED (not a merge)", () => {
    const v = live("a\nMID\nc\n", "x\nMID\nz\n"); // normal "MID\n" between groups
    const s = sep(v); // points into "MID\n" region's leading \n
    at(v, s);
    press(v, "Delete");
    expect(groupCount(v)).toBe(2); // externalGuard/keymap protect a non-empty separator
    expect(v.state.selection.main.head).toBe(s); // bug-17: blocked change must NOT slide the caret
  });

  it("ONE delete can't create TWO un-merged runs (group-spanning selection rebuilds, §2.2.9)", () => {
    // 3 groups, two empty separators. A selection spanning BOTH separators contains
    // the middle group → it is a terminal-spanning selection → diffSelectionDelete
    // REBUILDS in one transaction (group-atomic §2.2.9 "neither"): the middle group
    // + both separators are removed and the whole span re-diffed → group0/group2's
    // remaining content re-tiled. No dangling two-run state can persist (it's a
    // single buildModel over the projected files, not a reactive per-group merge).
    const v = live("a\n\nc\n\ne\n", "x\n\nz\n\nw\n"); // groups (a/x),(c/z),(e/w)
    expect(groupCount(v)).toBe(3);
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    const g2v1 = readStructure(v.state).find((r) => r.group === 2 && r.ver === 1)!;
    v.dispatch({ selection: { anchor: g0v2.to, head: g2v1.from } }); // spans the middle group
    press(v, "Delete");
    // middle group (c/z) + separators deleted from both sides; a/x and e/w remain,
    // now separated only by what's left. splitModel must be a valid 2-group tiling.
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(sp.base).toBe("a\ne\n");
    expect(sp.sibling).toBe("x\nw\n");
    // exactly one group survived as a single conflict (a/x vs e/w → 1 group), and no
    // two touching groups (a valid structure).
    expect(groupCount(v)).toBe(1);
  });

  it("case 2 — SELECT the normal line + Delete merges (multi-char delete passes the keymap)", () => {
    const v = live("a\nMID\nc\n", "x\nMID\nz\n");
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    v.dispatch({ selection: { anchor: g0v2.to, head: g1v1.from } }); // select "MID\n"
    press(v, "Delete"); // non-empty selection → defaultKeymap deletes it → merge
    expect(groupCount(v)).toBe(1);
    expect(split(v)).toEqual({ base: "a\nc\n", sibling: "x\nz\n" });
  });

  it("merge of a MIDDLE pair leaves the THIRD group intact", () => {
    // 3 groups; merge group0+group1 (lone empty sep), group2 untouched.
    const v = live("a\n\nc\nK\ne\n", "x\n\nz\nK\nw\n"); // groups (a/x),(c/z) then K common then (e/w)
    expect(groupCount(v)).toBe(3);
    at(v, sep(v)); // separator between group0 and group1
    press(v, "Delete");
    expect(groupCount(v)).toBe(2); // 0+1 merged, group2 survives
    expect(split(v)).toEqual({ base: "a\nc\nK\ne\n", sibling: "x\nz\nK\nw\n" });
  });

  it("merge caret = join point; survives UNDO/REDO + REPLAY", () => {
    const sink = arraySink();
    const flag = new ReplayFlag();
    const v = live(...LONE, { sink, flag });
    const before = sep(v);
    at(v, before); // caret on the empty separator
    press(v, "Delete"); // merge
    const after = v.state.selection.main.head;
    // §6.1 merge caret = first line of the LAST group's ver1 ("c").
    expect(v.state.doc.lineAt(after).text).toBe("c");

    undo(v);
    expect(groupCount(v)).toBe(2); // separator + both groups restored
    expect(v.state.selection.main.head).toBe(before);
    redo(v);
    expect(v.state.selection.main.head).toBe(after);
    expect(v.state.doc.lineAt(after).text).toBe("c");

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const sink2 = arraySink();
    const flag2 = new ReplayFlag();
    const twin = live(...LONE, { sink: sink2, flag: flag2 });
    replayWithGuard(twin, jsonl, flag2);
    expect(docStruct(twin)).toEqual(docStruct(v));
    expect(twin.state.selection.main.head).toBe(after);
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
