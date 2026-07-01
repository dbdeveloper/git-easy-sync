// Diff-Panel — the singleton list view (S6 of the panel/editor split,
// docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// Since S2–S5 the DETAIL engine (DiffPaneOwner, recovery, toolbar, `[←]` commit)
// lives in `DiffDetailController`, driven by the multi-tab `DiffEditorView`. The
// panel no longer hosts detail mode at all — a conflicts-list row-click opens a
// dedicated `diff2-editor-view` tab (behind the open-guard). So this view is now a
// PURE list: sub-tabs (Conflicts / Deleted), the conflicts list, the ConflictCounter
// subscription, the singleton guard, and the `[←]` back-nav target (applyBackNav).
// S6 deleted the dead detail code (controller, the DiffDetailHost callbacks, the
// Mod+F search hook, the ESC scope, the dynamic-title flip) that the slim-down made
// unreachable.
//
// View-type STRING stays `diff2-edit-view` (stable so saved panel leaves resolve);
// the class is `DiffPanelView`.
//
// Future phases: Phase 9b — Deleted-mode UI; Phase 7/8 — History/Compare (via the
// editor + their own entry points, not a panel sub-tab — R-A).
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list), §R2.7.5 (default tab)
//   - docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12 (the split), R-A/R-D (panel/[←])

import { ItemView, type Vault, WorkspaceLeaf } from "obsidian";
import type SnapshotStore from "../sync2/snapshot-store";
import type { ConflictCounter } from "../sync2/conflict-counter";
import type ConflictStore from "../sync2/conflict-store";
import { renderConflictsList } from "./conflicts-list";
import { DiffEditSubTab } from "./events";
import type Logger from "../logger";
import {
  findAllConflicts,
  type ConflictEntry,
} from "./synthetic-detector";
import type { BackNav, DiffEditorOrigin } from "./editor-tabs";

export const DIFF2_EDIT_VIEW_TYPE = "diff2-edit-view";

// The dependency object both diff2 hosts (this panel + the editor) take. Most fields
// are consumed by the editor's DiffDetailController; the panel itself uses only vault,
// conflictStore, conflictCounter, and openEditor.
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
  // open-guard). The panel routes a conflicts-list row-click here. Optional so test
  // fixtures / the editor host (which never lists) can omit it.
  openEditor?: (entry: ConflictEntry) => void;
  // S5 — the editor host calls this on a committed `[←]` so the host (main.ts) can
  // navigate back: reveal the singleton panel + scroll to the base group (R-D). origin
  // routes the destination; anchorPath = base for a conflict.
  onEditorCommitted?: (origin: DiffEditorOrigin, anchorPath: string) => void;
}

// Which sub-tab is active. (The pre-split list↔detail state machine is gone — the
// panel is list-only; detail lives in `DiffEditorView`.)
interface PanelViewState {
  tab: DiffEditSubTab;
}

function initialState(): PanelViewState {
  // R2.7.5 — default sub-tab is always Conflicts (deterministic UX regardless of
  // pending-count). Even when N === 0 the conflicts tab opens; user switches to Deleted.
  return { tab: "conflicts" };
}

export class DiffPanelView extends ItemView {
  private viewState: PanelViewState = initialState();
  private readonly deps: DiffEditViewDeps;
  // Unsubscribe handle from ConflictCounter.subscribe — set on open, called on close.
  private unsubscribeCounter: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, deps: DiffEditViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_EDIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    // Static (S6 — the dynamic detail-title flip + refreshHeader hack are gone; the
    // file title lives on the editor tab now). "Diff Panel", not "Conflict Panel" —
    // Conflicts is only one of its roles (Deleted sub-tab too).
    return "Diff Panel";
  }

  getIcon(): string {
    return "git-merge";
  }

  async onOpen(): Promise<void> {
    // Singleton via MOVE, not clone (R-A): exactly ONE diff-panel — the editor's `[←]`
    // reveals "the" panel, so a second would make back-nav ambiguous. Obsidian's
    // drag-to-split / "Open in new window" spawns a 2nd leaf whose onOpen fires HERE.
    // THIS leaf is the just-opened one (the drag target), so KEEP it and detach any
    // older panel(s) — the panel MOVES to where the user put it instead of snapping back.
    // Using `this.leaf` (not getLeavesOfType ORDER) means no tree-traversal assumption →
    // correct for both in-window split and popout. The collapse-on-open holds the
    // invariant (any open → exactly one panel), so only one is ever persisted; the old
    // "two onOpens race to zero panels" case is thus unreachable (no layout-ready dedup
    // needed), and even if it somehow occurred it's recoverable by reopening.
    for (const l of this.app.workspace
      .getLeavesOfType(DIFF2_EDIT_VIEW_TYPE)
      .filter((l) => l !== this.leaf)) {
      l.detach();
    }

    // ConflictCounter notifies on any sibling-event vault change → re-render the list.
    // Deferred to a microtask so multiple rapid changes collapse into one re-render.
    this.unsubscribeCounter = this.deps.conflictCounter.subscribe(() => {
      queueMicrotask(() => this.render());
    });

    this.viewState = initialState();
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.unsubscribeCounter) {
      this.unsubscribeCounter();
      this.unsubscribeCounter = null;
    }
  }

  // S5 — execute a back-nav the editor host produced via planBackNav: switch to the
  // sub-tab, re-render the (now-fresher) list, and scroll to the resolved base group.
  applyBackNav(nav: BackNav): void {
    this.viewState = { tab: nav.tab };
    this.render();
    if (nav.scrollToBase) this.scrollToBase(nav.scrollToBase);
  }

  // Scroll the conflicts list to a base group's first row. Deferred past layout: the
  // panel was just revealed / re-rendered, so its geometry isn't measured yet and a
  // synchronous scrollIntoView would no-op or mis-target (same reason the editor's
  // auto-focus and focus-on-reveal defer). rAF also lets the ConflictCounter re-render
  // settle first, so the scroll targets the final DOM. `row?.` covers "the base group is
  // already gone" — the last-sibling-resolved path (planBackNav passed null, but a
  // racing re-render can drop the row too) falls out as a no-op.
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
    const container = this.contentEl;
    container.empty();
    container.addClass("diff2-edit-view-root");
    this.renderHeader(container, this.viewState.tab);
    this.renderListBody(container, this.viewState.tab);
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
        if (this.viewState.tab !== t.id) {
          this.viewState = { tab: t.id };
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
        // A row-click opens a dedicated diff2-editor tab (behind the open-guard in
        // main). Production always wires openEditor via diffViewDeps.
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
