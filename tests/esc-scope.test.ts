// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi } from "vitest";
import { holdEscapeWhileActive } from "../src/ui/esc-scope";

// Owner, 2026-10-25: Obsidian's own Esc makes the last-active FILE tab
// active when the active view is not "navigation" (meant for sidebars).
// The diff-editor stopped it long ago with a keymap Scope that swallows
// Esc while its leaf is active (TODO #8); the diff-panel and the log
// viewer get the same.
function world() {
  const scopes: unknown[] = [];
  const handlers = new Map<string, (l: unknown) => void>();
  const leaf = { id: "me" };
  const other = { id: "other" };
  const cleanups: Array<() => void> = [];
  const app = {
    scope: {},
    keymap: {
      pushScope: (s: unknown) => scopes.push(s),
      popScope: (s: unknown) => {
        const i = scopes.indexOf(s);
        if (i >= 0) scopes.splice(i, 1);
      },
    },
    workspace: {
      activeLeaf: other as unknown,
      on: (name: string, fn: (l: unknown) => void) => {
        handlers.set(name, fn);
        return { name };
      },
    },
  };
  const view = {
    app,
    leaf,
    registerEvent: vi.fn(),
    register: (fn: () => void) => cleanups.push(fn),
  };
  const activate = (l: unknown) => {
    app.workspace.activeLeaf = l;
    handlers.get("active-leaf-change")?.(l);
  };
  return { scopes, view, leaf, other, activate, unload: () => cleanups.forEach((f) => f()) };
}

describe("holdEscapeWhileActive", () => {
  it("🔑 the scope is in Obsidian's keymap only while this leaf is active", () => {
    const w = world();
    holdEscapeWhileActive(w.view as never);
    expect(w.scopes).toHaveLength(0); // another leaf is active
    w.activate(w.leaf);
    expect(w.scopes).toHaveLength(1);
    w.activate(w.leaf); // idempotent
    expect(w.scopes).toHaveLength(1);
    w.activate(w.other);
    expect(w.scopes).toHaveLength(0);
  });

  it("already active at install → pushed at once", () => {
    const w = world();
    w.view.app.workspace.activeLeaf = w.leaf;
    holdEscapeWhileActive(w.view as never);
    expect(w.scopes).toHaveLength(1);
  });

  it("🔑 Esc in the scope: swallowed (false), and the view's own action runs", () => {
    const w = world();
    const onEscape = vi.fn();
    w.view.app.workspace.activeLeaf = w.leaf;
    holdEscapeWhileActive(w.view as never, onEscape);
    const scope = w.scopes[0] as { keys: Array<{ key: string; func: () => unknown }> };
    const esc = scope.keys.find((k) => k.key === "Escape")!;
    expect(esc.func()).toBe(false);
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("🔑 unloading the view pops a pushed scope", () => {
    const w = world();
    w.view.app.workspace.activeLeaf = w.leaf;
    holdEscapeWhileActive(w.view as never);
    w.unload();
    expect(w.scopes).toHaveLength(0);
  });
});

// Field log 2026-10-25: right after a tab is torn off into its own window,
// Obsidian's active leaf is a NOTE in the main window (no
// active-leaf-change fired), the keyboard is inside our tab, and the
// keymap scope never sees the Esc — Obsidian's own Esc then focuses the
// note, i.e. the main window. So an Esc with the focus INSIDE our tab is
// caught first, on the tab's window in the capture phase, whatever the
// active leaf.
describe("holdEscapeWhileActive — Esc with the focus inside the tab, whatever the active leaf", () => {
  function domWorld() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const input = container.appendChild(document.createElement("input"));
    const search = container.appendChild(document.createElement("div"));
    search.className = "cm-search";
    const searchInput = search.appendChild(document.createElement("input"));
    (container as unknown as { onWindowMigrated: unknown }).onWindowMigrated = () => () => {};
    const outside = document.body.appendChild(document.createElement("input"));
    const onEscape = vi.fn();
    const view = {
      app: {
        scope: {},
        keymap: { pushScope: () => {}, popScope: () => {} },
        workspace: { activeLeaf: { id: "a note" }, on: () => ({}) },
      },
      leaf: { id: "me" },
      containerEl: container,
      registerEvent: () => {},
      register: () => {},
    };
    holdEscapeWhileActive(view as never, onEscape);
    const esc = (target: HTMLElement) => {
      target.focus();
      const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      return ev;
    };
    return { input, searchInput, outside, onEscape, esc };
  }

  it("🔑 the focus inside the tab (another leaf active): handled by us, Obsidian does not get it", () => {
    const w = domWorld();
    const ev = w.esc(w.input);
    expect(w.onEscape).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("🔑 the focus in CodeMirror's search field: left to CodeMirror (it closes the search)", () => {
    const w = domWorld();
    const ev = w.esc(w.searchInput);
    expect(w.onEscape).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("the focus outside the tab: not ours", () => {
    const w = domWorld();
    w.esc(w.outside);
    expect(w.onEscape).not.toHaveBeenCalled();
  });
});
