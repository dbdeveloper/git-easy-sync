// Diff-Editor tab — the multi-tab host ItemView (S3 of the panel/editor split,
// docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// One `diff2-editor-view` leaf per `base:sibling` pair (Option A, R-A). It reuses
// the SAME `DiffDetailController` as the singleton panel host (`DiffPanelView`) —
// the proof the S2 seam was right is that this host needs ZERO controller changes:
// the only difference is the navigation callbacks. Where the panel host renders a
// list on `[←]` / cancel, this host DETACHES its leaf (the editor is pure detail —
// R-D / §8). S5 specializes `onCommitExit` to detach + reveal the panel + scroll.
//
// Unlike the panel, the editor:
//   - is NOT a singleton (many open at once — S4 open-guard keeps the write-sets
//     disjoint);
//   - does NOT subscribe to ConflictAnalyzer (it is not a list — S2 contract);
//   - has a STATIC title (the file it resolves, fixed for the leaf's lifetime —
//     no dynamic `getDisplayText` flip / `refreshHeader` hack; title-simplification
//     starts here per §12).
//
// Phase 1 only ever mounts `origin: "conflict"`. The Mod+F window hook is
// duplicated per-host on purpose (the contract ratified "view-level chrome in
// each host, don't gold-plate the generic API"). The Esc scope is shared since
// 2026-10-25 (ui/esc-scope.ts), on the owner's word: three views needed it.

import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { holdEscapeWhileActive } from "../ui/esc-scope";
import { formatConflictTimestamp } from "./strip-conflict-suffix";
import {
  DiffDetailController,
  type DiffDetailHost,
} from "./diff-detail-controller";
import type { DiffEditViewDeps } from "./diff-panel-view";
import { installMobileHeaderClamp } from "./mobile-header-clamp";
import { ConflictResolvedModal, FilesChangedModal } from "./recovery-dialog";
import {
  openDescFor,
  persistedEditorState,
  historyEntryFromState,
  type EditorTabState,
  type OpenEditorDesc,
  editorOpenDecision,
  diskChangedSinceSeen,
  editorRefreshDecision,
} from "./editor-tabs";
import {
  autosaveIdForEntry,
  entryFromSibling,
  type ConflictEntry,
} from "./synthetic-detector";
import { isConflictPair } from "../sync2/conflict-siblings";

export const DIFF2_EDITOR_VIEW_TYPE = "diff2-editor-view";

export class DiffEditorView extends ItemView implements DiffDetailHost {
  private readonly deps: DiffEditViewDeps;
  // S2 — the detail engine, shared verbatim with the panel host. Created per-view
  // in onOpen; mount/dispose cycle inside.
  private controller!: DiffDetailController;
  // The pair this tab resolves. Set once at mount (the editor never re-targets —
  // one pair per leaf), so the title is naturally static.
  private state: EditorTabState | null = null;
  private entry: ConflictEntry | null = null;
  private mounted = false;
  // tryMount is now async (a sibling-exists check). Set synchronously at the top of the
  // one call that has both controller+state ready, so a second setState landing during
  // its first await can't double-mount.
  private mounting = false;
  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDITOR_VIEW_TYPE;
  }

  getIcon(): string {
    return "git-merge";
  }

  getDisplayText(): string {
    // The file being resolved, fixed once `entry` lands. Since 1B made tryMount ASYNC
    // (a sibling-exists check), `entry` is set AFTER setState returns — so Obsidian's
    // post-setState read of getDisplayText sees `null` → "Diff editor". `refreshHeader()`
    // (called once when entry lands) forces a re-read. This is a ONE-TIME title set, not
    // the panel's per-nav dynamic flip.
    if (!this.entry) return "Diff editor";
    const e = this.entry;
    return `${e.basePath} · ${e.deviceLabel} @ ${formatConflictTimestamp(e.isoTimestamp)}`;
  }

  // Force Obsidian to re-read getDisplayText() — the TAB title (undocumented
  // `updateHeader`) + the centered VIEW-HEADER title (direct DOM, scoped to this leaf).
  // Called ONCE when the entry lands (tryMount is async since 1B). Best-effort.
  private refreshHeader(): void {
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    const headerTitle = this.contentEl
      .closest(".workspace-leaf-content")
      ?.querySelector(".view-header-title");
    if (headerTitle) headerTitle.textContent = this.getDisplayText();
  }

  // 1B persistence — Obsidian serializes this leaf to workspace.json (every layout change
  // + on quit) so it restores on restart. We persist only the pair IDENTITY, and STRIP
  // `openMode`: a restored leaf therefore never carries openMode → its mount is SILENT (a
  // continuation, R-C2), while a user-reopen (openEditorForPair injects `openMode:"user"`)
  // shows the ResumeRecoveryModal.
  //
  // Duplicate safety still holds: a "Split"/"Open in new window" clone gets the FULL state
  // (so it reaches tryMount's scan-guard, which refuses it — exactly as before). The
  // empty-state branch is now a defensive fallback for a genuinely corrupt/empty state.
  getState(): Record<string, unknown> {
    return (this.state ? persistedEditorState(this.state) : {}) as unknown as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(state: any, result: unknown): Promise<void> {
    this.state = state as EditorTabState;
    await super.setState(state, result as never);
    void this.tryMount();
  }

  async onOpen(): Promise<void> {
    this.controller = new DiffDetailController(this.app, this.deps, this);

    // §2.2.17 — Cmd/Ctrl+F opens the diff-editor's OWN search panel. Obsidian
    // captures Mod+F before a custom view's CM6 keymap; a window capture-phase
    // keydown wins, gated on focus being in OUR editor. (Duplicated from the panel
    // host — each editor leaf installs its own, self-guarded by the dom-contains
    // check so only the focused editor reacts.)
    this.registerDomEvent(
      window,
      "keydown",
      (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "r" || e.key === "R")) {
          // Ctrl/Cmd+R — only for the editor the user is in.
          if (this.app.workspace.activeLeaf !== this.leaf) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          void this.onActivated(); // the same check as a focus, one at a time
          return;
        }
        if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F"))) return;
        const v = this.controller.getView();
        if (!v || !v.dom.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.controller.toggleSearch();
      },
      { capture: true },
    );

    // TODO #8 — ESC must NOT pull focus out of the diff-editor. A keymap Scope
    // swallows it through Obsidian's own dispatch; pushed only while this leaf is
    // active so ESC keeps working in other tabs. The mechanism is shared since
    // 2026-10-25 (ui/esc-scope.ts — the diff-panel and the log viewer use it too).
    holdEscapeWhileActive(this);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        // Re-focus the editor when this leaf becomes active again (Obsidian does
        // this for MarkdownView but not a custom ItemView).
        if (leaf === this.leaf) {
          this.controller.getView()?.focus();
          this.onLeafActivated();
        }
      }),
    );

    // Obsidian's window gets the OS focus back (owner, 2026-10-18): the user
    // returns from another program — check what changed meanwhile.
    const win = this.containerEl.ownerDocument?.defaultView;
    if (win) this.registerDomEvent(win, "focus", () => this.onWindowFocus());

    // A change to one of this editor's files (owner, 2026-10-18) — see
    // onVaultChange. Dot-paths send no events; the focus check covers them.
    this.registerEvent(this.app.vault.on("modify", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onVaultChange(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onVaultChange(f.path)));
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        this.onVaultChange(f.path);
        this.onVaultChange(oldPath);
      }),
    );

    void this.tryMount();
  }

  // Every focus of this tab works as Ctrl/Cmd+R (owner, 2026-10-12) — a focus
  // with the OS input on it (owner, 2026-10-18: onLeafActivated /
  // onWindowFocus). One
  // check at a time: the windows it may show move the focus, and that is not
  // a second check; nothing runs before the editor is mounted.
  private activating = false;
  async onActivated(): Promise<void> {
    if (!this.mounted || this.activating) return;
    this.activating = true;
    try {
      await this.refreshFromDisk();
    } finally {
      this.activating = false;
    }
  }

  // Ctrl/Cmd+R, a focus, or a file event (owner, 2026-10-12 / 2026-10-18):
  // look at the disk again. Resolved outside → the tab closes, no window,
  // back to the Diff Panel; changed on disk since the user last saw it →
  // "Files changed outside the editor" [Reload and start over] / [Continue];
  // nothing new → nothing.
  //
  // Two SEPARATE files (not a file and its own conflict copy — two ordinary
  // files, or two copies of one file; owner, 2026-10-12): if one of them is
  // gone, "One of the files is gone" [Exit] and the tab closes.
  //
  // `quiet` (a file event while this tab is not in focus — owner, 2026-10-18):
  // only an UNEDITED editor follows the disk, silently; no window, no focus
  // move — everything else waits for the focus (the tab cleaner closes a
  // resolved conflict's tab on its own).
  private async refreshFromDisk(opts: { quiet?: boolean } = {}): Promise<void> {
    const entry = this.entry;
    if (!entry || !this.state || this.state.origin === "history") return;
    const pair = isConflictPair(entry.basePath, entry.siblingPath);
    const adapter = this.deps.vault.adapter;
    const resolved = !pair
      ? false
      : this.deps.isCopyResolved
        ? await this.deps.isCopyResolved(entry.basePath, entry.siblingPath)
        : !(await adapter.exists(entry.siblingPath));
    let gonePath: string | null = null;
    if (!pair) {
      if (!(await adapter.exists(entry.basePath))) gonePath = entry.basePath;
      else if (!(await adapter.exists(entry.siblingPath))) gonePath = entry.siblingPath;
    }
    const fileGone = gonePath !== null;
    const disk = resolved || fileGone ? null : await this.controller.diskVersusStart();
    const decision = editorRefreshDecision({
      pair,
      resolved,
      fileGone,
      changedOnDisk: disk !== null && diskChangedSinceSeen({ ...disk, seen: this.seenDisk }),
    });
    if (opts.quiet) {
      if (decision !== "ask-changed" || !disk || (await this.controller.hasUnsavedChanges())) return;
      await this.reloadFromDisk();
      return;
    }
    if (decision === "close-resolved") {
      // No window (owner, 2026-10-18): resolved outside is too late for one.
      this.leaf.detach();
      this.deps.showDiffPanel?.();
    } else if (decision === "close-file-gone") {
      await new ConflictResolvedModal(this.app, gonePath!, "gone").prompt();
      this.leaf.detach();
    } else if (decision === "ask-changed" && disk) {
      // Nothing edited yet (owner, 2026-10-18): follow the disk silently —
      // the window is only for a user who already started resolving.
      const edited = await this.controller.hasUnsavedChanges();
      if (edited) {
        const choice = await new FilesChangedModal(this.app, entry.basePath).prompt();
        if (!this.mounted) return; // the tab went while the window was open
        if (choice === "continue") {
          this.seenDisk = disk.now; // ask again only when the disk moves on from here
          return;
        }
      }
      await this.reloadFromDisk();
    }
  }

  // Reload (asked or silent): a fresh session from the disk as it is now.
  private async reloadFromDisk(): Promise<void> {
    await this.controller.discardSession();
    this.mounted = false;
    this.seenDisk = null;
    await this.tryMount();
  }

  // The disk state the user answered about last in the "files changed"
  // window (null: none yet in this session).
  private seenDisk: string | null = null;

  // A vault event for one of this editor's two files (owner, 2026-10-18):
  // check only while this editor IS the active tab — a change made in the
  // file explorer is asked about when the user comes back here (the focus
  // check). This editor's own [←] writes are not a change outside it.
  onVaultChange(path: string): void {
    const entry = this.entry;
    if (!entry || (path !== entry.basePath && path !== entry.siblingPath)) return;
    if (this.controller?.isCommitting()) return;
    if (this.hasInputFocus()) {
      void this.onActivated();
      return;
    }
    // Not in focus: an unedited editor still follows the disk, quietly.
    void this.checkQuietly();
  }

  private async checkQuietly(): Promise<void> {
    if (!this.mounted || this.activating) return;
    this.activating = true;
    try {
      await this.refreshFromDisk({ quiet: true });
    } finally {
      this.activating = false;
    }
  }

  // "In focus" (owner, 2026-10-18): this tab is Obsidian's active tab AND
  // its window has the OS input focus — the user is typing/clicking here
  // right now. A change made in another program is asked about only when
  // the user comes back (onWindowFocus).
  private hasInputFocus(): boolean {
    return this.app.workspace.activeLeaf === this.leaf && this.osHasFocus();
  }

  private osHasFocus(): boolean {
    return this.containerEl?.ownerDocument?.hasFocus() ?? false;
  }

  // This tab just became the active tab (the caller checked the leaf).
  onLeafActivated(): void {
    if (this.osHasFocus()) void this.onActivated();
  }

  // Obsidian's window got the OS focus back.
  onWindowFocus(): void {
    if (this.app.workspace.activeLeaf === this.leaf) void this.onActivated();
  }

  // Mount the detail editor once BOTH the controller (onOpen) and the state (setState)
  // are ready — Obsidian's call order between them is not guaranteed. Only ONE call ever
  // has both ready (the other returns early), so there is no concurrent-proceed; the
  // `mounting` flag guards the narrower case of a second setState landing during the
  // sibling-exists await.
  private async tryMount(): Promise<void> {
    if (this.mounted || this.mounting || !this.controller || !this.state) return;
    // 7a.3 — a History editor has no conflict sibling to parse; it mounts a read-only
    // version against currentFile. Branch before the conflict-sibling machinery below.
    if (this.state.origin === "history") {
      await this.tryMountHistory();
      return;
    }
    // Defensive: a genuinely corrupt/empty state (siblingPath missing). With 1B's getState
    // a clone carries the full state and is caught by the scan-guard below instead, so this
    // is now a rare fallback. parseSiblingFilename would THROW on a non-string anyway.
    const siblingPath = this.state.siblingPath;
    if (typeof siblingPath !== "string" || !siblingPath) {
      new Notice("A diff-editor tab can't be split or duplicated. Reopen it from the Diff Panel.");
      this.leaf.detach();
      return;
    }
    this.mounting = true;

    // The async portion (an adapter.exists check) is wrapped so an unexpected rejection
    // detaches the leaf rather than leaving a stuck blank editor (mounting=true, never
    // mounted, never closed). The intentional detach-return paths below are unaffected.
    try {
      const entry = entryFromSibling(this.deps.conflictStore, siblingPath);
      if (!entry) {
        // Not a `*.conflict-from-*` sibling (stale / hand-edited state) — nothing to
        // resolve. Detach so a dead tab doesn't linger.
        this.deps.logger?.warn("diff2: an editor tab points at a file that is no longer a conflict — closing", { siblingPath });
        new Notice("This diff-editor tab points at a file that is no longer a conflict.");
        this.leaf.detach();
        return;
      }

      // 1B — the conflict may have been RESOLVED between sessions: a crash mid-`[←]`-commit
      // is finished by onload recoverCommit (sibling removed) BEFORE this restored tab
      // mounts, so a restored editor can point at a now-gone conflict. Close cleanly rather
      // than rendering a "Failed to load diff" error body. (Absent BASE is legit — a
      // delete-vs-modify conflict; mount reads "" for it. Only an absent SIBLING means
      // "resolved → gone".)
      // Owner, 2026-10-12: a conflict resolved OUTSIDE the editor (its copy
      // gone, or byte-equal to its base) does not open. The user who opened
      // it is told it is already resolved; a restored tab in focus closes
      // without a window and the Diff Panel shows (owner, 2026-10-18); any
      // other restored tab closes silently.
      const resolved = this.deps.isCopyResolved
        ? await this.deps.isCopyResolved(entry.basePath, siblingPath)
        : !(await this.deps.vault.adapter.exists(siblingPath));
      const decision = editorOpenDecision({
        resolved,
        userOpened: this.state.openMode === "user",
        // The tab the user works in: the most recent MAIN-AREA leaf — the
        // file explorer being Obsidian's active leaf does not hide it.
        focused: this.leaf === this.app.workspace.getMostRecentLeaf(),
      });
      if (decision !== "mount") {
        if (decision === "notify-already-resolved") {
          await new ConflictResolvedModal(this.app, entry.basePath, "open").prompt();
        }
        this.leaf.detach();
        // Back to the panel unless the tab was in the background — and
        // the panel's focus re-reads its list, so the row of a conflict found
        // resolved here goes too (owner, 2026-10-12).
        if (decision !== "close-silently") this.deps.showDiffPanel?.();
        return;
      }

      // DUPLICATE guard for a full-state clone (split/open-in-new-window): scan for a LIVE
      // editor already holding this pair (same autosaveId — the key the open-guard uses)
      // and, if found, this leaf is the clone → close it and focus the original. The
      // original is already mounted (never re-runs tryMount), so there is no mutual-suicide.
      // MUST run before controller.mount touches the shared dir. (On a restart, restored
      // editors have UNIQUE pairs → no false match.)
      const autosaveId = autosaveIdForEntry(entry);
      const original = this.app.workspace
        .getLeavesOfType(DIFF2_EDITOR_VIEW_TYPE)
        .find(
          (l) =>
            l !== this.leaf &&
            l.view instanceof DiffEditorView &&
            l.view.openDesc()?.autosaveId === autosaveId,
        );
      if (original) {
        new Notice("This conflict is already open in another diff-editor tab.");
        this.leaf.detach();
        this.app.workspace.revealLeaf(original);
        if (original.view instanceof DiffEditorView) original.view.focusEditor();
        return;
      }

      this.entry = entry;
      this.refreshHeader(); // entry just landed (async) → make Obsidian re-read getDisplayText
      this.mounted = true;
      const container = this.contentEl;
      container.empty();
      container.addClass("diff2-edit-view-root");
      // R-C2 — a restored leaf carries no `openMode` (getState strips it) → silent resume;
      // a user-reopen has `openMode:"user"` → the ResumeRecoveryModal.
      const silentResume = !this.state.openMode;
      void this.controller.mount(container, entry, { silentResume }).then(() => {
        // Mobile header clamp (tail1) — install after the CM6 scroller exists. Editor-tab only;
        // no-op on desktop. register() auto-disposes on view close.
        requestAnimationFrame(() => {
          const dispose = installMobileHeaderClamp(container, () => this.controller.getView()?.scrollDOM, this.deps.logger);
          if (dispose) this.register(dispose);
        });
      });
    } catch (err) {
      this.deps.logger?.error("diff2 editor tryMount failed — detaching", { err: String(err) });
      this.leaf.detach();
    } finally {
      // The mount decision is made — `mounted` guards from here on. Left set,
      // it blocked every later remount of this tab (empty editor; field,
      // 2026-10-18).
      this.mounting = false;
    }
  }

  // 7a.3 — mount a read-only historical version against currentFile. Mirrors the
  // conflict tryMount (dup-guard, exists-check, mounting flag) but builds a synthetic
  // entry and passes the lazy bytes-fetcher through to the controller's fresh path.
  private async tryMountHistory(): Promise<void> {
    const state = this.state!;
    const entry = historyEntryFromState(state);
    if (!entry) {
      this.deps.logger?.warn("diff2 history: a tab is missing its version — closing");
      new Notice("This history tab is missing its version — reopen it from the file's history.");
      this.leaf.detach();
      return;
    }
    const currentFile = entry.basePath;
    const version = state.historyVersion!;
    this.mounting = true;
    try {
      // currentFile deleted between sessions → nothing to diff against. Close cleanly.
      if (!(await this.deps.vault.adapter.exists(currentFile))) {
        this.deps.logger?.warn("diff2 history: the file no longer exists — closing its editor", { path: currentFile });
        new Notice("The file no longer exists — closing its history editor.");
        this.leaf.detach();
        return;
      }
      // DUPLICATE guard (split / restored clone): another editor already holds this
      // exact version (same autosaveId) → this leaf is the clone, close it + focus original.
      const autosaveId = autosaveIdForEntry(entry);
      const original = this.app.workspace
        .getLeavesOfType(DIFF2_EDITOR_VIEW_TYPE)
        .find(
          (l) =>
            l !== this.leaf &&
            l.view instanceof DiffEditorView &&
            l.view.openDesc()?.autosaveId === autosaveId,
        );
      if (original) {
        new Notice("This version is already open in another tab.");
        this.leaf.detach();
        this.app.workspace.revealLeaf(original);
        if (original.view instanceof DiffEditorView) original.view.focusEditor();
        return;
      }
      if (!this.deps.fetchHistoryVersionBytes) {
        this.deps.logger?.warn("diff2 history: not available — GitHub sync not configured");
        new Notice("History editing isn't available (GitHub sync not configured).");
        this.leaf.detach();
        return;
      }

      this.entry = entry;
      this.refreshHeader();
      this.mounted = true;
      const container = this.contentEl;
      container.empty();
      container.addClass("diff2-edit-view-root");
      const silentResume = !state.openMode;
      void this.controller
        .mount(container, entry, {
          silentResume,
          history: {
            versionSha: version.id,
            fetchBytes: () =>
              this.deps.fetchHistoryVersionBytes!(currentFile, version),
          },
        })
        .then(() => {
          // Mobile header clamp — MUST install for History too. Was conflict-path-only
          // (tryMount); the History path forgot it, so a History editor had no toolbar
          // shutter AND hit the Android keyboard-shrink blank (white screen) that the
          // clamp fixes. Same install as tryMount; no-op on desktop; auto-disposed on close.
          requestAnimationFrame(() => {
            const dispose = installMobileHeaderClamp(container, () => this.controller.getView()?.scrollDOM, this.deps.logger);
            if (dispose) this.register(dispose);
          });
        });
    } catch (err) {
      this.deps.logger?.error("diff2 history tryMount failed — detaching", {
        err: String(err),
      });
      this.leaf.detach();
    } finally {
      this.mounting = false; // see tryMount
    }
  }

  async onClose(): Promise<void> {
    this.controller?.dispose();
    // Closed: an answer still pending in a window (e.g. "files changed" →
    // Reload) must not mount into this leaf any more.
    this.mounted = false;
    // UI reconcile site 3 of 3 (§III "ЗАУВАЖЕННЯ"): leaving the editor
    // is where resolutions land on disk (base rewritten, sibling
    // deleted) — reconcile conflicts.json with that reality so the
    // resolved entry prunes (and, via the prune seam, trash's
    // the record is pruned) without waiting for the next drain.
    // Only for a conflict copy — not History, not two ordinary files.
    const closed = this.entry;
    if (closed && isConflictPair(closed.basePath, closed.siblingPath)) {
      void this.deps.reconcileConflicts?.();
    }
  }

  // S4 open-guard — this editor's descriptor for `openGuard` (the autosaveId
  // same-pair key + the write-set it would commit). Built through `openDescFor` so
  // the write-set is normalized (the carry-flag). Available from the STATE before
  // the async mount completes (a rapid double-open is caught), and null when the
  // state is missing / not a real conflict sibling.
  // TODO §21 — does this editor hold unsaved work? Read by the open-guard to decide reload
  // (clean) vs the "already modified" warning. Null controller (pre-mount) → clean. Async: the
  // content-SHA check git-blob-SHAs both reconstructed sides.
  async hasUnsavedChanges(): Promise<boolean> {
    return (await this.controller?.hasUnsavedChanges()) ?? false;
  }

  // TODO §21 — the HISTORY version this editor currently shows (per-file autosaveId collapses
  // all versions to one open-guard key, so main.ts compares versions to tell "same version →
  // reveal" from "different version → reload"). Undefined for a conflict editor.
  historyVersionSha(): string | undefined {
    return this.state?.historyVersion?.id;
  }

  // TODO §21 — dispose in REPLACE mode ahead of a reload: no abandon-wipe (the caller clears the
  // shared per-file dir explicitly, ordered before the new mount). Called before detach so the
  // subsequent onClose→dispose is an idempotent no-op.
  disposeForReload(): void {
    this.controller?.dispose(true);
  }

  // TODO §21 resume-move — flush pending edits before a move-close so the silent resume at the
  // new location restores the latest keystrokes (not just the last auto-saved tail).
  async flushEdits(): Promise<void> {
    await this.controller?.flushForReload();
  }

  openDesc(): OpenEditorDesc | null {
    const s = this.state;
    if (!s) return null;
    // 7a.3 — history entry is built from state (no conflict sibling to parse).
    if (s.origin === "history") {
      const entry = this.entry ?? historyEntryFromState(s);
      if (!entry) return null;
      return openDescFor("history", entry.basePath, entry.siblingPath, autosaveIdForEntry(entry));
    }
    if (typeof s.siblingPath !== "string" || !s.siblingPath) return null;
    const entry = this.entry ?? entryFromSibling(this.deps.conflictStore, s.siblingPath);
    if (!entry) return null;
    return openDescFor(s.origin, entry.basePath, entry.siblingPath, autosaveIdForEntry(entry));
  }

  // Focus the editor's CM6 view — used by the open-guard's focus/switch paths when
  // they reveal THIS already-open tab. `revealLeaf` activates the tab but does NOT
  // reliably put the caret in the editor (Obsidian's own focus management runs after
  // our active-leaf-change handler, and a just-revealed view isn't measured yet), so
  // the user otherwise has to click the text. Deferring past layout (same rAF pattern
  // as the controller's auto-focus) lets focus() land.
  focusEditor(): void {
    requestAnimationFrame(() => this.controller?.getView()?.focus());
  }

  // This tab's own [←] is saving — read by the editor-tab cleaner in main.ts.
  isCommitting(): boolean {
    return this.controller?.isCommitting() ?? false;
  }

  // ── DiffDetailHost — the navigation seam ──────────────────────────────────

  // One pair per leaf, so this is effectively always true; the explicit compare is a
  // defensive backstop (the controller separately checks `!body.isConnected`).
  isStillTargeting(entry: ConflictEntry): boolean {
    return this.entry?.siblingPath === entry.siblingPath;
  }

  // Leaving detail without a commit (cancel / no session) → close the tab. The
  // editor is pure detail (R-D); there is no list to fall back to. detach() →
  // onClose → controller.dispose() runs the §4.1 abandon-wipe if the session was
  // a fresh net-0 (the controller already nulls activeSession on a real commit).
  // Leaving without a commit (resolved outside on [←], the copy gone at mount,
  // Cancel in the recovery window). A CONFLICT editor always lands in the Diff
  // Panel, opening it if it is closed (owner, 2026-10-12 — otherwise Obsidian
  // activates whatever tab is next). History and two separate files just close
  // — for now: the future "Diff with…" mode will open the FIRST file's tab
  // (the one the user started from; TODO п.58).
  onLeaveDetail(): void {
    const s = this.state;
    const toPanel =
      s?.origin === "conflict" &&
      typeof s.basePath === "string" &&
      typeof s.siblingPath === "string" &&
      isConflictPair(s.basePath, s.siblingPath);
    this.leaf.detach();
    if (toPanel) this.deps.showDiffPanel?.();
  }

  // `[←]` committed → close the tab + navigate back (R-D, S5). Capture the origin
  // BEFORE detach (this.leaf/state vanish); the host (main.ts) reveals the panel and
  // scrolls to the base group. For a conflict the anchor is the base just committed.
  // The controller already nulled its activeSession before calling this, so
  // detach → onClose → dispose skips the §4.1 abandon-wipe (the commit removed the dir).
  onCommitExit(entry: ConflictEntry, opts?: { copyRemoved?: boolean }): void {
    const origin = this.state?.origin ?? "conflict";
    const src = this.leaf;
    if (origin === "history") {
      // 7a UX — return to the history list in THIS editor's tab group, not a random
      // one. If the user CLOSED the history tab by hand, the host reopens it via
      // getLeaf("tab"), which targets the ACTIVE group — so open FIRST (this editor is
      // still active + attached → its group), THEN detach. (When the history tab is
      // still open the host's dup-guard just reveals it; order is harmless there.)
      void Promise.resolve(
        this.deps.onEditorCommitted?.(origin, entry.basePath),
      ).finally(() => src.detach());
    } else if (!isConflictPair(entry.basePath, entry.siblingPath)) {
      // Two separate files: the Diff Panel is about conflicts — just close (for
      // now; the future "Diff with…" mode opens the first file's tab, TODO п.58).
      src.detach();
    } else {
      // Conflict: the panel is a singleton with its own spot. A copy this
      // [←] removed leaves the panel's list FIRST (owner, 2026-10-18):
      // closing this tab brings the panel back on screen, and its row must
      // not be there even for a moment.
      if (opts?.copyRemoved) this.deps.onCopyRemoved?.(entry.siblingPath);
      src.detach();
      this.deps.onEditorCommitted?.(origin, entry.basePath);
    }
  }
}
