// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi, afterEach } from "vitest";
import { keepLeafFocus, refocusOnEmptyClick } from "../src/ui/keep-focus";

// Owner, 2026-10-25: after a move (into its own window, or next to other
// tabs) the editing area lost the focus until clicked.
function world() {
  const leaf = { id: "me" };
  const other = { id: "other" };
  const handlers = new Map<string, () => void>();
  let migrated: ((w: Window) => void) | null = null;
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);
  const inner = containerEl.appendChild(document.createElement("input"));
  (containerEl as unknown as { onWindowMigrated: unknown }).onWindowMigrated = (fn: (w: Window) => void) => {
    migrated = fn;
    return () => {};
  };
  const setActiveLeaf = vi.fn((l: unknown) => {
    ws.activeLeaf = l;
  });
  const ws = {
    activeLeaf: other as unknown,
    setActiveLeaf,
    on: (name: string, fn: () => void) => {
      handlers.set(name, fn);
      return {};
    },
  };
  const focusEditor = vi.fn();
  const view = {
    leaf,
    app: { workspace: ws },
    containerEl,
    registerEvent: () => {},
    register: () => {},
    registerDomEvent: (el: HTMLElement, type: string, fn: () => void) => el.addEventListener(type, fn),
  };
  keepLeafFocus(view as never, focusEditor);
  return { leaf, other, ws, setActiveLeaf, focusEditor, inner, containerEl, layout: () => handlers.get("layout-change")?.(), migrate: () => migrated!(window) };
}

afterEach(() => vi.useRealTimers());

describe("keepLeafFocus", () => {
  it("🔑 moved to another window → the editing area gets the focus", () => {
    vi.useFakeTimers();
    const w = world();
    w.migrate();
    vi.runAllTimers();
    expect(w.focusEditor).toHaveBeenCalled();
  });

  it("🔑 a layout change while THIS tab is active and the focus is outside it → focus back", () => {
    vi.useFakeTimers();
    const w = world();
    w.ws.activeLeaf = w.leaf;
    w.layout();
    vi.runAllTimers();
    expect(w.focusEditor).toHaveBeenCalledTimes(1);
  });

  it("🔑 a layout change while ANOTHER tab is active → no focus stolen", () => {
    vi.useFakeTimers();
    const w = world();
    w.layout();
    vi.runAllTimers();
    expect(w.focusEditor).not.toHaveBeenCalled();
  });

  it("a layout change with the focus already inside → nothing", () => {
    vi.useFakeTimers();
    const w = world();
    w.ws.activeLeaf = w.leaf;
    w.inner.focus();
    w.layout();
    vi.runAllTimers();
    expect(w.focusEditor).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-25 (History): "whenever such a tab or window gets the
// focus, the list must get it at once" — coming back to the window from
// another program left the keyboard nowhere.
describe("keepLeafFocus — the window gets the OS focus", () => {
  it("🔑 THIS tab active, the keyboard not inside → the editing area gets the focus", () => {
    vi.useFakeTimers();
    const w = world();
    w.ws.activeLeaf = w.leaf;
    window.dispatchEvent(new FocusEvent("focus"));
    vi.runAllTimers();
    expect(w.focusEditor).toHaveBeenCalledTimes(1);
  });

  it("another tab active → no focus stolen", () => {
    vi.useFakeTimers();
    const w = world();
    window.dispatchEvent(new FocusEvent("focus"));
    vi.runAllTimers();
    expect(w.focusEditor).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-25 (History): a click in the tab OUTSIDE the list (above
// or below it) turned the selection pale — the list's focus was set on
// mousedown, and the browser's own default then moved the focus to the
// clicked empty spot. The list gets the focus back AFTER that default.
describe("refocusOnEmptyClick", () => {
  function clickWorld() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const empty = container.appendChild(document.createElement("div"));
    const input = container.appendChild(document.createElement("input"));
    const button = container.appendChild(document.createElement("button"));
    const focus = vi.fn();
    const view = {
      registerDomEvent: (el: HTMLElement, type: string, fn: (e: Event) => void) => el.addEventListener(type, fn),
    };
    refocusOnEmptyClick(view as never, container, focus);
    const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { empty, input, button, focus, down };
  }

  it("🔑 a click on an empty spot → the list gets the focus AFTER the browser's default", () => {
    vi.useFakeTimers();
    const w = clickWorld();
    w.down(w.empty);
    expect(w.focus).not.toHaveBeenCalled(); // not before the default
    vi.runAllTimers();
    expect(w.focus).toHaveBeenCalledTimes(1);
  });

  it("a click on an input or a button → its focus is left alone", () => {
    vi.useFakeTimers();
    const w = clickWorld();
    w.down(w.input);
    w.down(w.button);
    vi.runAllTimers();
    expect(w.focus).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-25: a click on the tab's own header (the title bar) or
// on its handle in the tab strip took the keyboard away from the list /
// the editor — both lie outside the content, and the tab was already
// active, so no active-leaf-change came. The editing area gets the focus
// back after such a click; the header's icons (menu, navigation) and the
// handle's close button are left alone.
describe("keepLeafFocus — clicks on the tab's header and handle", () => {
  function headerWorld() {
    const containerEl = document.createElement("div");
    const header = containerEl.appendChild(document.createElement("div"));
    header.className = "view-header";
    const title = header.appendChild(document.createElement("div"));
    const icon = header.appendChild(document.createElement("div"));
    icon.className = "clickable-icon";
    containerEl.appendChild(document.createElement("div")).className = "view-content";
    document.body.appendChild(containerEl);
    const tabHeaderEl = document.createElement("div");
    const handleTitle = tabHeaderEl.appendChild(document.createElement("div"));
    const close = tabHeaderEl.appendChild(document.createElement("div"));
    close.className = "workspace-tab-header-inner-close-button";
    document.body.appendChild(tabHeaderEl);
    (containerEl as unknown as { onWindowMigrated: unknown }).onWindowMigrated = () => () => {};
    const leaf = { tabHeaderEl };
    const focusEditor = vi.fn();
    const view = {
      leaf,
      app: { workspace: { activeLeaf: leaf, on: () => ({}) } },
      containerEl,
      registerEvent: () => {},
      register: () => {},
      registerDomEvent: (el: HTMLElement, type: string, fn: (e: Event) => void) => el.addEventListener(type, fn),
    };
    keepLeafFocus(view as never, focusEditor);
    const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { title, icon, handleTitle, close, focusEditor, down };
  }

  it("🔑 a click on the title bar or the tab handle → the editing area gets the focus", () => {
    vi.useFakeTimers();
    const w = headerWorld();
    w.down(w.title);
    vi.runAllTimers();
    expect(w.focusEditor).toHaveBeenCalledTimes(1);
    w.down(w.handleTitle);
    vi.runAllTimers();
    expect(w.focusEditor).toHaveBeenCalledTimes(2);
  });

  it("the header's icons and the handle's close button → left alone", () => {
    vi.useFakeTimers();
    const w = headerWorld();
    w.down(w.icon);
    w.down(w.close);
    vi.runAllTimers();
    expect(w.focusEditor).not.toHaveBeenCalled();
  });
});
