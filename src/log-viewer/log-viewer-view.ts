// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER on DESKTOP: a workspace tab, opened in its own pop-out
// window above Settings (spec §2.16). The content is LogViewerPanel —
// the same component the phone's full-screen modal hosts.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";
import { onlyTabInItsPopout } from "./log-poll";
import { holdEscapeWhileActive } from "../ui/esc-scope";

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

  // The window this tab lives in, kept current: at onClose the tab is
  // already detached and containerEl.win no longer tells it (owner,
  // 2026-10-25: Esc lost the focus again once the return moved there).
  private ownWin: Window | null = null;

  async onOpen(): Promise<void> {
    this.ownWin = this.containerEl.win ?? null;
    this.register(
      this.containerEl.onWindowMigrated((win) => {
        this.ownWin = win;
      }),
    );
    // Logging turned off in Settings closes the tab (owner, 2026-10-08).
    // Esc closes it while it is the one tab of its own pop-out window —
    // where Settings open it (§2.24); asked at each press.
    const alone = () =>
      onlyTabInItsPopout(this.leaf, this.app.workspace as unknown as Parameters<typeof onlyTabInItsPopout>[1]);
    this.panel = new LogViewerPanel(this.deps, {
      onClose: () => this.leaf.detach(),
      closeOnEscape: alone,
    });
    // Esc goes through a keymap scope while this tab is active: Obsidian's
    // own Esc would otherwise jump to another tab (owner, 2026-10-25) —
    // the diff-editor's mechanism (TODO #8).
    holdEscapeWhileActive(this, () => this.panel?.handleEscape());
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
  // Started in onClose, which Obsidian calls however the tab is closed —
  // Esc, Cmd+W, the tab's ×, the window's close button (owner, 2026-10-25:
  // Cmd+W and the × went past the Esc path and lost the focus).
  private returnFocusWhenPopoutCloses(): void {
    const back = this.openedFrom();
    const own = this.ownWin;
    // One line per close, so a field report says which way it went.
    this.deps.logger().info?.("Log viewer closed", {
      inPopout: own !== null && own !== window,
      openedFromKnown: back !== null,
      openedFromOpen: back !== null && !back.closed,
      popoutAlreadyClosed: own?.closed ?? null,
    });
    if (!back || !own || back === own || own === window) return;
    // Closed already (the window went before the tab's onClose ran)?
    if (own.closed) {
      window.setTimeout(() => raiseWindow(back), 0);
      return;
    }
    // Wait for the pop-out to be really gone, by looking — not by the
    // "window-close" event: Obsidian fires it BEFORE the tab's onClose
    // runs (field log 2026-10-25: armed here, it never arrived), while
    // the window is still open. 50 ms steps, at most 5 s (the pop-out may
    // stay open with other tabs in it).
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (own.closed) {
        window.clearInterval(timer);
        this.deps.logger().info?.("Log viewer pop-out gone - raising the window it was opened from", {
          ms: Date.now() - started,
        });
        raiseWindow(back);
      } else if (Date.now() - started > 5000) {
        window.clearInterval(timer);
      }
    }, 50);
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
