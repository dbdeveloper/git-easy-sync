// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// "The initial vault analysis is still running" — the wait a Sync click
// runs into while §8.1's scan is still walking the tree.
//
// ⚠️ Two exits, and they mean different things (owner, 2026-09-28):
//
//   finished  — the analysis completed while the user was looking at this.
//               The window closes ITSELF and the sync CONTINUES: either
//               into the conflict modal, if the scan produced a proposal,
//               or straight into the sync.
//   cancelled — the user pressed [Back]. The window closes and THE SYNC
//               IS CANCELLED. Not "wait a bit longer", not "go ahead" —
//               the click is undone, and the next one starts the check
//               again from the marker.
//
// So this is a RACE, not a question: whichever happens first decides. The
// number ticks because a dialog showing a frozen count reads as a hang,
// and the wait is measured in tens of seconds on a phone (a full Android
// walk, METAFILE §1) rather than in the ~300 ms a desktop takes.

import { App, Modal } from "obsidian";

export type AnalysisWaitOutcome = "finished" | "cancelled";

const TICK_MS = 400;

export class GitignoreAnalysisModal extends Modal {
  private outcome: AnalysisWaitOutcome = "cancelled";
  private timer: ReturnType<typeof setInterval> | null = null;
  private countEl: HTMLElement | null = null;

  constructor(
    app: App,
    // Read live rather than passed by value: the walk is still running, and
    // a snapshot would be stale before it was painted.
    private readonly dirsScanned: () => number,
  ) {
    super(app);
  }

  // Close from the OUTSIDE, because the analysis finished. Resolves the
  // pending prompt() with "finished" instead of the dismissal default.
  finish(): void {
    this.outcome = "finished";
    this.close();
  }

  prompt(): Promise<AnalysisWaitOutcome> {
    return new Promise((resolve) => {
      this.onClose = () => {
        if (this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
        }
        this.contentEl.empty();
        resolve(this.outcome);
      };

      this.titleEl.setText("Git Easy Sync: checking your vault");
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        text:
          "Looking through the vault for .gitignore files outside the root, " +
          "so their rules can be moved somewhere this plugin reads. This " +
          "runs once.",
      });
      this.contentEl.createEl("p", {
        text:
          "Syncing waits until it finishes — the rules decide what gets " +
          "synced at all, so starting before they are settled could send " +
          "the wrong files.",
      });
      this.countEl = this.contentEl.createEl("p", {
        cls: "git-easy-sync-analysis-count",
      });
      this.paint();
      this.timer = setInterval(() => this.paint(), TICK_MS);

      const row = this.contentEl.createDiv({ cls: "modal-button-container" });
      const back = row.createEl("button", { text: "Back" });
      back.addEventListener("click", () => {
        // Leaves `outcome` at its "cancelled" default — Escape and the X
        // button mean the same thing, and all three cancel the sync.
        this.close();
      });

      this.open();
    });
  }

  private paint(): void {
    const n = this.dirsScanned();
    // Folders, and no total: the walk discovers the tree as it goes, so
    // "N of M" would need a denominator we do not have. An honest running
    // count beats an invented one.
    this.countEl?.setText(
      `${n} ${n === 1 ? "folder" : "folders"} checked so far…`,
    );
  }
}
