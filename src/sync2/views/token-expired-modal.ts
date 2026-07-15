// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — se LICENSE.

import { App, Modal, Platform, Setting } from "obsidian";
import { GITHUB_TOKENS_URL, PLUGIN_README_URL } from "./token-help";
import { tokenExpiredMessage, type TokenExpiredKind } from "../../token-expired-flag";

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
    // §35 — 401 ("invalid": token expired/revoked/wrong) vs 403 ("scope": valid
    // token, missing permissions). Picks the intro paragraph so the modal
    // explains the actual problem. Defaults to the common 401 case.
    private readonly kind: TokenExpiredKind = "invalid",
  ) {
    super(app);
  }

  open(): void {
    super.open();
    // §35 — two layouts. Mobile gets a SHORT one (a phone screen can't afford
    // the desktop intro + 3-step list + 3 buttons): the one-line class message
    // and the two buttons that actually matter on a phone.
    const mobile = Platform.isMobile;

    this.titleEl.setText(
      mobile
        ? "GitHub token expired"
        : "GitHub Easy Sync — GitHub token expired or invalid",
    );
    this.contentEl.empty();

    const intro = this.contentEl.createDiv();
    intro.style.marginBottom = "1em";
    if (mobile) {
      // One concise, class-appropriate sentence (shared with the Settings card).
      intro.setText(tokenExpiredMessage(this.kind));
    } else {
      intro.setText(
        this.kind === "scope"
          ? "GitHub returned 403 (Forbidden) for your last sync. Your token is " +
              "valid but it lacks the permissions this plugin needs: Contents " +
              "(Read + Write) and Metadata (Read) on your sync repo. Sync will " +
              "keep failing until you re-scope the token (or generate a new one)."
          : "GitHub returned 'Bad credentials' for your last sync. The most " +
              "likely cause: your fine-grained personal access token reached " +
              "its expiration date (the maximum lifetime is one year). " +
              "Sync will keep failing until you renew it.",
      );
    }

    // The verbose recovery checklist is desktop-only — on a phone it just eats
    // the screen; the concise intro + buttons carry the same information.
    if (!mobile) {
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
    }

    // ── Buttons ────────────────────────────────────────────────────
    // Same three on both platforms — [Open GitHub token page (CTA)] [README]
    // [Open settings]. The token page is needed on mobile too (it's in Settings'
    // token-help box as well); only the intro/steps above are trimmed for phones.
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
