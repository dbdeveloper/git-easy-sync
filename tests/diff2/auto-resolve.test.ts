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
import { buildModel } from "../../src/diff2/diff-model";
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

  it("both sides edited to EMPTY does NOT vanish (empty = valid §2.2.4 state / commit-time delete)", () => {
    // delete-vs-modify: ver1 empty, ver2 "gone\n". Delete ver2 content → both empty.
    const v = live("a\nb\n", "a\ngone\nb\n"); // ver1 empty, ver2 "gone\n"
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(groupCount(v)).toBe(1);
    // delete ver2's content "gone" (keep its \n) → ver2 becomes empty too.
    v.dispatch({ changes: { from: v2.from, to: v2.from + 4 }, userEvent: "delete.backward" });
    expect(groupCount(v)).toBe(1); // group SURVIVES (empty-vs-empty is not a vanish)
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
