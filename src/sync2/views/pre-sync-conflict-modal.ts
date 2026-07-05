// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { App, Modal } from "obsidian";

// Pre-sync confirmation modal — one of three visibility surfaces
// for pending conflicts. Fires before EVERY manual sync click while
// there is at least one TRACKED conflict (§24):
//
//   "N file(s) still in tracked conflict. [resolve] [sync anyway]"
//
// §24 — the modal is TRACKED-only. `paths` is the tracked base-path
// list (main.ts already filters synthetic-only conflicts out via
// pendingConflictSummary, which returns null when nothing is tracked,
// so this modal never fires for a synthetic-only sweep). Only a
// tracked conflict is invisible on other devices until resolved; a
// synthetic conflict is a local-only leftover. The note glossary
// spells that distinction out so a user learns to tell the two apart.
//
// We add a Cancel button for the standard escape hatch (user
// changed their mind mid-click). Returns the user's chosen action:
//
//   - "resolve"     — user wants to act on the conflicts now;
//                     caller opens the first sibling in the editor.
//   - "sync-anyway" — user accepts the warning; sync proceeds.
//   - "cancel"      — bail; sync skipped.
//
// Modal is fired by manual sync() / syncCurrentFile() only.
// Background drains (interval tick, watchdog, onload startup) skip
// the modal — they're not user-driven and a blocking dialog would
// surprise the user.

export type PreSyncDecision = "resolve" | "sync-anyway" | "cancel";

export class PreSyncConflictModal extends Modal {
  private decision: PreSyncDecision = "cancel";

  constructor(
    app: App,
    private readonly paths: string[],
    // Total tracked-conflict (sibling) count. Only consulted when there is exactly ONE
    // tracked file, to pick "a tracked conflict…it" vs "tracked conflicts…them" — a single
    // file can carry several tracked conflicts (one per remote device). §24.
    private readonly conflictCount: number = paths.length,
  ) {
    super(app);
  }

  // Render the modal and resolve with the user's choice when it
  // closes. Closing via Escape / clicking outside / the X button is
  // treated as "cancel" (decision is initialised to "cancel" and
  // only the explicit button clicks overwrite it).
  prompt(): Promise<PreSyncDecision> {
    return new Promise((resolve) => {
      this.onClose = () => resolve(this.decision);

      const n = this.paths.length;
      const one = n === 1;
      const word = one ? "file" : "files";
      // Title: "N file(s) still in <strong>tracked</strong> conflict" — titleEl
      // renders DOM, so build the bold "tracked" as a real element (no markdown).
      this.titleEl.empty();
      this.titleEl.appendText(`${n} ${word} still in `);
      this.titleEl.createEl("strong", { text: "tracked" });
      this.titleEl.appendText(" conflict");
      this.contentEl.empty();

      // Intro sentence — plural-aware on BOTH axes (§24):
      //   >1 file                → "These files … tracked conflicts … resolve them:"
      //    1 file, 1 conflict    → "This file … a tracked conflict … resolve it:"
      //    1 file, >1 conflicts  → "This file … tracked conflicts … resolve them:"
      // (A single file can hold several tracked conflicts — one per remote device — so a
      // flat "1 file = 1 conflict" copy would tell the user "1" then the panel shows more.)
      const oneConflict = one && this.conflictCount === 1;
      this.contentEl.createEl("p").setText(
        oneConflict
          ? `This file with a tracked conflict is not visible on other devices until you resolve it:`
          : one
            ? `This file with tracked conflicts is not visible on other devices until you resolve them:`
            : `These files with tracked conflicts are not visible on other devices until you resolve them:`,
      );
      // §24 — show only the first 5 tracked paths; the total is already in the
      // title and "Resolve" opens the panel with the full list, so a "…" line
      // stands in for the 6th-and-rest rather than a scrollable dump.
      const LIMIT = 5;
      const list = this.contentEl.createEl("ul");
      for (const p of this.paths.slice(0, LIMIT)) {
        list.createEl("li").setText(p);
      }
      if (this.paths.length > LIMIT) {
        list.createEl("li").setText("…");
      }
      // §24 glossary — teach the tracked-vs-synthetic distinction so the user
      // learns which conflicts actually affect other devices. NOTE (not CAUTION)
      // → plain text, not `mod-warning` red. `gh-presync-note` adds the gap after
      // the file list AND lays the block out as a flex row: the "NOTE:" label on
      // the left, the two definition lines stacked in a column to its right (so
      // both definitions align under each other, not under the word "NOTE").
      // Built with real <strong> segments (setText would show literal ** markers).
      const note = this.contentEl.createEl("div", { cls: "gh-presync-note" });
      note.appendText("NOTE:");
      const defs = note.createDiv({ cls: "gh-presync-note-defs" });
      const tracked = defs.createDiv();
      tracked.createEl("strong", { text: "Tracked conflict" });
      tracked.appendText(" — real conflict from GitHub sync.");
      const synthetic = defs.createDiv();
      synthetic.createEl("strong", { text: "Synthetic conflict" });
      synthetic.appendText(" — local conflict only.");

      const btnRow = this.contentEl.createDiv({
        cls: "modal-button-container",
      });
      const resolveBtn = btnRow.createEl("button", { text: "Resolve" });
      resolveBtn.addEventListener("click", () => {
        this.decision = "resolve";
        this.close();
      });
      const syncAnywayBtn = btnRow.createEl("button", {
        text: "Sync anyway",
      });
      syncAnywayBtn.addEventListener("click", () => {
        this.decision = "sync-anyway";
        this.close();
      });
      const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
      cancelBtn.addEventListener("click", () => {
        this.decision = "cancel";
        this.close();
      });

      this.open();
    });
  }
}
