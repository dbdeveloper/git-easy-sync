// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The root .gitignore editor on DESKTOP: a workspace tab, opened in its
// own pop-out window above Settings (the log viewer's pattern). The
// content is GitignoreEditorPanel — the same component the phone's
// full-screen modal hosts. Closing the tab drops unsaved changes — Esc
// too (owner, 2026-10-25: "for professionals; saving nothing beats saving
// the wrong thing"). Esc and the focus return are the log viewer's: see
// ui/settings-popout.ts.

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { GitignoreEditorPanel, type GitignoreEditorDeps } from "./gitignore-editor-panel";
import { settingsPopout } from "../ui/settings-popout";

export const GITIGNORE_EDITOR_VIEW_TYPE = "git-easy-sync-gitignore-editor";

export class GitignoreEditorView extends ItemView {
  private popout: { closed(): void } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: GitignoreEditorDeps,
    // The window it was opened from (Settings): the focus goes back there.
    private readonly openedFrom: () => Window | null = () => null,
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
    this.popout = settingsPopout(this, {
      openedFrom: this.openedFrom,
      close: () => this.leaf.detach(),
    });
    await panel.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.popout?.closed();
    this.popout = null;
    this.contentEl.empty();
  }
}
