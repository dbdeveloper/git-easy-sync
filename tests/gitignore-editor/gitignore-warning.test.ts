// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The warning shown EVERY time before the root .gitignore editor opens
// (owner, 2026-10-08) — short enough for a small phone screen.

import { describe, it, expect } from "vitest";
import {
  buildGitignoreWarning,
  GITIGNORE_RULES_URL,
} from "../../src/gitignore-editor/gitignore-warning";

// Obsidian's HTMLElement helpers, the subset the panel uses (happy-dom has none).
type Info = string | { cls?: string; text?: string; attr?: Record<string, string> };
const P = HTMLElement.prototype as unknown as Record<string, unknown>;
if (!P.createEl) {
  P.createEl = function (this: HTMLElement, tag: string, info?: Info) {
    const el = document.createElement(tag);
    if (typeof info === "string") el.className = info;
    else if (info) {
      if (info.cls) el.className = info.cls;
      if (info.text != null) el.textContent = info.text;
      for (const k of Object.keys(info.attr ?? {})) el.setAttribute(k, info.attr![k]);
    }
    this.appendChild(el);
    return el;
  };
  P.createDiv = function (this: HTMLElement, info?: Info) {
    return (this as unknown as { createEl: (t: string, i?: Info) => HTMLElement }).createEl("div", info);
  };
  P.createSpan = function (this: HTMLElement, info?: Info) {
    return (this as unknown as { createEl: (t: string, i?: Info) => HTMLElement }).createEl("span", info);
  };
  P.appendText = function (this: HTMLElement, t: string) {
    this.appendChild(document.createTextNode(t));
  };
  P.empty = function (this: HTMLElement) {
    this.replaceChildren();
  };
  P.addClass = function (this: HTMLElement, c: string) {
    this.classList.add(c);
  };
  P.toggleClass = function (this: HTMLElement, c: string, on: boolean) {
    this.classList.toggle(c, on);
  };
  P.setText = function (this: HTMLElement, t: string) {
    this.textContent = t;
  };
  P.setAttr = function (this: HTMLElement, k: string, v: string) {
    this.setAttribute(k, v);
  };
  // Obsidian calls the listener when the element moves to another window
  // (a tab dragged out into a pop-out). Tests trigger it by hand.
  P.onWindowMigrated = function (this: HTMLElement, listener: (win: Window) => void) {
    (this as unknown as { __migrated?: (win: Window) => void }).__migrated = listener;
    return () => {
      (this as unknown as { __migrated?: unknown }).__migrated = undefined;
    };
  };
}

function setup() {
  const got: string[] = [];
  const el = document.createElement("div");
  buildGitignoreWarning(el, { onCancel: () => got.push("cancel"), onConfirm: () => got.push("confirm") });
  const buttons = Array.from(el.querySelectorAll("button"));
  return { got, el, buttons };
}

describe("buildGitignoreWarning", () => {
  it("🔑 the owner's text; '.gitignore rules' links to git's pattern-format docs", () => {
    const { el } = setup();
    expect(el.textContent).toContain(
      ".gitignore rules decide which files go to GitHub. A wrong line can upload your secrets or stop needed files from syncing.",
    );
    const a = el.querySelector("a") as HTMLAnchorElement;
    expect(a.textContent).toBe(".gitignore rules");
    expect(a.getAttribute("href")).toBe(GITIGNORE_RULES_URL);
    expect(GITIGNORE_RULES_URL).toBe("https://git-scm.com/docs/gitignore#_pattern_format");
  });

  it("🔑 [Cancel] cancels; [I know .gitignore rules] (a warning button) confirms", () => {
    const { got, buttons } = setup();
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "I know .gitignore rules"]);
    expect(buttons[1].classList.contains("mod-warning")).toBe(true);
    buttons[0].click();
    buttons[1].click();
    expect(got).toEqual(["cancel", "confirm"]);
  });

  it("is short: no more than 30 words of body text", () => {
    const { el } = setup();
    const body = (el.querySelector("p")?.textContent ?? "").trim().split(/\s+/);
    expect(body.length).toBeLessThanOrEqual(30);
  });
});
