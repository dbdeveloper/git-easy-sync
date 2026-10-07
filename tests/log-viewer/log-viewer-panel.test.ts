// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER: the panel that both the desktop tab and the phone's
// full-screen modal host. What matters for the modal: closing it ENDS
// the logger subscription — also when it is closed before the file read
// has finished, which must then draw nothing.

import { describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { LogViewerPanel, isLastLineVisible } from "../../src/log-viewer/log-viewer-panel";
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
  // Obsidian calls the listener when the element moves to another window
  // (a tab dragged out into a pop-out). Tests trigger it by hand.
  P.onWindowMigrated = function (this: HTMLElement, listener: (win: Window) => void) {
    (this as unknown as { __migrated?: (win: Window) => void }).__migrated = listener;
    return () => {
      (this as unknown as { __migrated?: unknown }).__migrated = undefined;
    };
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

  it("🔑 the search button is a TOGGLE: open, close — and it shows the panel's state", async () => {
    const d = deps(`${line(1)}\n`);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(root);
    const btn = root.querySelector<HTMLButtonElement>(".ges-log-search-toggle")!;
    const panelOpen = () => root.querySelector(".cm-search") !== null;
    btn.click();
    expect(panelOpen()).toBe(true);
    expect(btn.classList.contains("is-active")).toBe(true);
    btn.click();
    expect(panelOpen()).toBe(false);
    expect(btn.classList.contains("is-active")).toBe(false);
    panel.destroy();
  });

  // Owner, 2026-10-08: follow new entries ONLY while the last line is in
  // view; scrolling up even a little turns it off, scrolling back to the
  // end turns it on. The old per-entry "am I at the bottom?" check broke
  // on a burst: CM6 inserts at once but scrolls on the next frame, so the
  // second entry of a burst saw "not at bottom" and stopped following.
  describe("auto-scroll follows only while the last line is visible", () => {
    it("isLastLineVisible: at the end yes; scrolled up by more than a line no", () => {
      expect(isLastLineVisible({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }, 20)).toBe(true);
      expect(isLastLineVisible({ scrollTop: 885, clientHeight: 100, scrollHeight: 1000 }, 20)).toBe(true);
      expect(isLastLineVisible({ scrollTop: 870, clientHeight: 100, scrollHeight: 1000 }, 20)).toBe(false);
      expect(isLastLineVisible({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 }, 20)).toBe(true);
    });

    const geometry = (el: HTMLElement, g: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
      for (const [k, v] of Object.entries(g)) Object.defineProperty(el, k, { configurable: true, value: v });
    };

    it("🔑 a BURST of live entries keeps following (the burst bug)", async () => {
      const d = deps(`${line(1)}\n`);
      const root = document.createElement("div");
      document.body.appendChild(root);
      const panel = new LogViewerPanel(d.deps);
      await panel.mount(root);
      const p = panel as unknown as { following: boolean };
      expect(p.following).toBe(true); // opens at the end
      // The geometry says "not at the bottom" — as it does between an
      // insert and the next frame — but no USER scroll happened.
      geometry(root.querySelector(".cm-scroller") as HTMLElement, { scrollTop: 0, clientHeight: 100, scrollHeight: 5000 });
      for (let i = 2; i <= 6; i++) d.subs.forEach((fn) => fn({ seq: i, line: line(i) }));
      expect(p.following).toBe(true);
      panel.destroy();
    });

    const writable = (el: HTMLElement, g: Record<string, number>) => {
      for (const [k, v] of Object.entries(g)) Object.defineProperty(el, k, { configurable: true, writable: true, value: v });
    };

    // Owner's field report, 2026-10-08: a trackpad gesture is never pure.
    // A sideways swipe carries vertical jitter, a downward one sideways
    // jitter, and a wheel at the very bottom fires NO scroll event at all.
    type P = { following: boolean; lastScrollLeft: number; lastScrollTop: number };
    async function world(at: { top: number; left: number; following: boolean }) {
      const d = deps(`${line(1)}\n`);
      const root = document.createElement("div");
      document.body.appendChild(root);
      const panel = new LogViewerPanel(d.deps);
      await panel.mount(root);
      await new Promise((r) => setTimeout(r, 50)); // let the open's own scroll land first
      const p = panel as unknown as P;
      const sc = root.querySelector(".cm-scroller") as HTMLElement;
      writable(sc, { scrollTop: at.top, clientHeight: 100, scrollHeight: 1000, scrollLeft: at.left });
      p.lastScrollTop = at.top;
      p.lastScrollLeft = at.left;
      p.following = at.following;
      const move = (top: number, left: number) => {
        sc.scrollTop = top;
        sc.scrollLeft = left;
        sc.dispatchEvent(new Event("scroll"));
      };
      return { d, sc, p, panel, move };
    }

    it("🔑 a sideways swipe turns following off — and its vertical JITTER at the bottom does not turn it back on", async () => {
      const w = await world({ top: 900, left: 0, following: true });
      w.move(899, 250); // mostly sideways
      expect(w.p.following).toBe(false);
      w.move(898, 250); // momentum: a pixel of vertical, still at the bottom
      expect(w.p.following).toBe(false);
      w.panel.destroy();
    });

    it("🔑 a downward scroll to the end with sideways JITTER turns following on", async () => {
      const w = await world({ top: 600, left: 250, following: false });
      w.move(900, 252); // mostly down, 2px sideways
      expect(w.p.following).toBe(true);
      w.panel.destroy();
    });

    it("scrolling UP keeps it on while the last line is still visible, turns it off once it is gone", async () => {
      const w = await world({ top: 900, left: 0, following: true });
      w.move(895, 0);
      expect(w.p.following).toBe(true);
      w.move(500, 0);
      expect(w.p.following).toBe(false);
      w.move(501, 0); // down, but not to the end
      expect(w.p.following).toBe(false);
      w.panel.destroy();
    });

    it("🔑 already at the bottom: a WHEEL down turns following on (no scroll event fires there)", async () => {
      const w = await world({ top: 900, left: 250, following: false });
      w.sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, deltaX: 0 }));
      expect(w.p.following).toBe(true);
      w.panel.destroy();
    });

    it("…a wheel down NOT at the bottom, or a sideways wheel, does not", async () => {
      const w = await world({ top: 500, left: 250, following: false });
      w.sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, deltaX: 0 }));
      expect(w.p.following).toBe(false);
      const v = await world({ top: 900, left: 250, following: false });
      v.sc.dispatchEvent(new WheelEvent("wheel", { deltaY: 2, deltaX: 40 }));
      expect(v.p.following).toBe(false);
      w.panel.destroy();
      v.panel.destroy();
    });

    it("🔑 turning ON jumps at once to the end and column 0", async () => {
      const w = await world({ top: 600, left: 250, following: false });
      w.move(900, 250); // down to the end
      await new Promise((r) => setTimeout(r, 50));
      expect(w.sc.scrollLeft).toBe(0);
      w.panel.destroy();
    });

    it("a horizontal move back TO 0 (our reset, or the browser clamping after a filter) decides nothing", async () => {
      const w = await world({ top: 900, left: 200, following: true });
      w.move(900, 0);
      expect(w.p.following).toBe(true);
      w.panel.destroy();
    });

    it("🔑 auto-scroll goes to the END and to column 0", async () => {
      const w = await world({ top: 900, left: 300, following: true });
      w.d.subs.forEach((fn) => fn({ seq: 2, line: line(2) }));
      await new Promise((r) => setTimeout(r, 50));
      expect(w.sc.scrollLeft).toBe(0);
      expect(w.sc.scrollTop).toBe(w.sc.scrollHeight);
      w.panel.destroy();
    });

    it("🔑 a scroll already scheduled does NOT run once following was turned off meanwhile", async () => {
      const w = await world({ top: 900, left: 0, following: true });
      w.d.subs.forEach((fn) => fn({ seq: 2, line: line(2) })); // schedules a scroll
      w.p.following = false; // the user swiped sideways before the frame
      w.sc.scrollLeft = 250;
      await new Promise((r) => setTimeout(r, 50));
      expect(w.sc.scrollLeft).toBe(250);
      w.panel.destroy();
    });
  });

  // Owner's field report, 2026-10-08: dragging the viewer's tab OUT into a
  // new pop-out window broke the text ("|||text", no scrolling). CM6
  // mounts its base styles (white-space: pre…) into the document it was
  // created in; a new window's document has none. setRoot() is CM6's API
  // for exactly this move.
  it("🔑 moved to another window: the editor is re-rooted there, and Ctrl/Cmd+F listens there too", async () => {
    const d = deps(`${line(1)}\n`);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(root);
    const setRoot = vi.spyOn(EditorView.prototype, "setRoot");
    const newDoc = document.implementation.createHTMLDocument("popout");
    const added: string[] = [];
    const newWin = {
      document: newDoc,
      addEventListener: (t: string) => added.push(t),
      removeEventListener: () => {},
    } as unknown as Window;
    (root as unknown as { __migrated: (w: Window) => void }).__migrated(newWin);
    expect(setRoot).toHaveBeenCalledWith(newDoc);
    expect(added).toContain("keydown");
    setRoot.mockRestore();
    panel.destroy();
    expect((root as unknown as { __migrated?: unknown }).__migrated).toBeUndefined();
  });

  // Owner, 2026-10-08: docking the window into a tab, or pulling it out
  // into its own window, reset the scroll to 0 — a user reading an entry
  // in the middle lost it. The browser resets scrollTop/Left when the DOM
  // moves to another window, WITHOUT a scroll event.
  describe("the scroll position survives a move to another window", () => {
    const writable = (el: HTMLElement, g: Record<string, number>) => {
      for (const [k, v] of Object.entries(g)) Object.defineProperty(el, k, { configurable: true, writable: true, value: v });
    };
    const fakeWin = () =>
      ({
        document: document.implementation.createHTMLDocument("popout"),
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as Window;

    async function mounted() {
      const d = deps(`${line(1)}\n`);
      const root = document.createElement("div");
      document.body.appendChild(root);
      const panel = new LogViewerPanel(d.deps);
      await panel.mount(root);
      await new Promise((r) => setTimeout(r, 50));
      const sc = root.querySelector(".cm-scroller") as HTMLElement;
      writable(sc, { scrollTop: 900, clientHeight: 100, scrollHeight: 1000, scrollLeft: 0 });
      sc.dispatchEvent(new Event("scroll"));
      return { root, panel, sc, p: panel as unknown as { following: boolean } };
    }
    const migrate = (root: HTMLElement) =>
      (root as unknown as { __migrated: (w: Window) => void }).__migrated(fakeWin());

    it("🔑 reading in the middle: the same vertical AND horizontal position after the move", async () => {
      const m = await mounted();
      m.sc.scrollTop = 400;
      m.sc.dispatchEvent(new Event("scroll")); // up, last line gone → following off
      m.sc.scrollLeft = 120;
      m.sc.dispatchEvent(new Event("scroll"));
      expect(m.p.following).toBe(false);
      m.sc.scrollTop = 0; // the browser's silent reset on the move
      m.sc.scrollLeft = 0;
      migrate(m.root);
      await new Promise((r) => setTimeout(r, 50));
      expect([m.sc.scrollTop, m.sc.scrollLeft]).toEqual([400, 120]);
      expect(m.p.following).toBe(false);
      m.panel.destroy();
    });

    it("following: after the move it is at the end and column 0, still following", async () => {
      const m = await mounted();
      m.sc.scrollTop = 0;
      migrate(m.root);
      await new Promise((r) => setTimeout(r, 50));
      expect(m.sc.scrollTop).toBe(m.sc.scrollHeight);
      expect(m.sc.scrollLeft).toBe(0);
      expect(m.p.following).toBe(true);
      m.panel.destroy();
    });

    it("a scroll event while DETACHED (zero height) does not overwrite the saved position", async () => {
      const m = await mounted();
      m.sc.scrollTop = 400;
      m.sc.dispatchEvent(new Event("scroll"));
      writable(m.sc, { scrollTop: 0, clientHeight: 0, scrollHeight: 0, scrollLeft: 0 });
      m.sc.dispatchEvent(new Event("scroll"));
      writable(m.sc, { scrollTop: 0, clientHeight: 100, scrollHeight: 1000, scrollLeft: 0 });
      migrate(m.root);
      await new Promise((r) => setTimeout(r, 50));
      expect(m.sc.scrollTop).toBe(400);
      m.panel.destroy();
    });
  });

  // Owner, 2026-10-08: the search panel's switches read and sit like the
  // filter's — "Aa", "W", ".*", in that order.
  it("🔑 the search panel's switches are labelled Aa / W / .* and ordered like the filter's", async () => {
    const d = deps(`${line(1)}\n`);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(root);
    root.querySelector<HTMLButtonElement>(".ges-log-search-toggle")!.click();
    const labels = Array.from(root.querySelectorAll(".cm-search label")).map((l) => l.textContent?.trim());
    expect(labels).toEqual(["Aa", "W", ".*"]);
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(".cm-search label input")).map((i) => i.name);
    expect(inputs).toEqual(["case", "word", "re"]);
    panel.destroy();
  });

  it("separator lines carry the class that draws the full-width rule", async () => {
    const d = deps(`${line(1)}\n${line(2)}\n`);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const panel = new LogViewerPanel(d.deps);
    await panel.mount(root);
    const seps = root.querySelectorAll(".cm-line.ges-log-sep");
    expect(seps.length).toBe(2);
    expect(seps[0].textContent).toMatch(/^[ +]+$/);
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
