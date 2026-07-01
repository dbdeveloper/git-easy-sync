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
//   - does NOT subscribe to ConflictCounter (it is not a list — S2 contract);
//   - has a STATIC title (the file it resolves, fixed for the leaf's lifetime —
//     no dynamic `getDisplayText` flip / `refreshHeader` hack; title-simplification
//     starts here per §12).
//
// Phase 1 only ever mounts `origin: "conflict"`. The escScope + Mod+F window hook
// are duplicated per-host on purpose (the contract ratified "view-level chrome in
// each host, don't gold-plate the generic API"); S6 may factor them.

import { ItemView, Notice, Scope, WorkspaceLeaf } from "obsidian";
import { formatConflictTimestamp } from "./strip-conflict-suffix";
import {
  DiffDetailController,
  type DiffDetailHost,
} from "./diff-detail-controller";
import type { DiffEditViewDeps } from "./diff-edit-view";
import {
  openDescFor,
  persistedEditorState,
  type EditorTabState,
  type OpenEditorDesc,
} from "./editor-tabs";
import {
  autosaveIdForEntry,
  entryFromSibling,
  type ConflictEntry,
} from "./synthetic-detector";

export const DIFF2_EDITOR_VIEW_TYPE = "diff2-editor-view";

// Monotonic per-construction id — proves object identity across a window move. A
// same-instance leaf reparent NEVER re-runs the `(leaf) => new DiffEditorView(...)`
// factory, so no new id is logged; a clone/recreate logs a fresh id. This is the
// definitive "is it the same editor?" signal (also makes editor opens visible in logs).
let diffEditorViewSeq = 0;

export class DiffEditorView extends ItemView implements DiffDetailHost {
  private readonly deps: DiffEditViewDeps;
  private readonly instanceId = ++diffEditorViewSeq;
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
  // TODO #8 — ESC-swallowing scope (Obsidian's default ESC jumps focus to the last
  // markdown editor). Pushed only while THIS leaf is active. Duplicated from the
  // panel host per the §12 per-host-chrome decision.
  private escScope: Scope | null = null;
  private escScopePushed = false;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
    // A NEW line here on a window move ⇒ the view was RECREATED; NO new line ⇒ the same
    // object was reparented into the other window (see diffEditorViewSeq).
    deps.logger?.info("diff2 editor view constructed", { instanceId: this.instanceId });
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
    // active so ESC keeps working in other tabs.
    this.escScope = new Scope(this.app.scope);
    this.escScope.register([], "Escape", () => false);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.syncEscScope(leaf);
        // Re-focus the editor when this leaf becomes active again (Obsidian does
        // this for MarkdownView but not a custom ItemView).
        if (leaf === this.leaf) this.controller.getView()?.focus();
      }),
    );
    this.syncEscScope(this.app.workspace.activeLeaf ?? null);

    void this.tryMount();
  }

  // TODO #8 — push the ESC scope iff this leaf is active; pop otherwise. Idempotent.
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

  // Mount the detail editor once BOTH the controller (onOpen) and the state (setState)
  // are ready — Obsidian's call order between them is not guaranteed. Only ONE call ever
  // has both ready (the other returns early), so there is no concurrent-proceed; the
  // `mounting` flag guards the narrower case of a second setState landing during the
  // sibling-exists await.
  private async tryMount(): Promise<void> {
    if (this.mounted || this.mounting || !this.controller || !this.state) return;
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
      if (!(await this.deps.vault.adapter.exists(siblingPath))) {
        this.leaf.detach();
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
      void this.controller.mount(container, entry, { silentResume });
    } catch (err) {
      this.deps.logger?.info("diff2 editor tryMount failed — detaching", { err: String(err) });
      this.leaf.detach();
    }
  }

  async onClose(): Promise<void> {
    // Fires only if the view is DESTROYED (tab close / recreate). A same-instance window
    // reparent does NOT fire it — so a move with neither this nor a "constructed" line is
    // proof the object was carried across intact.
    this.deps.logger?.info("diff2 editor view onClose", { instanceId: this.instanceId });
    if (this.escScope && this.escScopePushed) {
      this.app.keymap.popScope(this.escScope);
      this.escScopePushed = false;
    }
    this.escScope = null;
    this.controller?.dispose();
  }

  // S4 open-guard — this editor's descriptor for `openGuard` (the autosaveId
  // same-pair key + the write-set it would commit). Built through `openDescFor` so
  // the write-set is normalized (the carry-flag). Available from the STATE before
  // the async mount completes (a rapid double-open is caught), and null when the
  // state is missing / not a real conflict sibling.
  openDesc(): OpenEditorDesc | null {
    const s = this.state;
    if (!s || typeof s.siblingPath !== "string" || !s.siblingPath) return null;
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
  onLeaveDetail(): void {
    this.leaf.detach();
  }

  // `[←]` committed → close the tab + navigate back (R-D, S5). Capture the origin
  // BEFORE detach (this.leaf/state vanish); the host (main.ts) reveals the panel and
  // scrolls to the base group. For a conflict the anchor is the base just committed.
  // The controller already nulled its activeSession before calling this, so
  // detach → onClose → dispose skips the §4.1 abandon-wipe (the commit removed the dir).
  onCommitExit(entry: ConflictEntry): void {
    const origin = this.state?.origin ?? "conflict";
    this.leaf.detach();
    this.deps.onEditorCommitted?.(origin, entry.basePath);
  }
}
