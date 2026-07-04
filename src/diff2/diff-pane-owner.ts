// V2-native DiffPane owner (DIFF-EDITOR.md §0.5 / P6.3 view-swap).
//
// The §1 `DiffPane` class is gone; this is its V2 replacement, DESIGNED from the
// V2 model rather than shimmed onto it. The §1 surface (enableRecording /
// onRecord(change,structure) / onUndo→truncateLastBlock) is dead — V2 records via
// a live `historyFeedListener` whose recording is suppressed during replay by ONE
// shared `ReplayFlag`, and undo/redo are COMMAND blocks (no truncation).
//
// What the owner ties together:
//   - the CM6 EditorView (mountDiffPaneV2 over diff-model/diff-structure),
//   - the ONE shared ReplayFlag — the SAME instance into the feed hooks AND
//     replayWithGuard (history-feed trap-2: a mismatched flag silently double-
//     records on replay),
//   - the HistoryWriterV2 sink (live append-log, §0.5.2),
//   - the CursorScheduler (§2.9 cadence) + its flush.
//
// splitModel + commit live in the VIEW (exit-commit is representation-independent);
// the owner only EXPOSES the resolved bytes (getResolved) and the live view.

import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Vault } from "obsidian";
import { redo as cmRedo, redoDepth, undo as cmUndo, undoDepth } from "@codemirror/commands";
import { splitModel } from "./diff-model";
import { readStructure, touchOnlyFacet, wordLevelFacet } from "./diff-structure";
import {
  type DiffViewConfig,
  gotoAdjacentConflict,
  mountDiffPaneV2,
  scrollToConflict,
  touchOnlyComp,
  wordLevelComp,
} from "./diff-pane-v2";
import { conflictCount, firstConflict, nextConflict, prevConflict } from "./diff-nav";
import { HistoryWriterV2 } from "./history-log-v2";
import { compactSessionLog } from "./history-rewrite";
import { ReplayFlag, replayWithGuard } from "./history-feed";
import type { ReplayResultV2 } from "./history-replay-v2";
import { applyResolveAll, type ResolveChoice, type ResolveOpts } from "./diff-resolve";
import { CursorScheduler } from "./cursor-timer";
import { clampCursor, persistCursor } from "./cursor-store";
import type { ResolvedSides } from "./exit-commit";
import type Logger from "../logger";

// RAW resolved sides ("" for an empty side). The empty-base semantics — delete
// vs write-0-byte vs the deferred "\n" guard — now live in commit7Step's
// baseCommitAction (it has the AutosaveMeta the decision needs: baseExistedAtStart
// + baseShaAtStart). Pushing the guard down to the commit means an empty
// delete-vs-modify resolution can DELETE the base instead of materialising a
// stub. The §5.0.e single-write paths (commitUnchangedSide/commitToAlt) keep
// their own empty→"\n" guard since they do not route through commit7Step.
export function resolvedFromView(view: EditorView): ResolvedSides {
  const { base, sibling } = splitModel(view.state.doc.toString(), readStructure(view.state));
  return { base, sibling };
}

export class DiffPaneOwner {
  private readonly view: EditorView;
  // ONE shared instance — into the feed hooks (below) AND replayWithGuard (trap-2).
  private readonly flag = new ReplayFlag();
  private readonly writer: HistoryWriterV2;
  private readonly cursorScheduler: CursorScheduler;
  private cursorFlushing = false;

  // `startSeq` continues a resumed history.jsonl's seq (scanHistoryV2(jsonl).
  // blocks.length); 0 for a fresh session. `config` = device labels + join date +
  // isMarkdown (drives marker decorations + the derived ResolveOpts).
  constructor(
    private readonly vault: Vault,
    private readonly conflictId: string,
    parent: HTMLElement,
    base: string,
    sibling: string,
    config: DiffViewConfig,
    startSeq: number,
    private readonly logger?: Logger,
    // §2.2.15 — fired on every doc/selection change so the view can refresh the toolbar.
    onUpdate?: () => void,
  ) {
    // §0.5.5 threshold-trigger: the writer fires this on its tail when the log
    // crosses 100 undos / 200KB cancelled. compactSessionLog rewrites the on-disk
    // log + returns the new block count (→ the writer resets seq). Mutually
    // exclusive with appends (runs on the tail) → race-free.
    this.writer = new HistoryWriterV2(vault, conflictId, startSeq, () =>
      compactSessionLog(vault, conflictId),
    );
    this.cursorScheduler = new CursorScheduler(() => this.flushCursor());
    this.view = mountDiffPaneV2(parent, base, sibling, {
      sink: this.writer,
      flag: this.flag,
      config,
      onActivity: (a) => {
        // Skip cadence scheduling during a replay (its re-dispatches are doc
        // changes too); live typing/nav still schedules.
        if (!this.flag.replaying) this.cursorScheduler.schedule(a);
      },
      onUpdate, // §2.2.15 toolbar live-refresh
      // bug-56 monitoring — permanent undo/redo balance log (debit=credit watch).
      onUndoRedo: (info) => this.logger?.info("diff2 undo/redo", info),
    });
  }

  // ── §2.2.15 toolbar surface ────────────────────────────────────────────────
  // Live state for the toolbar (count + nav/undo/redo disabled), recomputed per update.
  toolbarState(): { conflictCount: number; hasPrev: boolean; hasNext: boolean; canUndo: boolean; canRedo: boolean } {
    const ranges = readStructure(this.view.state);
    const caret = this.view.state.selection.main.head;
    return {
      conflictCount: conflictCount(ranges),
      hasPrev: prevConflict(ranges, caret) !== null,
      hasNext: nextConflict(ranges, caret) !== null,
      canUndo: undoDepth(this.view.state) > 0,
      canRedo: redoDepth(this.view.state) > 0,
    };
  }

  undo(): void {
    cmUndo(this.view);
    this.view.focus();
  }
  redo(): void {
    cmRedo(this.view);
    this.view.focus();
  }
  navPrev(): void {
    gotoAdjacentConflict(this.view, false); // no-op at the first conflict
    this.view.focus(); // toolbar click must return focus to the editor (caret + hotkeys)
  }
  navNext(): void {
    gotoAdjacentConflict(this.view, true); // no-op at the last conflict
    this.view.focus();
  }

  // Auto-focus: scroll to the FIRST remaining conflict (caret at its ver1.from). No-op if none.
  focusFirstConflict(): void {
    const g = firstConflict(readStructure(this.view.state));
    if (g) scrollToConflict(this.view, g.from);
  }

  // §2.2.15 live mode toggles (per-session) — reconfigure the Compartments.
  setTouchOnly(on: boolean): void {
    this.view.dispatch({ effects: touchOnlyComp.reconfigure(touchOnlyFacet.of(on)) });
    this.view.contentDOM.inputMode = on ? "none" : ""; // facet-driven changeFilter handles edits; keyboard is a DOM attr
  }
  setWordLevel(on: boolean): void {
    this.view.dispatch({ effects: wordLevelComp.reconfigure(wordLevelFacet.of(on)) });
  }

  // Replay a saved history.jsonl into the live view (resume/recovery). The SHARED
  // flag suppresses the feed listener for the WHOLE replay — edit re-dispatches
  // carry replayDispatch, but undo(view)/redo(view) build un-annotatable txs, so
  // the flag is what keeps them out of the log (history-feed trap-2).
  replayWithGuard(jsonl: string): ReplayResultV2 {
    return replayWithGuard(this.view, jsonl, this.flag);
  }

  // Bulk resolve every group toward `choice` (interim toolbar — see
  // [[project-diff2-toolbar-redesign]]). One transaction → one undo step → one
  // recorded block. The module-level applyResolveAll derives opts from the view config.
  applyResolveAll(choice: ResolveChoice, opts?: ResolveOpts): boolean {
    return applyResolveAll(this.view, choice, opts);
  }

  getResolved(): ResolvedSides {
    return resolvedFromView(this.view);
  }

  // §2.9 cursor restore (resume). Selection-only, addToHistory:false → not an
  // undo step and not recorded (classifyFeed skips non-docChanged). Clamped to
  // the replayed doc (which may have shrunk). Focuses so Ctrl/Cmd+Z works at once.
  setCursor(anchor: number, head: number, scrollTop = 0): void {
    const c = clampCursor({ anchor, head }, this.view.state.doc.length);
    this.view.dispatch({
      selection: EditorSelection.range(c.anchor, c.head),
      annotations: Transaction.addToHistory.of(false),
    });
    this.view.scrollDOM.scrollTop = scrollTop;
    this.view.focus();
  }

  // §4.1 — net trustworthy edits THIS session holds IN MEMORY (fresh sessions):
  // net = totalEntries − 2·undoCount (redo cancels). A RESUMED session's prior
  // edits are NOT in memory, so the exit-commit recordCount reads the full
  // history.jsonl from disk instead — this is only the synchronous abandon-wipe
  // signal for a genuinely fresh dir.
  // TODO §21 — the live RAW resolved sides (base = normal+ver1, sibling = normal+ver2), for the
  // content-SHA dirty check (isResolvedPristine). Cheap: reads the doc + structure, no SHA here.
  resolvedSides(): ResolvedSides {
    return resolvedFromView(this.view);
  }

  inMemoryNetEdits(): number {
    // undoDepth = steps back to the session's STARTING doc. 0 ⇔ the doc is pristine (the [undo]
    // toolbar button is greyed) ⇔ no unsaved changes — the SAME signal the toolbar already uses
    // for canUndo. The old `totalEntries − 2·undoCount` heuristic mis-counted GROUPED undos, so a
    // doc undone all the way back to the start still read as edited → the §21 "modified" modal
    // (and the §4.1 abandon-wipe's "worthless session" test) were wrong. undoDepth is exact.
    return undoDepth(this.view.state);
  }

  // [← back] Step-1 flush barrier (§2.8) — await every scheduled append before
  // the commit removes the dir.
  drainHistory(): Promise<void> {
    return this.writer.drain();
  }

  // Cancel any pending cursor flush — MUST run before the commit path stages/
  // removes the autosave dir (a fired timer would persist into a torn dir).
  stopCursorTimer(): void {
    this.cursorScheduler.stop();
  }

  getView(): EditorView {
    return this.view;
  }

  focus(): void {
    this.view.focus();
  }

  dispose(): void {
    this.cursorScheduler.stop();
    this.view.destroy();
  }

  // §2.9 — the scheduler's flush thunk. Re-reads the LIVE selection (ignores any
  // stale passed position) and ping-pong-persists it. Fire-and-forget; cursor is
  // a best-effort signal. `cursorFlushing` drops an overlapping flush.
  private flushCursor(): void {
    if (this.cursorFlushing) return;
    const sel = this.view.state.selection.main;
    this.cursorFlushing = true;
    void persistCursor(this.vault, this.conflictId, {
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: this.view.scrollDOM.scrollTop,
    })
      .catch((e) => this.logger?.warn("diff2 cursor flush failed", { err: String(e) }))
      .finally(() => {
        this.cursorFlushing = false;
      });
  }
}
