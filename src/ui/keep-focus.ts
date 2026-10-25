// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Our tab views and the keyboard focus (owner, 2026-10-25), for the
// diff-editor, the diff-panel, the log viewer and the .gitignore editor:
// a move — into its own window, or next to other tabs — re-draws the tab
// and the editing area loses the focus until clicked; no typing, no
// Mod+F. After a move to another window (onWindowMigrated) the editing
// area gets the focus back. After a layout change in the same window,
// the same — but only for the ACTIVE tab whose focus is not inside it any
// more, so an unrelated layout change (a sidebar opened) never steals it.
// And when the OS gives the window the focus back, the same for the
// active tab.

import type { App, EventRef, WorkspaceLeaf } from "obsidian";

export interface KeepFocusView {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  registerEvent(ref: EventRef): void;
  register(cb: () => void): void;
}

export function keepLeafFocus(view: KeepFocusView, focusEditor: () => void): void {
  const { app, leaf, containerEl } = view;
  const keyboardInside = () => {
    const focus = (containerEl.doc ?? document).activeElement;
    return focus !== null && containerEl.contains(focus);
  };
  const focusSoon = () => {
    // After the re-draw settles.
    window.setTimeout(() => focusEditor(), 0);
  };
  // The OS gives the window the focus back (owner, 2026-10-25, History:
  // "whenever such a tab or window gets the focus, the list must get it")
  // — for the ACTIVE tab whose keyboard is not inside it. Re-bound when
  // the tab moves to another window.
  let unbindWin: (() => void) | null = null;
  const watchWin = (win: Window) => {
    unbindWin?.();
    const onFocus = () => {
      if (app.workspace.activeLeaf !== leaf || keyboardInside()) return;
      focusSoon();
    };
    win.addEventListener("focus", onFocus);
    unbindWin = () => win.removeEventListener("focus", onFocus);
  };
  watchWin(containerEl.win ?? window);
  view.register(() => unbindWin?.());
  view.register(
    containerEl.onWindowMigrated((win) => {
      watchWin(win);
      focusSoon();
    }),
  );
  view.registerEvent(
    app.workspace.on("layout-change", () => {
      if (app.workspace.activeLeaf !== leaf) return;
      if (keyboardInside()) return;
      focusSoon();
    }),
  );
}

// A click in the tab outside its list (above it, below it) must just give
// the list the keyboard (owner, 2026-10-25, History: the selection went
// pale). Focusing the list ON mousedown is too early — the browser's own
// default then moves the focus to the clicked empty spot. So the list is
// focused right AFTER that default. A click on something that takes the
// focus itself (an input, a button, a link…) keeps it.
const TAKES_FOCUS = "input, textarea, select, button, a[href], [contenteditable]";

export function refocusOnEmptyClick(
  view: { registerDomEvent(el: HTMLElement, type: "mousedown", cb: (e: MouseEvent) => unknown): void },
  container: HTMLElement,
  focus: () => void,
): void {
  view.registerDomEvent(container, "mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(TAKES_FOCUS)) return;
    window.setTimeout(() => focus(), 0);
  });
}
