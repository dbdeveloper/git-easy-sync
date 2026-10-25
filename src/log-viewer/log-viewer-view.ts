// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER on DESKTOP: a workspace tab, opened in its own pop-out
// window above Settings (spec §2.16). The content is LogViewerPanel —
// the same component the phone's full-screen modal hosts.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";
import { onlyTabInItsPopout } from "./log-poll";

export const LOG_VIEWER_VIEW_TYPE = "git-easy-sync-log-viewer";

export class LogViewerView extends ItemView {
  private panel: LogViewerPanel | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: LogViewerDeps,
    // The window the viewer was opened from (Settings) — it gets the
    // focus back when the viewer's pop-out closes (§2.24).
    private readonly openedFrom: () => Window | null = () => null,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LOG_VIEWER_VIEW_TYPE;
  }

  // The log's file name (owner, 2026-10-24): it carries the device label,
  // so the tab says which device's log this is.
  getDisplayText(): string {
    return this.deps.logPath;
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    // Logging turned off in Settings closes the tab (owner, 2026-10-08).
    // Esc closes it while it is the one tab of its own pop-out window —
    // where Settings open it (§2.24); asked at each press.
    const alone = () =>
      onlyTabInItsPopout(this.leaf, this.app.workspace as unknown as Parameters<typeof onlyTabInItsPopout>[1]);
    this.panel = new LogViewerPanel(this.deps, {
      onClose: () => this.leaf.detach(),
      closeOnEscape: alone,
    });
    await this.panel.mount(this.contentEl);
  }

  // Owner, 2026-10-25: after Esc (or Cmd+W) the Settings window went
  // BEHIND another one. Obsidian 1.13 can show Settings in a window of
  // their own (its "settingsPopoutWindow" option), and when Obsidian
  // closes a pop-out it hands the focus to the vault's MAIN window — in
  // front of Settings. (The OS close button does not go through Obsidian,
  // so it did not happen there.) So once our pop-out has really closed,
  // the window we were opened from is raised again — the way Obsidian
  // raises its own Settings window: restore() if minimised, then focus().
  // Armed in onClose, which Obsidian calls however the tab is closed —
  // Esc, Cmd+W, the tab's ×, the window's close button (owner, 2026-10-25:
  // Cmd+W and the × went past the Esc path and lost the focus).
  private returnFocusWhenPopoutCloses(): void {
    const back = this.openedFrom();
    const own = this.containerEl.win;
    if (!back || !own || back === own || own === window) return;
    const ws = this.app.workspace;
    const ref = ws.on("window-close", () => {
      ws.offref(ref);
      window.setTimeout(() => raiseWindow(back), 0);
    });
    // The pop-out may stay open (other tabs in it): do not wait forever.
    window.setTimeout(() => ws.offref(ref), 5000);
  }

  async onClose(): Promise<void> {
    this.returnFocusWhenPopoutCloses();
    this.panel?.destroy();
    this.panel = null;
  }
}

function raiseWindow(win: Window): void {
  if (win.closed) return;
  const ew = (win as unknown as {
    electronWindow?: { isMinimized?: () => boolean; restore?: () => void; focus: () => void };
  }).electronWindow;
  try {
    if (ew) {
      if (ew.isMinimized?.()) ew.restore?.();
      ew.focus();
      return;
    }
  } catch {
    // fall back below
  }
  win.focus();
}
