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
import { splitModel } from "./diff-model";
import { readStructure } from "./diff-structure";
import { type DiffViewConfig, mountDiffPaneV2 } from "./diff-pane-v2";
import { HistoryWriterV2 } from "./history-log-v2";
import { ReplayFlag, replayWithGuard } from "./history-feed";
import { applyResolveAll, type ResolveChoice, type ResolveOpts } from "./diff-resolve";
import { CursorScheduler, type CursorActivity } from "./cursor-timer";
import { clampCursor, persistCursor } from "./cursor-store";
import type { ResolvedSides } from "./exit-commit";
import type Logger from "../logger";

// splitModel + the §5.0 empty→"\n" guard (SYNC2 §2.9 zero-byte-restore: a 0-byte
// write would trip the restore guard, so an emptied side commits as "\n", the
// canonical minimal non-empty file). Shared by owner.getResolved() AND the
// detached §3.2.a extraction, so done.json hashes EXACTLY the bytes we commit.
export function resolvedFromView(view: EditorView): ResolvedSides {
  const { base, sibling } = splitModel(view.state.doc.toString(), readStructure(view.state));
  return { base: base === "" ? "\n" : base, sibling: sibling === "" ? "\n" : sibling };
}

export class DiffPaneOwner {
  private readonly view: EditorView;
  // ONE shared instance — into the feed hooks (below) AND replayWithGuard (trap-2).
  private readonly flag = new ReplayFlag();
  private readonly writer: HistoryWriterV2;
  private readonly cursorScheduler: CursorScheduler;
  private cursorFlushing = false;
  // Bulk resolve-all (interim toolbar) reuses the view config's join header.
  private readonly resolveOpts: ResolveOpts;

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
  ) {
    this.resolveOpts = { label: config.remoteLabel, date: config.date };
    this.writer = new HistoryWriterV2(vault, conflictId, startSeq);
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
    });
  }

  // Replay a saved history.jsonl into the live view (resume/recovery). The SHARED
  // flag suppresses the feed listener for the WHOLE replay — edit re-dispatches
  // carry replayDispatch, but undo(view)/redo(view) build un-annotatable txs, so
  // the flag is what keeps them out of the log (history-feed trap-2).
  replayWithGuard(jsonl: string): void {
    replayWithGuard(this.view, jsonl, this.flag);
  }

  // Bulk resolve every group toward `choice` (interim toolbar — see
  // [[project-diff2-toolbar-redesign]]). One transaction → one undo step → one
  // recorded block. opts defaults to the constructor's resolveOpts via the view.
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
  inMemoryNetEdits(): number {
    const s = this.writer.getStats();
    return Math.max(0, s.totalEntries - 2 * s.undoCount);
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
