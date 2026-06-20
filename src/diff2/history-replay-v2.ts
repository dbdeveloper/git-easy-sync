// V2 replay (DIFF-EDITOR.md §0.5.3) — RE-RUN COMMANDS. Parallel to the §1
// `history-replay.ts`, which dies at Phase 6 (its `syntheticRange` caret-trim is
// the #10 throwaway the explicit-`resolveCaret` model replaces).
//
// `scanHistoryV2` / `assessHistoryV2` / `replayStep` are PURE (parse + verify +
// classify, no CM6). `replayHistoryV2` is the CM6 EDGE: it drives a MOUNTED view,
// re-running each block exactly as the live editor produced it:
//   edit → view.dispatch(change + [setStructure(structure)?, resolveCaret(caret)?]
//          + userEvent:"input.type" + (newGroup ? isolateHistory.of("before")) +
//          replayDispatch.of(true))
//   undo → undo(view) ; redo → redo(view)
//
// This reproduces doc + structure + undo-depth + granularity + resolution caret
// (the 1b + mixed-recovery gates). The annotation strategy is the 1b spike's —
// `userEvent:"input.type"` on EVERY edit, `isolateHistory` ONLY on `newGroup`
// blocks — which is the superset that reproduces coalesced typing bursts (the
// mixed-recovery "isolate every block" strategy only works without bursts).
//
// The view must be a real (happy-dom / DOM) EditorView carrying the diff-pane-v2
// extensions (`history()` etc.). Per the gate spikes, undo/redo replay needs CM6's
// history machinery, so a headless `{state, dispatch}` target is NOT used here.

import { isolateHistory, redo, undo } from "@codemirror/commands";
import { ChangeSet, EditorSelection, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { resolveCaret, setStructure, toRangeSet } from "./diff-structure";
import { parseBlock, replayDispatch, verifyBlock } from "./history-log-v2";
import type { EditBlock, HistoryBlockV2 } from "./history-log-v2";

// Parse + verify the trustworthy PREFIX of `jsonl`, stopping at the first blank-
// after-content / unparseable / failed-checksum line (a torn final append leaves
// a clean prefix; everything past the tear is discarded).
export function scanHistoryV2(jsonl: string): {
  blocks: HistoryBlockV2[];
  stoppedAtCorrupt: boolean;
} {
  const blocks: HistoryBlockV2[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    const b = parseBlock(line);
    if (!b || !verifyBlock(b)) {
      return { blocks, stoppedAtCorrupt: true };
    }
    blocks.push(b);
  }
  return { blocks, stoppedAtCorrupt: false };
}

// What the recovery dialog needs BEFORE committing to a replay (§3.5).
export interface HistoryAssessmentV2 {
  edits: number; // NET live count: #edit − #undo + #redo, clamped ≥0 (see below)
  stoppedAtCorrupt: boolean; // a corrupt block truncated the log → "recovered K of N"
  empty: boolean; // nothing to restore + clean log → stale session, NO modal
  firstBlockCorrupt: boolean; // corruption at block 1 → "0 edits", [Continue] disabled
}

// `edits` is the NET count `#edit − #undo + #redo`, not the raw edit-block count
// (carry-into-step-2 #3): a raw count reports a typed-then-undone session as
// non-empty and pops a bogus "N edits saved" modal. The net count is a HEURISTIC,
// not exact — CM6 coalesces a typing burst into ONE undo group, so a single `undo`
// can cancel several `edit` blocks (net over-reports by the burst length). It is
// only ever the modal's cosmetic "N" + the `empty` gate; the authoritative restore
// is the replay itself. `empty` (net 0 + clean log) is the one decision that
// matters: a fresh/stale session shows no modal.
export function assessHistoryV2(jsonl: string): HistoryAssessmentV2 {
  const { blocks, stoppedAtCorrupt } = scanHistoryV2(jsonl);
  // (bug-31/32) Count only `newGroup` edits — that is the live UNDO DEPTH, which is
  // what "edits saved" means to the user. CM6 coalesces a typing burst into ONE
  // undo group but the log keeps one edit block per keystroke (`newGroup:false`
  // continuations); counting ALL edit blocks over-reports wildly (the real log:
  // 275 edits / 133 newGroup → net 162, but only 20 live undo-groups). Each newGroup
  // pushes a group (+1); undo moves one group to the redo stack (−1); redo reverses
  // (+1); truncation clears only the redo stack (never undo) → not in this formula.
  // Result === CM6's undoDepth after replay.
  let net = 0;
  for (const b of blocks) {
    if (b.kind === "edit") net += b.newGroup ? 1 : 0;
    else if (b.kind === "undo") net -= 1;
    else net += 1; // redo
  }
  const edits = Math.max(0, net);
  return {
    edits,
    stoppedAtCorrupt,
    empty: edits === 0 && !stoppedAtCorrupt,
    firstBlockCorrupt: blocks.length === 0 && stoppedAtCorrupt,
  };
}

// Pure classifier (§0.5.3): a block maps to one replay action.
export type ReplayAction = "dispatch" | "undo" | "redo";
export function replayStep(block: HistoryBlockV2): ReplayAction {
  return block.kind === "edit" ? "dispatch" : block.kind;
}

export interface ReplayResultV2 {
  replayed: number; // blocks applied (edit + undo + redo)
  stoppedAtCorrupt: boolean; // stopped before EOF on a corrupt block
}

// EDGE: replay `jsonl` into a mounted `view`. The caller MUST pause its history-
// recording listener around this call: edit re-dispatches carry
// `replayDispatch.of(true)`, but `undo(view)`/`redo(view)` build their own
// un-annotatable transactions — so a `replaying` flag (step-2 wiring) is what
// keeps those out of the log. Returns counts; the final caret comes from
// `cursor.json` (§2.9), NOT from replay.
export function replayHistoryV2(view: EditorView, jsonl: string): ReplayResultV2 {
  const { blocks, stoppedAtCorrupt } = scanHistoryV2(jsonl);
  for (const block of blocks) {
    const action = replayStep(block);
    if (action === "undo") {
      undo(view);
      continue;
    }
    if (action === "redo") {
      redo(view);
      continue;
    }
    const b = block as EditBlock;
    const effects = [];
    if (b.structure) effects.push(setStructure.of(toRangeSet(b.structure)));
    if (b.caret) effects.push(resolveCaret.of(b.caret));
    // §0.5.x cursor fidelity — an ORDINARY edit carries `sel` (before/after selection)
    // so the reconstructed CM6 history has the SAME per-step undo/redo selections as
    // live (the wander fix). The BEFORE is restored ONLY at a group boundary
    // (newGroup) — that's where CM6 captures a group's startSelection (the undo
    // target); it's set as a NO-HISTORY tx so it doesn't create its own undo step. A
    // coalescing edit just rides the AFTER. RESOLUTIONS keep `caret`/resolveCaret
    // (no `sel`); legacy blocks without `sel` fall back to today's map-only behavior.
    if (b.sel && b.newGroup) {
      view.dispatch({
        selection: EditorSelection.range(b.sel.before.a, b.sel.before.h),
        annotations: Transaction.addToHistory.of(false),
      });
    }
    const annotations = b.newGroup
      ? [Transaction.userEvent.of("input.type"), isolateHistory.of("before"), replayDispatch.of(true)]
      : [Transaction.userEvent.of("input.type"), replayDispatch.of(true)];
    // `change` is stored as ChangeSet.toJSON() (what the Phase-6 updateListener
    // reads from `tr.changes`); reconstruct the ChangeSet before re-dispatch.
    view.dispatch({
      changes: ChangeSet.fromJSON(b.change),
      ...(b.sel ? { selection: EditorSelection.range(b.sel.after.a, b.sel.after.h) } : {}),
      effects,
      annotations,
    });
  }
  return { replayed: blocks.length, stoppedAtCorrupt };
}
