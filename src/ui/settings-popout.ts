// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// A tab that Settings open in its OWN pop-out window — the log viewer and
// the root .gitignore editor, which must behave exactly alike (owner,
// 2026-10-25). Three things, each learned in the field:
//
//   Esc — through a keymap scope while the tab is active (esc-scope.ts):
//     the view's own Esc first (the log viewer closes its search panel);
//     then, if the tab is the ONE tab of its own pop-out, it closes;
//     otherwise nothing — and Obsidian's own Esc, which would make the
//     last file tab active, never runs. Checked at each press, so a tab
//     dragged next to others stays.
//
//   The focus goes back to the window the tab was opened from. Obsidian
//   1.13 can show Settings in a window of their own (its
//   "settingsPopoutWindow" option); a pop-out closed THROUGH Obsidian
//   (Esc, Cmd+W, the tab's ×) hands the focus to the vault's main window,
//   which lands in front of Settings. So, however the tab is closed, once
//   its pop-out is really gone the opener is raised as Obsidian raises
//   its own Settings window (electronWindow.restore() if minimised, then
//   focus()). "Really gone" is LOOKED at every 50 ms (at most 5 s):
//   Obsidian fires "window-close" BEFORE the tab's onClose runs.
//
//   The tab's own window is kept current (set at install, updated when
//   the tab moves): at onClose the tab is detached already and
//   containerEl.win no longer tells it.

import { holdEscapeWhileActive, type EscScopeHost } from "./esc-scope";

export interface SettingsPopoutView extends EscScopeHost {
  containerEl: HTMLElement;
}

export interface SettingsPopoutOptions {
  // The window the tab was opened from (Settings), or null.
  openedFrom: () => Window | null;
  // Close the tab.
  close: () => void;
  // The view's own Esc, first: true = handled, nothing more.
  onEscape?: () => boolean;
  // One line for the log when the opener is raised.
  log?: (message: string, data: unknown) => void;
}

// Install in the view's onOpen; call closed() from its onClose.
export function settingsPopout(
  view: SettingsPopoutView,
  opts: SettingsPopoutOptions,
): { closed(): void } {
  let ownWin: Window | null = view.containerEl.win ?? null;
  view.register(
    view.containerEl.onWindowMigrated((win) => {
      ownWin = win;
    }),
  );
  const ws = view.app.workspace as unknown as Parameters<typeof onlyTabInItsPopout>[1];
  holdEscapeWhileActive(view, () => {
    if (opts.onEscape?.()) return;
    if (onlyTabInItsPopout(view.leaf as unknown as LeafLike, ws)) opts.close();
  });
  return {
    closed(): void {
      const back = opts.openedFrom();
      const own = ownWin;
      if (!back || !own || back === own || own === window) return;
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (own.closed) {
          window.clearInterval(timer);
          opts.log?.("Pop-out from Settings gone - raising the window it was opened from", {
            ms: Date.now() - started,
          });
          raiseWindow(back);
        } else if (Date.now() - started > 5000) {
          window.clearInterval(timer);
        }
      }, 50);
    },
  };
}

function raiseWindow(win: Window): void {
  if (win.closed) return;
  const ew = (win as unknown as {
    electronWindow?: { isMinimized?: () => boolean; restore?: () => void; focus: () => void };
  }).electronWindow;
  try {
    if (ew) {
      if (ew.isMinimized?.()) ew.restore?.();
      ew.focus();
      return;
    }
  } catch {
    // fall back below
  }
  win.focus();
}

// The ONE tab of its own pop-out window? Never in the main window (an
// empty tab would remain) or a sidebar.
export interface LeafLike {
  getRoot(): unknown;
}

export function onlyTabInItsPopout(
  leaf: LeafLike,
  ws: {
    rootSplit: unknown;
    leftSplit: unknown;
    rightSplit: unknown;
    iterateAllLeaves(cb: (l: LeafLike) => void): void;
  },
): boolean {
  const root = leaf.getRoot();
  if (root === ws.rootSplit || root === ws.leftSplit || root === ws.rightSplit) return false;
  let n = 0;
  ws.iterateAllLeaves((l) => {
    if (l.getRoot() === root) n += 1;
  });
  return n === 1;
}

