// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Shown EVERY time before the root .gitignore editor opens (owner,
// 2026-10-08; spec docs/tasks/GITIGNORE-EDITOR.md). Deliberately short —
// it must fit a small phone screen with a large font, and a wall of text
// is not read. The owner's wording; the link is git's own pattern-format
// reference (GitHub's "Ignoring files" page barely explains the rules).

import { Modal, type App } from "obsidian";

export const GITIGNORE_RULES_URL = "https://git-scm.com/docs/gitignore#_pattern_format";

export function buildGitignoreWarning(
  el: HTMLElement,
  on: { onCancel: () => void; onConfirm: () => void },
): void {
  const p = el.createEl("p");
  p.createEl("a", { text: ".gitignore rules", attr: { href: GITIGNORE_RULES_URL } });
  p.appendText(
    " decide which files go to GitHub. A wrong line can upload your secrets " +
      "or stop needed files from syncing.",
  );
  const buttons = el.createDiv("modal-button-container");
  buttons.createEl("button", { text: "Cancel" }).addEventListener("click", on.onCancel);
  buttons
    .createEl("button", { text: "I know .gitignore rules", cls: "mod-warning" })
    .addEventListener("click", on.onConfirm);
}

export class GitignoreWarningModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Edit .gitignore?");
    this.contentEl.empty();
    buildGitignoreWarning(this.contentEl, {
      onCancel: () => this.close(),
      onConfirm: () => {
        this.close();
        this.onConfirm();
      },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
