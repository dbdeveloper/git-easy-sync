// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The two `.gitignore` decisions the user is asked to make (DOT-FILES
// §8.1.5 / §8.1.5a), as a real modal rather than a Notice.
//
// ⚠️ Why not a Notice (owner, 2026-09-28): a toast is for reporting, and
// both of these ask a QUESTION. The migration one hands the user a change
// they must accept or discard; the gate one explains why a sync they just
// asked for did not happen. A toast fades whether or not it was read, and
// on mobile it can be missed entirely — so the one moment the user needs
// to understand something would be the one that vanishes on its own.
//
// One class, two callers: they differ only in wording and in what the
// second button means. Building two nearly identical modals would leave
// two places to keep consistent, and the shape has two real cases today,
// which is the bar for making it shared.

import { App, Modal } from "obsidian";

export type GitignoreDecision = "resolve" | "dismiss";

export class GitignoreDecisionModal extends Modal {
  // Escape / clicking outside / the X button all mean "dismiss": the
  // dismissive branch is the safe one in both uses — sync stays blocked,
  // the proposal stays on disk.
  private decision: GitignoreDecision = "dismiss";

  constructor(
    app: App,
    private readonly opts: {
      title: string;
      // Paragraphs. Split rather than one blob so the modal stays
      // readable on a phone, where a five-line paragraph is a wall.
      body: string[];
      // Files the decision is about. Rendered as a list when present —
      // the user is being asked to judge specific rules, and naming them
      // is most of what makes that possible.
      paths?: string[];
      // Omit to offer no resolve action at all (the "nothing to do"
      // report, which is a statement rather than a question).
      resolveLabel?: string;
      dismissLabel: string;
    },
  ) {
    super(app);
  }

  prompt(): Promise<GitignoreDecision> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.decision);

      this.titleEl.setText(this.opts.title);
      this.contentEl.empty();
      for (const paragraph of this.opts.body) {
        this.contentEl.createEl("p", { text: paragraph });
      }
      if (this.opts.paths && this.opts.paths.length > 0) {
        const list = this.contentEl.createEl("ul");
        for (const p of this.opts.paths) {
          list.createEl("li", { text: p });
        }
      }

      const row = this.contentEl.createDiv({ cls: "modal-button-container" });
      if (this.opts.resolveLabel !== undefined) {
        const resolveBtn = row.createEl("button", {
          text: this.opts.resolveLabel,
          cls: "mod-cta",
        });
        resolveBtn.addEventListener("click", () => {
          this.decision = "resolve";
          this.close();
        });
      }
      const dismissBtn = row.createEl("button", {
        text: this.opts.dismissLabel,
      });
      dismissBtn.addEventListener("click", () => {
        this.decision = "dismiss";
        this.close();
      });

      this.open();
    });
  }
}
