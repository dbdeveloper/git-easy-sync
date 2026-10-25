// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Obsidian's own Esc makes the last-active FILE tab active when the active
// view is not "navigation" — meant for sidebars, it also yanked the focus
// out of our tab views (owner, 2026-10-25: the diff-panel and the log
// viewer jumped to another tab on Esc). The diff-editor stopped it long
// ago (TODO #8) with a keymap Scope that swallows Esc while its leaf is
// active; this is that mechanism for the other views. Pushed only while
// the leaf is active, so Esc keeps working in every other tab. The scope
// runs before the view's own DOM (Obsidian's keymap comes first), so a
// view that has its own use for Esc does it in `onEscape`.

import { Scope, type App, type EventRef, type WorkspaceLeaf } from "obsidian";

export interface EscScopeHost {
  app: App;
  leaf: WorkspaceLeaf;
  registerEvent(ref: EventRef): void;
  register(cb: () => void): void;
}

export function holdEscapeWhileActive(view: EscScopeHost, onEscape: () => void = () => {}): void {
  const { app, leaf } = view;
  const scope = new Scope(app.scope);
  scope.register([], "Escape", () => {
    onEscape();
    return false; // handled: Obsidian's own Esc does not run
  });
  let pushed = false;
  const sync = (active: WorkspaceLeaf | null) => {
    const want = active === leaf;
    if (want && !pushed) {
      app.keymap.pushScope(scope);
      pushed = true;
    } else if (!want && pushed) {
      app.keymap.popScope(scope);
      pushed = false;
    }
  };
  view.registerEvent(app.workspace.on("active-leaf-change", (l) => sync(l)));
  sync(app.workspace.activeLeaf ?? null);
  view.register(() => {
    if (pushed) app.keymap.popScope(scope);
    pushed = false;
  });
}
