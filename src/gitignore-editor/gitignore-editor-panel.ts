// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The root .gitignore editor (owner, 2026-10-08; spec
// docs/tasks/GITIGNORE-EDITOR.md). One component, mounted by the desktop
// tab (its own pop-out window) and by the phone's full-screen modal —
// the log viewer's pattern.
//
// A plain textarea, not CodeMirror: native undo, reliable on phones, and
// nothing to re-root when the tab moves to another window.
//
// [Cancel] drops every change. [Save]:
//   - nothing changed → nothing written (a write would touch the file and
//     make the next sync report a change the user did not make);
//   - the file changed on disk since it was opened (a sync brought another
//     device's version) → NOT written; the user is told and keeps the text;
//   - otherwise → written (atomically, by deps.save) and closed.

import { Notice } from "obsidian";

export interface GitignoreEditorDeps {
  // The text to edit (the plugin re-assembles its managed blocks first).
  load(): Promise<string>;
  // The file as it is on disk right now.
  readCurrent(): Promise<string>;
  // Atomic write + the plugin's managed-block pass.
  save(content: string): Promise<void>;
}

export interface GitignoreEditorHost {
  close(): void;
}

export class GitignoreEditorPanel {
  private initial = "";
  private area: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(
    private readonly deps: GitignoreEditorDeps,
    private readonly host: GitignoreEditorHost,
  ) {}

  async mount(root: HTMLElement): Promise<void> {
    root.empty();
    root.addClass("ges-gitignore-editor");
    root.createEl("p", {
      cls: "ges-gitignore-hint",
      text:
        "Lines between the DO-NOT-EDIT markers are maintained by the plugin " +
        "and will be rewritten back to their canonical form. Everything " +
        "between the two blocks is yours.",
    });
    const area = root.createEl("textarea", { cls: "ges-gitignore-text" });
    area.spellcheck = false;
    area.disabled = true; // until the file is read
    this.area = area;
    this.errorEl = root.createDiv("ges-gitignore-error");

    const buttons = root.createDiv("ges-gitignore-buttons");
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.host.close());
    const save = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
    save.addEventListener("click", () => void this.onSave(save));

    try {
      this.initial = await this.deps.load();
      area.value = this.initial;
      area.disabled = false;
    } catch (err) {
      save.disabled = true;
      this.errorEl.setText(`Could not read .gitignore: ${err}`);
    }
  }

  private async onSave(save: HTMLButtonElement): Promise<void> {
    const content = this.area?.value ?? this.initial;
    if (content === this.initial) {
      this.host.close();
      return;
    }
    save.disabled = true;
    this.errorEl?.setText("");
    try {
      if ((await this.deps.readCurrent()) !== this.initial) {
        this.errorEl?.setText(
          ".gitignore changed on disk while you were editing. " +
            "Copy your text, Cancel, and open it again.",
        );
        save.disabled = false;
        return;
      }
      await this.deps.save(content);
      new Notice("Root .gitignore saved.");
      this.host.close();
    } catch (err) {
      this.errorEl?.setText(`Could not save .gitignore: ${err}`);
      save.disabled = false;
    }
  }
}
