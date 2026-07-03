// Phase 7 §4.7 stage 7a.2 — the `diff2-history` view: a PER-FILE list of a
// file's versions (local unpushed push-queue batches + GitHub commits, merged
// by the 7a.0 data layer). List-only: plain "Loading…", click a row → 7a.3.
// NO filter / skeleton / infinite-scroll (those are 7b). One tab per file
// (per-file dup-guard, §4.2) — many DIFFERENT files can be open at once.
//
// Two template patterns are borrowed verbatim from diff-editor-view.ts (they
// solve the same ItemView hazards):
//   - a BOTH-READY gate: onOpen and setState arrive in an unguaranteed order (a
//     cold-restart restore often hits setState first), so a single `render()` is
//     called from both and no-ops until `contentEl` AND `state.path` exist;
//   - a TRANSIENT empty state: a split/move rebuilds the leaf with `{}` before the
//     real `{path}` lands, so `currentPath()` returns null then (the dup-guard
//     treats null as "no match").

import { ItemView, WorkspaceLeaf } from "obsidian";
import {
  loadHistoryVersions,
  type HistoryCommitSource,
  type HistoryVersion,
  type QueueVersionSource,
} from "./history-versions";

export const DIFF2_HISTORY_VIEW_TYPE = "diff2-history";

export interface DiffHistoryViewDeps {
  // Thunks return null when GitHub sync is not configured (sync2Manager absent) —
  // a restored history leaf on an unconfigured vault renders "not configured"
  // rather than throwing in the view factory.
  queue: () => QueueVersionSource | null;
  client: () => HistoryCommitSource | null;
  branch: () => string;
  localDeviceLabel: () => string;
  logger?: { info(message: string, o?: unknown): void };
  // Wired in 7a.3 — open the clicked version in a diff2-editor (origin=history).
  openHistoryVersion: (path: string, version: HistoryVersion) => void;
}

interface HistoryViewState {
  path?: string;
}

// The pure per-file dup-guard (`findExistingHistoryLeaf`) lives in editor-tabs.ts
// (obsidian-runtime-free → unit-testable); main.ts uses it in openHistoryView.

// Human-readable row date. toLocaleString is locale/timezone-aware — fine for a
// display-only list (the true authoring ms is carried on the version for sorting).
function formatRowDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

export class DiffHistoryView extends ItemView {
  private readonly deps: DiffHistoryViewDeps;
  private state: HistoryViewState = {};
  // Generation token — the latest render() wins; a stale in-flight load (a second
  // render from the onOpen/setState pair, or a path change) is discarded on return.
  private gen = 0;

  constructor(leaf: WorkspaceLeaf, deps: DiffHistoryViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return DIFF2_HISTORY_VIEW_TYPE;
  }

  getIcon(): string {
    return "history";
  }

  getDisplayText(): string {
    // `state.path` is available synchronously from setState (no async entry like the
    // editor), so the title needs no refreshHeader hack. Full path per the user.
    return this.state.path ? `${this.state.path} History` : "History";
  }

  // The path this leaf shows, or null when its state hasn't resolved yet (transient
  // empty getState on a split/move). Read by main.ts's per-file dup-guard.
  currentPath(): string | null {
    return this.state.path ?? null;
  }

  // Keep THIS leaf, detach any OTHER diff2-history leaf showing the same file — the
  // MOVE-not-clone rule (see render). Per-path: a leaf mid-rebuild (null path) never
  // matches, so a split's transient empty phase can't detach a live tab.
  private collapseSameFileDuplicates(path: string): void {
    for (const l of this.app.workspace
      .getLeavesOfType(DIFF2_HISTORY_VIEW_TYPE)
      .filter(
        (l) =>
          l !== this.leaf &&
          l.view instanceof DiffHistoryView &&
          l.view.currentPath() === path,
      )) {
      l.detach();
    }
  }

  getState(): Record<string, unknown> {
    return { path: this.state.path } as unknown as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(state: any, result: unknown): Promise<void> {
    this.state = (state ?? {}) as HistoryViewState;
    await super.setState(state, result as never);
    void this.render();
  }

  async onOpen(): Promise<void> {
    void this.render();
  }

  // Both-ready gate + generation token. Loads local (instant, can't throw) always,
  // then GitHub (may throw — offline / unconfigured / rate-limited); a GitHub failure
  // still shows the local unpushed versions (advisor: don't let a throw hide local).
  private async render(): Promise<void> {
    if (!this.contentEl || !this.state.path) return;
    const gen = ++this.gen;
    const path = this.state.path;
    const container = this.contentEl;

    // Per-file uniqueness via MOVE, not clone — same as the diff-panel (read-only
    // list → no write-race, so we MOVE rather than refuse like the editor). A
    // drag-to-split / "Open in new window" spawns a 2nd leaf for the SAME file whose
    // render fires here once its `{path}` lands; THIS leaf is the drag target, so KEEP
    // it and detach any OTHER diff2-history leaf showing the same path → the tab MOVES
    // to where the user put it. Different files keep their own tabs (§4.2). Runs before
    // the load so a split collapses immediately.
    this.collapseSameFileDuplicates(path);

    const queue = this.deps.queue();
    const client = this.deps.client();
    container.empty();
    container.addClass("diff2-history-view-root");
    if (!queue || !client) {
      container.createEl("div", {
        text: "GitHub sync is not configured — open Settings to set it up.",
        cls: "diff2-history-empty",
      });
      return;
    }
    container.createEl("div", { text: "Loading…", cls: "diff2-history-loading" });

    // local-always + caught GitHub failure (see loadHistoryVersions). A GitHub throw
    // is logged here (the seam swallows it into `githubError`) so the log still shows why.
    const { versions, githubError } = await loadHistoryVersions(
      queue,
      client,
      path,
      this.deps.branch(),
      this.deps.localDeviceLabel(),
    );
    if (githubError) {
      this.deps.logger?.info("diff2 history github load failed", { path });
    }
    // Superseded by a newer render, OR this leaf was detached mid-fetch (the move-guard
    // detaching a same-path leaf that was still loading) → don't render into a dead node.
    if (gen !== this.gen || !this.contentEl.isConnected) return;
    this.renderList(container, path, versions, githubError);
  }

  private renderList(
    container: HTMLElement,
    path: string,
    versions: readonly HistoryVersion[],
    githubError: boolean,
  ): void {
    container.empty();
    if (githubError) {
      container.createEl("div", {
        text: "Couldn't load GitHub history — showing local unpushed versions only.",
        cls: "diff2-history-error",
      });
    }
    if (versions.length === 0) {
      container.createEl("div", {
        text: githubError ? "No local history for this file." : "No history for this file.",
        cls: "diff2-history-empty",
      });
      return;
    }
    const list = container.createEl("div", { cls: "diff2-history-list" });
    for (const v of versions) {
      const row = list.createEl("div", { cls: "diff2-history-row" });
      row.dataset.local = String(v.local);
      row.createEl("span", { text: formatRowDate(v.date), cls: "diff2-history-date" });
      row.createEl("span", {
        text: v.local ? `${v.deviceLabel} · not pushed` : v.deviceLabel,
        cls: "diff2-history-who",
      });
      row.addEventListener("click", () => this.deps.openHistoryVersion(path, v));
    }
  }
}
