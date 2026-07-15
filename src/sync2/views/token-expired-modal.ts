// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — se LICENSE.

import { App, Modal, Setting } from "obsidian";
import { GITHUB_TOKENS_URL, PLUGIN_README_URL } from "./token-help";

// Surfaced when GitHub returns 401 ("Bad credentials") or 403 on a
// sync surface — typically because the fine-grained PAT expired.
// Fine-grained tokens have a maximum lifetime of 366 days; a year
// later the same workflow comes back with "Bad credentials" and
// the user has forgotten where to renew it.
//
// The modal hands the user three clear next steps:
//   1. Open the GitHub token settings page.
//   2. Open the plugin README for a step-by-step (with screenshots)
//      of token creation + the required permissions.
//   3. Jump straight to the plugin settings to paste the new token
//      once they've generated it.
//
// Throttling: the caller (main.ts) holds a `lastAuthModalShownMs`
// timestamp and skips re-opening this modal more than once per
// hour. The drain status section in Settings keeps a passive
// banner up the whole time the token is invalid.

// URLs live in ./token-help so the modal, the Settings drain-status
// box, and the Test-connection box all point at the same two
// destinations.

export class TokenExpiredModal extends Modal {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    app: App,
    private readonly openSettings: () => void,
    // E1 — auto-dismiss: poll the token-expired flag and close the modal once it clears
    // (the user renewed the token and a sync / the Settings connection-probe succeeded), so
    // it doesn't linger after the problem is fixed. Optional (older callers / tests omit it).
    private readonly isExpired?: () => boolean,
    // §35 — fired from onClose (auto-dismiss, [X], or ESC) so the caller can drop its
    // "a modal is already open" guard and let the NEXT sync re-open a fresh one.
    private readonly onClosed?: () => void,
  ) {
    super(app);
  }

  open(): void {
    super.open();
    this.titleEl.setText(
      "GitHub Easy Sync — GitHub token expired or invalid",
    );
    this.contentEl.empty();

    const intro = this.contentEl.createDiv();
    intro.style.marginBottom = "1em";
    intro.setText(
      "GitHub returned 'Bad credentials' for your last sync. The most " +
        "likely cause: your fine-grained personal access token reached " +
        "its expiration date (the maximum lifetime is one year). " +
        "Sync will keep failing until you renew it.",
    );

    const steps = this.contentEl.createDiv();
    steps.style.marginBottom = "1em";
    steps.createEl("p").setText("To restore syncing:");
    const list = steps.createEl("ol");
    list.createEl("li").setText(
      "Open GitHub's token settings page (button below).",
    );
    list.createEl("li").setText(
      "Generate a NEW fine-grained token. Required permissions: " +
        "Contents (Read + Write) and Metadata (Read) on your sync repo. " +
        "The README link below walks through this with screenshots.",
    );
    list.createEl("li").setText(
      "Paste the new token into the plugin settings (the Open " +
        "settings button below jumps you there).",
    );

    // ── Buttons ────────────────────────────────────────────────────
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Open GitHub token page")
          .setCta()
          .onClick(() => {
            window.open(GITHUB_TOKENS_URL, "_blank");
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("How to renew (README)")
          .onClick(() => {
            window.open(PLUGIN_README_URL, "_blank");
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Open settings").onClick(() => {
          this.close();
          this.openSettings();
        }),
      );

    // Auto-dismiss once the token is renewed (the flag clears on the next successful
    // auth). Poll every 1.5s; close when no longer expired. `close()` → onClose clears
    // the timer, so an [x]/ESC dismissal also tears it down.
    if (this.isExpired) {
      this.pollTimer = setInterval(() => {
        if (!this.isExpired?.()) this.close();
      }, 1500);
    }
  }

  onClose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.contentEl.empty();
    this.onClosed?.();
  }
}
