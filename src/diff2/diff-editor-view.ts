// Diff-Editor tab — the multi-tab host ItemView (S3 of the panel/editor split,
// docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// One `diff2-editor-view` leaf per `base:sibling` pair (Option A, R-A). It reuses
// the SAME `DiffDetailController` as the singleton panel host (`DiffEditView`) —
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
import { openDescFor, type EditorTabState, type OpenEditorDesc } from "./editor-tabs";
import {
  autosaveIdForEntry,
  entryFromSibling,
  type ConflictEntry,
} from "./synthetic-detector";

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
  // TODO #8 — ESC-swallowing scope (Obsidian's default ESC jumps focus to the last
  // markdown editor). Pushed only while THIS leaf is active. Duplicated from the
  // panel host per the §12 per-host-chrome decision.
  private escScope: Scope | null = null;
  private escScopePushed = false;

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
    // Static for the leaf's lifetime — the file being resolved. Obsidian reads this
    // after setState (its standard onOpen→setState order), by which point `entry` is
    // set. No `refreshHeader`/`updateHeader` hack (that was the panel's dynamic flip).
    if (!this.entry) return "Diff editor";
    const e = this.entry;
    return `${e.basePath} · ${e.deviceLabel} @ ${formatConflictTimestamp(e.isoTimestamp)}`;
  }

  // getState/setState — Obsidian serializes a leaf to workspace.json on every layout
  // change and rebuilds it from that state on an in-session leaf-move (e.g. dragging
  // the tab into a split). Returning the live state preserves the pair across such a
  // move. (1B adds restart-restore by dropping the unload-detach + registering for
  // restore; this in-session getState is the smaller, separable need.)
  getState(): Record<string, unknown> {
    return (this.state ?? {}) as unknown as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(state: any, result: unknown): Promise<void> {
    this.state = state as EditorTabState;
    await super.setState(state, result as never);
    this.tryMount();
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

    this.tryMount();
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

  // Mount the detail editor once BOTH the controller (onOpen) and the state
  // (setState) are ready — Obsidian's call order between them is not guaranteed, so
  // either entry point calls this and the mounted-guard makes the later one a no-op.
  private tryMount(): void {
    if (this.mounted || !this.controller || !this.state) return;
    // Untrusted state: a moved leaf is rebuilt via setState({}) before the real state
    // lands, so siblingPath may be missing — entryFromSibling → parseSiblingFilename
    // THROWS on a non-string. Guard, then close cleanly if the pair is unusable.
    const siblingPath = this.state.siblingPath;
    if (typeof siblingPath !== "string" || !siblingPath) return;

    const entry = entryFromSibling(this.deps.conflictStore, siblingPath);
    if (!entry) {
      // Not a `*.conflict-from-*` sibling (stale / hand-edited state) — nothing to
      // resolve. Detach so a dead tab doesn't linger.
      new Notice("This diff-editor tab points at a file that is no longer a conflict.");
      this.leaf.detach();
      return;
    }

    this.entry = entry;
    this.mounted = true;
    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");
    void this.controller.mount(container, entry);
  }

  async onClose(): Promise<void> {
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

  // `[←]` committed → close the tab. S5 specializes this to detach + reveal the
  // panel + scroll to the base group (origin-routed via this.state.origin); S3 just
  // closes the editor.
  onCommitExit(_entry: ConflictEntry): void {
    this.leaf.detach();
  }
}
