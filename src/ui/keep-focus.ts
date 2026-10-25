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
  view.register(containerEl.onWindowMigrated(() => focusSoon()));
  view.registerEvent(
    app.workspace.on("layout-change", () => {
      if (app.workspace.activeLeaf !== leaf) return;
      if (keyboardInside()) return;
      focusSoon();
    }),
  );
}
