// @vitest-environment happy-dom
//
// bug-56 forward proofs (recorded THROUGH the fixed filters, not the old broken log):
//  (1) debit=credit — a cascade (vanish) edit, then undo, MUST land back on the exact
//      initial doc+structure (proves autoResolveFilter does NOT re-cascade on undo).
//  (2) lockstep — record edit→undo→redo live, replay into a fresh view, assert the two
//      stay identical (doc+structure+undoDepth) at every undo/redo step.

import { afterEach, describe, expect, it } from "vitest";
import { isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { DEFAULT_VIEW_CONFIG, mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { buildCommandBlock, buildEditBlock, serializeBlock, type HistoryBlockV2 } from "../../src/diff2/history-log-v2";
import { replayHistoryV2 } from "../../src/diff2/history-replay-v2";

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

// §31 — a view mounted in touch-only (read-only) mode: Edit-mode OFF.
function mountTouch(base: string, sibling: string): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling, { config: { ...DEFAULT_VIEW_CONFIG, touchOnly: true } });
}

const dcs = (v: EditorView) => ({ doc: v.state.doc.toString(), struct: readStructure(v.state) });

function recorder(view: EditorView) {
  const log: HistoryBlockV2[] = [];
  let seq = 0;
  return {
    edit(spec: TransactionSpec) {
      const before = undoDepth(view.state);
      const tr = view.state.update({
        ...spec,
        annotations: ([] as unknown[]).concat(spec.annotations ?? [], isolateHistory.of("before")) as TransactionSpec["annotations"],
      });
      view.dispatch(tr);
      log.push(buildEditBlock(++seq, "t", tr.changes.toJSON(), tr.effects, undoDepth(view.state) - before));
    },
    undo() {
      undo(view);
      log.push(buildCommandBlock("undo", ++seq, "t"));
    },
    redo() {
      redo(view);
      log.push(buildCommandBlock("redo", ++seq, "t"));
    },
    jsonl() {
      return log.map(serializeBlock).join("\n");
    },
  };
}

// a conflict whose ver1 ("a") converges to ver2 ("b") with a 1-char edit → VANISH.
const BASE = "x\na\ny\n";
const SIBLING = "x\nb\ny\n";

describe("bug-56 forward — cascade + undo/redo balance", () => {
  it("debit=credit: a vanish edit, undone, lands EXACTLY on the initial doc+structure", () => {
    const v = mount(BASE, SIBLING);
    const initial = dcs(v);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    // edit ver1 "a" → "b" ⇒ ver1content === ver2content ⇒ autoResolveFilter VANISH
    v.dispatch(v.state.update({ changes: { from: v1.from, to: v1.from + 1, insert: "b" }, userEvent: "input.type" }));
    expect(dcs(v)).not.toEqual(initial); // the group collapsed
    undo(v);
    expect(dcs(v)).toEqual(initial); // ← debit=credit: the undo FULLY reverted (no re-cascade)
    expect(undoDepth(v.state)).toBe(0);
  });

  it("lockstep: edit→undo→redo replays identically into a fresh view", () => {
    const v = mount(BASE, SIBLING);
    const rec = recorder(v);
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    rec.edit({ changes: { from: v1.from, to: v1.from + 1, insert: "b" }, userEvent: "input.type" });
    rec.undo();
    rec.redo();
    const rv = mount(BASE, SIBLING);
    replayHistoryV2(rv, rec.jsonl());
    expect(undoDepth(rv.state)).toBe(undoDepth(v.state));
    expect(dcs(rv)).toEqual(dcs(v));
    const depth = undoDepth(v.state);
    for (let i = 0; i < depth; i++) {
      undo(v);
      undo(rv);
      expect(dcs(rv), `undo ${i + 1}`).toEqual(dcs(v));
    }
    for (let i = 0; i < depth; i++) {
      redo(v);
      redo(rv);
      expect(dcs(rv), `redo ${i + 1}`).toEqual(dcs(v));
    }
  });
});

// §31 — read-only (touch / Edit-mode OFF) mode blocks live user edits via the
// changeFilter, but must NOT block recovery/resume REPLAY — else a crash leaves the
// file unrestored while Edit-mode is OFF (the reported "прикольний баг"). The replay
// re-dispatches recorded edits with userEvent "input.type" + a replayDispatch
// annotation; the changeFilter now exempts that annotation.
describe("§31 — touch-only (read-only) must NOT block recovery replay", () => {
  it("recorded edits REPLAY into a touch-only view (crash restored while Edit-mode OFF)", () => {
    // record a normal-region edit in an EDIT-mode view.
    const v = mount(BASE, SIBLING);
    const rec = recorder(v);
    rec.edit({ changes: { from: 0, insert: "Q" }, userEvent: "input.type" }); // "x…" → "Qx…"
    expect(v.state.doc.toString().startsWith("Q")).toBe(true);

    // replay that log into a READ-ONLY (touch-only) view — the recovery path.
    const rv = mountTouch(BASE, SIBLING);
    expect(rv.state.doc.toString().startsWith("Q")).toBe(false); // starts unedited
    replayHistoryV2(rv, rec.jsonl());
    // WITHOUT the fix, the touch-only changeFilter drops the replay's input.type →
    // rv stays === BASE (file not restored). WITH the fix, the edit is reproduced.
    expect(dcs(rv)).toEqual(dcs(v));
    expect(rv.state.doc.toString().startsWith("Q")).toBe(true);
  });

  it("a LIVE user edit is STILL blocked in touch-only (read-only not weakened)", () => {
    // the fix exempts ONLY replay dispatches — a plain user input.type (no
    // replayDispatch) must remain blocked, or read-only would be a lie.
    const v = mountTouch(BASE, SIBLING);
    const before = v.state.doc.toString();
    v.dispatch({ changes: { from: 0, insert: "Q" }, userEvent: "input.type" });
    expect(v.state.doc.toString()).toBe(before); // blocked → doc unchanged
  });
});
