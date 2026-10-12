// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// "Is this conflict still in force?" — the owner's rule (2026-10-11).
//
// conflicts.json is the DRAIN's ledger: only the drain changes it. The file
// system is the ground truth of what the user has done since. Everyone else
// reads both and writes neither — and this is the one place they read the
// combination through:
//
//   a tracked conflict is IN FORCE while at least one of its tracked copies
//   exists on disk AND differs from the base file.
//
// A copy that is gone (deleted, renamed onto the base) or byte-equal to the
// base no longer holds the conflict; the next drain prunes it. Base deleted
// while a copy exists: still in force. Synthetic copies never hold a
// tracked conflict.
//
// Cheap by construction: a copy of another size than the base is decided by
// stat alone; a copy whose size+mtime still match its record uses the
// record's sha (the content cache the drain keeps); only an edited copy of
// the base's size is read and hashed — and so is the base, once. RAW bytes
// throughout, exactly like the drain's reconcile (rule 2.3), which asks
// copyMatchesBase too: the commit pass and the drain can never disagree.
//
// READ-ONLY: nothing here writes a record or a file.

import { buildSiblingFilePath } from "./conflict-siblings";
import { FileInfo } from "./diff3";

export interface ConflictLiveDeps {
  adapter: {
    stat(path: string): Promise<{ size: number; mtime: number } | null>;
    readBinary(path: string): Promise<ArrayBuffer>;
  };
  computeSha(bytes: ArrayBuffer): Promise<string>;
}

// The base file, measured lazily: its sha is computed at most once, and only
// if some copy has its size.
export interface BaseFacts {
  size: number | null; // null = the base file does not exist
  sha(): Promise<string>;
}

export async function baseFacts(deps: ConflictLiveDeps, basePath: string): Promise<BaseFacts> {
  const st = await deps.adapter.stat(basePath);
  let memo: string | null = null;
  return {
    size: st === null ? null : st.size,
    sha: async () => {
      memo ??= await deps.computeSha(await deps.adapter.readBinary(basePath));
      return memo;
    },
  };
}

// One tracked copy against the base: "gone", or whether it is byte-equal.
export async function copyMatchesBase(
  deps: ConflictLiveDeps,
  basePath: string,
  copy: FileInfo,
  base: BaseFacts,
): Promise<"gone" | boolean> {
  const copyPath = buildSiblingFilePath(basePath, copy.timeLabel ?? 0, copy.deviceLabel);
  const st = await deps.adapter.stat(copyPath);
  if (st === null) return "gone";
  if (base.size === null || st.size !== base.size) return false;
  const copySha =
    copy.sha !== null && copy.size === st.size && copy.mtime === st.mtime
      ? copy.sha
      : await deps.computeSha(await deps.adapter.readBinary(copyPath));
  return copySha === (await base.sha());
}

export async function isConflictInForce(
  deps: ConflictLiveDeps,
  basePath: string,
  trackedCopies: FileInfo[],
): Promise<boolean> {
  const base = await baseFacts(deps, basePath);
  for (const copy of trackedCopies) {
    if ((await copyMatchesBase(deps, basePath, copy, base)) === false) return true;
  }
  return false;
}

// The commit pass's reference for a file that HAS a conflict record: its
// conflict-branch version (conflictBase.sha; null = the branch records a
// deletion) while the conflict is in force; undefined once it is not —
// then the file is compared with its baseline like any other, so a
// resolution made through the file system is committed, and reaches main,
// in the SAME sync (owner, 2026-10-11 — the double-sync defect).
//
// A record whose siblings list is still EMPTY (STEP1 ran, the copy is not
// written yet — a drain-internal transient that a crash can persist) stays
// in force: there is no copy to judge by, and dropping the filter there
// would re-commit our version to main mid-conflict.
export function conflictBaseShaWhileInForce(
  store: {
    getCachedState(): {
      entries: Map<string, { conflictBase: FileInfo; siblings: FileInfo[] }>;
    };
  },
  deps: ConflictLiveDeps,
): (path: string) => Promise<string | null | undefined> {
  return async (path) => {
    const entry = store.getCachedState().entries.get(path);
    if (entry === undefined) return undefined;
    if (entry.siblings.length > 0 && !(await isConflictInForce(deps, path, entry.siblings))) {
      return undefined;
    }
    return entry.conflictBase.sha;
  };
}
