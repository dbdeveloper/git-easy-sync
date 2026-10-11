// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// A conflict whose COPY is gone is resolved (owner, 2026-10-11) — however
// it went: the user deleted it, renamed it onto the base, deleted both
// files, or the conflict reconcile removed it because it matched the base.
// Its open diff-editor tabs close silently and its autosave is wiped. A
// deleted BASE alone is not a resolution: the copy is still there, so the
// conflict goes on and the tab stays.
//
// ⚠️ The disk decides, never a vault event: Obsidian sends no events for
// dot-files and dot-folders, so the callers run this at checkpoints that
// do not depend on events (after a conflict reconcile, after a drain), and
// on delete/rename events only as a shortcut.
//
// UNSAVED WORK (owner, option 2): a tab holding edits not yet applied with
// [←] closes TOO — the conflict it was resolving no longer exists — but its
// base is reported in `discardedEdits`, so the caller tells the user.
//
// Tabs are read from their SERIALIZED state, so a deferred (background)
// leaf counts too. Both autosave kinds are wiped: a closed-over tab no longer
// says whether its copy was tracked or synthetic.

import { autosaveDir, deriveAutosaveId } from "./autosave-store";

export interface VanishedCopyDeps {
  editorTabs(): Array<{
    origin: string;
    basePath: string;
    siblingPath: string;
    detach(): void;
    // Asked BEFORE anything is wiped.
    hasUnsavedEdits(): Promise<boolean>;
  }>;
  adapter: {
    exists(path: string): Promise<boolean>;
    rmdir(path: string, recursive: boolean): Promise<void>;
  };
}

export async function closeEditorsOfVanishedCopies(
  deps: VanishedCopyDeps,
): Promise<{ closedTabs: number; wipedDirs: number; discardedEdits: string[] }> {
  let closedTabs = 0;
  let wipedDirs = 0;
  const discardedEdits: string[] = [];
  for (const tab of deps.editorTabs()) {
    if (tab.origin !== "conflict") continue;
    if (!tab.siblingPath || tab.siblingPath === tab.basePath) continue;
    if (await deps.adapter.exists(tab.siblingPath)) continue;
    if (await tab.hasUnsavedEdits()) discardedEdits.push(tab.basePath);
    tab.detach();
    closedTabs++;
    for (const kind of ["tracked", "synthetic"] as const) {
      const dir = autosaveDir(deriveAutosaveId(kind, tab.basePath, tab.siblingPath));
      if (await deps.adapter.exists(dir)) {
        await deps.adapter.rmdir(dir, true);
        wipedDirs++;
      }
    }
  }
  return { closedTabs, wipedDirs, discardedEdits };
}
