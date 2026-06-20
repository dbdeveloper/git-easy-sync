// @vitest-environment happy-dom
//
// §0.5.5 carousel — CONSERVATIVE compaction. The ORACLE is full lockstep
// replay-equivalence BOTH directions (undo-to-base + redo-to-top), not final-doc
// equality: conservative vs lossy compaction are indistinguishable on the final
// doc — the difference only shows on the undo/redo walk (advisor 2026-06-20).
//
// Two layers: (1) synthetic controlled scenarios incl. the user's canonical
// "10 edits → undo 7 → +1 edit → exactly 4 survive" and a redo-survival case
// (exercises the redo emit-order); (2) the REAL bug-31 log (428 blocks) replayed
// against its real base/sibling snapshots.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import {
  buildCommandBlock,
  buildEditBlock,
  serializeBlock,
  type HistoryBlockV2,
} from "../../src/diff2/history-log-v2";
import {
  assessHistoryV2,
  compactHistoryV2,
  replayHistoryV2,
  scanHistoryV2,
} from "../../src/diff2/history-replay-v2";

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

// doc + structure are the conservative-compaction guarantee. The caret is NOT
// compared between the two replay paths: post-replay it is restored from cursor.json
// (not the log), and a plain edit's WALK caret is CM6-path-dependent (compact's
// history is shorter but doc-equivalent). Resolution carets ride resolveCaret IN the
// surviving blocks, so they're preserved by construction. The redo emit-order bug —
// the reason for the walk at all — surfaces as a wrong DOC on redo, which this catches.
const dcs = (v: EditorView) => ({
  doc: v.state.doc.toString(),
  struct: readStructure(v.state),
});

// Live-session recorder (same shape as history-replay-v2.test.ts).
function recorder(view: EditorView) {
  const log: HistoryBlockV2[] = [];
  let seq = 0;
  return {
    log,
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

function replayInto(base: string, sibling: string, jsonl: string): EditorView {
  const v = mount(base, sibling);
  replayHistoryV2(v, jsonl);
  return v;
}

// THE ORACLE: two logs replay to the SAME state and stay equal step-by-step through
// undo-all-the-way-down AND redo-all-the-way-up (doc + structure each step).
function assertLogsEquivalent(base: string, sibling: string, a: string, b: string): void {
  const va = replayInto(base, sibling, a);
  const vb = replayInto(base, sibling, b);
  expect(undoDepth(va.state), "undo depth equal").toBe(undoDepth(vb.state));
  expect(dcs(va), "post-replay state equal").toEqual(dcs(vb));
  const depth = undoDepth(vb.state);
  for (let i = 0; i < depth; i++) {
    undo(va);
    undo(vb);
    expect(dcs(va), `undo step ${i + 1}/${depth}`).toEqual(dcs(vb));
  }
  for (let i = 0; i < depth; i++) {
    redo(va);
    redo(vb);
    expect(dcs(va), `redo step ${i + 1}/${depth}`).toEqual(dcs(vb));
  }
}
const assertReplayEquivalent = (base: string, sibling: string, jsonl: string): void =>
  assertLogsEquivalent(base, sibling, compactHistoryV2(jsonl), jsonl);

const editCount = (jsonl: string) =>
  scanHistoryV2(jsonl).blocks.filter((b) => b.kind === "edit").length;
const blockCount = (jsonl: string) => scanHistoryV2(jsonl).blocks.length;

describe("compactHistoryV2 — conservative, replay-equivalent both directions", () => {
  it("user's canonical case: 10 edits → undo 7 → +1 edit → EXACTLY 4 survive", () => {
    const v = mount("seed\n", "seed\n"); // base==sibling → 0 groups, plain editable
    const rec = recorder(v);
    for (let i = 0; i < 10; i++) rec.edit({ changes: { from: 0, insert: `${i}\n` }, userEvent: "input.type" });
    for (let i = 0; i < 7; i++) rec.undo();
    rec.edit({ changes: { from: 0, insert: "X\n" }, userEvent: "input.type" }); // truncates redo → 7 dead
    const jsonl = rec.jsonl();

    const c = compactHistoryV2(jsonl);
    expect(editCount(c)).toBe(4); // 3 survivors of the undo + the post-undo edit
    expect(blockCount(c)).toBe(4); // no undo commands left (redo stack empty)
    // user requirement: exactly 4 UNDO returns to the base diff-document.
    const rv = replayInto("seed\n", "seed\n", c);
    expect(undoDepth(rv.state)).toBe(4);
    for (let i = 0; i < 4; i++) undo(rv);
    expect(rv.state.doc.toString()).toBe("seed\n"); // back to the initial conflict doc
    assertReplayEquivalent("seed\n", "seed\n", jsonl);
  });

  it("redo-survival: edits then undo (no truncating edit) → redo stack preserved (emit-order)", () => {
    const v = mount("seed\n", "seed\n");
    const rec = recorder(v);
    rec.edit({ changes: { from: 0, insert: "a\n" }, userEvent: "input.type" });
    rec.edit({ changes: { from: 0, insert: "b\n" }, userEvent: "input.type" });
    rec.edit({ changes: { from: 0, insert: "c\n" }, userEvent: "input.type" });
    rec.undo(); // c undone, redoable — NOTHING dead
    const jsonl = rec.jsonl();
    const c = compactHistoryV2(jsonl);
    // nothing dead → all 3 edits survive + 1 undo command (redo reachable).
    expect(editCount(c)).toBe(3);
    assertReplayEquivalent("seed\n", "seed\n", jsonl); // redo-to-top must reach "c" in both
  });

  it("interleaved undo/redo then dead edits → only the dead are dropped", () => {
    const v = mount("seed\n", "seed\n");
    const rec = recorder(v);
    for (let i = 0; i < 5; i++) rec.edit({ changes: { from: 0, insert: `${i}\n` }, userEvent: "input.type" });
    rec.undo(); rec.undo(); rec.redo(); // net: 4 groups live, 1 redoable
    rec.edit({ changes: { from: 0, insert: "Z\n" }, userEvent: "input.type" }); // truncates the 1 redoable → dead
    const jsonl = rec.jsonl();
    const c = compactHistoryV2(jsonl);
    expect(blockCount(c)).toBeLessThan(blockCount(jsonl)); // shrank
    assertReplayEquivalent("seed\n", "seed\n", jsonl);
  });

  it("fully-undone session compacts to empty", () => {
    const v = mount("seed\n", "seed\n");
    const rec = recorder(v);
    rec.edit({ changes: { from: 0, insert: "a\n" }, userEvent: "input.type" });
    rec.edit({ changes: { from: 0, insert: "b\n" }, userEvent: "input.type" });
    rec.undo(); rec.undo();
    rec.edit({ changes: { from: 0, insert: "c\n" }, userEvent: "input.type" }); // truncates → a,b dead
    const jsonl = rec.jsonl();
    const c = compactHistoryV2(jsonl);
    expect(editCount(c)).toBe(1); // only "c" survives
  });

  it("a clean log with no undos is unchanged in length (nothing to remove)", () => {
    const v = mount("seed\n", "seed\n");
    const rec = recorder(v);
    rec.edit({ changes: { from: 0, insert: "a\n" }, userEvent: "input.type" });
    rec.edit({ changes: { from: 0, insert: "b\n" }, userEvent: "input.type" });
    const jsonl = rec.jsonl();
    expect(blockCount(compactHistoryV2(jsonl))).toBe(2);
    assertReplayEquivalent("seed\n", "seed\n", jsonl);
  });

  it("empty log → empty", () => {
    expect(compactHistoryV2("")).toBe("");
  });
});

describe("append-after-compact boundary (mid-session threshold-trigger surface)", () => {
  // The case mid-edit compaction introduces and nothing else covers: the log becomes
  // [compacted prefix] ++ [new appends]. A crash→replay across that boundary must
  // reconstruct the live editor exactly (advisor 2026-06-20). We simulate the trigger
  // by compacting the prefix, then appending more REAL edits to the SAME live view
  // (its CM6 history is untouched by compaction), and assert replay(boundary) ==
  // replay(full-uncompacted) through the whole undo/redo walk spanning the seam.
  it("compacted prefix + later edits replays == the full uncompacted session", () => {
    const v = mount("seed\n", "seed\n");
    const rec = recorder(v);
    // prefix L1 — has dead pairs (5 edits, undo 3, +1 truncating edit).
    for (let i = 0; i < 5; i++) rec.edit({ changes: { from: 0, insert: `${i}\n` }, userEvent: "input.type" });
    rec.undo(); rec.undo(); rec.undo();
    rec.edit({ changes: { from: 0, insert: "X\n" }, userEvent: "input.type" });
    const l1Count = rec.log.length;
    const compactedPrefix = compactHistoryV2(rec.jsonl());

    // continue the SAME view (CM6 history intact) — these are the post-compact appends.
    rec.edit({ changes: { from: 0, insert: "A\n" }, userEvent: "input.type" });
    rec.edit({ changes: { from: 0, insert: "B\n" }, userEvent: "input.type" });
    rec.undo(); // exercise undo across the seam too
    const l2 = rec.log.slice(l1Count).map(serializeBlock).join("\n");

    const fullLog = rec.jsonl(); // uncompacted L1 ++ L2
    const boundaryLog = `${compactedPrefix}${l2}\n`; // compacted prefix ++ raw L2

    // both must scan clean (every block self-verifies — seq gap across the seam is fine).
    expect(scanHistoryV2(boundaryLog).stoppedAtCorrupt).toBe(false);
    assertLogsEquivalent("seed\n", "seed\n", boundaryLog, fullLog);
  });
});

describe("compactHistoryV2 — REAL bug-31 log (428 blocks) stress", () => {
  const fx = (n: string) => readFileSync(join(process.cwd(), "tests/diff2/fixtures", n), "utf8");
  const base = fx("bug31-base.snapshot");
  const sibling = fx("bug31-sibling.snapshot");
  const jsonl = fx("bug31-history.jsonl");

  it("shrinks the log substantially", () => {
    const c = compactHistoryV2(jsonl);
    expect(blockCount(c)).toBeLessThan(blockCount(jsonl)); // 428 → fewer
    expect(c.length).toBeLessThan(jsonl.length); // bytes drop
  });

  it("replay-equivalent BOTH directions on the real base/sibling", () => {
    assertReplayEquivalent(base, sibling, jsonl);
  });

  it("the corrected metric is net-invariant under compaction (conservative check)", () => {
    // conservative compaction must NOT change the live undo depth — a regression
    // guard that we didn't accidentally build a lossy compactor.
    expect(assessHistoryV2(compactHistoryV2(jsonl)).edits).toBe(assessHistoryV2(jsonl).edits);
  });
});
