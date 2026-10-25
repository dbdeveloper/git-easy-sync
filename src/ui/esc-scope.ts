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
  containerEl?: HTMLElement;
  getViewType?(): string;
}

// DIAGNOSTIC (owner, 2026-10-25 — remove once understood): the first Esc
// after a tab is torn off into its own window still threw the focus to
// the main window. One log line per Esc pressed in one of our tabs, and
// one when the scope is installed, say what state things were in. Set by
// main.ts to the plugin's logger.
let diag: ((message: string, data: unknown) => void) | null = null;
export function setEscDiagnostics(fn: ((message: string, data: unknown) => void) | null): void {
  diag = fn;
}
export function escDiag(message: string, data: unknown): void {
  diag?.(message, data);
}

export function holdEscapeWhileActive(view: EscScopeHost, onEscape: () => void = () => {}): void {
  const { app, leaf } = view;
  const scope = new Scope(app.scope);
  scope.register([], "Escape", () => {
    diag?.("Esc: handled by our scope", { view: view.getViewType?.() });
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

  // The keyboard inside the tab — caught first, whatever the active leaf
  // (field log 2026-10-25: right after a tear-off into its own window,
  // Obsidian's active leaf was a NOTE in the main window with no
  // active-leaf-change, the focus was inside our tab, and the keymap scope
  // above never saw the Esc; Obsidian's own Esc then focused the note —
  // the main window). On the tab's window, capture phase, so nothing else
  // sees it; moved with the tab. CodeMirror's search field keeps its Esc
  // (it closes the search).
  const el = view.containerEl;
  if (!el) return;
  const popout = () => (el.win ?? window) !== window;
  diag?.("Esc scope installed", {
    view: view.getViewType?.(),
    popout: popout(),
    activeIsMe: app.workspace.activeLeaf === leaf,
    pushed,
  });
  let unbind: (() => void) | null = null;
  const bind = (win: Window) => {
    unbind?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const doc = el.doc ?? document;
      const focus = doc.activeElement;
      const inside = focus !== null && el.contains(focus);
      diag?.("Esc pressed in our tab's window", {
        view: view.getViewType?.(),
        popout: popout(),
        activeIsMe: app.workspace.activeLeaf === leaf,
        activeType: app.workspace.activeLeaf?.view?.getViewType?.() ?? null,
        pushed,
        focusInside: inside,
        focusTag: focus?.tagName ?? null,
      });
      if (!inside) return;
      // Obsidian handles keys in a window before us; this Esc may already
      // have gone its way — at least the next one finds our leaf active.
      if (app.workspace.activeLeaf !== leaf) app.workspace.setActiveLeaf(leaf, { focus: false });
      if ((focus as HTMLElement).closest?.(".cm-search")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscape();
    };
    win.addEventListener("keydown", onKey, { capture: true });
    unbind = () => win.removeEventListener("keydown", onKey, { capture: true });
  };
  bind(el.win ?? window);
  view.register(
    el.onWindowMigrated((win) => {
      diag?.("Esc diag: tab moved to another window", { view: view.getViewType?.() });
      bind(win);
    }),
  );
  view.register(() => unbind?.());
}
