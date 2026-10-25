// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi, afterEach } from "vitest";
import { keepLeafFocus } from "../src/ui/keep-focus";

// Owner, 2026-10-25: (1) Esc in a pop-out sometimes threw the focus to the
// main window — the keyboard was in our tab but Obsidian's active leaf
// was still another (it follows clicks), so our Esc scope was not in
// place; (2) after a move (into its own window, or next to other tabs)
// the editing area lost the focus until clicked.
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
  it("🔑 the keyboard focus enters the tab → the tab becomes Obsidian's active leaf", () => {
    const w = world();
    w.inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(w.setActiveLeaf).toHaveBeenCalledWith(w.leaf, { focus: false });
  });

  it("already active → left alone", () => {
    const w = world();
    w.ws.activeLeaf = w.leaf;
    w.inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(w.setActiveLeaf).not.toHaveBeenCalled();
  });

  it("🔑 moved to another window → active, and the editing area gets the focus", () => {
    vi.useFakeTimers();
    const w = world();
    w.migrate();
    vi.runAllTimers();
    expect(w.ws.activeLeaf).toBe(w.leaf);
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
