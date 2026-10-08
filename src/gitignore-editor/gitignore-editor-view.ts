// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The root .gitignore editor on DESKTOP: a workspace tab, opened in its
// own pop-out window above Settings (the log viewer's pattern). The
// content is GitignoreEditorPanel — the same component the phone's
// full-screen modal hosts. Closing the tab drops unsaved changes.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { GitignoreEditorPanel, type GitignoreEditorDeps } from "./gitignore-editor-panel";

export const GITIGNORE_EDITOR_VIEW_TYPE = "git-easy-sync-gitignore-editor";

export class GitignoreEditorView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: GitignoreEditorDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GITIGNORE_EDITOR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Root .gitignore";
  }

  getIcon(): string {
    return "file-cog";
  }

  async onOpen(): Promise<void> {
    const panel = new GitignoreEditorPanel(this.deps, { close: () => this.leaf.detach() });
    await panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
