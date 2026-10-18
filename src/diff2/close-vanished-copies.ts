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
// UNSAVED WORK is discarded SILENTLY (owner, 2026-10-11): once the conflict
// was resolved outside the editor, edits not yet applied with [←] are moot —
// "the train has left". No notice. The same rule holds for [←] itself
// (DiffDetailController.resolvedOutside).
//
// Tabs are read from their SERIALIZED state, so a deferred (background)
// leaf counts too. Both autosave kinds are wiped: a closed-over tab no longer
// says whether its copy was tracked or synthetic.

import { autosaveDir, deriveAutosaveId } from "./autosave-store";
import { isConflictPair } from "../sync2/conflict-siblings";

export interface VanishedCopyDeps {
  editorTabs(): Array<{
    origin: string;
    basePath: string;
    siblingPath: string;
    // The tab the user is looking at (owner, 2026-10-12): not closed under
    // them — they are told first.
    isActive?: boolean;
    detach(): void;
  }>;
  // The conflict model's verdict for this copy (owner, 2026-10-12): resolved
  // when the copy is gone OR byte-equal to its base. Default: gone only.
  isResolved?: (basePath: string, copyPath: string) => Promise<boolean>;
  // Shown before the FOCUSED tab closes ("resolved outside the editor").
  notifyResolved?: (basePath: string) => Promise<void>;
  // After the FOCUSED tab closed: back to the Diff Panel (owner, 2026-10-12).
  onFocusedClosed?: () => void;
  // One tab's check threw: that tab is left for the next pass, the rest go on.
  onCheckFailed?: (copyPath: string, err: unknown) => void;
  adapter: {
    exists(path: string): Promise<boolean>;
    rmdir(path: string, recursive: boolean): Promise<void>;
  };
}

export async function closeEditorsOfVanishedCopies(
  deps: VanishedCopyDeps,
): Promise<{ closedTabs: number; wipedDirs: number }> {
  let closedTabs = 0;
  let wipedDirs = 0;
  for (const tab of deps.editorTabs()) {
    if (tab.origin !== "conflict") continue;
    // Not a conflict copy of its base (two ordinary files) — not ours.
    if (!isConflictPair(tab.basePath, tab.siblingPath)) continue;
    if (!tab.siblingPath || tab.siblingPath === tab.basePath) continue;
    // A check that throws used to abort the whole pass (field, 2026-10-18).
    let resolved: boolean;
    try {
      resolved = deps.isResolved
        ? await deps.isResolved(tab.basePath, tab.siblingPath)
        : !(await deps.adapter.exists(tab.siblingPath));
    } catch (err) {
      deps.onCheckFailed?.(tab.siblingPath, err);
      continue;
    }
    if (!resolved) continue;
    if (tab.isActive && deps.notifyResolved) await deps.notifyResolved(tab.basePath);
    tab.detach();
    if (tab.isActive) deps.onFocusedClosed?.();
    closedTabs++;
    for (const kind of ["tracked", "synthetic"] as const) {
      const dir = autosaveDir(deriveAutosaveId(kind, tab.basePath, tab.siblingPath));
      if (await deps.adapter.exists(dir)) {
        await deps.adapter.rmdir(dir, true);
        wipedDirs++;
      }
    }
  }
  return { closedTabs, wipedDirs };
}
