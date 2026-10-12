// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// SYNTHETIC conflict copies — files named like a conflict copy that the
// drain's ledger (conflicts.json) does not track. Moved here from diff2's
// synthetic-detector (owner, 2026-10-12): finding conflicts is about
// conflicts as a whole, not about the UI; the Diff Panel calls it from here.
//
// Two branches, because Obsidian's index cannot see dot-paths:
//   - syntheticCopiesFromIndex — the FAST one: the in-memory index, no disk
//     I/O, the whole non-dot space at once;
//   - syntheticCopiesFromDotSpace — the SLOW one: a real walk of the
//     dot-space the user opted into, plus a listing of the directories that
//     hold the opted-in dot FILES (the root `.gitignore` among them). Measured
//     at ~22 s on Android for a large configDir.
// Tracked copies are left out of both: the ledger lists them.
//
// The result is a list of PATHS only. Whether a copy is still alive (gone,
// equal to its base, a duplicate) is the conflict model's question
// (conflict-model.ts), asked of the disk at that moment — so a list that is a
// little old can never make anyone act on a copy that changed since.

import { normalizePath, type Vault } from "obsidian";
import type ConflictStoreV2 from "./conflict-store-v2";
import { parseSiblingFilename, timeLabelFromStamp } from "./conflict-siblings";
import { readRootGitignore, walkDotDir } from "./dot-space";
import type { SyntheticCopy } from "./conflict-model";

export interface DotSpaceScope {
  configDir: string;
  syncConfigDir: () => boolean;
}

// The copy at `path`, if it is an UNTRACKED copy's name; null otherwise.
function syntheticAt(store: ConflictStoreV2, path: string): SyntheticCopy | null {
  const parsed = parseSiblingFilename(path);
  if (!parsed) return null;
  if (store.getBySiblingPath(path)) return null; // tracked — the ledger's
  const t = timeLabelFromStamp(parsed.isoTimestamp);
  return { path, basePath: parsed.basePath, timeLabel: Number.isNaN(t) ? 0 : t };
}

// NOTE (2026-06-18): an ABSENT base is NOT skipped. A copy whose base is
// missing is a delete-vs-modify conflict (base deleted, the copy holds the
// other side); it is listed so the user can resolve it.
export function syntheticCopiesFromIndex(vault: Vault, store: ConflictStoreV2): SyntheticCopy[] {
  const out: SyntheticCopy[] = [];
  for (const file of vault.getFiles()) {
    const c = syntheticAt(store, file.path);
    if (c) out.push(c);
  }
  return out;
}

// It walks the SAME targets the sync scan does, through the same walker: a
// copy in a dot-directory nobody opted into is one the user could not
// resolve through sync anyway.
export async function syntheticCopiesFromDotSpace(
  vault: Vault,
  store: ConflictStoreV2,
  scope: DotSpaceScope,
): Promise<SyntheticCopy[]> {
  const optIn = await readRootGitignore({
    vault,
    configDir: scope.configDir,
    syncConfigDir: scope.syncConfigDir,
  });
  const out: SyntheticCopy[] = [];
  for (const target of optIn.walkTargets) {
    const { files } = await walkDotDir(vault, target);
    for (const f of files) {
      const c = syntheticAt(store, f.path);
      if (c) out.push(c);
    }
  }

  // …and the opt-in set's dot FILES, whose copies no walk target covers. A
  // `dotFiles` member is addressed by exact path, so the DIRECTORY it lives
  // in is never walked; for `.gitignore` that directory is the vault root.
  // Obsidian's indexer hides a path if ANY segment is dotted (confirmed
  // against obsidian.asar, 2026-09-27), so without this a synthetic copy of
  // `<root>/.gitignore` was seen by nobody. Owner's rule: every conflict
  // must be findable. Grouped by directory: one listing per directory.
  const byDir = new Map<string, Set<string>>();
  for (const filePath of optIn.dotFiles) {
    const slash = filePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : filePath.slice(0, slash);
    const members = byDir.get(dir) ?? new Set<string>();
    members.add(filePath);
    byDir.set(dir, members);
  }
  for (const [dir, members] of byDir) {
    let listing: { files: string[] };
    try {
      listing = await vault.adapter.list(dir);
    } catch {
      continue; // unreadable or vanished mid-scan — skip-class
    }
    for (const candidate of listing.files) {
      const c = syntheticAt(store, normalizePath(candidate));
      if (!c) continue;
      // A listing holds every copy in the directory, including ones of
      // files that are NOT members: those are the index branch's (ordinary
      // files) or deliberately out of reach (a dot-file nobody opted into).
      if (!members.has(c.basePath)) continue;
      out.push(c);
    }
  }
  return out;
}
