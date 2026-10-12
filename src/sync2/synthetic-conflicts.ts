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
import { buildConflictModel, type SyntheticCopy } from "./conflict-model";
import { calculateGitBlobSHA } from "../utils";
import { baseFacts, copyAtPathMatchesBase } from "./conflict-live";
import { SYNC_BAK_SUFFIX, SYNC_TMP_SUFFIX } from "./atomic-write";

export interface DotSpaceScope {
  configDir: string;
  syncConfigDir: () => boolean;
}

// The copy at `path`, if it is an UNTRACKED copy's name; null otherwise.
function syntheticAt(store: ConflictStoreV2, path: string): SyntheticCopy | null {
  // A staging file of an atomic write (`…Z.ges-tmp.md`) also fits the name
  // pattern; it belongs to the crash recovery, never to us.
  if (path.includes(SYNC_TMP_SUFFIX) || path.includes(SYNC_BAK_SUFFIX)) return null;
  const parsed = parseSiblingFilename(path);
  if (!parsed) return null;
  if (store.isTrackedCopy(path)) return null; // tracked — the ledger's
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

// THE cleanup of synthetic copies (owner, 2026-10-12). The drain is about
// tracked conflicts and touches a synthetic copy only next to a tracked one;
// everywhere else a synthetic copy with nothing left to say is removed here:
//   - equal to its file  → the conflict is resolved;
//   - a duplicate        → the same bytes as a copy that stays (tracked beats
//                          synthetic, then the newer).
// The verdicts are the conflict model's, so the panel, the badge and this
// agree. A TRACKED copy is never touched — the drain prunes those together
// with their ledger records. Copies are never synced (*.conflict-from-*), so a
// removal stays on this device.
//
// Run when the Diff Panel opens, on Ctrl/Cmd+R in the panel and once at
// plugin start — alongside the drain, never waiting for it. Two properties
// make that safe for tracked conflicts (owner + advisor, 2026-10-12):
//   (A) no content loss — at the moment of removal the bytes are proven to
//       exist elsewhere: the verdict is RE-CHECKED against the disk right
//       before removing (the file or the surviving twin may have changed
//       since the model was built), and which twin survives is one total
//       order shared with the drain (survivorOf);
//   (B) no structural damage — the tracked check and the removal are one
//       step (ConflictStoreV2.removeIfUntracked), the drain announces every
//       copy before writing it, and a drain writing a copy at a name being
//       removed waits for the removal first.
export interface CleanSyntheticDeps {
  vault: Vault;
  store: ConflictStoreV2;
  scope: DotSpaceScope;
  computeSha?: (bytes: ArrayBuffer) => Promise<string>;
  logger?: { info(message: string, data?: unknown): void };
  now?: () => number;
}

export async function cleanSyntheticConflicts(
  deps: CleanSyntheticDeps,
): Promise<{ survivors: SyntheticCopy[]; removed: string[] }> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const found = new Map<string, SyntheticCopy>();
  for (const c of syntheticCopiesFromIndex(deps.vault, deps.store)) found.set(c.path, c);
  for (const c of await syntheticCopiesFromDotSpace(deps.vault, deps.store, deps.scope)) {
    found.set(c.path, c);
  }
  const copies = [...found.values()];

  const computeSha = deps.computeSha ?? calculateGitBlobSHA;
  const model = await buildConflictModel(
    { adapter: deps.vault.adapter as never, computeSha },
    deps.store.getCachedState(),
    copies,
  );
  const liveDeps = { adapter: deps.vault.adapter as never, computeSha };
  const shaOf = async (p: string): Promise<string | null> => {
    try {
      return await computeSha(await deps.vault.adapter.readBinary(p));
    } catch {
      return null; // gone meanwhile
    }
  };
  const removed: string[] = [];
  for (const entry of model.entries.values()) {
    for (const c of entry.copies) {
      if (c.kind !== "synthetic") continue;
      if (c.state !== "equals-base" && c.state !== "duplicate") continue;
      // (A) re-check the verdict against the disk as it is NOW.
      if (c.state === "equals-base") {
        const base = await baseFacts(liveDeps, entry.basePath);
        if ((await copyAtPathMatchesBase(liveDeps, c.path, base, null)) !== true) continue;
      } else {
        const mine = await shaOf(c.path);
        if (mine === null || c.duplicateOf === undefined || mine !== (await shaOf(c.duplicateOf))) continue;
      }
      // (B) the tracked check and the removal in one step.
      let gone = false;
      const done = await deps.store.removeIfUntracked(c.path, async () => {
        try {
          await deps.vault.adapter.remove(c.path);
          gone = true;
        } catch {
          // Removed by someone else meanwhile ([←]) — nothing to do.
        }
      });
      if (!done || !gone) continue;
      if (c.state === "equals-base") {
        deps.logger?.info("Conflict copy removed: identical to the file — the conflict is resolved", {
          path: entry.basePath,
          copy: c.path,
        });
      } else {
        deps.logger?.info("Conflict copy removed: identical to another copy", {
          path: entry.basePath,
          copy: c.path,
          kept: c.duplicateOf,
        });
      }
      removed.push(c.path);
    }
  }
  deps.logger?.info("Looked for leftover conflict copies", {
    found: copies.length,
    removed: removed.length,
    ms: now() - started,
  });
  const gone = new Set(removed);
  return { survivors: copies.filter((c) => !gone.has(c.path)), removed };
}
