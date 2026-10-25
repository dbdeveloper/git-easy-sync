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
    this.panel = new LogViewerPanel(this.deps, {
      // Leaving a pop-out: focus goes back to the main window — Settings,
      // where the viewer was opened from (owner, 2026-10-25).
      onClose: () => {
        const own = this.containerEl.win;
        this.leaf.detach();
        if (own && own !== window) window.focus();
      },
      closeOnEscape: () =>
        onlyTabInItsPopout(this.leaf, this.app.workspace as unknown as Parameters<typeof onlyTabInItsPopout>[1]),
    });
    await this.panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
  }
}
