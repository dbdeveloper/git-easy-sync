// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER on a PHONE (owner, 2026-10-08): no pop-out windows exist
// there, and Settings cover the whole screen — so the viewer opens as a
// FULL-SCREEN modal ABOVE Settings. Closing it returns to Settings.
// The content is the same LogViewerPanel the desktop tab hosts.

import { Modal, type App } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";

export class LogViewerModal extends Modal {
  private panel: LogViewerPanel | null = null;

  constructor(
    app: App,
    private readonly deps: LogViewerDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ges-log-modal");
    this.titleEl.setText("git-easy-sync log");
    this.panel = new LogViewerPanel(this.deps);
    void this.panel.mount(this.contentEl);
  }

  onClose(): void {
    this.panel?.destroy(); // ends the logger subscription with the modal
    this.panel = null;
    this.contentEl.empty();
  }
}
