// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Our tab views and the keyboard focus (owner, 2026-10-25), for the
// diff-editor, the diff-panel, the log viewer and the .gitignore editor:
//
//   - Obsidian makes a leaf ACTIVE when it is clicked. After a move the
//     keyboard can be in our tab while Obsidian's active leaf is still
//     another — then our Esc scope (esc-scope.ts, pushed only while the
//     leaf is active) is not in place, and Obsidian's own Esc threw the
//     focus to a note in the main window ("sometimes", and never when
//     tried again: one click fixed it). So the focus entering the tab
//     makes it the active leaf.
//
//   - A move — into its own window, or next to other tabs — re-draws the
//     tab and the editing area loses the focus until clicked; no typing,
//     no Mod+F. After a move to another window (onWindowMigrated) the tab
//     becomes active and its editing area gets the focus. After a layout
//     change in the same window, the same — but only for the ACTIVE tab
//     whose focus is not inside it any more, so an unrelated layout change
//     (a sidebar opened) never steals the focus.

import type { App, EventRef, WorkspaceLeaf } from "obsidian";
import { escDiag } from "./esc-scope";

export interface KeepFocusView {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  registerEvent(ref: EventRef): void;
  register(cb: () => void): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    cb: (ev: HTMLElementEventMap[K]) => unknown,
  ): void;
}

export function keepLeafFocus(view: KeepFocusView, focusEditor: () => void): void {
  const { app, leaf, containerEl } = view;
  const makeActive = () => {
    if (app.workspace.activeLeaf !== leaf) app.workspace.setActiveLeaf(leaf, { focus: false });
  };
  const keyboardInside = () => {
    const focus = (containerEl.doc ?? document).activeElement;
    return focus !== null && containerEl.contains(focus);
  };
  const focusSoon = () => {
    // After the re-draw settles.
    window.setTimeout(() => focusEditor(), 0);
  };
  // Field log 2026-10-25: after a tear-off Obsidian made a NOTE in the main
  // window the active leaf — silently (no active-leaf-change) and AFTER
  // the move — while the keyboard stayed in our tab; the first Esc then
  // went to Obsidian and focused that note. So the tab re-asserts itself
  // 100 ms and 500 ms after a move, and when its window gets the OS focus,
  // each time only with the keyboard inside it.
  const reassert = (why: string) => {
    escDiag("Focus keeper: re-assert", {
      why,
      keyboardInside: keyboardInside(),
      activeIsMe: app.workspace.activeLeaf === leaf,
      activeType: app.workspace.activeLeaf?.view?.getViewType?.() ?? null,
    });
    if (keyboardInside()) makeActive();
  };
  let unbindWin: (() => void) | null = null;
  const watchWin = (win: Window) => {
    unbindWin?.();
    const onFocus = () => reassert("window focus");
    win.addEventListener("focus", onFocus);
    unbindWin = () => win.removeEventListener("focus", onFocus);
  };
  watchWin(containerEl.win ?? window);
  view.register(() => unbindWin?.());

  view.registerDomEvent(containerEl, "focusin", () => makeActive());
  view.register(
    containerEl.onWindowMigrated((win) => {
      watchWin(win);
      makeActive();
      focusSoon();
      window.setTimeout(() => reassert("100 ms after a move"), 100);
      window.setTimeout(() => reassert("500 ms after a move"), 500);
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
