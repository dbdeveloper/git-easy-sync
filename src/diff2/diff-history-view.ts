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
  historyIsoTimestamp,
  loadHistoryVersions,
  type HistoryCommitSource,
  type HistoryVersion,
  type QueueVersionSource,
} from "./history-versions";
import { formatConflictTimestamp } from "./strip-conflict-suffix";

export const DIFF2_HISTORY_VIEW_TYPE = "diff2-history-view";

export interface DiffHistoryViewDeps {
  // Thunks return null when GitHub sync is not configured (sync2Manager absent) —
  // a restored history leaf on an unconfigured vault renders "not configured"
  // rather than throwing in the view factory.
  queue: () => QueueVersionSource | null;
  client: () => HistoryCommitSource | null;
  branch: () => string;
  localDeviceLabel: () => string;
  logger?: { info(message: string, o?: unknown): void };
  // §35 — token-expired gate for the GitHub history load: skip the network when
  // set (→ "TOKEN EXPIRED!" message), and latch the marker on a first-time 401.
  isTokenExpired?: () => boolean;
  noteAuthError?: (err: unknown) => void;
  // Wired in 7a.3 — open the clicked version in a diff2-editor (origin=history). toRight
  // (Ctrl/⌘): open to the right of this history window (see main.createEditorLeaf).
  openHistoryVersion: (
    path: string,
    version: HistoryVersion,
    toRight?: boolean,
  ) => void;
}

interface HistoryViewState {
  path?: string;
  // Persisted selection (the last-viewed / about-to-open version) so returning to the tab —
  // or reopening it after a restart — restores the focus bar and keyboard position.
  selectedKey?: string;
}

// Stable per-version identity for persisting the selection across re-renders / reopen. `id` is
// a batchId (local) or a commit-sha (remote); `local` disambiguates the two id-spaces.
function versionKey(v: HistoryVersion): string {
  return `${v.local ? "L" : "R"}:${v.id}`;
}

// Rows to jump for PageUp / PageDown.
const HISTORY_PAGE = 10;

// Pure keyboard-nav resolver (obsidian-runtime-free → unit-testable). Maps a key + the current
// index + list length to the NEXT selected index (clamped), "open" ([Enter]), or null (a key we
// don't handle → let it pass through).
export function nextHistorySelection(
  key: string,
  current: number,
  len: number,
): number | "open" | null {
  if (len === 0) return null;
  const clamp = (n: number) => Math.max(0, Math.min(n, len - 1));
  switch (key) {
    case "ArrowDown": return clamp(current + 1);
    case "ArrowUp": return clamp(current - 1);
    case "Home": return 0;
    case "End": return len - 1;
    case "PageDown": return clamp(current + HISTORY_PAGE);
    case "PageUp": return clamp(current - HISTORY_PAGE);
    case "Enter": return "open";
    default: return null;
  }
}

// The pure per-file dup-guard (`findExistingHistoryLeaf`) lives in editor-tabs.ts
// (obsidian-runtime-free → unit-testable); main.ts uses it in openHistoryView.

// Row date in the standard "YYYY-MM-DD HH:MM:SS" (24-hour) form used everywhere else (the
// conflicts list, the detail-view title/labels) — via the SAME historyIsoTimestamp →
// formatConflictTimestamp derivation, so the list and the opened editor read identically.
function formatRowDate(ms: number): string {
  return formatConflictTimestamp(historyIsoTimestamp(ms));
}

export class DiffHistoryView extends ItemView {
  private readonly deps: DiffHistoryViewDeps;
  private state: HistoryViewState = {};
  // Generation token — the latest render() wins; a stale in-flight load (a second
  // render from the onOpen/setState pair, or a path change) is discarded on return.
  private gen = 0;
  // Keyboard-driven selection state (rebuilt each renderList; selectedKey persists).
  private versions: readonly HistoryVersion[] = [];
  private rows: HTMLElement[] = [];
  private listEl: HTMLElement | null = null;
  private selectedIndex = 0;
  private selectedKey: string | null = null;
  // The version LAST OPENED from this list (the "launch position"). Distinct from selectedKey:
  // you may navigate the list (v3 → v10) while the editor is open, but [←] must return the
  // cursor to the version you launched (v3), not wherever you roamed. Set on open.
  private launchedKey: string | null = null;

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
    return {
      path: this.state.path,
      selectedKey: this.selectedKey ?? undefined,
    } as unknown as Record<string, unknown>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(state: any, result: unknown): Promise<void> {
    this.state = (state ?? {}) as HistoryViewState;
    if (typeof this.state.selectedKey === "string") {
      this.selectedKey = this.state.selectedKey;
    }
    await super.setState(state, result as never);
    void this.render();
  }

  async onOpen(): Promise<void> {
    // Re-focus the list whenever this tab becomes active again — e.g. after opening a version
    // in the editor and clicking [←] back here. Without this the list keeps DOM focus nowhere,
    // so the selection cursor stays low-contrast AND the arrow keys do nothing. Also focus on
    // any mousedown in the body, so clicking ANYWHERE in the view (not just a row) activates
    // the keyboard cursor. registerEvent/registerDomEvent auto-clean on view close.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) this.focusList();
      }),
    );
    this.registerDomEvent(this.contentEl, "mousedown", () => this.focusList());
    void this.render();
  }

  // Focus the list so the keyboard cursor is active. Queries the LIVE list element (not the
  // possibly-stale `this.listEl`, which a split/layout rebuild can detach) → we never focus a
  // dead node. Public so the reveal-on-[←] path (main.ts) can focus DETERMINISTICALLY: when the
  // editor closes in a DIFFERENT split, active-leaf-change doesn't reliably target this leaf.
  focusList(): void {
    const list =
      this.contentEl?.querySelector<HTMLElement>(".diff2-history-list") ?? this.listEl;
    list?.focus({ preventScroll: true });
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
    const { versions, githubError, tokenExpired } = await loadHistoryVersions(
      queue,
      client,
      path,
      this.deps.branch(),
      this.deps.localDeviceLabel(),
      this.deps.isTokenExpired,
      this.deps.noteAuthError,
    );
    if (githubError) {
      this.deps.logger?.info("diff2 history github load failed", {
        path,
        tokenExpired,
      });
    }
    // Superseded by a newer render, OR this leaf was detached mid-fetch (the move-guard
    // detaching a same-path leaf that was still loading) → don't render into a dead node.
    if (gen !== this.gen || !this.contentEl.isConnected) return;
    this.renderList(container, path, versions, githubError, tokenExpired);
  }

  private renderList(
    container: HTMLElement,
    path: string,
    versions: readonly HistoryVersion[],
    githubError: boolean,
    tokenExpired: boolean,
  ): void {
    container.empty();
    if (githubError) {
      container.createEl("div", {
        // §35 — a latched token gets an explicit "TOKEN EXPIRED!" prefix so the
        // user knows WHY GitHub history is missing (vs a generic network blip).
        text: tokenExpired
          ? "TOKEN EXPIRED! Couldn't load GitHub history — showing local unpushed versions only."
          : "Couldn't load GitHub history — showing local unpushed versions only.",
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
    // Keyboard-driven list: the container owns focus; rows carry a persistent selection bar.
    this.versions = versions;
    const restored = this.selectedKey
      ? versions.findIndex((v) => versionKey(v) === this.selectedKey)
      : -1;
    this.selectedIndex = restored >= 0 ? restored : 0;
    this.selectedKey = versionKey(versions[this.selectedIndex]);

    const list = container.createEl("div", { cls: "diff2-history-list" });
    list.tabIndex = 0; // focusable → arrows / Home / End / PgUp / PgDn / Enter
    this.listEl = list;
    this.rows = [];
    versions.forEach((v, i) => {
      const row = list.createEl("div", { cls: "diff2-history-row" });
      row.dataset.local = String(v.local);
      row.createEl("span", { text: formatRowDate(v.date), cls: "diff2-history-date" });
      row.createEl("span", {
        text: v.local ? `${v.deviceLabel} · not pushed` : v.deviceLabel,
        cls: "diff2-history-who",
      });
      // Click both SELECTS (shows the bar) and OPENS. Ctrl+Click → open to the right.
      row.addEventListener("click", (e) => {
        this.select(i);
        this.openSelected(path, e.ctrlKey);
      });
      // macOS turns Ctrl+Click into a system secondary-click → it arrives as `contextmenu`, not
      // `click`. Treat a Ctrl one as open-to-the-right so Ctrl+Click works on Mac too (matching
      // Ctrl+Enter); a plain right-click is left untouched.
      row.addEventListener("contextmenu", (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          this.select(i);
          this.openSelected(path, true);
        }
      });
      this.rows.push(row);
    });
    this.applySelection();
    list.addEventListener("keydown", (e) => this.onKeyDown(e, path));
    // Focus the list so the arrows work the instant the tab is shown / returned to.
    list.focus({ preventScroll: true });
  }

  // Paint the selection bar on the selected row and reveal it.
  private applySelection(): void {
    this.rows.forEach((r, i) =>
      r.classList.toggle("diff2-history-row-selected", i === this.selectedIndex),
    );
    this.rows[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  // Move the selection (clamped), remember it (persists across re-render / reopen).
  private select(i: number): void {
    if (this.versions.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(i, this.versions.length - 1));
    this.selectedKey = versionKey(this.versions[this.selectedIndex]);
    this.applySelection();
  }

  private openSelected(path: string, toRight = false): void {
    const v = this.versions[this.selectedIndex];
    if (!v) return;
    this.launchedKey = versionKey(v); // remember the launch position for [←] return
    this.deps.openHistoryVersion(path, v, toRight);
  }

  // On [←] back-nav: return the cursor to the version we LAUNCHED (not wherever the list was
  // navigated to since), scroll it into view, and take keyboard focus. Public — called from
  // main.ts's reveal path. Falls back to focus-only if the launch version is gone.
  restoreLaunchedSelection(): void {
    if (this.launchedKey) {
      const i = this.versions.findIndex((v) => versionKey(v) === this.launchedKey);
      if (i >= 0) {
        this.selectedIndex = i;
        this.selectedKey = this.launchedKey;
        this.applySelection(); // scrolls the launched row into view
      }
    }
    this.focusList();
  }

  private onKeyDown(e: KeyboardEvent, path: string): void {
    const r = nextHistorySelection(e.key, this.selectedIndex, this.versions.length);
    if (r === null) return;
    e.preventDefault();
    if (r === "open") this.openSelected(path, e.ctrlKey); // Ctrl+Enter → right
    else this.select(r);
  }
}
