// S2 of the panel/editor split (docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// `DiffDetailController` owns the diff-edit DETAIL engine — the DiffPaneOwner
// lifecycle, the recovery/resume flow, the toolbar, and the `[←]` 7-step commit —
// extracted VERBATIM out of `DiffEditView` so the same engine can drive both the
// current single-tab host (panel detail-mode, today) and the future multi-tab
// `DiffEditorView` (S3+). This is a behavior-preserving extract: every decision the
// old `DiffEditView.renderDetail`/`mountDiffPane`/`exitDetailView` made is unchanged.
//
// The only seam between engine and host is navigation: the controller never knows
// whether it lives in a list↔detail state-machine (old host → render(list)) or in a
// dedicated editor tab (new host → leaf.detach() + reveal panel). It calls back
// through `DiffDetailHost` for exactly that — the post-commit / cancel NAVIGATION,
// and the stale-state targeting check after a long await/modal.
//
// Lifetime: per-VIEW (the host creates one in onOpen, disposes it in onClose). The
// mount/dispose cycle happens INSIDE; view-level concerns (escScope, Mod+F window
// keydown, ConflictCounter subscription) stay in the host.

import { type App, Notice } from "obsidian";
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { DiffPaneOwner, resolvedFromView } from "./diff-pane-owner";
import {
  type DiffEditorMode,
  type DiffEditorSearchContext,
  type DiffViewConfig,
  mountDiffPaneV2,
} from "./diff-pane-v2";
import { formatConflictTimestamp } from "./strip-conflict-suffix";
import { sessionHasValue } from "./editor-tabs";
import { toLf } from "./eol";
import { isMarkdownPath } from "./conflict-merge-all";
import {
  autosaveDir,
  classifyReopen,
  readResumeSession,
  startSession,
  type AutosaveMeta,
  type ResumeSession,
} from "./autosave-store";
import { reopenAction } from "./reopen-action";
import {
  EmptyDeleteModal,
  ResumeRecoveryModal,
  SaveToAltModal,
} from "./recovery-dialog";
import { assessHistoryV2, replayHistoryV2, scanHistoryV2 } from "./history-replay-v2";
import { compactSessionLog } from "./history-rewrite";
import { readCursor } from "./cursor-store";
import { atomicWriteFile } from "../sync2/atomic-write";
import {
  commitOrDiscardExit,
  commitToAlt,
  commitUnchangedSide,
  guardEmpty,
  isResolvedPristine,
  type ResolvedSides,
  type ToctouStatus,
} from "./exit-commit";
import {
  autosaveIdForEntry,
  type ConflictEntry,
} from "./synthetic-detector";
import { type DiffToolbarHandle, renderDiffToolbar } from "./diff-toolbar";
import type { DiffEditViewDeps } from "./diff-panel-view";
import { calculateGitBlobSHA } from "../utils";

// The navigation seam. Composition, NOT a base class: the controller asks the host
// to perform the parts that differ between the single-tab panel host and the
// multi-tab editor host. Everything else (owner lifecycle, commit, modals) is the
// controller's own; it checks `!body.isConnected` itself — the host only answers
// the viewState-targeting question.
export interface DiffDetailHost {
  // Stale-state guard after an await / a minutes-long modal: is THIS entry still
  // the one the host is showing? old host → viewState.mode==="detail" && same
  // sibling; new editor host → always true (one pair per tab).
  isStillTargeting(entry: ConflictEntry): boolean;
  // Leaving detail without a commit (cancel / no session): old host → render(list);
  // new host → leaf.detach().
  onLeaveDetail(): void;
  // `[←]` committed successfully: old host → render(list); new host → detach +
  // reveal panel + scroll (S5).
  onCommitExit(entry: ConflictEntry): void;
}

export class DiffDetailController {
  // §2.2.15 toolbar — the live handle (update on every owner change) + per-session
  // Auto-focus state + the last conflict count (to detect a resolve = count
  // decrease → focus first).
  private toolbarHandle: DiffToolbarHandle | null = null;
  private autoFocus = false;
  // TODO §17 — external search context captured at mount() (history/deleted from a searched
  // list). Drives the open-focus priority over Auto-focus. null in conflict mode / no search.
  private openSearch: DiffEditorSearchContext | null = null;
  private prevConflictCount = 0;
  // Active V2 DiffPaneOwner lives only while detail-mode is shown. Replaced on every
  // mount; disposed when leaving detail-mode or on view close. The owner holds the
  // EditorView + the shared ReplayFlag + the HistoryWriterV2 sink + the cursor
  // scheduler (§0.5 / P6.3).
  private owner: DiffPaneOwner | null = null;
  // Autosave session bound to the active owner: the conflict's autosave id + the
  // meta startSession wrote + whether this mount REPLAYED prior edits. Set at mount,
  // consumed by the `[←]` commit7Step, cleared on dispose. Null when no detail editor
  // is open. `hadPriorEdits` gates the §4.1 abandon-wipe: a FRESH session abandoned
  // with zero net edits is wiped; a resumed one is kept for crash recovery (its prior
  // edits aren't in the owner's in-memory writer).
  private activeSession:
    | {
        conflictId: string;
        meta: AutosaveMeta;
        hadPriorEdits: boolean;
        // 7a.3 — a History session commits via commitUnchangedSide("base") (writes
        // only currentFile, never the read-only version), NOT commit7Step. Hung on
        // the session so exit() can't desync it from the session lifecycle.
        isHistory?: boolean;
      }
    | null = null;
  // Step-0 (§5.0) — re-entrancy guard for the `[←]` commit. Set true on entry to
  // exit(), reset in its finally. A second click while a commit (or its §5.0.e modal)
  // is in flight is rejected — two concurrent commit7Step runs on the same dir would
  // leave undefined vault state (the race between steps 2–7).
  private committing = false;

  constructor(
    private readonly app: App,
    private readonly deps: DiffEditViewDeps,
    private readonly host: DiffDetailHost,
  ) {}

  // gap-1 — the view-host Mod+F handler reads the live EditorView through the
  // controller (the owner is private). Null when no detail editor is mounted.
  getView(): EditorView | null {
    return this.owner?.getView() ?? null;
  }

  // §2.2.17 — toggle the CM6 search panel (shared by Mod+F and the toolbar lens
  // button).
  toggleSearch(): void {
    const v = this.owner?.getView();
    if (!v) return;
    if (searchPanelOpen(v.state)) closeSearchPanel(v);
    else openSearchPanel(v);
  }

  // gap-2 — idempotent. The old host calls this from render() (top, before re-render)
  // AND from onClose(); calling twice must not double-fire the §4.1 abandon-wipe.
  // `reload` (TODO §21) — this is a REPLACE, not an abandon: the SAME per-file autosave dir will
  // host the next version, so DON'T fire the async abandon-wipe here (it would race the caller's
  // awaited dir-clear + new startSession). The caller clears the dir explicitly, ordered.
  dispose(reload = false): void {
    const session = this.activeSession;
    // §4.1 net-edit signal — read BEFORE dispose (owner.dispose stops the cursor
    // timer + destroys the view). For a FRESH session this in-memory net count is
    // authoritative; a resumed session is handled by `hadPriorEdits` below.
    const netEdits = this.owner?.inMemoryNetEdits() ?? 0;
    this.deps.logger?.info("diff2 disposeOwner", { hadOwner: !!this.owner, hadToolbar: !!this.toolbarHandle });
    this.owner?.dispose();
    this.owner = null;
    this.toolbarHandle = null; // §2.2.15 — toolbar DOM is rebuilt on the next mount
    this.prevConflictCount = 0;
    // §4.1 zero-edit invariant: a session ABANDONED (sub-tab switch / view close, the
    // "інший механізм" exit) with no recovery value → wipe its dir (fire-and-forget;
    // the onload sweep is the backstop). A FRESH session is worthless iff it recorded
    // zero net edits; a RESUMED session (hadPriorEdits) always carries prior on-disk
    // edits a crash should keep, so it is NEVER wiped here. The committed/discarded
    // `[←]` path nulls activeSession before navigation, so this only fires on a genuine
    // abandon (the host's counter-guard prevents a spurious detail-mode re-render).
    if (!reload && session && !sessionHasValue(netEdits)) {
      void this.deps.vault.adapter
        .rmdir(autosaveDir(session.conflictId), true)
        .catch(() => {
          /* best-effort; onload sweep is the backstop */
        });
    }
    this.activeSession = null;
  }

  // TODO §21 — does this editor hold unsaved work? CONTENT-AUTHORITATIVE: dirty iff the live
  // resolved sides differ from the session-start SHAs (isResolvedPristine) — immune to undo/redo
  // bookkeeping AND manual add-then-remove (both leave undoDepth > 0 at identical content, which
  // used to keep the "already modified" warning up). The p.21 open-guard reads this to decide
  // reload (clean) vs the warning. Deliberately SPLIT from dispose()'s §4.1 abandon-wipe, which
  // stays on the SYNC undoDepth signal: the only divergence is manual-add-then-remove (undoDepth>0
  // keeps the dir, isPristine says clean) → a content-identical dir the onload sweep reclaims. No
  // data loss, no stuck modal, and dispose() stays synchronous. undoDepth also still drives the
  // toolbar's canUndo — a separate, legitimate use.
  async hasUnsavedChanges(): Promise<boolean> {
    const session = this.activeSession;
    if (!session || !this.owner) return false;
    return !(await isResolvedPristine(this.owner.resolvedSides(), session.meta));
  }

  // TODO §21 resume-move — flush pending edits to the autosave dir (history.jsonl) BEFORE the
  // editor is closed for a move, so the new leaf's SILENT RESUME restores the latest keystrokes.
  // Same §2.8 drain barrier the `[←]` commit uses.
  async flushForReload(): Promise<void> {
    await this.owner?.drainHistory();
  }

  // §2.2.15 — refresh the toolbar's live state on every owner update (count + nav/undo/
  // redo disabled). Auto-focus: a resolve dropped the conflict count → scroll to the
  // first remaining conflict (count-decrease guard prevents a feedback loop from the
  // scroll's own selection-set update). Called via the owner's onUpdate hook + once
  // after owner mount.
  private refreshToolbar(): void {
    if (!this.owner || !this.toolbarHandle) {
      this.deps.logger?.info("diff2 refreshToolbar SKIP", {
        hasOwner: !!this.owner,
        hasToolbar: !!this.toolbarHandle,
      });
      return;
    }
    const s = this.owner.toolbarState();
    this.toolbarHandle.update(s);
    // Record the new count BEFORE focusFirstConflict(): its scrollToConflict dispatches a
    // selection-set transaction that RE-ENTERS refreshToolbar synchronously (onUpdate fires
    // on selectionSet). Updating prevConflictCount first makes that re-entrant call see
    // conflictCount == prevConflictCount → the count-decrease guard is false → no re-focus,
    // no infinite recursion (was: RangeError "Maximum call stack size exceeded").
    const dropped = this.autoFocus && s.conflictCount > 0 && s.conflictCount < this.prevConflictCount;
    this.prevConflictCount = s.conflictCount;
    if (dropped) this.owner.focusFirstConflict();
  }

  // §2.2.15 — Auto-focus the first conflict, DEFERRED past layout. On a just-mounted
  // view the scroll/caret silently no-op (the view isn't measured yet) — that was the
  // intermittent "auto-focus didn't work on open". rAF runs after CM6's measure cycle.
  // No-op when the flag is off or the owner is gone (disposed / re-rendered).
  private autoFocusFirst(): void {
    // TODO §17 — an external search phrase (history/deleted opened from a searched list) has
    // HIGHER priority than Auto-focus: scroll to the first MATCH on open, regardless of the
    // Auto-focus toggle. Engine (@codemirror/search) + 7b source pending — this is the seam.
    if (this.openSearch?.query) {
      this.focusFirstSearchMatch();
      return;
    }
    if (!this.autoFocus) return;
    requestAnimationFrame(() => this.owner?.focusFirstConflict());
  }

  // TODO §17 — search-driven initial focus (higher priority than Auto-focus). No-op until the
  // Ctrl+F search engine + the 7b list-filter that supplies the phrase are wired; the seam
  // (openSearch + this call site) is in place so lighting it up needs no controller change.
  private focusFirstSearchMatch(): void {
    this.deps.logger?.info?.("diff2 §17 search-driven focus (engine pending)", {
      query: this.openSearch?.query,
    });
  }

  // bug-56 pre-flight — how many edits would ACTUALLY be recovered, with NO side
  // effects. replayHistoryV2 stops at the first un-appliable block (a diverged/corrupt
  // tail), so the real recovery may restore fewer than the raw block count. We learn
  // that here by replaying into a throwaway, sink-less view (no hooks → no history
  // written; `destroy()` after), so the Resume modal's "NNN edits saved" == what
  // `Continue` (the same stop-on-error replay) really restores. 0 → nothing to resume →
  // caller starts fresh (silently).
  private dryRunRecoverableEdits(base: string, sibling: string, jsonl: string): number {
    const t0 = performance.now();
    const host = document.createElement("div"); // detached; replay is pure state, no measure
    const dv = mountDiffPaneV2(host, base, sibling);
    const res = replayHistoryV2(dv, jsonl);
    dv.destroy();
    const recoverable = res.stoppedAtError
      ? assessHistoryV2(jsonl.split("\n").slice(0, res.replayed).join("\n")).edits // net edits over the SAFE prefix
      : assessHistoryV2(jsonl).edits;
    // perf — this dry-run is the pre-modal lag. A full second replay happens on
    // Continue (mountReplayed). Watch these to decide if a replay-once reorder is worth
    // it for big files.
    this.deps.logger?.info("diff2 dry-run (pre-modal)", {
      recoverable,
      replayedBlocks: res.replayed,
      docBytes: base.length + sibling.length,
      ms: Math.round(performance.now() - t0),
    });
    return recoverable;
  }

  // Build the detail DOM (toolbar + body) and load the owner. The host calls this once
  // per detail open; S3's editor host gets identical DOM for free (no scaffold to
  // replicate). The async owner-load runs after the synchronous scaffold, so the
  // toolbar/body appear immediately (same as the old `void mountDiffPane`).
  // `opts.silentResume` (1B / R-C2): a restart-RESTORE is a continuation, not a crash —
  // resume the recorded edits WITHOUT the ResumeRecoveryModal. Only affects the "resume"
  // branch (a clean restart can't change the vault, so classifyReopen lands there); a
  // user-reopen passes it false and gets the modal.
  async mount(
    parent: HTMLElement,
    entry: ConflictEntry,
    opts?: {
      silentResume?: boolean;
      // 7a.3 (History) — when set, `entry` is a history session (base===sibling===
      // currentFile). The base is a READ-ONLY historical version fetched LAZILY
      // (`fetchBytes`, consumed ONLY on the fresh path — resume reads snapshots, so
      // a resume works offline). `classifyReopen`/`startSession` get ignoreBase/
      // readOnlyBase; commit routes to commitUnchangedSide. Absent ⇒ conflict path
      // is textually today's code.
      history?: { versionSha: string; fetchBytes: () => Promise<ArrayBuffer> };
      // TODO §17 — external search context (history/deleted opened from a searched list). Seam
      // only for now: stored + drives the open-focus priority; engine/source wired later.
      search?: DiffEditorSearchContext;
    },
  ): Promise<void> {
    const history = opts?.history;
    this.openSearch = opts?.search ?? null;
    // TODO §17 — the diff-editor runs in three modes with mode-specific side labels + button
    // verbs (Deleted reuses History). CONFLICT: ver1 = the literal "Local" (the base-file on
    // THIS machine — a user who never renamed their device would otherwise see "Obsidian" vs
    // "Obsidian", useless), ver2 = the remote's deviceLabel. HISTORY/DELETED: the roles flip —
    // ver1 = the past/deleted VERSION, labelled by its DATE (version date / deletion date) in
    // the standard "YYYY-MM-DD HH:MM:SS" form — NOT the deviceLabel (which the user reads off
    // the history/deleted LIST). ver2 = "Actual" (the current file).
    const mode: DiffEditorMode = history ? "history" : "conflict";
    const localSideLabel =
      mode === "conflict" ? "Local" : formatConflictTimestamp(entry.isoTimestamp);
    const remoteSideLabel = mode === "conflict" ? entry.deviceLabel : "Actual";
    const toolbar = parent.createDiv({ cls: "diff2-detail-toolbar" });
    this.renderToolbar(toolbar, entry, localSideLabel, remoteSideLabel, mode);
    // Mobile keyboard grab-strip ("tail1"): a 16px bar between the toolbar and the editor. It is the
    // bottom continuation of the collapsible header — mobile-header-clamp.ts hard-clamps the outer
    // scroll at the toolbar bottom, so the toolbar scrolls fully off but this strip stays as a handle
    // to drag it back. Shown only under body.is-mobile; a no-op (display:none) on desktop.
    parent.createDiv({ cls: "diff2-detail-kbd-strip" });
    // §title (Screenshot-17): the file identity lives in the VIEW HEADER
    // (getDisplayText), so the old in-body title row is dropped — saving a row for the
    // editor itself.
    const body = parent.createDiv({ cls: "diff2-detail-body" });

    const adapter = this.deps.vault.adapter;
    try {
      // bug-59 — the model hardcodes `\n` (and CM6 strips `\r`). Normalize the live
      // files' EOL to `\n` for the model; write-back restores the session EOL (meta.eol).
      // History: base (ours) is the read-only version, fetched lazily inside
      // startFreshAndMount (NOT from vault — basePath is currentFile, i.e. the sibling
      // side). `theirs` (currentFile) is read from the vault for both.
      let ours = "";
      if (!history) {
        const baseExists = await adapter.exists(entry.basePath);
        if (baseExists) {
          ours = toLf(await adapter.read(entry.basePath));
        }
      }
      const theirs = toLf(await adapter.read(entry.siblingPath));

      // Stale-state guard: bail if the user switched away during await.
      if (!this.host.isStillTargeting(entry) || !body.isConnected) {
        return;
      }

      // (§1.3 sentinel collision check removed — the V2 diff-model has no `\0`/`\1`
      // sentinels, so any byte is ordinary text; classifyReopen's defensive `sentinel`
      // branch is now unreachable.)

      // Autosave session lifecycle (DIFF-EDITOR.md §3.1 / §3.2 / §3.2.a). An in-flight
      // commit (done.json) is NEVER touched here — onload recoverCommit finishes it
      // before any mount (§5.0.a precedence); bail defensively if one is present.
      const conflictId = autosaveIdForEntry(entry);
      const dir = autosaveDir(conflictId);
      if (await adapter.exists(`${dir}/done.json`)) {
        new Notice(
          "A previous save for this conflict is still recovering. " +
            "Reload the plugin and reopen.",
        );
        return;
      }
      // §0.5.5 carousel REOPEN-trigger: compact history.jsonl BEFORE classifying /
      // showing the Resume modal, so the modal's "edits saved" + the replay use the
      // compacted log. Safe here — the done.json guard above already excluded a
      // commit-in-flight (the one window where compaction must not run), and there is
      // no live undo stack yet. Conservative: nothing reachable is lost.
      await compactSessionLog(this.deps.vault, conflictId);

      // Classify the reopen → action (pure dispatch, W4c Step A).
      const action = reopenAction(
        await classifyReopen(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
          history !== undefined, // Contract A — History base is snapshot-only.
        ),
      );
      this.deps.logger?.info("diff2 reopenAction", { kind: action.kind, base: entry.basePath, hasToolbar: !!this.toolbarHandle });

      // View config threaded through the owner into the V2 pane: device labels
      // (top/bottom markers), join date, and isMarkdown (Join-button gate). The owner
      // derives the resolve ResolveOpts {label: remoteLabel, date} from it.
      const config: DiffViewConfig = {
        localLabel: localSideLabel, // TODO §17 — "Local" (conflict) / version label (history)
        remoteLabel: remoteSideLabel, // TODO §17 — remote deviceLabel (conflict) / "Actual" (history)
        date: entry.isoTimestamp,
        isMarkdown: isMarkdownPath(entry.basePath),
        mode, // TODO §17 — drives ver-block button verbs + Join gate
        touchOnly: this.deps.touchOnly?.() ?? false, // §2.2.14 read-only mode (Settings)
        wordLevelDiff: this.deps.diffWordLevel?.() ?? false, // word vs char highlight (Settings)
      };

      // Clear any prior dir, open a fresh session, and mount the owner from the CURRENT
      // vault bytes. Used by fresh / discard-fresh and the "Start over" choices. A fresh
      // session has no prior edits → hadPriorEdits:false.
      const startFreshAndMount = async (): Promise<void> => {
        const tFresh = performance.now();
        if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
        // History — fetch the read-only version bytes ONLY here (the fresh path).
        // RAW bytes: startSession recomputes baseShaAtStart + normalizes internally;
        // `ours` (the model's base side) is the \n-normalized decode.
        let readOnlyBase: { bytes: ArrayBuffer } | undefined;
        if (history) {
          const bytes = await history.fetchBytes();
          // The version fetch is a (multi-second) network call — the ONLY guard ran
          // before it. Re-check here so closing the tab mid-fetch doesn't create a
          // live owner/session into a detached body (a "ghost editor" + leaked dir).
          // Return BEFORE startSession so no dir is created either.
          if (!body.isConnected) return;
          readOnlyBase = { bytes };
          ours = toLf(new TextDecoder().decode(bytes));
        }
        const meta = await startSession(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
          undefined,
          readOnlyBase,
        );
        this.deps.logger?.info("diff2 fresh-mount", {
          base: entry.basePath,
          history: history !== undefined,
          docBytes: ours.length + theirs.length,
          ms: Math.round(performance.now() - tFresh),
        });
        this.activeSession = {
          conflictId,
          meta,
          hadPriorEdits: false,
          isHistory: history !== undefined,
        };
        this.owner = new DiffPaneOwner(
          this.deps.vault,
          conflictId,
          body,
          ours,
          theirs,
          config,
          0, // fresh history.jsonl seq
          this.deps.logger,
          () => this.refreshToolbar(), // §2.2.15 toolbar live-refresh
        );
        this.refreshToolbar(); // seed the toolbar's initial count/disabled state
        this.autoFocusFirst(); // §2.2.15 — focus the first conflict on a fresh open (deferred)
      };

      // Non-lossy mount: rebuild the owner from the session-start SNAPSHOTS, replay the
      // recorded history under the shared ReplayFlag, restore the cursor. KEEPS the dir
      // and REUSES the session (never startSession, which would overwrite the snapshots
      // / history being replayed). Continues the history.jsonl seq. hadPriorEdits:true —
      // its prior on-disk edits are real recovery value, so it is never abandon-wiped.
      const mountReplayed = async (
        sess: ResumeSession,
        meta: AutosaveMeta,
      ): Promise<void> => {
        const owner = new DiffPaneOwner(
          this.deps.vault,
          conflictId,
          body,
          sess.base,
          sess.sibling,
          config,
          scanHistoryV2(sess.jsonl).blocks.length,
          this.deps.logger,
          () => this.refreshToolbar(), // §2.2.15 (no-op until this.owner is set below)
        );
        const tReplay = performance.now();
        const replayRes = owner.replayWithGuard(sess.jsonl);
        this.deps.logger?.info("diff2 recovered", {
          base: entry.basePath,
          replayedBlocks: replayRes.replayed,
          docBytes: sess.base.length + sess.sibling.length,
          ms: Math.round(performance.now() - tReplay),
        });
        if (replayRes.stoppedAtError) {
          // §2.2.15 recovery monitoring — a diverging history stopped at a safe prefix
          // (the user re-resolves the rest). Permanent log: catch recurrences + their
          // signature.
          this.deps.logger?.info("diff2 replay STOPPED (divergence)", {
            base: entry.basePath,
            ...replayRes.stoppedAtError,
            replayed: replayRes.replayed,
          });
        }
        const cursor = await readCursor(this.deps.vault, conflictId);
        if (cursor) {
          owner.setCursor(cursor.anchor, cursor.head, cursor.scrollTop);
        }
        this.activeSession = {
          conflictId,
          meta,
          hadPriorEdits: true,
          isHistory: history !== undefined,
        };
        this.owner = owner;
        this.refreshToolbar(); // §2.2.15 seed toolbar after replay mount
        // §2.2.15 — Auto-focus ON overrides the restored cursor: jump to the first
        // conflict (user: cursor-restore is the right resume behaviour ONLY when
        // Auto-focus is OFF).
        this.autoFocusFirst();
      };

      try {
        // §4.5.2/§4.5.7 (A1) — History mounts ALWAYS FRESH (never resume). Per-file
        // keying means the session dir can't tell WHICH version it holds, so a stale
        // dir (a prior version's crashed session for the same file) must NOT be resumed
        // — that would mount the WRONG version's base. startFreshAndMount rmdirs the
        // stale dir + startSession's the REQUESTED version. (Pre-B3 there is no marker-
        // restore, so every History open is a fresh "show this version"; version-aware
        // resume becomes valid only once B3's marker reopens the exact version.) Base is
        // immutable anyway, so the conflict "restore" branch would clobber currentFile.
        // Falls through to the shared `this.owner?.focus()` below like the normal cases.
        if (history) {
          this.deps.logger?.info("diff2 history mount → fresh", {
            base: entry.basePath,
            action: action.kind,
          });
          await startFreshAndMount();
        } else
        switch (action.kind) {
          case "fresh":
          case "discard-fresh":
            await startFreshAndMount();
            break;
          case "restore": {
            // §3.2.a — EXACTLY ONE vault side changed under the session. Reuse the §3.2
            // ResumeRecoveryModal (a "*" marks the changed file — no scary "files
            // changed" dialog; it is just crash recovery).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // §3.5 + bug-56 pre-flight: how many edits would ACTUALLY recover (dry-run,
            // stops safely). 0 → nothing to restore (empty OR a fully un-replayable log)
            // → skip the modal, start fresh from the CURRENT vault (which reflects the
            // one-side change).
            const recoverable = this.dryRunRecoverableEdits(sess.base, sess.sibling, sess.jsonl);
            if (recoverable === 0) {
              this.deps.logger?.info("diff2 resume(changed) → fresh (0 recoverable)", { base: entry.basePath });
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: recoverable, // bug-56 — the real recoverable count, == what Continue restores
              baseChanged: action.changedSide === "base",
              siblingChanged: action.changedSide === "sibling",
              nowMs: Date.now(),
            }).prompt();

            // ❗Re-assert the stale-state guard after the (minutes-long) modal.
            if (!this.host.isStillTargeting(entry) || !body.isConnected) {
              return;
            }

            if (choice === "cancel") {
              this.host.onLeaveDetail();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "Continue": replay (in a DETACHED V2 view) to extract the user's resolved
            // content, write the restored content of the UNCHANGED side onto the vault
            // (the changed side keeps its new content), then recreate the session.
            // Symmetric — file1/file2, no privilege.
            const resolved = extractResolved(sess.base, sess.sibling, sess.jsonl);
            const writePath =
              action.changedSide === "base"
                ? entry.siblingPath
                : entry.basePath;
            // guardEmpty: this is a single direct write (not commit7Step), so an emptied
            // unchanged side must stay a benign 1-byte "\n", never a 0-byte file the next
            // sync would resurrect (SYNC2 §2.9). Same rule as the §5.0.e
            // commitUnchangedSide path.
            const writeStr = guardEmpty(
              action.changedSide === "base" ? resolved.sibling : resolved.base,
            );
            await atomicWriteFile(
              this.deps.vault,
              writePath,
              new TextEncoder().encode(writeStr).buffer as ArrayBuffer,
            );
            if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
            const meta = await startSession(
              this.deps.vault,
              conflictId,
              entry.basePath,
              entry.siblingPath,
            );
            // A brand-new session mounted from the just-written snapshots — no replay
            // into the live view → hadPriorEdits:false (the restored work is already
            // durable in the unchanged-side file).
            this.activeSession = { conflictId, meta, hadPriorEdits: false };
            const fresh = await readResumeSession(this.deps.vault, conflictId);
            this.owner = new DiffPaneOwner(
              this.deps.vault,
              conflictId,
              body,
              fresh.base,
              fresh.sibling,
              config,
              0,
              this.deps.logger,
              () => this.refreshToolbar(), // §2.2.15 toolbar live-refresh
            );
            this.refreshToolbar();
            this.autoFocusFirst(); // §2.2.15 — focus first conflict on (vault-changed) fresh open (deferred)
            break;
          }
          case "resume": {
            // §3.2 — vault unchanged since session start. Offer replay-resume vs fresh.
            // editCount = the trustworthy-prefix block count, i.e. exactly what
            // replayFrom will apply (so the dialog can't promise more than it restores).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // 1B (R-C2) — a silent restart-restore is a continuation: NO modal, and skip
            // the dry-run too (we don't display a count). Straight to mountReplayed, which
            // safely handles an empty/corrupt log (stop-at-error → safe prefix) and 0 edits
            // (snapshots == the unchanged vault). Halves the restart replay cost.
            // NB: unlike the modal path, this does NOT wipe a fully-corrupt (0-recoverable)
            // log — it mounts the snapshots (no loss on a clean restart) but leaves the bad
            // log to be re-hit next restart. Stale, not lossy; acceptable for a rare crash.
            if (opts?.silentResume) {
              this.deps.logger?.info("diff2 resume → silent (restore)", { base: entry.basePath });
              await mountReplayed(sess, action.meta);
              break;
            }
            // §3.5 + bug-56 pre-flight: a dry-run replay (stops safely) tells us how many
            // edits would ACTUALLY recover. 0 → nothing to resume (empty OR a fully
            // un-replayable / corrupt log) → skip the pointless modal, start fresh (wipe
            // + fresh session). This also subsumes the old `.empty` skip and silently
            // drops a broken history.jsonl.
            const recoverable = this.dryRunRecoverableEdits(sess.base, sess.sibling, sess.jsonl);
            if (recoverable === 0) {
              this.deps.logger?.info("diff2 resume → fresh (0 recoverable)", { base: entry.basePath });
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: recoverable, // bug-56 — real recoverable count == what Continue restores
              nowMs: Date.now(),
            }).prompt();

            // ❗The modal can sit open for minutes — re-assert the stale-state guard
            // before touching disk / mounting. The user may have switched to another
            // conflict; a stale Start-over would otherwise rmdir a dir the now-current
            // view is using.
            if (!this.host.isStillTargeting(entry) || !body.isConnected) {
              return;
            }

            if (choice === "cancel") {
              this.host.onLeaveDetail();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "continue": rebuild from the session-start SNAPSHOTS + replay (KEEP the
            // dir, REUSE the session — see mountReplayed).
            await mountReplayed(sess, action.meta);
            break;
          }
        }
        // TODO §6.1 — focus the freshly-mounted editor so the caret shows and
        // Ctrl/Cmd+Z works without a click. Cancel paths returned early; every mount
        // path set the owner. Idempotent on the resume-with-cursor path (setCursor
        // already focused).
        this.owner?.focus();
      } catch (err) {
        body.createEl("p", {
          cls: "diff2-detail-error",
          text: `Failed to start the edit session: ${String(err)}`,
        });
        return;
      }
    } catch (err) {
      body.createEl("p", {
        cls: "diff2-detail-error",
        text: `Failed to load diff: ${String(err)}`,
      });
    }
  }

  // R7.9a toolbar — [← Back] + group resolve buttons + Auto-advance toggle. Built once
  // per detail open into the `toolbar` element `mount` created; `refreshToolbar` keeps
  // its live state in sync thereafter.
  private renderToolbar(
    toolbar: HTMLElement,
    entry: ConflictEntry,
    localLabel: string, // TODO §17 — "Local" (conflict) / version label (history), from mount()
    remoteLabel: string, // TODO §17 — remote deviceLabel (conflict) / "Actual" (history)
    mode: DiffEditorMode,
  ): void {
    const isMd = isMarkdownPath(entry.basePath);
    // TODO §17 — Join is conflict-only (a version-restore never merges, even for markdown).
    const joinable = isMd && mode === "conflict";

    // §2.2.15 — per-session mode state seeded from Settings; toggled locally for this
    // view. resolve-all routes to the V2 owner (ours→keep1, theirs→keep2, join→join).
    // The join opts carry the conflict's label+date so the header reads "Changes from
    // `<device>` at <date>".
    // TODO §17 — auto-focus default is PER-MODE (conflict on / history+deleted off): you review
    // versions in history, you don't want an auto-jump to the first diff.
    this.autoFocus = this.deps.autoFocus?.(mode) ?? mode === "conflict";
    const joinOpts = { label: entry.deviceLabel, date: entry.isoTimestamp };
    this.toolbarHandle = renderDiffToolbar(
      toolbar,
      {
        localLabel,
        remoteLabel,
        isMarkdown: isMd,
        mode,
        // §2.2.14 — the toolbar shows the POSITIVE face (Editor mode = editing enabled);
        // deps.touchOnly is the read-only setting, so editorModeOn = !touchOnly.
        editorModeOn: !(this.deps.touchOnly?.() ?? false),
        autoFocusOn: this.autoFocus,
        diffMode: this.deps.diffWordLevel?.() ? "words" : "characters",
      },
      {
        onBack: () => void this.exit(entry),
        onSearch: () => this.toggleSearch(),
        onKeepAll: () => this.owner?.applyResolveAll("keep1"),
        onApplyAll: () => this.owner?.applyResolveAll("keep2"),
        onJoinAll: joinable ? () => this.owner?.applyResolveAll("join", joinOpts) : undefined,
        onPrev: () => this.owner?.navPrev(),
        onNext: () => this.owner?.navNext(),
        onUndo: () => this.owner?.undo(),
        onRedo: () => this.owner?.redo(),
        // The toolbar toggles must NOT steal the caret from the editor — clicking a
        // checkbox/select focuses it, so we hand focus straight back to the editor
        // (Auto-focus ON then jumps to the first conflict via autoFocusFirst; the others
        // just keep the caret put).
        onToggleEditorMode: (editable) => {
          this.owner?.setTouchOnly(!editable); // Editor mode ON ⇒ read-only OFF
          this.owner?.getView().focus();
        },
        onToggleAutoFocus: (on) => {
          this.autoFocus = on; // per-session JS flag; behaviour fires on resolve in refreshToolbar
          this.owner?.getView().focus();
          this.autoFocusFirst(); // §2.2.15 — enabling Auto-focus jumps to the first conflict NOW (deferred)
        },
        onSetDiffMode: (m) => {
          this.owner?.setWordLevel(m === "words");
          this.owner?.getView().focus();
        },
      },
    );
  }

  // `[←]` exit — the 7-step pair-atomic commit (DIFF-EDITOR.md §5.0). commit7Step
  // writes done.json (barrier) → stages base+sibling → promotes both → drops backups →
  // §6.5 proactive sibling cleanup (SHA(base)==SHA(sibling)) → rmdir's the autosave dir.
  // Pair-atomic: crash ⇒ both sides or neither, and recoverCommit at onload finishes or
  // rolls back any interrupted commit.
  //
  // Step-0 (§5.0): the `committing` re-entrancy guard below. Step-8 (history clear + →
  // navigation): the host's onCommitExit IS the success tail, and the CM6 history is
  // cleared by `view.destroy()` when the host disposes the owner (there is no
  // `historyClear` API, and the view is torn down anyway).
  //
  // §5.0.e TOCTOU (W5): when classifyToctou finds the vault changed under the session,
  // the SAME symmetric rule as §3.2.a-reopen applies — see resolveToctou. We NEVER
  // overwrite an externally-changed file.
  async exit(entry: ConflictEntry): Promise<void> {
    // Step-0 (§5.0) — reject a re-entrant `[←]` while a commit is in flight (the common
    // path is ms-scale; the §5.0.e modal can sit open for minutes, during which
    // `committing` stays true on purpose — the modal blocks the UI, and a Cancel resets
    // the flag via the finally so the user can click again).
    if (this.committing) return;
    this.committing = true;
    // W3 — cancel any pending cursor flush BEFORE the first commit await (the commit
    // rmdir's the dir; a timer firing mid-commit would persistCursor into a dir being
    // staged/removed). This runs only on the non-re-entrant path (the guard above
    // already returned for a second click); stop() (not dispose) so a failed commit that
    // stays in the editor keeps autosaving.
    this.owner?.stopCursorTimer();

    try {
      const owner = this.owner;
      const session = this.activeSession;
      if (!owner || !session) {
        this.host.onLeaveDetail();
        return;
      }

      // 7a.3 — a History `[←]` is a single write to currentFile (commitUnchangedSide),
      // never the pair-atomic commit7Step. Separate path so the conflict body stays
      // byte-identical.
      if (session.isHistory) {
        await this.exitHistory(entry, owner, session);
        return;
      }

      try {
        // TODO(perf) — [←] commit-chain instrumentation. A 2 MB file froze the UI ~1-2 min
        // on save with 0 conflicts left (so NOT the diff — base==sibling is a trivial
        // diffLines). Each step logs its own ms + payload size so a repro pins the exact
        // offender (suspected: the history.jsonl path — a "Keep/Apply all" on a big file
        // records a ~file-sized ChangeSet, so drain/read/assess grow with the log). Cheap
        // (a few log lines per save); keep until the large-file freeze is fixed + verified.
        const tExit0 = performance.now();
        let tPrev = tExit0;
        const lap = (step: string, extra?: Record<string, unknown>): void => {
          const now = performance.now();
          this.deps.logger?.info(`diff2 [←] ${step}`, { ms: Math.round(now - tPrev), ...extra });
          tPrev = now;
        };

        // Step 1 (§5.0) — flush queued history before the commit. commit7Step Step 7
        // removes the dir on success; drainHistory awaits the serialized append chain.
        await owner.drainHistory();
        lap("drainHistory");
        // §4.1 zero-edit invariant — the NET trustworthy edit count over the FULL
        // history.jsonl (prior + this session): 0 ⇒ "no recovery value AND nothing to
        // commit" → commitOrDiscardExit wipes the dir without touching the input files.
        // Read from disk (not the owner's in-memory writer) because a resumed session's
        // prior edits live on disk, and a new undo can pop into a replayed edit, so
        // in-memory + prior is not additive (§0.5.4).
        const jsonl = await readHistoryJsonl(this.deps.vault, session.conflictId);
        lap("readHistoryJsonl", { jsonlKB: Math.round(jsonl.length / 1024) });
        const recordCount = assessHistoryV2(jsonl).edits;
        lap("assessHistoryV2", { recordCount });
        // getResolved() = raw splitModel sides ("" for empty); commit7Step's
        // baseCommitAction applies the empty-base semantics (delete / 0-byte / "\n") and
        // hashes EXACTLY those bytes into done.json.
        const resolved = owner.getResolved();
        lap("getResolved", {
          baseKB: Math.round(resolved.base.length / 1024),
          siblingKB: Math.round(resolved.sibling.length / 1024),
        });
        // §5.0 exit decision (discard-if-empty / commit / TOCTOU). TOCTOU (§5.0 Step
        // 1.5): a sync may have rewritten base/sibling under us. Open-tab preservation for
        // base+sibling is handled UNIFORMLY inside atomicWriteFile/promoteInPlace (via the
        // view-preserve hook) — no wrap needed here.
        const outcome = await commitOrDiscardExit(
          this.deps.vault,
          session.conflictId,
          session.meta,
          resolved,
          recordCount,
          // case-4: confirm before deleting a had-content base the user emptied. Invoked
          // only on the ok-commit path (after the TOCTOU check).
          () => new EmptyDeleteModal(this.app, entry.basePath).prompt(),
        );
        if (outcome.kind === "cancelled") {
          // User declined the delete → stay in the editor with their (empty) edit.
          return;
        }
        if (outcome.kind === "toctou") {
          // §5.0.e symmetric resolution. Returns false when the user cancels (or the
          // view moved on during the modal) → stay in the editor.
          const proceed = await this.resolveToctou(
            entry,
            session,
            resolved,
            outcome.toctou,
          );
          if (!proceed) return;
        } else if (outcome.kind === "committed") {
          const { basePath, baseDeleted } = outcome.result;
          const prefix = baseDeleted ? "Deleted" : "Saved";
          new Notice(`${prefix} ${basePath}`);
        }
        // outcome.kind === "discarded": §4.1 silent wipe — no Notice, no write.
      } catch (err) {
        new Notice(`Failed to save ${entry.basePath}: ${String(err)}`);
        // Commit failed — stay in detail view so the user doesn't lose work. commit7Step
        // is pair-atomic; recoverCommit at onload reconciles any partially-applied commit
        // on the next launch.
        return;
      }

      // Success — Step-8: navigate away. Null activeSession FIRST so the host's
      // dispose() (via render()/onClose) sees no session and skips the abandon-wipe (the
      // commit already removed the dir); dispose() destroys the owner's CM6 view.
      this.activeSession = null;
      this.host.onCommitExit(entry);
    } finally {
      this.committing = false;
    }
  }

  // 7a.3 — History `[←]`. The base is a read-only version; the ONLY writable target is
  // currentFile (= meta.siblingPath). commitUnchangedSide("base") writes resolved.sibling
  // there (guardEmpty→"\n"; restoreEol) and rmdir's the dir — never commit7Step, never
  // baseCommitAction, so History can't delete the file. Two guards precede it:
  //   - ZERO net edits (the user only browsed) → discard (rmdir, no write, no mtime bump
  //     that would spawn a spurious sync commit), then navigate back like a commit.
  //   - currentFile CHANGED externally under the session → REFUSE (never clobber a
  //     changed original — §5.0.e's load-bearing invariant); stay in the editor. A full
  //     symmetric-resolution modal is a carry-item; silent clobber is not acceptable.
  // On any thrown write → "Failed to save" + stay (mirrors the conflict path).
  private async exitHistory(
    entry: ConflictEntry,
    owner: DiffPaneOwner,
    session: { conflictId: string; meta: AutosaveMeta; hadPriorEdits: boolean },
  ): Promise<void> {
    try {
      // TODO(perf) — history [←] instrumentation (History is unfinished — may still hit a
      // "primitive" path). A 2 MB history version froze the UI ~1-2 min on [←]. Same step
      // timers as the conflict path so a repro pins the offender (drain / read / assess /
      // resolve / never-clobber SHA / commitUnchangedSide). Keep until the freeze is fixed.
      const tExit0 = performance.now();
      let tPrev = tExit0;
      const lap = (step: string, extra?: Record<string, unknown>): void => {
        const now = performance.now();
        this.deps.logger?.info(`diff2 history [←] ${step}`, { ms: Math.round(now - tPrev), ...extra });
        tPrev = now;
      };

      await owner.drainHistory();
      lap("drainHistory");
      const jsonl = await readHistoryJsonl(this.deps.vault, session.conflictId);
      lap("readHistoryJsonl", { jsonlKB: Math.round(jsonl.length / 1024) });
      const edits = assessHistoryV2(jsonl).edits;
      lap("assessHistoryV2", { edits });
      const resolved = owner.getResolved();
      lap("getResolved", {
        baseKB: Math.round(resolved.base.length / 1024),
        siblingKB: Math.round(resolved.sibling.length / 1024),
      });

      if (edits === 0) {
        // Browsed only — discard the session (no write), then navigate back.
        await this.deps.vault.adapter
          .rmdir(autosaveDir(session.conflictId), true)
          .catch(() => {});
        this.deps.logger?.info("diff2 history [←] no edits — discarded", {
          base: entry.basePath,
        });
        this.activeSession = null;
        this.host.onCommitExit(entry);
        return;
      }

      // Never-clobber: currentFile must be byte-identical to session start.
      const curBytes = await this.deps.vault.adapter.readBinary(entry.siblingPath);
      const curSha = await calculateGitBlobSHA(curBytes);
      lap("neverClobberSha", { curKB: Math.round(curBytes.byteLength / 1024) });
      if (curSha !== session.meta.siblingShaAtStart) {
        new Notice(
          `"${entry.basePath}" changed since you opened this version — not ` +
            `overwriting. Reopen its history to try again.`,
        );
        this.deps.logger?.info("diff2 history [←] refused — currentFile changed", {
          base: entry.basePath,
        });
        return; // stay in the editor
      }

      // Open-tab preservation is now handled UNIFORMLY inside atomicWriteFile (via the
      // view-preserve hook): a large write to an open file closes the tab → renames →
      // reopens fresh + cursor. So this call is a plain write.
      const { writtenPath } = await commitUnchangedSide(
        this.deps.vault,
        session.conflictId,
        session.meta,
        resolved,
        "base", // write resolved.sibling → meta.siblingPath (= currentFile)
      );
      lap("commitUnchangedSide", { totalMs: Math.round(performance.now() - tExit0) });
      new Notice(`Saved ${writtenPath}`);
    } catch (err) {
      new Notice(`Failed to save ${entry.basePath}: ${String(err)}`);
      return; // stay in the editor so the user doesn't lose work
    }
    this.activeSession = null;
    // TODO(perf) — freeze 2 marker: the 2nd device freeze happened AFTER the editor closed,
    // when currentFile (now ~693 KB) got revealed in a tab and Obsidian rendered the markdown.
    // onCommitExit drives the host navigation (detach editor → reveal panel/file). Timestamp
    // it + disposeOwner (logged in dispose) so the gap to the next log line localizes freeze 2.
    const tNav = performance.now();
    this.host.onCommitExit(entry);
    this.deps.logger?.info("diff2 history [←] onCommitExit", { ms: Math.round(performance.now() - tNav) });
  }

  // §5.0.e — the vault changed under the session (classifyToctou → mismatch).
  // Symmetric, the SAME rule as §3.2.a-reopen: the resolved content lands ONLY on the
  // side whose vault file did NOT change; we never overwrite a file that was modified
  // externally. Returns true if the exit should proceed (session torn down by the
  // helper), false to stay in the editor (cancel / view moved on). Runs inside exit()'s
  // try — a thrown write/guard surfaces as "Failed to save" and keeps the user in the
  // editor.
  private async resolveToctou(
    entry: ConflictEntry,
    session: { conflictId: string; meta: AutosaveMeta; hadPriorEdits: boolean },
    resolved: ResolvedSides,
    toctou: Extract<ToctouStatus, { kind: "mismatch" }>,
  ): Promise<boolean> {
    // Exactly one side changed (XOR) → SILENT single-side write to the unchanged side;
    // log, no Notice (DIFF-EDITOR.md §5.0.e). The conflict simply continues with the
    // changed side's new bytes.
    if (toctou.baseChanged !== toctou.siblingChanged) {
      const changedSide = toctou.baseChanged ? "base" : "sibling";
      const { writtenPath } = await commitUnchangedSide(
        this.deps.vault,
        session.conflictId,
        session.meta,
        resolved,
        changedSide,
      );
      this.deps.logger?.info(
        "diff2 [←] exit: one input changed externally; wrote resolved " +
          "unchanged side, conflict continues",
        { changedSide, writtenPath },
      );
      return true;
    }

    // BOTH sides changed → the only place the exit asks anything. Save the resolution
    // under a fresh name, or discard. The modal fail-closes on a colliding name (the
    // prefill IS the changed original).
    const choice = await new SaveToAltModal(this.app, {
      defaultName: session.meta.basePath,
      exists: (name) => this.deps.vault.adapter.exists(name),
    }).prompt();

    // The modal can sit open for minutes — bail if the view moved on (dispose nulls
    // activeSession) before we touch disk.
    if (this.activeSession !== session) return false;

    if (choice.choice === "cancel") return false; // stay in the editor
    if (choice.choice === "save") {
      const res = await commitToAlt(
        this.deps.vault,
        session.conflictId,
        choice.name,
        resolved,
        entry.deviceLabel,
        Date.now(),
        session.meta.eol ?? "lf", // bug-59 — session EOL restored on the alt write
      );
      const suffix = res.siblingPath ? ` (+ ${res.siblingPath})` : "";
      new Notice(`Saved your resolution as ${res.basePath}${suffix}`);
      return true;
    }
    // discard
    await this.deps.vault.adapter.rmdir(autosaveDir(session.conflictId), true);
    this.deps.logger?.info(
      "diff2 [←] exit: both inputs changed externally; user discarded resolution",
      { base: session.meta.basePath, sibling: session.meta.siblingPath },
    );
    return true;
  }
}

// §3.2.a "Continue" — replay a saved history.jsonl into a DETACHED V2 view to extract
// the user's resolved sides (no live feed/guard needed: a hookless mountDiffPaneV2 has
// no recording listener, so replayHistoryV2 runs directly). resolvedFromView returns
// RAW sides ("" for empty); the §3.2.a caller applies guardEmpty before its single
// direct write (it does NOT go through commit7Step). The div is appended to the document
// so CM6 history (undo/redo replay) has a real layout to work against.
function extractResolved(
  base: string,
  sibling: string,
  jsonl: string,
): ResolvedSides {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = mountDiffPaneV2(parent, base, sibling);
  try {
    replayHistoryV2(view, jsonl);
    return resolvedFromView(view);
  } finally {
    view.destroy();
    parent.remove();
  }
}

// The session's history.jsonl as a string ("" if absent). Used by the [←] exit to
// compute the NET trustworthy edit count (§4.1) over prior + this-session blocks.
async function readHistoryJsonl(
  vault: import("obsidian").Vault,
  conflictId: string,
): Promise<string> {
  const p = `${autosaveDir(conflictId)}/history.jsonl`;
  return (await vault.adapter.exists(p)) ? vault.adapter.read(p) : "";
}
