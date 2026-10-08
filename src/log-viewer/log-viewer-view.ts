// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER on DESKTOP: a workspace tab, opened in its own pop-out
// window above Settings (spec §2.16). The content is LogViewerPanel —
// the same component the phone's full-screen modal hosts.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";

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

  getDisplayText(): string {
    return "git-easy-sync log";
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    // Logging turned off in Settings closes the tab (owner, 2026-10-08).
    this.panel = new LogViewerPanel(this.deps, { onClose: () => this.leaf.detach() });
    await this.panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
  }
}
