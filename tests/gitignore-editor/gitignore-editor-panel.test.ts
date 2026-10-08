// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The root .gitignore editor (owner, 2026-10-08): the panel that both the
// desktop tab (pop-out window) and the phone's full-screen modal host.
// [Cancel] drops every change; [Save] writes only a real change, and never
// over a file that changed on disk while it was being edited.

import { describe, it, expect } from "vitest";
import { GitignoreEditorPanel } from "../../src/gitignore-editor/gitignore-editor-panel";

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

function setup(onDisk: string, opts: { failSave?: boolean } = {}) {
  const state = { disk: onDisk, saved: [] as string[], closed: 0, logged: [] as string[] };
  const deps = {
    load: async () => state.disk,
    readCurrent: async () => state.disk,
    save: async (content: string) => {
      if (opts.failSave) throw new Error("disk full");
      state.saved.push(content);
      state.disk = content;
    },
    logError: (message: string) => state.logged.push(message),
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const panel = new GitignoreEditorPanel(deps, { close: () => state.closed++ });
  return { state, root, panel };
}
const area = (root: HTMLElement) => root.querySelector("textarea") as HTMLTextAreaElement;
const button = (root: HTMLElement, text: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
const edit = (root: HTMLElement, text: string) => {
  area(root).value = text;
  area(root).dispatchEvent(new Event("input"));
};

describe("GitignoreEditorPanel", () => {
  it("shows the file as loaded, with [Cancel] and [Save]", async () => {
    const s = setup("*.tmp\n");
    await s.panel.mount(s.root);
    expect(area(s.root).value).toBe("*.tmp\n");
    expect(button(s.root, "Cancel")).toBeTruthy();
    expect(button(s.root, "Save")).toBeTruthy();
  });

  it("🔑 [Cancel] drops the changes: nothing written, the host closes", async () => {
    const s = setup("*.tmp\n");
    await s.panel.mount(s.root);
    edit(s.root, "secret.txt\n");
    button(s.root, "Cancel").click();
    await flush();
    expect(s.state.saved).toEqual([]);
    expect(s.state.closed).toBe(1);
  });

  it("🔑 [Save] with nothing changed writes nothing (no false change for Sync) and closes", async () => {
    const s = setup("*.tmp\n");
    await s.panel.mount(s.root);
    button(s.root, "Save").click();
    await flush();
    expect(s.state.saved).toEqual([]);
    expect(s.state.closed).toBe(1);
  });

  it("🔑 [Save] with a change writes it and closes", async () => {
    const s = setup("*.tmp\n");
    await s.panel.mount(s.root);
    edit(s.root, "*.tmp\n*.bak\n");
    button(s.root, "Save").click();
    await flush();
    expect(s.state.saved).toEqual(["*.tmp\n*.bak\n"]);
    expect(s.state.closed).toBe(1);
  });

  it("🔑 the file changed on disk meanwhile (a Sync): NOT written, told so, the editor stays with the text", async () => {
    const s = setup("*.tmp\n");
    await s.panel.mount(s.root);
    edit(s.root, "mine\n");
    s.state.disk = "theirs\n";
    button(s.root, "Save").click();
    await flush();
    expect(s.state.saved).toEqual([]);
    expect(s.state.closed).toBe(0);
    expect(area(s.root).value).toBe("mine\n");
    expect(s.root.querySelector(".ges-gitignore-error")?.textContent).toContain("changed on disk");
  });

  it("a failed write: told so, the editor stays, [Save] can be pressed again", async () => {
    const s = setup("*.tmp\n", { failSave: true });
    await s.panel.mount(s.root);
    edit(s.root, "x\n");
    button(s.root, "Save").click();
    await flush();
    expect(s.state.closed).toBe(0);
    expect(s.root.querySelector(".ges-gitignore-error")?.textContent).toContain("disk full");
    expect(s.state.logged).toEqual(["Could not save .gitignore"]); // shown AND logged
    expect(button(s.root, "Save").disabled).toBe(false);
  });
});
