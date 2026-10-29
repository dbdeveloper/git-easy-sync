// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The empty-folder sweep on a receiving device (GITKEEP I29-I32, C12,
// C13; docs/tasks/GITKEEP.md). After the drain applied its deletions,
// ONE pass over the folders of those deletions: a folder left TRULY
// empty goes, then its parent, up to the first folder that does not go.
//
// Nothing inside a folder is ever deleted — the main job is to lose no
// data. A folder that still holds anything (a `.DS_Store`, a file kept
// out of sync by .gitignore, a note not committed yet) stays; if the
// drain removed its `.gitkeep`, it is marked, and the next commit gives
// it a `.gitkeep` back, so it returns to the other devices — the
// owner's "Phoenix", a feature.
//
// An ORDINARY folder that is empty but whose `.gitkeep` record lives on
// (the user deleted the `.gitkeep` by hand, then the server emptied the
// folder) is alive: it is marked, not removed — otherwise the next scan
// would read "record, no folder" and delete the folder on every device.
//
// ⚠️ No platform gives a "remove only if empty" (read in Obsidian
// 1.13.4): desktop `adapter.rmdir(p, false)` is Node `rm` without
// `recursive`, which refuses even an EMPTY directory (EISDIR); the
// Capacitor adapter ignores the flag and always deletes recursively.
// So emptiness is OUR check, made by `removeIfEmpty` immediately before
// a recursive rmdir — the same list-then-rmdir Obsidian Sync uses for
// its own folders. Keep that check and the removal adjacent.
//
// Never the root, `<configDir>/`, `<configDir>/plugins/`. Callers pass
// the paths of EVERY deletion the drain applies this run, removed now or
// already gone (a redo after a dead battery must sweep again).

import { isDotPath } from "./change-detector";

export interface FolderSweepInput {
  deletedPaths: Iterable<string>;
  configDir: string;
  // The folder's direct entries (names), or null when it does not exist.
  list: (folder: string) => Promise<string[] | null>;
  // Remove the folder only if it is empty RIGHT NOW: list and remove in
  // one step, nothing in between. true = removed, false = not empty.
  removeIfEmpty: (folder: string) => Promise<boolean>;
  // Does the plugin hold a record for this `.gitkeep` path?
  hasRecord: (gitkeepPath: string) => Promise<boolean>;
  mark: (folder: string) => void;
}

const parentOf = (p: string): string => {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
};

export async function sweepEmptyFolders(
  input: FolderSweepInput,
): Promise<{ removed: string[] }> {
  const deleted = new Set(input.deletedPaths);
  const never = new Set(["", input.configDir, `${input.configDir}/plugins`]);
  // Deepest first, so a child is settled before its parent is looked at.
  const start = [...new Set([...deleted].map(parentOf))].sort(
    (a, b) => b.split("/").length - a.split("/").length || (a < b ? -1 : 1),
  );
  const done = new Set<string>();
  const removed: string[] = [];

  for (let folder of start) {
    // `done` holds only folders that are GONE: a folder found non-empty
    // is looked at again when a sibling's walk reaches it, since that
    // sibling's removal may just have emptied it.
    while (!never.has(folder) && !done.has(folder)) {
      const entries = await input.list(folder);
      if (entries === null) {
        done.add(folder);
        folder = parentOf(folder); // already gone — a redo; look higher
        continue;
      }
      const ordinary = !isDotPath(folder);
      const keep = `${folder}/.gitkeep`;
      if (entries.length > 0) {
        // Something lives here; nothing of it is touched. If the drain
        // took its .gitkeep, the next commit puts one back (I31).
        if (ordinary && deleted.has(keep)) input.mark(folder);
        break;
      }
      if (ordinary && !deleted.has(keep) && (await input.hasRecord(keep))) {
        input.mark(folder); // C13 — alive, its .gitkeep is due back
        break;
      }
      // The emptiness that counts is checked right at the removal.
      if (!(await input.removeIfEmpty(folder))) break;
      done.add(folder);
      removed.push(folder);
      folder = parentOf(folder);
    }
  }
  return { removed };
}
