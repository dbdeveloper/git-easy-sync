// @vitest-environment happy-dom
// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi, afterEach } from "vitest";
import { settingsPopout } from "../src/ui/settings-popout";

// A tab opened from Settings in its own pop-out window — the log viewer
// and the root .gitignore editor (owner, 2026-10-25: "they must behave
// exactly alike"). Esc closes it while it is the ONE tab of its own
// pop-out; next to other tabs Esc does nothing; however it is closed,
// the window it was opened from gets the focus back.
function world(opts: { alone?: boolean; onEscape?: () => boolean } = {}) {
  const main = window;
  const popout = {
    closed: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & { closed: boolean };
  const settingsWin = {
    closed: false,
    electronWindow: { isMinimized: () => false, restore: vi.fn(), focus: vi.fn() },
    focus: vi.fn(),
  } as unknown as Window & { electronWindow: { focus: ReturnType<typeof vi.fn> } };
  const scopes: Array<{ keys: Array<{ key: string; func: () => unknown }> }> = [];
  const popRoot = { name: "popout" };
  const leaf = { getRoot: () => popRoot };
  const others: Array<{ getRoot: () => unknown }> = opts.alone === false ? [{ getRoot: () => popRoot }] : [];
  let migrate: ((w: Window) => void) | null = null;
  const cleanups: Array<() => void> = [];
  const view = {
    leaf,
    app: {
      scope: {},
      keymap: {
        pushScope: (s: never) => scopes.push(s),
        popScope: (s: never) => scopes.splice(scopes.indexOf(s), 1),
      },
      workspace: {
        activeLeaf: leaf,
        rootSplit: { name: "main" },
        leftSplit: {},
        rightSplit: {},
        on: () => ({}),
        iterateAllLeaves: (cb: (l: unknown) => void) => [leaf, ...others].forEach(cb),
      },
    },
    containerEl: {
      win: popout,
      contains: () => false,
      onWindowMigrated: (fn: (w: Window) => void) => {
        migrate = fn;
        return () => {};
      },
    },
    registerEvent: () => {},
    register: (fn: () => void) => cleanups.push(fn),
  };
  const close = vi.fn();
  const ctl = settingsPopout(view as never, {
    openedFrom: () => settingsWin,
    close,
    onEscape: opts.onEscape,
  });
  const esc = () => scopes[0].keys.find((k) => k.key === "Escape")!.func();
  return { ctl, close, esc, popout, settingsWin, main, migrate: (w: Window) => migrate?.(w) };
}

afterEach(() => vi.useRealTimers());

describe("settingsPopout — Esc", () => {
  it("🔑 the one tab of its own pop-out: Esc closes it", () => {
    const w = world();
    expect(w.esc()).toBe(false); // swallowed
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("🔑 next to other tabs: Esc does nothing (and Obsidian does not get it)", () => {
    const w = world({ alone: false });
    expect(w.esc()).toBe(false);
    expect(w.close).not.toHaveBeenCalled();
  });

  it("🔑 the view's own Esc comes first (the log viewer's search panel)", () => {
    const w = world({ onEscape: () => true });
    w.esc();
    expect(w.close).not.toHaveBeenCalled();
  });
});

describe("settingsPopout — the focus goes back to where it was opened from", () => {
  it("🔑 once the pop-out is really gone, the opener is raised", () => {
    vi.useFakeTimers();
    const w = world();
    w.ctl.closed();
    vi.advanceTimersByTime(100);
    expect(w.settingsWin.electronWindow.focus).not.toHaveBeenCalled(); // still open
    w.popout.closed = true;
    vi.advanceTimersByTime(100);
    expect(w.settingsWin.electronWindow.focus).toHaveBeenCalledTimes(1);
  });

  it("the pop-out stays open (other tabs) → gives up after 5 s", () => {
    vi.useFakeTimers();
    const w = world();
    w.ctl.closed();
    vi.advanceTimersByTime(6000);
    w.popout.closed = true;
    vi.advanceTimersByTime(1000);
    expect(w.settingsWin.electronWindow.focus).not.toHaveBeenCalled();
  });

  it("🔑 moved into the MAIN window → nothing to return", () => {
    vi.useFakeTimers();
    const w = world();
    w.migrate(window);
    w.ctl.closed();
    vi.advanceTimersByTime(1000);
    expect(w.settingsWin.electronWindow.focus).not.toHaveBeenCalled();
  });
});
