// Small disk-level helpers used by TrashStore. Each one is trivial and
// could live inline, but they recur enough that a named helper keeps
// the algorithm bodies readable.
//
// Canonical specs: docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.8 (helpers).

import { DataAdapter } from "obsidian";
import { safeRename } from "../sync2/cross-platform";

// Atomic write of a JSON-serializable object. Writes to a temp sibling
// first, then safeRename to the final path. On any failure mid-write,
// the temp file is the artifact left on disk; the final path stays at
// its previous (or absent) state. Caller may scan for orphan ".tmp"
// files at startup if needed; TrashStore doesn't (orphan temps are
// inert and a future write will safeRename over them anyway via
// cross-platform's exists-then-remove guard).
//
// Compare to PSEUDO-MERGE-MODE.md §9.4 Path B: that protocol uses .ges-tmp
// because the staged bytes have meaningful integrity-witness behavior
// (the conflict record's theirsBlobSha lets recovery promote the temp
// to its final form). meta.json files don't have that property — a
// half-written meta is just garbage — so the simpler temp+rename here
// is correct.
export async function atomicWriteJson(
  adapter: DataAdapter,
  path: string,
  obj: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  await adapter.write(tmp, JSON.stringify(obj));
  await safeRename(adapter, tmp, path);
}

// Read+parse a JSON file. Returns null when the file is absent OR the
// content fails to parse OR the read throws — every "I can't get a
// valid object out of this path" outcome collapses to the same null.
// Callers treat null as "treat this record as missing"; the recovery
// sweep (R8.1) is the only thing that further classifies what to do
// (orphan dir → wipe, etc).
export async function tryReadMetaJson<T>(
  adapter: DataAdapter,
  path: string,
): Promise<T | null> {
  try {
    if (!(await adapter.exists(path))) return null;
    const raw = await adapter.read(path);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Recursive directory removal. adapter.rmdir signatures vary across
// adapter implementations and platforms: most accept a recursive flag,
// some require explicit walk. We try the adapter's native recursive
// path first; if that fails (or the flag is ignored), fall back to a
// manual depth-first walk.
//
// Idempotent on already-absent dirs.
export async function rmrf(
  adapter: DataAdapter,
  dirPath: string,
): Promise<void> {
  if (!(await adapter.exists(dirPath))) return;
  try {
    await adapter.rmdir(dirPath, true);
    if (!(await adapter.exists(dirPath))) return;
  } catch {
    // fall through to manual walk
  }
  // Manual walk — list + recurse files + recurse subfolders + rmdir self.
  const { files, folders } = await adapter.list(dirPath);
  for (const f of files) await adapter.remove(f);
  for (const sub of folders) await rmrf(adapter, sub);
  await adapter.rmdir(dirPath, false);
}

// Ensure all parent directories of `filePath` exist, building them
// segment-by-segment so the operation works on mobile adapters whose
// mkdir is non-recursive. Mirrors push-queue.ts::ensureParentDir but
// exported for reuse. No-op when filePath has no parent (root-level).
export async function ensureParentDirs(
  adapter: DataAdapter,
  filePath: string,
): Promise<void> {
  const slash = filePath.lastIndexOf("/");
  if (slash <= 0) return;
  const parent = filePath.substring(0, slash);
  if (await adapter.exists(parent)) return;
  const parts = parent.split("/");
  let acc = "";
  for (const part of parts) {
    acc = acc === "" ? part : `${acc}/${part}`;
    if (!(await adapter.exists(acc))) {
      await adapter.mkdir(acc);
    }
  }
}
