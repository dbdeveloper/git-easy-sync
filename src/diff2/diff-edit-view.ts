// Diff-Edit widget — the host ItemView that Obsidian opens in a tab.
//
// As of S2 of the panel/editor split (docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md
// §12) the DETAIL engine — DiffPaneOwner lifecycle, recovery/resume flow, toolbar,
// and the `[←]` 7-step commit — lives in `DiffDetailController`. This view is the
// HOST: it owns the list↔detail navigation state machine, the sub-tab header, the
// conflicts list, the ESC scope, the Mod+F window hook, and the ConflictCounter
// subscription; it delegates everything detail to the controller and answers the
// controller's three navigation callbacks (DiffDetailHost). S3 introduces a second,
// multi-tab host (`DiffEditorView`) that reuses the SAME controller with a
// detach-and-reveal implementation of those callbacks.
//
// Phase 1 ships:
//   - Sub-tabs header (Conflicts / Deleted).
//   - Conflicts list body (real, populated via synthetic-detector).
//   - Deleted body placeholder (Phase 9b).
//   - Detail view (DiffPane via the controller) reachable by clicking a row;
//     `[←]` back arrow commits + returns to list.
//   - Subscribes to ConflictCounter so the list refreshes when the
//     vault changes (sibling create/delete/rename).
//
// Future phases:
//   Phase 7 — History list + restore
//   Phase 8 — Compare picker + compare-mode
//   Phase 9b — Deleted-mode UI + restore
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.7.5 (default sub-tab)
//   - docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12 (S2 host/engine seam)

import { ItemView, Scope, type Vault, WorkspaceLeaf } from "obsidian";
import type SnapshotStore from "../sync2/snapshot-store";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { formatConflictTimestamp } from "./strip-conflict-suffix";
import { DiffEditSubTab } from "./events";
import type Logger from "../logger";
import {
  findAllConflicts,
  type ConflictEntry,
} from "./synthetic-detector";
import {
  DiffDetailController,
  type DiffDetailHost,
} from "./diff-detail-controller";
import type { BackNav, DiffEditorOrigin } from "./editor-tabs";

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
  // Diff highlight granularity: true → word-level, false → char-level (default). Read at open.
  diffWordLevel?: () => boolean;
  // §2.2.15 Auto-focus default (scroll to the first remaining conflict on each resolve). Read
  // at open; toggled per-session in the toolbar. Default true.
  autoFocus?: () => boolean;
  // Plugin logger — the §5.0.e one-side-silent exit logs here instead of
  // nagging the user with a Notice (no-op when logging is disabled). Optional
  // in test fixtures.
  logger?: Logger;
  // S4 — open a dedicated `diff2-editor-view` tab for a conflict (behind the
  // open-guard). The panel routes a conflicts-list row-click here; its own
  // detail-mode is bypassed (dead code until the S6 slim-down). Optional so test
  // fixtures / the editor host (which never lists) can omit it.
  openEditor?: (entry: ConflictEntry) => void;
  // S5 — the editor host calls this on a committed `[←]` so the host (main.ts) can
  // navigate back: reveal the singleton panel + scroll to the base group (R-D). origin
  // routes the destination; anchorPath = base for a conflict.
  onEditorCommitted?: (origin: DiffEditorOrigin, anchorPath: string) => void;
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

export class DiffEditView extends ItemView implements DiffDetailHost {
  private viewState: Phase1ViewState = initialState();
  private readonly deps: DiffEditViewDeps;
  // S2 — the detail engine (owner lifecycle, recovery, toolbar, `[←]` commit). Created
  // per-view in onOpen; the mount/dispose cycle happens inside. The host (this view)
  // answers its three navigation callbacks below.
  private controller!: DiffDetailController;
  // Unsubscribe handle from ConflictCounter.subscribe — set on open,
  // called on close.
  private unsubscribeCounter: (() => void) | null = null;
  // TODO #8 — a keymap Scope that swallows ESC (so Obsidian's default "ESC →
  // focus the markdown editor" can't pull focus out of the diff-editor). Pushed
  // only while THIS view is the active leaf (so ESC still works in other tabs).
  private escScope: Scope | null = null;
  private escScopePushed = false;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    // The view header (and tab) double as the detail title — saves a body row. In a detail
    // view it shows the file being resolved (path · device @ date); the list shows the panel
    // name. render() calls refreshHeader() so it flips on enter/back. (Screenshot-17.)
    if (this.viewState.mode === "detail") {
      const e = this.viewState.entry;
      return `${e.basePath} · ${e.deviceLabel} @ ${formatConflictTimestamp(e.isoTimestamp)}`;
    }
    // "Diff Panel" (not "Conflict Panel") — Conflicts is only one of its roles
    // (Deleted / History sub-tabs too).
    return "Diff Panel";
  }

  // Force Obsidian to re-read getDisplayText() for the view header + tab. `updateHeader` is an
  // undocumented WorkspaceLeaf method (the standard dynamic-title trick); guarded so a future
  // API change just leaves the header on its last value until the next natural refresh.
  private refreshHeader(): void {
    const title = this.getDisplayText();
    // `updateHeader` (undocumented) refreshes the TAB; keep it best-effort.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    // Reliable path for the centered VIEW-HEADER title: set its DOM element directly, scoped to
    // THIS leaf. Obsidian only re-reads getDisplayText() on its own events (active-leaf-change…),
    // and getDisplayText() returns the same dynamic value, so the direct set stays consistent.
    const headerTitle = this.contentEl.closest(".workspace-leaf-content")?.querySelector(".view-header-title");
    if (headerTitle) headerTitle.textContent = title;
  }

  getIcon(): string {
    return "git-merge";
  }

  async onOpen(): Promise<void> {
    // Singleton (R-A): exactly ONE diff-panel per vault — the editor's `[←]` reveals
    // "the" panel, so a second one would make back-navigation ambiguous. Obsidian
    // "Split"/"Open in new window" clone the view into a new leaf; if another panel
    // already exists, this leaf is the clone → reveal the original and close this one.
    // (activateDiffEditView reveals-or-creates a single leaf, so this only fires on an
    // Obsidian-initiated duplicate.)
    // ⚠️ 1B note: if two panel leaves' onOpen ever fire in the SAME tick (only reachable
    // once 1B makes panels restart-persistent → a saved pair restored together), each
    // finds the other and BOTH detach → zero panels. Unreachable in 1A (unload detaches
    // panels, nothing restores). When 1B lands, dedup once at layout-ready / keep-by-leaf-
    // order instead of each onOpen racing.
    const existing = this.app.workspace
      .getLeavesOfType(DIFF2_EDIT_VIEW_TYPE)
      .find((l) => l !== this.leaf);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      this.leaf.detach();
      return;
    }

    // S2 — create the per-view detail engine before the first render (render() disposes
    // it at the top; on a list-mode open that is a no-op).
    this.controller = new DiffDetailController(this.app, this.deps, this);

    // §2.2.17 — Cmd/Ctrl+F opens the diff-editor's OWN search panel. Obsidian captures Mod+F for
    // its markdown-editor search before a custom view's CM6 keymap (a View scope does NOT win it —
    // device-confirmed). A window capture-phase keydown fires BEFORE Obsidian's document-level
    // handler, so it wins: it opens the panel only while OUR editor has focus. The CM6
    // search()/searchKeymap cover the panel's own keys (next/prev/Esc) once it is open.
    this.registerDomEvent(
      window,
      "keydown",
      (e) => {
        if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F"))) return;
        const v = this.controller.getView();
        // Only when focus is in OUR editor — its content OR its (open) search panel, so Mod+F can
        // also CLOSE the panel from inside the search field. `view.dom` is the whole .cm-editor.
        if (!v || !v.dom.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.controller.toggleSearch();
      },
      { capture: true },
    );

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
        // re-render would re-run the controller's mount — disposing the live DiffPane
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
        if (leaf === this.leaf) this.controller.getView()?.focus();
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
    // `?.` — a duplicate panel detached itself in onOpen before creating the controller.
    this.controller?.dispose();
  }

  // ── DiffDetailHost — the navigation seam the controller calls back through ──

  // Stale-state guard after an await / a minutes-long modal: still showing THIS entry?
  // The controller separately checks `!body.isConnected`.
  isStillTargeting(entry: ConflictEntry): boolean {
    return (
      this.viewState.mode === "detail" &&
      this.viewState.entry.siblingPath === entry.siblingPath
    );
  }

  // Leaving detail without a commit (cancel / no session) → back to the list.
  onLeaveDetail(): void {
    this.viewState = { mode: "list", tab: "conflicts" };
    this.render();
  }

  // `[←]` committed → back to the list. The controller nulls its activeSession before
  // calling this, so render()'s dispose() skips the §4.1 abandon-wipe (commit already
  // removed the dir).
  onCommitExit(_entry: ConflictEntry): void {
    this.viewState = { mode: "list", tab: "conflicts" };
    this.render();
  }

  // S5 — execute a back-nav the editor host produced via planBackNav: switch to the
  // sub-tab, re-render the (now-fresher) list, and scroll to the resolved base group.
  applyBackNav(nav: BackNav): void {
    this.viewState = { mode: "list", tab: nav.tab };
    this.render();
    if (nav.scrollToBase) this.scrollToBase(nav.scrollToBase);
  }

  // Scroll the conflicts list to a base group's first row. Deferred past layout: the
  // panel was just revealed / re-rendered, so its geometry isn't measured yet and a
  // synchronous scrollIntoView would no-op or mis-target (same reason the controller's
  // auto-focus and the editor's focus-on-reveal defer). rAF also lets the ConflictCounter
  // re-render settle first, so the scroll targets the final DOM. `row?.` covers "the base
  // group is already gone" — the last-sibling-resolved path (planBackNav passed null, but
  // a racing re-render can drop the row too) falls out as a no-op.
  private scrollToBase(basePath: string): void {
    requestAnimationFrame(() => {
      const row = this.contentEl.querySelector<HTMLElement>(
        `.diff2-conflicts-row[data-base-path="${CSS.escape(basePath)}"]`,
      );
      row?.scrollIntoView({ block: "center" });
    });
  }

  // ── render dispatch ───────────────────────────────────────────────

  private render(): void {
    // Dispose any active owner before tearing down its parent DOM —
    // CM6 EditorView.destroy() unhooks its own event listeners + DOM
    // children. If we just empty() the parent without destroy(), we
    // leak the listeners. dispose() is idempotent (gap-2).
    this.controller.dispose();

    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");

    if (this.viewState.mode === "list") {
      this.renderHeader(container, this.viewState.tab);
      this.renderListBody(container, this.viewState.tab);
    } else {
      void this.controller.mount(container, this.viewState.entry);
    }
    this.refreshHeader(); // §title — flip the view header to the file (detail) / "Diff Panel" (list)
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
        // S4 — a row-click opens a dedicated diff2-editor tab (behind the
        // open-guard in main). The panel's own detail-mode is bypassed — single
        // routing only, so viewState never becomes "detail" (the dead detail code
        // is removed in S6). Production always wires openEditor via diffViewDeps.
        onEntryClick: (entry) => this.deps.openEditor?.(entry),
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
}
