// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The start scan (GITKEEP I16-I19; docs/tasks/GITKEEP.md) — builds the
// folder journal after a start, when whatever happened while the plugin
// was not running left no events. It only MARKS; the commit writes (I20).
// No .gitignore question here (I13): the rules may change before the
// commit, so only the commit decides.
//
// Marked: an ordinary folder whose .gitkeep is missing, non-empty,
// unrecorded, or recorded with the server's non-empty sha (the heal of
// I4); and the folder of every recorded .gitkeep that is gone from
// Obsidian's folder list. One stat per folder, in chunks with a pause
// between them, so a phone does not stall.

import { isDotPath } from "./change-detector";
import { GITKEEP_SHA } from "./text-normalize";

export interface FolderScanInput {
  folders: Iterable<string>; // getAllFolders paths
  records: Map<string, string>; // ordinary-folder .gitkeep path -> sha
  stat: (path: string) => Promise<{ size: number } | null>;
  mark: (folder: string) => void;
  pause: () => Promise<void>;
}

const CHUNK = 100;

export async function scanFolders(input: FolderScanInput): Promise<number> {
  let marked = 0;
  const seen = new Set<string>();
  let n = 0;
  for (const raw of input.folders) {
    const folder = raw.split("/").filter((s) => s.length > 0).join("/");
    if (folder === "" || isDotPath(folder) || seen.has(folder)) continue;
    seen.add(folder);
    if (++n % CHUNK === 0) await input.pause();
    const path = `${folder}/.gitkeep`;
    const stat = await input.stat(path);
    const record = input.records.get(path);
    if (stat === null || stat.size > 0 || record === undefined || record !== GITKEEP_SHA) {
      input.mark(folder);
      marked += 1;
    }
  }
  for (const path of input.records.keys()) {
    const folder = path.slice(0, -"/.gitkeep".length);
    if (folder === "" || isDotPath(folder) || seen.has(folder)) continue;
    input.mark(folder);
    marked += 1;
  }
  return marked;
}
