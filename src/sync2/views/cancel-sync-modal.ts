// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { App, Modal, Setting } from "obsidian";

// 2.0.2-beta2 ribbon-click confirmation modal. Fires when the user
// clicks the [Sync with GitHub] ribbon icon while a drain is
// already running. The previous behaviour ("silently ignore the
// click") was confusing — the user couldn't tell whether the click
// registered, and there was no clear path to stop a stuck sync
// from the icon they just clicked.
//
// Two buttons:
//   [Cancel sync] (red CTA) → triggers Sync2Manager.cancelDrain()
//                              + closes the modal.
//   [Keep going]            → just closes; current drain continues.
//
// Distinct from the TokenExpiredModal: this one is for a healthy
// in-flight sync the user wants to abort, not for an auth failure.

export class CancelSyncModal extends Modal {
  constructor(
    app: App,
    private readonly onCancelConfirmed: () => void,
  ) {
    super(app);
  }

  open(): void {
    super.open();
    this.titleEl.setText("Git Easy Sync — sync in progress");
    this.contentEl.empty();

    const body = this.contentEl.createDiv();
    body.style.marginBottom = "1em";
    body.setText(
      "A sync is currently running. Would you like to cancel it? " +
        "Any commits that haven't been uploaded yet stay in the queue " +
        "and will be picked up by the next sync.",
    );

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Cancel sync")
          .setWarning()
          .onClick(() => {
            this.onCancelConfirmed();
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Keep going").onClick(() => {
          this.close();
        }),
      );
  }
}
