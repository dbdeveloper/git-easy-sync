// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The reconcile of the marked folders (GITKEEP §3.6.1, I22 step 2-3,
// I26; docs/tasks/GITKEEP.md): ONE procedure for every marked subtree,
// both ways, instead of separate "appeared / vanished / renamed"
// branches.
//
//   folders -> records: a folder that exists with no record gets an
//                       addition (or an update when its record is the
//                       server's non-empty sha - the heal of I4);
//   records -> folders: a record whose folder is gone gets a deletion.
//
// The three truths: `folders` (getAllFolders - what IS), `records` (the
// plugin's baselines - what WAS; vanished folders are found here, since
// Obsidian does not send an event for every subfolder), and `queued`
// (what is committed but not pushed yet - asked exactly as the detector
// asks it for ordinary files). `.gitignore` decides PER VISITED FOLDER,
// not per marked prefix: after the ancestor collapse the snapshot holds
// only top folders, and an excluded one may sit anywhere below.
//
// Dot folders and the root are not this function's business: dot
// folders' .gitkeep is the detector's (I8), the root never gets one.
// No disk I/O here - putting the files on disk is the caller's step 1.
//
// Precondition: `records` and `queuedPaths` hold ORDINARY-folder
// `.gitkeep` paths only (isOrdinaryFolderGitkeep) - a root `.gitkeep`
// would map to the folder "" and be ignored, not rejected.

import { isDotPath } from "./change-detector";
import { GITKEEP_SHA } from "./text-normalize";

export interface GitkeepPlanInput {
  // The commit's snapshot of the journal (already collapsed).
  snapshot: Iterable<string>;
  // Every folder Obsidian knows (getAllFolders paths).
  folders: Iterable<string>;
  // Ordinary-folder `.gitkeep` records: path -> baseline sha.
  records: Map<string, string>;
  // Does .gitignore let this `.gitkeep` path through?
  syncable: (gitkeepPath: string) => Promise<boolean>;
  // The newest queued batch's view of the path: a sha, null for a queued
  // deletion, undefined when no batch holds it.
  queued: (gitkeepPath: string) => Promise<string | null | undefined>;
  // Every ordinary-folder `.gitkeep` path some queued batch holds. A
  // commit that added `a/.gitkeep` and `a/b/.gitkeep` and was not pushed
  // yet has no records for them; if `a` is deleted now, these are the
  // only trace of what has to be cancelled.
  queuedPaths?: Iterable<string>;
}

export interface GitkeepPlan {
  add: string[]; // send an (empty) .gitkeep - no record yet
  update: string[]; // send the empty one over a recorded non-empty sha
  remove: string[]; // send the deletion - its folder is gone
  forget: string[]; // drop the record silently - .gitignore excludes it now
  // Every existing ordinary folder the walk visited, EXCLUDED ones too:
  // the caller's step 1 puts a missing .gitkeep into each (I1, I22) -
  // the same walk, so it is not done twice.
  visited: string[];
}

const gitkeepOf = (folder: string): string => `${folder}/.gitkeep`;
const folderOf = (gitkeep: string): string => gitkeep.slice(0, -"/.gitkeep".length);

function normalized(folder: string): string {
  return folder.split("/").filter((s) => s.length > 0).join("/");
}

// Everything in a SORTED list that is `prefix` itself or lies under it.
// Binary search to the first candidate, then a straight walk: each
// marked prefix costs log(n) + the size of its own subtree, and the
// collapsed snapshot never visits a subtree twice.
function* subtree(sorted: string[], prefix: string): IterableIterator<string> {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < prefix) lo = mid + 1;
    else hi = mid;
  }
  const under = `${prefix}/`;
  for (let i = lo; i < sorted.length; i++) {
    const p = sorted[i];
    if (p === prefix || p.startsWith(under)) {
      yield p;
      continue;
    }
    // `notes!` sorts between `notes` and `notes/`: keep walking past
    // names that only share the prefix, stop once beyond `notes/`.
    if (p > under && !p.startsWith(under)) break;
  }
}

export async function planGitkeeps(input: GitkeepPlanInput): Promise<GitkeepPlan> {
  const plan: GitkeepPlan = { add: [], update: [], remove: [], forget: [], visited: [] };

  const existing = [
    ...new Set([...input.folders].map(normalized).filter((f) => f !== "" && !isDotPath(f))),
  ].sort();
  const existingSet = new Set(existing);
  // What WAS: recorded, or committed and waiting in the queue.
  const knownFolders = [
    ...new Set([...input.records.keys(), ...(input.queuedPaths ?? [])].map(folderOf)),
  ].sort();

  for (const raw of input.snapshot) {
    const prefix = normalized(raw);
    if (prefix === "" || isDotPath(prefix)) continue;

    // folders -> records
    for (const folder of subtree(existing, prefix)) {
      plan.visited.push(folder);
      const path = gitkeepOf(folder);
      const recorded = input.records.get(path);
      if (!(await input.syncable(path))) {
        if (recorded !== undefined) plan.forget.push(path);
        continue;
      }
      const q = await input.queued(path);
      const reference = q !== undefined ? q : recorded;
      if (reference === GITKEEP_SHA) continue;
      if (recorded !== undefined) plan.update.push(path);
      else plan.add.push(path);
    }

    // records -> folders: what was recorded or queued under the prefix,
    // gone from disk now. A folder that still exists was settled above.
    for (const folder of subtree(knownFolders, prefix)) {
      if (existingSet.has(folder)) continue;
      const path = gitkeepOf(folder);
      const recorded = input.records.has(path);
      if (!(await input.syncable(path))) {
        if (recorded) plan.forget.push(path);
        continue;
      }
      const q = await input.queued(path);
      if (q === null) continue; // its deletion is already queued
      // No record and nothing queued: nothing to take back.
      if (!recorded && q === undefined) continue;
      plan.remove.push(path);
    }
  }
  return plan;
}
