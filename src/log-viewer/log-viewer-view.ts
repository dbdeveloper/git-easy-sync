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
    const alone = () =>
      onlyTabInItsPopout(this.leaf, this.app.workspace as unknown as Parameters<typeof onlyTabInItsPopout>[1]);
    this.panel = new LogViewerPanel(this.deps, {
      // The one tab of its own pop-out: close the WINDOW, as its close
      // button does — then the OS returns the focus to the window it was
      // opened from (Settings). Detaching the tab let the emptied pop-out
      // close on its own, and the OS brought another Obsidian window to
      // the front, hiding Settings (owner, 2026-10-25).
      onClose: () => {
        const win = this.containerEl.win;
        if (win && win !== window && alone()) win.close();
        else this.leaf.detach();
      },
      closeOnEscape: alone,
    });
    await this.panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
  }
}
