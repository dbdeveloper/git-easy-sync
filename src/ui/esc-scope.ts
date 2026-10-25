// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Obsidian's own Esc makes the last-active FILE tab active when the active
// view is not "navigation" — meant for sidebars, it also yanked the focus
// out of our tab views (owner, 2026-10-25: the diff-panel and the log
// viewer jumped to another tab on Esc). The diff-editor stopped it long
// ago (TODO #8) with a keymap Scope that swallows Esc while its leaf is
// active; this is that mechanism, shared by the diff-editor, the
// diff-panel, the log viewer and the .gitignore editor. Pushed only while
// the leaf is active, so Esc keeps working in every other tab. The scope
// runs before the view's own DOM (Obsidian's keymap comes first), so a
// view that has its own use for Esc does it in `onEscape`.

import { Scope, type App, type EventRef, type WorkspaceLeaf } from "obsidian";

export interface EscScopeHost {
  app: App;
  leaf: WorkspaceLeaf;
  registerEvent(ref: EventRef): void;
  register(cb: () => void): void;
  containerEl?: HTMLElement;
}

export function holdEscapeWhileActive(view: EscScopeHost, onEscape: () => void = () => {}): void {
  const { app, leaf } = view;
  const scope = new Scope(app.scope);
  scope.register([], "Escape", () => {
    onEscape();
    return false; // handled: Obsidian's own Esc does not run
  });
  // Obsidian's keymap keeps a scope stack PER WINDOW (read in 1.13.4,
  // 2026-10-25): pushScope pushes onto the stack of `activeWindow` at that
  // moment, and the keys of a window use only that window's stack. A
  // scope pushed while the tab was in the main window stayed there after
  // a tear-off, and Esc in the pop-out never reached it — Obsidian's own
  // Esc then focused a note in the main window (field logs: "handled by
  // our scope" in the main window every time, never in the pop-out). So
  // the scope follows the tab: re-pushed into the tab's window once that
  // window is the active one (the keyboard entering the tab, a move to
  // another window).
  let pushed = false;
  let scopeWin: unknown = null;
  const currentWindow = (): unknown =>
    typeof activeWindow !== "undefined" ? activeWindow : window;
  const tabWindow = (): unknown => view.containerEl?.win ?? window;
  const push = () => {
    app.keymap.pushScope(scope);
    scopeWin = currentWindow();
    pushed = true;
  };
  const pop = () => {
    app.keymap.popScope(scope);
    scopeWin = null;
    pushed = false;
  };
  const relocate = () => {
    if (!pushed || scopeWin === tabWindow() || currentWindow() !== tabWindow()) return;
    pop();
    push();
  };
  const sync = (active: WorkspaceLeaf | null) => {
    const want = active === leaf;
    if (want && !pushed) push();
    else if (!want && pushed) pop();
    relocate();
  };
  view.registerEvent(app.workspace.on("active-leaf-change", (l) => sync(l)));
  sync(app.workspace.activeLeaf ?? null);
  view.register(() => {
    if (pushed) pop();
  });
  if (view.containerEl) {
    const host = view.containerEl;
    const onFocusIn = () => relocate();
    host.addEventListener("focusin", onFocusIn);
    view.register(() => host.removeEventListener("focusin", onFocusIn));
    view.register(
      host.onWindowMigrated(() => {
        relocate();
        window.setTimeout(relocate, 0);
      }),
    );
  }
}
