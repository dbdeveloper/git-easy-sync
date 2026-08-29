// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Single source of truth for the "your GitHub token needs attention"
// help affordance. The same two destinations — the GitHub token
// settings page and the plugin README's token walkthrough — are
// surfaced from three places:
//   1. TokenExpiredModal (the throttled pop-up after a failed drain).
//   2. The Settings "GitHub sync status" section, as a passive box
//      under the last-error line when that error was an auth failure.
//   3. The Settings "Test connection" probe, as a box under the red
//      result when the probe hit 401/403 (or the token field is
//      blank).
//
// Keeping the URLs and the box renderer here means a future change to
// either link (or the copy) lands in one place and every surface
// stays in step.

export const GITHUB_TOKENS_URL =
  "https://github.com/settings/personal-access-tokens";
export const PLUGIN_README_URL =
  "https://github.com/dbdeveloper/git-easy-sync/blob/main/README.md#github-token-setup";

// Renders a self-contained help box into `parent` and returns the box
// element so the caller can remove or re-render it. The box carries a
// one-line explanation plus two link buttons. Layout matches the
// surrounding Settings cards (rounded, secondary background) so it
// reads as part of the error surface it sits under, not a pop-up.
export function renderTokenHelpBox(parent: HTMLElement): HTMLElement {
  const box = parent.createDiv();
  box.style.marginTop = "0.6em";
  box.style.padding = "0.6em 0.8em";
  box.style.borderRadius = "4px";
  box.style.background = "var(--background-secondary)";
  box.style.border = "1px solid var(--background-modifier-border)";

  const line = box.createDiv();
  line.style.marginBottom = "0.5em";
  line.style.fontSize = "0.85em";
  line.setText(
    "This looks like a GitHub authorization problem. Token, Owner, " +
      "Repository, and Repository branch must all be correctly filled, " +
      "and the token must be valid (fine-grained tokens expire — max " +
      "lifetime one year). Open the token page to generate a new one, " +
      "or read the step-by-step setup in the README.",
  );

  const buttons = box.createDiv();
  buttons.style.display = "flex";
  buttons.style.gap = "0.5em";
  buttons.style.flexWrap = "wrap";

  const tokenBtn = buttons.createEl("button", {
    text: "Open GitHub token page",
  });
  tokenBtn.classList.add("mod-cta");
  tokenBtn.style.cursor = "pointer";
  tokenBtn.addEventListener("click", () => {
    window.open(GITHUB_TOKENS_URL, "_blank");
  });

  const readmeBtn = buttons.createEl("button", {
    text: "How to renew (README)",
  });
  readmeBtn.style.cursor = "pointer";
  readmeBtn.addEventListener("click", () => {
    window.open(PLUGIN_README_URL, "_blank");
  });

  return box;
}
