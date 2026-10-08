// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The root .gitignore editor on a PHONE: no pop-out windows exist there,
// and Settings cover the whole screen — so it opens as a FULL-SCREEN
// modal above Settings (the log viewer's pattern). Closing it (×, back)
// drops unsaved changes, like [Cancel].

import { Modal, type App } from "obsidian";
import { GitignoreEditorPanel, type GitignoreEditorDeps } from "./gitignore-editor-panel";

export class GitignoreEditorModal extends Modal {
  constructor(
    app: App,
    private readonly deps: GitignoreEditorDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ges-gitignore-modal");
    this.titleEl.setText("Root .gitignore");
    void new GitignoreEditorPanel(this.deps, { close: () => this.close() }).mount(this.contentEl);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
