// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER on DESKTOP: a workspace tab, opened in its own pop-out
// window above Settings (spec §2.16). The content is LogViewerPanel —
// the same component the phone's full-screen modal hosts.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";
import { settingsPopout } from "../ui/settings-popout";
import { keepLeafFocus } from "../ui/keep-focus";

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

  private popout: { closed(): void } | null = null;

  async onOpen(): Promise<void> {
    // Logging turned off in Settings, or the file gone: the tab closes.
    this.panel = new LogViewerPanel(this.deps, { onClose: () => this.leaf.detach() });
    // Opened from Settings in its own pop-out (§2.24): Esc and the focus
    // return, shared with the root .gitignore editor (ui/settings-popout).
    // The panel's own Esc first: an open search panel closes.
    this.popout = settingsPopout(this, {
      openedFrom: this.openedFrom,
      close: () => this.leaf.detach(),
      onEscape: () => this.panel?.closeSearch() ?? false,
    });
    keepLeafFocus(this, () => this.panel?.focus());
    await this.panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.popout?.closed();
    this.popout = null;
    this.panel?.destroy();
    this.panel = null;
  }
}
