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

// Read in Obsidian 1.13.4 (2026-10-25): the keymap keeps a scope stack PER
// WINDOW — pushScope pushes onto the stack of `activeWindow` at that
// moment, and keys in a window use only that window's stack. Our scope,
// pushed while the tab was in the main window, stayed there after a
// tear-off: Esc in the pop-out never reached it.
describe("holdEscapeWhileActive — the scope lives in the tab's OWN window", () => {
  function perWindowWorld() {
    const g = globalThis as unknown as { activeWindow: unknown };
    const saved = g.activeWindow;
    const mainWin = { name: "main", addEventListener: () => {}, removeEventListener: () => {} };
    const popWin = { name: "pop", addEventListener: () => {}, removeEventListener: () => {} };
    const stacks = new Map<unknown, unknown[]>();
    const stack = (w: unknown) => stacks.get(w) ?? (stacks.set(w, []), stacks.get(w)!);
    g.activeWindow = mainWin;
    let migrated: ((w: Window) => void) | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const inner = container.appendChild(document.createElement("input"));
    const c = container as unknown as Record<string, unknown>;
    c.onWindowMigrated = (fn: (w: Window) => void) => {
      migrated = fn;
      return () => {};
    };
    let tabWin: unknown = mainWin;
    Object.defineProperty(container, "win", { get: () => tabWin, configurable: true });
    const leaf = { id: "me" };
    const view = {
      app: {
        scope: {},
        keymap: {
          pushScope: (s: { win?: unknown }) => {
            stack(g.activeWindow).push(s);
            s.win = g.activeWindow;
          },
          popScope: (s: { win?: unknown }) => {
            const st = stack(s.win);
            st.splice(st.indexOf(s), 1);
            s.win = undefined;
          },
        },
        workspace: { activeLeaf: leaf, on: () => ({}), setActiveLeaf: () => {} },
      },
      leaf,
      containerEl: container,
      registerEvent: () => {},
      register: () => {},
      registerDomEvent: (el: HTMLElement, type: string, fn: () => void) => el.addEventListener(type, fn),
    };
    holdEscapeWhileActive(view as never);
    return {
      stack,
      mainWin,
      popWin,
      inner,
      restore: () => (g.activeWindow = saved),
      tearOff: () => {
        tabWin = popWin;
        migrated!(popWin as unknown as Window);
      },
      focusPopout: () => {
        g.activeWindow = popWin;
        inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      },
    };
  }

  it("🔑 torn off → the scope moves to the pop-out's stack once that window is active", () => {
    const w = perWindowWorld();
    try {
      expect(w.stack(w.mainWin)).toHaveLength(1);
      w.tearOff();
      w.focusPopout();
      expect(w.stack(w.mainWin)).toHaveLength(0);
      expect(w.stack(w.popWin)).toHaveLength(1);
      w.focusPopout(); // again: not doubled
      expect(w.stack(w.popWin)).toHaveLength(1);
    } finally {
      w.restore();
    }
  });
});
