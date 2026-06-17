// V2 history feed — the CM6 ↔ HistoryWriterV2 bridge (DIFF-EDITOR.md §0.5.6 step-2).
//
// Step-1 proved the persistence CORE (build/serialize/replay) reproduces the live
// editor's undo-model GIVEN correct per-tx blocks. Step-2 is the EDGE that produces
// those blocks live: a CM6 `updateListener` that watches every transaction and
// routes it to a `HistorySink` (HistoryWriterV2 in production, an array in tests).
//
// §0.5.5.1 pure-core / thin-edges: `classifyFeed` is PURE (a truth table over a
// few booleans, unit-testable with no CM6). The listener is the thin edge — it
// reads the CM6 facts (`docChanged`, userEvent, the `replayDispatch` annotation,
// the `undoDepth` delta) and hands them to the pure classifier + the sink.
//
// THREE traps, each of which fails SILENTLY if wrong (pinned by the fidelity test):
//  1. The undoDepth delta MUST be measured per-transaction from `tr.startState` →
//     `tr.state`, NOT from the update-level `u.startState`/`u.state`: an update
//     BATCHES transactions, so a u-level delta can't be attributed to one tx.
//  2. The listener and `replayWithGuard` MUST share ONE `ReplayFlag` instance. A
//     mismatched flag makes the guard a no-op and replay silently double-records.
//  3. undo/redo are checked BEFORE docChanged — an undo/redo tx is also docChanged,
//     and must record as a COMMAND block (replay re-runs it), not an edit.

import { undoDepth } from "@codemirror/commands";
import type { Extension, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { replayDispatch } from "./history-log-v2";
import type { SelPair } from "./history-log-v2";
import { replayHistoryV2 } from "./history-replay-v2";
import type { ReplayResultV2 } from "./history-replay-v2";

// What the listener routes a transaction to. "skip" = not recorded.
export type FeedAction = "skip" | "edit" | "undo" | "redo";

// The CM6 facts the pure classifier needs — nothing CM6-typed leaks past here.
export interface FeedInput {
  docChanged: boolean;
  isUndo: boolean; // tr.isUserEvent("undo")
  isRedo: boolean; // tr.isUserEvent("redo")
  isReplayDispatch: boolean; // tr carries the replayDispatch annotation
  replaying: boolean; // the shared flag is set (a replay is in flight)
}

// Pure decision (§0.5.3). Order matters (trap 3): a replay is suppressed wholesale;
// undo/redo win over docChanged (their txs are docChanged too); a plain doc change
// is an edit; everything else (pure selection moves, the cursorRestore follow-up,
// effect-only txs) is skipped.
export function classifyFeed(input: FeedInput): FeedAction {
  if (input.replaying || input.isReplayDispatch) return "skip";
  if (input.isUndo) return "undo";
  if (input.isRedo) return "redo";
  if (input.docChanged) return "edit";
  return "skip";
}

// HistoryWriterV2 already satisfies this — the edge only needs these two methods,
// so tests can pass an in-memory array sink instead of a vault-backed writer.
export interface HistorySink {
  recordEdit(
    change: unknown,
    effects: readonly StateEffect<unknown>[],
    undoDepthDelta: number,
    at: string,
    sel?: SelPair, // ordinary edit's before/after selection (faithful u/r replay)
  ): void;
  recordCommand(kind: "undo" | "redo", at: string): void;
}

// Shared mutable flag — ONE instance wired into BOTH the listener and
// `replayWithGuard` (trap 2). A class (not a bare boolean) so the reference is
// shared by identity, not by value.
export class ReplayFlag {
  replaying = false;
}

// EDGE: the updateListener that feeds `sink`. `now` is injectable for deterministic
// tests; `at` is not in the block checksum, so real timestamps are replay-safe.
export function historyFeedListener(
  sink: HistorySink,
  flag: ReplayFlag,
  now: () => string = () => new Date().toISOString(),
): Extension {
  return EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      const action = classifyFeed({
        docChanged: tr.docChanged,
        isUndo: tr.isUserEvent("undo"),
        isRedo: tr.isUserEvent("redo"),
        isReplayDispatch: tr.annotation(replayDispatch) === true,
        replaying: flag.replaying,
      });
      if (action === "skip") continue;
      const at = now();
      if (action === "edit") {
        // Trap 1: per-tx delta. +1 ⇒ this tx started a new undo group, 0 ⇒ it
        // coalesced into the current one (approach B, §0.5.4).
        const delta = undoDepth(tr.state) - undoDepth(tr.startState);
        // before/after main selection — replay reconstructs CM6's per-step undo/redo
        // selections from these (the wander fix). buildEditBlock drops `sel` for a
        // resolution (it carries `caret` instead).
        const bs = tr.startState.selection.main;
        const as = tr.state.selection.main;
        const sel: SelPair = {
          before: { a: bs.anchor, h: bs.head },
          after: { a: as.anchor, h: as.head },
        };
        sink.recordEdit(tr.changes.toJSON(), tr.effects, delta, at, sel);
      } else {
        sink.recordCommand(action, at);
      }
    }
  });
}

// Replay `jsonl` into `view` with the feed listener's recording suppressed for the
// WHOLE replay. The edit re-dispatches carry `replayDispatch`, but `undo(view)` /
// `redo(view)` (driven by replayHistoryV2) build their OWN un-annotatable txs — so
// the annotation alone is not enough; the `replaying` flag covers the gap. MUST be
// the SAME flag instance the listener holds (trap 2).
export function replayWithGuard(view: EditorView, jsonl: string, flag: ReplayFlag): ReplayResultV2 {
  flag.replaying = true;
  try {
    return replayHistoryV2(view, jsonl);
  } finally {
    flag.replaying = false;
  }
}
