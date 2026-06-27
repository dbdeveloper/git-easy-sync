// Diff-Edit widget — the host ItemView that Obsidian opens in a tab.
//
// Phase 1 ships:
//   - Sub-tabs header (Conflicts / Deleted).
//   - Conflicts list body (real, populated via synthetic-detector).
//   - Deleted body placeholder (Phase 9b).
//   - Detail-view placeholder reachable by clicking a conflict row;
//     `[←]` back arrow returns to list. The DiffPane itself lands in
//     Phase 2 — Phase 1's detail view is a stub that just shows the
//     selected (basePath, siblingPath).
//   - Subscribes to ConflictCounter so the list refreshes when the
//     vault changes (sibling create/delete/rename).
//
// Future phases:
//   Phase 2 — DiffPane render in detail view
//   Phase 3 — chunk-action buttons + group toolbar (resolve flow)
//   Phase 5 — autosave + recovery dialog on reopen
//   Phase 6 — entry-point hooks (file-menu, post-sync modal,
//             status-bar/ribbon click already wired to activateView
//             from main.ts)
//   Phase 7 — History list + restore
//   Phase 8 — Compare picker + compare-mode
//   Phase 9b — Deleted-mode UI + restore
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.7.5 (default sub-tab)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7 (DiffPane form — Phase 2)

import { ItemView, Notice, Scope, type Vault, WorkspaceLeaf } from "obsidian";
import type SnapshotStore from "../sync2/snapshot-store";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { isMarkdownPath } from "./conflict-merge-all";
import { formatConflictTimestamp } from "./strip-conflict-suffix";
import { DiffPaneOwner, resolvedFromView } from "./diff-pane-owner";
import { type DiffViewConfig, mountDiffPaneV2 } from "./diff-pane-v2";
import {
  DEFAULT_DIFF_EDIT_VIEW_STATE,
  DiffEditSubTab,
  DiffEditViewState,
} from "./events";
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
import type Logger from "../logger";
import { atomicWriteFile } from "../sync2/atomic-write";
import {
  commitOrDiscardExit,
  commitToAlt,
  commitUnchangedSide,
  guardEmpty,
  type ResolvedSides,
  type ToctouStatus,
} from "./exit-commit";
import {
  autosaveIdForEntry,
  findAllConflicts,
  type ConflictEntry,
} from "./synthetic-detector";
import { renderConflictsToolbar } from "./toolbar-conflicts";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

export interface DiffEditViewDeps {
  vault: Vault;
  conflictStore: ConflictStore;
  conflictCounter: ConflictCounter;
  // Snapshot store passed to atomicWriteFile so the post-write
  // recordSync step lines up with the snapshot's expectations.
  // Optional in test fixtures; required in production for
  // crash-safety per PSEUDO-MERGE-MODE.md §9.3 5-step protocol.
  snapshotStore?: SnapshotStore;
  // Local device label for the top-marker / "Keep all local
  // (<label>)" button text. Falls back to "local" when undefined.
  localDeviceLabel?: () => string;
  // §2.2.14 — read the current "Touch mode (read-only)" setting at view open. Optional
  // (test fixtures omit it → editable as before).
  touchOnly?: () => boolean;
  // Plugin logger — the §5.0.e one-side-silent exit logs here instead of
  // nagging the user with a Notice (no-op when logging is disabled). Optional
  // in test fixtures.
  logger?: Logger;
}

// Phase 1 owns the navigation state machine inside the view: which
// sub-tab is active, and (when in detail mode) which entry the user
// drilled into. Future phases extend this with compare/history modes.
type Phase1ViewState =
  | { mode: "list"; tab: DiffEditSubTab }
  | { mode: "detail"; entry: ConflictEntry; tab: DiffEditSubTab };

function initialState(): Phase1ViewState {
  // R2.7.5 — default sub-tab is always Conflicts (deterministic UX
  // regardless of pending-count). Even when N === 0 the conflicts
  // tab opens; user must explicitly switch to Deleted.
  return { mode: "list", tab: "conflicts" };
}

export class DiffEditView extends ItemView {
  private viewState: Phase1ViewState = initialState();
  private readonly deps: DiffEditViewDeps;
  // Unsubscribe handle from ConflictCounter.subscribe — set on open,
  // called on close.
  private unsubscribeCounter: (() => void) | null = null;
  // TODO #8 — a keymap Scope that swallows ESC (so Obsidian's default "ESC →
  // focus the markdown editor" can't pull focus out of the diff-editor). Pushed
  // only while THIS view is the active leaf (so ESC still works in other tabs).
  private escScope: Scope | null = null;
  private escScopePushed = false;
  // Active V2 DiffPaneOwner lives only while detail-mode is shown. Replaced on
  // every detail-open; disposed when leaving detail-mode or on view close. The
  // owner holds the EditorView + the shared ReplayFlag + the HistoryWriterV2 sink
  // + the cursor scheduler (§0.5 / P6.3) — the §1 DiffPane is gone.
  private owner: DiffPaneOwner | null = null;
  // Autosave session bound to the active owner: the conflict's autosave id + the
  // meta startSession wrote + whether this mount REPLAYED prior edits. Set at
  // mount, consumed by the `[←]` commit7Step, cleared on dispose. Null when no
  // detail editor is open. `hadPriorEdits` gates the §4.1 abandon-wipe: a FRESH
  // session abandoned with zero net edits is wiped; a resumed one is kept for
  // crash recovery (its prior edits aren't in the owner's in-memory writer).
  private activeSession:
    | { conflictId: string; meta: AutosaveMeta; hadPriorEdits: boolean }
    | null = null;
  // Step-0 (§5.0) — re-entrancy guard for the `[←]` commit. Set true on entry to
  // exitDetailView, reset in its finally. A second click while a commit (or its
  // §5.0.e modal) is in flight is rejected — two concurrent commit7Step runs on
  // the same dir would leave undefined vault state (the race between steps 2–7).
  private committing = false;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Diff-Edit";
  }

  getIcon(): string {
    return "git-merge";
  }

  // Phase 0 API kept for forward-compat. Phase 6 may use this to drop
  // the view straight into a particular sub-tab from external entry
  // points (file-menu, summary modal). Phase 1 ignores
  // compare/history shapes — they're stubbed out below.
  setDiffEditState(state: DiffEditViewState): void {
    if (state.kind === "sub-tab") {
      this.viewState = { mode: "list", tab: state.tab };
      this.render();
    }
    // compare-detail / history-detail not handled in Phase 1.
  }

  getDiffEditState(): DiffEditViewState {
    return this.viewState.mode === "list"
      ? { kind: "sub-tab", tab: this.viewState.tab }
      : { kind: "sub-tab", tab: this.viewState.tab };
  }

  async onOpen(): Promise<void> {
    // ConflictCounter notifies on any sibling-event vault change.
    // List-mode subscribers re-render; detail-mode just keeps showing
    // the active entry (refresh is a no-op for detail since the
    // selected sibling is stable until user clicks `[←]`).
    this.unsubscribeCounter = this.deps.conflictCounter.subscribe(() => {
      // Defer render to next microtask so multiple rapid changes
      // collapse into one re-render. Simple debounce; later phases
      // may upgrade to requestAnimationFrame if needed.
      queueMicrotask(() => {
        // ONLY the list re-renders on a count change. In detail mode a
        // re-render would re-run mountDiffPane — disposing the live DiffPane
        // (losing the in-progress edit) AND re-classifying the now-existing
        // autosave dir into a spurious "Resume previous edit session? · 0 edits"
        // modal (TODO §2 double-mount). The active entry is stable until the
        // user clicks `[←]`/back, so detail needs no refresh here (the comment
        // above always intended this no-op; the guard now enforces it).
        if (this.viewState.mode === "list") this.render();
      });
    });

    // TODO #8 — ESC must NOT move focus out of the diff-editor (Obsidian's
    // default ESC jumps focus to the last markdown editor). A keymap Scope
    // intercepts ESC through Obsidian's OWN dispatch (so it fires BEFORE the
    // built-in handler regardless of DOM phase); `() => false` swallows it. The
    // scope is pushed only while this view is the active leaf, so ESC keeps
    // working in other tabs. (A DOM capture listener was tried first but lost to
    // Obsidian's earlier-phase handler.)
    this.escScope = new Scope(this.app.scope);
    this.escScope.register([], "Escape", () => false);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.syncEscScope(leaf);
        // TODO #8b — re-focus the editor when this leaf becomes active again
        // (e.g. user clicked another markdown tab, then back). Obsidian
        // re-focuses a MarkdownView's editor on activation but does nothing for
        // our custom ItemView, so the caret would vanish until a manual click.
        if (leaf === this.leaf) this.owner?.focus();
      }),
    );
    this.syncEscScope(this.app.workspace.activeLeaf ?? null);

    this.viewState = initialState();
    this.render();
  }

  // TODO #8 — push the ESC-swallowing scope iff this view is the active leaf;
  // pop it otherwise. Idempotent (guarded by escScopePushed).
  private syncEscScope(activeLeaf: WorkspaceLeaf | null): void {
    if (!this.escScope) return;
    const shouldBlock = activeLeaf === this.leaf;
    if (shouldBlock && !this.escScopePushed) {
      this.app.keymap.pushScope(this.escScope);
      this.escScopePushed = true;
    } else if (!shouldBlock && this.escScopePushed) {
      this.app.keymap.popScope(this.escScope);
      this.escScopePushed = false;
    }
  }

  async onClose(): Promise<void> {
    if (this.unsubscribeCounter) {
      this.unsubscribeCounter();
      this.unsubscribeCounter = null;
    }
    // TODO #8 — pop the ESC scope if it's still on the keymap stack.
    if (this.escScope && this.escScopePushed) {
      this.app.keymap.popScope(this.escScope);
      this.escScopePushed = false;
    }
    this.escScope = null;
    this.disposeOwner();
  }

  private disposeOwner(): void {
    const session = this.activeSession;
    // §4.1 net-edit signal — read BEFORE dispose (owner.dispose stops the cursor
    // timer + destroys the view). For a FRESH session this in-memory net count is
    // authoritative; a resumed session is handled by `hadPriorEdits` below.
    const netEdits = this.owner?.inMemoryNetEdits() ?? 0;
    this.owner?.dispose();
    this.owner = null;
    // §4.1 zero-edit invariant: a session ABANDONED (sub-tab switch / view close,
    // the "інший механізм" exit) with no recovery value → wipe its dir (fire-and-
    // forget; the onload sweep is the backstop). A FRESH session is worthless iff
    // it recorded zero net edits; a RESUMED session (hadPriorEdits) always carries
    // prior on-disk edits a crash should keep, so it is NEVER wiped here. The
    // committed/discarded `[←]` path nulls activeSession before render(), so this
    // only fires on a genuine abandon (the onOpen counter-guard prevents a
    // spurious detail-mode re-render).
    if (session && !session.hadPriorEdits && netEdits === 0) {
      void this.deps.vault.adapter
        .rmdir(autosaveDir(session.conflictId), true)
        .catch(() => {
          /* best-effort; onload sweep is the backstop */
        });
    }
    this.activeSession = null;
  }

  // ── render dispatch ───────────────────────────────────────────────

  private render(): void {
    // Dispose any active owner before tearing down its parent DOM —
    // CM6 EditorView.destroy() unhooks its own event listeners + DOM
    // children. If we just empty() the parent without destroy(), we
    // leak the listeners.
    this.disposeOwner();

    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");

    if (this.viewState.mode === "list") {
      this.renderHeader(container, this.viewState.tab);
      this.renderListBody(container, this.viewState.tab);
    } else {
      this.renderDetail(container, this.viewState.entry);
    }
  }

  private renderHeader(parent: HTMLElement, activeTab: DiffEditSubTab): void {
    const header = parent.createDiv({ cls: "diff2-view-header" });
    const tabs: { id: DiffEditSubTab; label: string }[] = [
      { id: "conflicts", label: "Conflicts" },
      { id: "deleted", label: "Deleted" },
    ];
    for (const t of tabs) {
      const tabEl = header.createDiv({
        cls:
          `diff2-tab diff2-tab-${t.id}` +
          (t.id === activeTab ? " diff2-tab-active" : ""),
        text: t.label,
      });
      tabEl.style.cursor = "pointer";
      tabEl.addEventListener("click", () => {
        if (this.viewState.mode !== "list" || this.viewState.tab !== t.id) {
          this.viewState = { mode: "list", tab: t.id };
          this.render();
        }
      });
    }
  }

  private renderListBody(parent: HTMLElement, tab: DiffEditSubTab): void {
    const body = parent.createDiv({ cls: "diff2-view-body" });

    if (tab === "conflicts") {
      const { entries } = findAllConflicts(
        this.deps.vault,
        this.deps.conflictStore,
      );
      renderConflictsList(body, entries, {
        onEntryClick: (entry) => {
          this.viewState = { mode: "detail", entry, tab };
          this.render();
        },
      });
      return;
    }

    // tab === "deleted" — Phase 9b placeholder.
    body.createEl("p", {
      cls: "diff2-deleted-placeholder",
      text:
        "Deleted-mode UI lands in Phase 9b. See " +
        "docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.13 for the Phase 9b enumeration.",
    });
  }

  private renderDetail(parent: HTMLElement, entry: ConflictEntry): void {
    // R7.9a toolbar — [← Back] + group resolve buttons + Auto-advance
    // toggle. Phase 6 will add [Open in external tool] on the right
    // (desktop-only); Phase 5 may add an "unresolved chunks" footer.
    const isMd = isMarkdownPath(entry.basePath);
    const localLabel = this.deps.localDeviceLabel?.() ?? "local";
    const toolbar = parent.createDiv({ cls: "diff2-detail-toolbar" });

    renderConflictsToolbar(
      toolbar,
      { localLabel, remoteLabel: entry.deviceLabel },
      {
        onBack: () => {
          void this.exitDetailView(entry);
        },
        // Interim toolbar (the redesign is its own session — see
        // [[project-diff2-toolbar-redesign]]); resolve-all routes to the V2 owner.
        // ours→keep1 (keep ver1), theirs→keep2 (keep ver2), join→join.
        onKeepAllLocal: () => {
          this.owner?.applyResolveAll("keep1");
        },
        onApplyAllRemote: () => {
          this.owner?.applyResolveAll("keep2");
        },
        onJoinAll: isMd
          ? () => {
              // Pass the conflict's label + timestamp so the join header reads
              // "Changes from `<device>` at <date>" (all groups here share this one
              // sibling); without opts joinText fell back to "remote" + "" (bug).
              this.owner?.applyResolveAll("join", {
                label: entry.deviceLabel,
                date: entry.isoTimestamp,
              });
            }
          : undefined,
      },
    );

    // Title row under the toolbar — shows the conflict's identity so
    // the user always sees which file they're resolving.
    const titleRow = parent.createDiv({ cls: "diff2-detail-title-row" });
    titleRow.createEl("span", {
      cls: "diff2-detail-base-path",
      text: entry.basePath,
    });
    titleRow.createEl("span", {
      cls: "diff2-detail-meta",
      text: ` · ${entry.deviceLabel} @ ${formatConflictTimestamp(entry.isoTimestamp)}`,
    });

    // Detail body — DiffPane mount.
    const body = parent.createDiv({ cls: "diff2-detail-body" });
    void this.mountDiffPane(body, entry);
  }

  private async mountDiffPane(
    body: HTMLElement,
    entry: ConflictEntry,
  ): Promise<void> {
    const adapter = this.deps.vault.adapter;
    try {
      let ours = "";
      const baseExists = await adapter.exists(entry.basePath);
      if (baseExists) {
        ours = await adapter.read(entry.basePath);
      }
      const theirs = await adapter.read(entry.siblingPath);

      // Stale-state guard: bail if the user switched away during await.
      if (
        this.viewState.mode !== "detail" ||
        this.viewState.entry.siblingPath !== entry.siblingPath ||
        !body.isConnected
      ) {
        return;
      }

      // (§1.3 sentinel collision check removed — the V2 diff-model has no
      // `\0`/`\1` sentinels, so any byte is ordinary text; classifyReopen's
      // defensive `sentinel` branch is now unreachable.)

      // Autosave session lifecycle (DIFF-EDITOR.md §3.1 / §3.2 / §3.2.a). An
      // in-flight commit (done.json) is NEVER touched here — onload recoverCommit
      // finishes it before any mount (§5.0.a precedence); bail defensively if one
      // is present.
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
      // commit-in-flight (the one window where compaction must not run), and there
      // is no live undo stack yet. Conservative: nothing reachable is lost.
      await compactSessionLog(this.deps.vault, conflictId);

      // Classify the reopen → action (pure dispatch, W4c Step A).
      const action = reopenAction(
        await classifyReopen(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
        ),
      );

      // View config threaded through the owner into the V2 pane: device labels
      // (top/bottom markers), join date, and isMarkdown (Join-button gate). The
      // owner derives the resolve ResolveOpts {label: remoteLabel, date} from it.
      const config: DiffViewConfig = {
        localLabel: this.deps.localDeviceLabel?.() ?? "local",
        remoteLabel: entry.deviceLabel,
        date: entry.isoTimestamp,
        isMarkdown: isMarkdownPath(entry.basePath),
        touchOnly: this.deps.touchOnly?.() ?? false, // §2.2.14 read-only mode (Settings)
      };

      // Clear any prior dir, open a fresh session, and mount the owner from the
      // CURRENT vault bytes. Used by fresh / discard-fresh and the "Start over"
      // choices. A fresh session has no prior edits → hadPriorEdits:false.
      const startFreshAndMount = async (): Promise<void> => {
        if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
        const meta = await startSession(
          this.deps.vault,
          conflictId,
          entry.basePath,
          entry.siblingPath,
        );
        this.activeSession = { conflictId, meta, hadPriorEdits: false };
        this.owner = new DiffPaneOwner(
          this.deps.vault,
          conflictId,
          body,
          ours,
          theirs,
          config,
          0, // fresh history.jsonl seq
          this.deps.logger,
        );
      };

      // Non-lossy mount: rebuild the owner from the session-start SNAPSHOTS,
      // replay the recorded history under the shared ReplayFlag, restore the
      // cursor. KEEPS the dir and REUSES the session (never startSession, which
      // would overwrite the snapshots / history being replayed). Continues the
      // history.jsonl seq. hadPriorEdits:true — its prior on-disk edits are real
      // recovery value, so it is never abandon-wiped.
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
        );
        owner.replayWithGuard(sess.jsonl);
        const cursor = await readCursor(this.deps.vault, conflictId);
        if (cursor) {
          owner.setCursor(cursor.anchor, cursor.head, cursor.scrollTop);
        }
        this.activeSession = { conflictId, meta, hadPriorEdits: true };
        this.owner = owner;
      };

      try {
        switch (action.kind) {
          case "fresh":
          case "discard-fresh":
            await startFreshAndMount();
            break;
          case "restore": {
            // §3.2.a — EXACTLY ONE vault side changed under the session. Reuse
            // the §3.2 ResumeRecoveryModal (a "*" marks the changed file — no
            // scary "files changed" dialog; it is just crash recovery).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // §3.5 (TODO §2): zero trustworthy edits → nothing to restore even
            // though one side changed in the vault. Skip the modal and start
            // fresh from the CURRENT vault (which reflects that one-side change);
            // there is no user work to carry onto the unchanged side.
            if (assessHistoryV2(sess.jsonl).empty) {
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: assessHistoryV2(sess.jsonl).edits,
              baseChanged: action.changedSide === "base",
              siblingChanged: action.changedSide === "sibling",
              nowMs: Date.now(),
            }).prompt();

            // ❗Re-assert the stale-state guard after the (minutes-long) modal.
            if (
              this.viewState.mode !== "detail" ||
              this.viewState.entry.siblingPath !== entry.siblingPath ||
              !body.isConnected
            ) {
              return;
            }

            if (choice === "cancel") {
              this.viewState = { mode: "list", tab: "conflicts" };
              this.render();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "Continue": replay (in a DETACHED V2 view) to extract the user's
            // resolved content, write the restored content of the UNCHANGED side
            // onto the vault (the changed side keeps its new content), then
            // recreate the session. Symmetric — file1/file2, no privilege.
            const resolved = extractResolved(sess.base, sess.sibling, sess.jsonl);
            const writePath =
              action.changedSide === "base"
                ? entry.siblingPath
                : entry.basePath;
            // guardEmpty: this is a single direct write (not commit7Step), so an
            // emptied unchanged side must stay a benign 1-byte "\n", never a
            // 0-byte file the next sync would resurrect (SYNC2 §2.9). Same rule
            // as the §5.0.e commitUnchangedSide path.
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
            // A brand-new session mounted from the just-written snapshots — no
            // replay into the live view → hadPriorEdits:false (the restored work
            // is already durable in the unchanged-side file).
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
            );
            break;
          }
          case "resume": {
            // §3.2 — vault unchanged since session start. Offer replay-resume
            // vs fresh. editCount = the trustworthy-prefix block count, i.e.
            // exactly what replayFrom will apply (so the dialog can't promise
            // more than it restores).
            const sess = await readResumeSession(this.deps.vault, conflictId);
            // §3.5 (TODO §2): a valid session whose history.jsonl holds ZERO
            // trustworthy edits is stale — there is nothing to resume, so the
            // "Resume previous edit session? · 0 edits saved" modal is pointless.
            // Skip it and start fresh (wipe + fresh session). `empty` = no blocks
            // AND no corruption; a corrupt-first-block session is a DIFFERENT
            // §3.5 row (it would still surface a modal) so it's intentionally
            // excluded here.
            if (assessHistoryV2(sess.jsonl).empty) {
              await startFreshAndMount();
              break;
            }
            const choice = await new ResumeRecoveryModal(this.app, {
              basePath: entry.basePath,
              siblingPath: entry.siblingPath,
              startedAtIso: action.meta.createdAt,
              editCount: assessHistoryV2(sess.jsonl).edits,
              nowMs: Date.now(),
            }).prompt();

            // ❗The modal can sit open for minutes — re-assert the stale-state
            // guard before touching disk / mounting. The user may have switched
            // to another conflict; a stale Start-over would otherwise rmdir a
            // dir the now-current view is using.
            if (
              this.viewState.mode !== "detail" ||
              this.viewState.entry.siblingPath !== entry.siblingPath ||
              !body.isConnected
            ) {
              return;
            }

            if (choice === "cancel") {
              this.viewState = { mode: "list", tab: "conflicts" };
              this.render();
              return;
            }
            if (choice === "start-over") {
              await startFreshAndMount();
              break;
            }
            // "continue": rebuild from the session-start SNAPSHOTS + replay
            // (KEEP the dir, REUSE the session — see mountReplayed).
            await mountReplayed(sess, action.meta);
            break;
          }
        }
        // TODO §6.1 — focus the freshly-mounted editor so the caret shows and
        // Ctrl/Cmd+Z works without a click. Cancel paths returned early; every
        // mount path set the owner. Idempotent on the resume-with-cursor path
        // (setCursor already focused).
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

  // `[←]` exit — the 7-step pair-atomic commit (DIFF-EDITOR.md §5.0).
  // commit7Step writes done.json (barrier) → stages base+sibling →
  // promotes both → drops backups → §6.5 proactive sibling cleanup
  // (SHA(base)==SHA(sibling)) → rmdir's the autosave dir. Pair-atomic:
  // crash ⇒ both sides or neither, and recoverCommit at onload finishes
  // or rolls back any interrupted commit.
  //
  // Step-0 (§5.0): the `committing` re-entrancy guard below. Step-8 (history
  // clear + → list view): the return-to-list IS the success tail, and the CM6
  // history is cleared by `view.destroy()` when render() disposes the DiffPane
  // (there is no `historyClear` API, and the view is torn down anyway).
  //
  // §5.0.e TOCTOU (W5): when classifyToctou finds the vault changed under the
  // session, the SAME symmetric rule as §3.2.a-reopen applies — see
  // resolveToctouExit. We NEVER overwrite an externally-changed file.
  private async exitDetailView(entry: ConflictEntry): Promise<void> {
    // Step-0 (§5.0) — reject a re-entrant `[←]` while a commit is in flight
    // (the common path is ms-scale; the §5.0.e modal can sit open for minutes,
    // during which `committing` stays true on purpose — the modal blocks the UI,
    // and a Cancel resets the flag via the finally so the user can click again).
    if (this.committing) return;
    this.committing = true;
    // W3 — cancel any pending cursor flush BEFORE the first commit await (the
    // commit rmdir's the dir; a timer firing mid-commit would persistCursor into
    // a dir being staged/removed). This runs only on the non-re-entrant path
    // (the guard above already returned for a second click); stop() (not dispose)
    // so a failed commit that stays in the editor keeps autosaving.
    this.owner?.stopCursorTimer();

    try {
      const owner = this.owner;
      const session = this.activeSession;
      if (!owner || !session) {
        this.viewState = { mode: "list", tab: "conflicts" };
        this.render();
        return;
      }

      try {
        // Step 1 (§5.0) — flush queued history before the commit. commit7Step
        // Step 7 removes the dir on success; drainHistory awaits the serialized
        // append chain.
        await owner.drainHistory();
        // §4.1 zero-edit invariant — the NET trustworthy edit count over the FULL
        // history.jsonl (prior + this session): 0 ⇒ "no recovery value AND nothing
        // to commit" → commitOrDiscardExit wipes the dir without touching the input
        // files. Read from disk (not the owner's in-memory writer) because a
        // resumed session's prior edits live on disk, and a new undo can pop into
        // a replayed edit, so in-memory + prior is not additive (§0.5.4).
        const jsonl = await readHistoryJsonl(this.deps.vault, session.conflictId);
        const recordCount = assessHistoryV2(jsonl).edits;
        // getResolved() = raw splitModel sides ("" for empty); commit7Step's
        // baseCommitAction applies the empty-base semantics (delete / 0-byte /
        // "\n") and hashes EXACTLY those bytes into done.json.
        const resolved = owner.getResolved();
        // §5.0 exit decision (discard-if-empty / commit / TOCTOU). TOCTOU
        // (§5.0 Step 1.5): a sync may have rewritten base/sibling under us.
        const outcome = await commitOrDiscardExit(
          this.deps.vault,
          session.conflictId,
          session.meta,
          resolved,
          recordCount,
          // case-4: confirm before deleting a had-content base the user emptied.
          // Invoked only on the ok-commit path (after the TOCTOU check).
          () => new EmptyDeleteModal(this.app, entry.basePath).prompt(),
        );
        if (outcome.kind === "cancelled") {
          // User declined the delete → stay in the editor with their (empty) edit.
          return;
        }
        if (outcome.kind === "toctou") {
          // §5.0.e symmetric resolution. Returns false when the user cancels (or
          // the view moved on during the modal) → stay in the editor.
          const proceed = await this.resolveToctouExit(
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
        // Commit failed — stay in detail view so the user doesn't lose work.
        // commit7Step is pair-atomic; recoverCommit at onload reconciles any
        // partially-applied commit on the next launch.
        return;
      }

      // Success — Step-8: return to list. Null activeSession FIRST so render()'s
      // disposeOwner sees no session and skips the abandon-wipe (the commit
      // already removed the dir); disposeOwner destroys the owner's CM6 view.
      this.activeSession = null;
      this.viewState = { mode: "list", tab: "conflicts" };
      this.render();
    } finally {
      this.committing = false;
    }
  }

  // §5.0.e — the vault changed under the session (classifyToctou → mismatch).
  // Symmetric, the SAME rule as §3.2.a-reopen: the resolved content lands ONLY
  // on the side whose vault file did NOT change; we never overwrite a file that
  // was modified externally. Returns true if the exit should proceed (session
  // torn down by the helper), false to stay in the editor (cancel / view moved
  // on). Runs inside exitDetailView's try — a thrown write/guard surfaces as
  // "Failed to save" and keeps the user in the editor.
  private async resolveToctouExit(
    entry: ConflictEntry,
    session: { conflictId: string; meta: AutosaveMeta; hadPriorEdits: boolean },
    resolved: ResolvedSides,
    toctou: Extract<ToctouStatus, { kind: "mismatch" }>,
  ): Promise<boolean> {
    // Exactly one side changed (XOR) → SILENT single-side write to the unchanged
    // side; log, no Notice (DIFF-EDITOR.md §5.0.e). The conflict simply
    // continues with the changed side's new bytes.
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

    // BOTH sides changed → the only place the exit asks anything. Save the
    // resolution under a fresh name, or discard. The modal fail-closes on a
    // colliding name (the prefill IS the changed original).
    const choice = await new SaveToAltModal(this.app, {
      defaultName: session.meta.basePath,
      exists: (name) => this.deps.vault.adapter.exists(name),
    }).prompt();

    // The modal can sit open for minutes — bail if the view moved on (onClose
    // nulls activeSession) before we touch disk.
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

// §3.2.a "Continue" — replay a saved history.jsonl into a DETACHED V2 view to
// extract the user's resolved sides (no live feed/guard needed: a hookless
// mountDiffPaneV2 has no recording listener, so replayHistoryV2 runs directly).
// resolvedFromView returns RAW sides ("" for empty); the §3.2.a caller applies
// guardEmpty before its single direct write (it does NOT go through commit7Step).
// The div is appended to the document so CM6 history (undo/redo replay) has a
// real layout to work against.
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
  vault: Vault,
  conflictId: string,
): Promise<string> {
  const p = `${autosaveDir(conflictId)}/history.jsonl`;
  return (await vault.adapter.exists(p)) ? vault.adapter.read(p) : "";
}
