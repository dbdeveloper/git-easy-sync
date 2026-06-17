// @vitest-environment happy-dom
//
// ORACLE for the undo/redo CURSOR-fidelity bug (user report 2026-06-17): in the
// RECOVERED document (after replay) the caret wanders on undo/redo of ORDINARY
// edits (typing / paste / delete), while RESOLUTION undo/redo (resolveCaret) is
// faithful. Selection restoration is pure EditorState (no geometry), so this is
// fully decidable in happy-dom.
//
// The discriminating case is a doc-change whose BEFORE selection was set by a pure
// cursor/selection move (NOT a doc change → NOT recorded as a block): e.g. select
// a range, then type over it. CM6's undo restores that BEFORE selection; replay
// (today) only re-dispatches the `change`, so CM6 MAPS whatever selection it had →
// the reconstructed undo target differs from live → wander.
//
// Method: record a live session's forward edits → jsonl; drive undo/redo on the
// LIVE view capturing selection after each; replay the jsonl into a fresh view and
// drive the SAME undo/redo; assert the selection sequence matches at every step.

import { afterEach, describe, expect, it } from "vitest";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
  type HistoryBlockV2,
} from "../../src/diff2/history-log-v2";
import { ReplayFlag, replayWithGuard, type HistorySink } from "../../src/diff2/history-feed";

const parents: HTMLElement[] = [];
function mount(base: string, sibling: string, sink: HistorySink, flag: ReplayFlag): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling, { sink, flag });
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

// Builds the SAME blocks HistoryWriterV2 would, kept in an array (→ serialize).
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

const sel = (v: EditorView) => {
  const m = v.state.selection.main;
  return { a: m.anchor, h: m.head };
};

describe("undo/redo cursor fidelity — replay reproduces live selections", () => {
  it("type-over-selection: undo restores the BEFORE selection; live === replayed", () => {
    // base === sibling ⇒ no diff-groups ⇒ a plain, freely-editable doc "abcdefgh\n".
    const baseDoc = "abcdefgh\n";
    const sink = arraySink();
    const flag = new ReplayFlag();
    const live = mount(baseDoc, baseDoc, sink, flag);

    // forward session (isolateHistory.of("before") = a deterministic group boundary,
    // the synchronous stand-in for a typing pause):
    live.dispatch({ selection: { anchor: 8 } }); // pure caret move (NOT recorded)
    live.dispatch({
      changes: { from: 8, insert: "Z" },
      selection: { anchor: 9 },
      userEvent: "input.type",
      annotations: isolateHistory.of("before"),
    }); // op1: insert "Z" — its BEFORE caret (8) came from the un-recorded move above
    live.dispatch({ selection: { anchor: 2, head: 5 } }); // pure SELECT "cde" (NOT recorded)
    live.dispatch({
      changes: { from: 2, to: 5, insert: "Q" },
      selection: { anchor: 3 },
      userEvent: "input.type",
      annotations: isolateHistory.of("before"),
    }); // op2: type over the selection — BEFORE = {2,5}, AFTER = {3}

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    expect(sink.blocks.map((b) => b.kind)).toEqual(["edit", "edit"]); // 2 forward edits

    // drive undo/redo on the LIVE view (the "live document") — the reference.
    const liveSels: { a: number; h: number }[] = [];
    undo(live); liveSels.push(sel(live)); // undo op2 → BEFORE op2 = {2,5}
    undo(live); liveSels.push(sel(live)); // undo op1 → BEFORE op1 = {8,8}
    redo(live); liveSels.push(sel(live)); // redo op1 → AFTER op1 = {9,9}
    redo(live); liveSels.push(sel(live)); // redo op2 → AFTER op2 = {3,3}

    // sanity: the live reference is what a human sees (a selection on the 1st undo).
    expect(liveSels[0]).toEqual({ a: 2, h: 5 });

    // replay the SAME forward session into a fresh view, then drive the SAME u/r.
    const flag2 = new ReplayFlag();
    const replayed = mount(baseDoc, baseDoc, arraySink(), flag2);
    replayWithGuard(replayed, jsonl, flag2);
    expect(replayed.state.doc.toString()).toBe(live.state.doc.toString()); // doc reconstructed

    const replaySels: { a: number; h: number }[] = [];
    undo(replayed); replaySels.push(sel(replayed));
    undo(replayed); replaySels.push(sel(replayed));
    redo(replayed); replaySels.push(sel(replayed));
    redo(replayed); replaySels.push(sel(replayed));

    // THE ASSERTION: the recovered doc's undo/redo cursor must match the live one.
    expect(replaySels).toEqual(liveSels);
  });

  it("coalesced typing burst: undo restores the WHOLE group's before (live === replayed)", () => {
    const baseDoc = "xy\n";
    const sink = arraySink();
    const flag = new ReplayFlag();
    const live = mount(baseDoc, baseDoc, sink, flag);

    live.dispatch({ selection: { anchor: 2 } }); // pure move (NOT recorded) — the burst's BEFORE
    // a burst of input.type with NO isolate ⇒ CM6 coalesces into ONE undo group:
    live.dispatch({ changes: { from: 2, insert: "a" }, selection: { anchor: 3 }, userEvent: "input.type" });
    live.dispatch({ changes: { from: 3, insert: "b" }, selection: { anchor: 4 }, userEvent: "input.type" });
    live.dispatch({ changes: { from: 4, insert: "c" }, selection: { anchor: 5 }, userEvent: "input.type" });
    live.dispatch({ selection: { anchor: 0 } }); // pure move (NOT recorded) — op2's BEFORE
    live.dispatch({
      changes: { from: 0, insert: "Z" },
      selection: { anchor: 1 },
      userEvent: "input.type",
      annotations: isolateHistory.of("before"),
    }); // separate group

    // the burst must have coalesced: first block newGroup, the other two not.
    const flags = sink.blocks.filter((b) => b.kind === "edit").map((b) => (b.newGroup ? "G" : "·")).join("");
    expect(flags).toBe("G··G");

    const jsonl = sink.blocks.map(serializeBlock).join("\n");
    const liveSels: { a: number; h: number }[] = [];
    undo(live); liveSels.push(sel(live)); // undo "Z" → before = {0,0}
    undo(live); liveSels.push(sel(live)); // undo the WHOLE burst → before = {2,2}
    redo(live); liveSels.push(sel(live)); // redo the burst → after = {5,5}
    redo(live); liveSels.push(sel(live)); // redo "Z"
    expect(liveSels[1]).toEqual({ a: 2, h: 2 }); // the burst's before came from an un-recorded move

    const flag2 = new ReplayFlag();
    const replayed = mount(baseDoc, baseDoc, arraySink(), flag2);
    replayWithGuard(replayed, jsonl, flag2);
    expect(replayed.state.doc.toString()).toBe(live.state.doc.toString());
    const replaySels: { a: number; h: number }[] = [];
    undo(replayed); replaySels.push(sel(replayed));
    undo(replayed); replaySels.push(sel(replayed));
    redo(replayed); replaySels.push(sel(replayed));
    redo(replayed); replaySels.push(sel(replayed));

    expect(replaySels).toEqual(liveSels);
  });
});
