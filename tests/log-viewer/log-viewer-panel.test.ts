// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER: the panel that both the desktop tab and the phone's
// full-screen modal host. What matters for the modal: closing it ENDS
// the logger subscription — also when it is closed before the file read
// has finished, which must then draw nothing.

import { describe, it, expect } from "vitest";
import { LogViewerPanel } from "../../src/log-viewer/log-viewer-panel";
import type { RecentLine } from "../../src/log-viewer/log-parse";

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
}

const line = (n: number) =>
  JSON.stringify({ timestamp: "2026-10-07T10:00:00.000Z", level: "INFO", message: `m${n}` });

function deps(text: string, readGate?: Promise<void>) {
  const subs = new Set<(l: RecentLine) => void>();
  return {
    subs,
    deps: {
      adapter: {
        stat: async () => ({ size: text.length }),
        read: async () => {
          await readGate;
          return text;
        },
      },
      logPath: "git-easy-sync.log",
      logger: () => ({
        recentLines: (): RecentLine[] => [],
        subscribe: (fn: (l: RecentLine) => void) => {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      }),
    },
  };
}

const status = (root: HTMLElement) => root.querySelector(".ges-log-status")?.textContent;

describe("LogViewerPanel", () => {
  it("mounts, shows the entries, and takes live ones", async () => {
    const d = deps(`${line(1)}\n${line(2)}\n`);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(root);
    expect(status(root)).toBe("2 of 2 entries");
    d.subs.forEach((fn) => fn({ seq: 1, line: line(3) }));
    expect(status(root)).toBe("3 of 3 entries");
    panel.destroy();
  });

  it("🔑 destroy() ends the logger subscription (closing the modal or the tab)", async () => {
    const d = deps(`${line(1)}\n`);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(document.createElement("div"));
    expect(d.subs.size).toBe(1);
    panel.destroy();
    expect(d.subs.size).toBe(0);
  });

  it("🔑 closed BEFORE the read finished: no subscription left, nothing drawn, no error", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps(`${line(1)}\n`, gate);
    const root = document.createElement("div");
    const panel = new LogViewerPanel(d.deps);
    const mounting = panel.mount(root);
    panel.destroy();
    release();
    await mounting;
    expect(d.subs.size).toBe(0);
    expect(root.querySelector(".cm-editor")).toBeNull();
  });
});
