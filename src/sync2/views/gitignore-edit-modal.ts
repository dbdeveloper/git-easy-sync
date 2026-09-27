// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// A plain editor for the vault's root `.gitignore` (DOT-FILES §8.1.5,
// TODO §4).
//
// ⚠️ Why a modal and not an editor tab: Obsidian's file indexer hides any
// path with a dotted segment — verified against obsidian.asar,
//
//   function(e){for(;e;){if(basename(e).startsWith("."))return!0;
//                        e=dirname(e)}return!1}
//
// so `.gitignore` is not a TFile and `leaf.openFile` has nothing to open.
// A textarea is the smallest thing that actually works, and it works on
// mobile too, where the user has no other way to reach the file at all.
// A real CM6 view (syntax, undo history) is the future option TODO §4
// describes; it is not needed to make the file editable.

import { App, Modal, Notice } from "obsidian";

export class GitignoreEditModal extends Modal {
  private textarea: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSave: (content: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    // Sizing + the flex-column clip live in styles.css; see the
    // bug-gitignore-editor comment there for why the default box gave two
    // scrollbars and hid the buttons.
    this.modalEl.addClass("git-easy-sync-gitignore-modal");
    contentEl.empty();
    // titleEl, not an h3 inside the content box — the house pattern
    // (PreSyncConflictModal), and it keeps the heading OUT of the flex
    // column, where it would have been a shrinkable item.
    this.titleEl.setText("Root .gitignore");
    contentEl.createEl("p", {
      text:
        "Lines between the DO-NOT-EDIT markers are maintained by the plugin " +
        "and will be rewritten back to their canonical form. Everything " +
        "between the two blocks is yours.",
      cls: "git-easy-sync-gitignore-hint",
    });

    const area = contentEl.createEl("textarea", {
      cls: "git-easy-sync-gitignore-editor",
    });
    area.value = this.initial;
    // No `rows`: the flex column decides the height, and a fixed row count
    // would fight it.
    area.spellcheck = false;
    this.textarea = area;

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const save = buttons.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    save.addEventListener("click", async () => {
      const content = this.textarea?.value ?? this.initial;
      // Unchanged means unchanged: writing anyway would touch the file's
      // mtime and make the next sync report a modification the user did
      // not make.
      if (content === this.initial) {
        this.close();
        return;
      }
      save.disabled = true;
      try {
        await this.onSave(content);
        new Notice("Root .gitignore saved.");
        this.close();
      } catch (err) {
        save.disabled = false;
        new Notice(`Could not save .gitignore: ${err}`);
      }
    });
    buttons
      .createEl("button", { text: "Cancel" })
      .addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.textarea = null;
  }
}
