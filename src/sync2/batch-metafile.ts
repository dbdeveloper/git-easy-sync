// Batch metafile — the SINGLE carrier of a batch's content list in
// the new format (SYNC2-FIX §12.1 + MASTER-PLAN §2.1, revised: batch
// DIRECTORIES stay, `vault/` and `deleted-paths.txt` go away).
//
// This tiny module is the shared TYPE both sides import: the commit
// side (PushQueue writer, Phase 2 group B) and the drain side
// (getBatch reader, this phase). Defining it once keeps the on-disk
// contract from forking.
//
// Layout after the format switch:
//   <configDir>/plugins/<self>/.runtime/push-queue/
//     <batchid>/
//       .meta.json         ← BatchMetafile below (THE only content list)
//       .attempted         ← R3b drain-claim marker (§II.8)
//       .attempted-commit  ← R3b commit-claim marker (§II.8)
//   bytes live in .runtime/sync_store/{sha} (metadata is written
//   BEFORE blobs — §12.4).

export const QUEUE_DIRNAME = ".runtime/push-queue";
export const BATCH_META_FILE = ".meta.json";
export const ATTEMPTED_MARKER = ".attempted";
export const ATTEMPTED_COMMIT_MARKER = ".attempted-commit";

// One path per batch (§7.3: the metafile is an ARRAY, so the old
// implicit fs-key dedup is gone — the writer must dedupe by path
// explicitly). `sha === null` IS the deletion sentinel — the same
// convention the GitHub tree API and TreeBuilder already use for
// deletions, so no second mechanism (`deleted-paths.txt`) exists.
export interface BatchEntry {
  path: string;
  sha: string | null;
  size: number | null;
  // Local mtime at commit time — the new drain's `local.mtime`
  // (§7.2: losing this on consolidation silently handed .obsidian/
  // tie-breaks to remote; the writer must carry it through merges).
  mtime: number | null;
}

export interface BatchMetafile {
  v: 1;
  id: string;
  createdAt: number;
  entries: BatchEntry[];
}

// Strict on structure (a batch with a malformed skeleton is
// "metafile incomplete" → CRASH_RECOVERY discards the dir), tolerant
// on unknown fields (forward-compat, same rule as the hot slots).
// Malformed individual entries disqualify the whole file — a partial
// content list is exactly the torn state the check exists to catch.
export function parseBatchMetafile(raw: string): BatchMetafile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.id !== "string" || typeof o.createdAt !== "number") return null;
  if (!Array.isArray(o.entries)) return null;
  const entries: BatchEntry[] = [];
  for (const e of o.entries) {
    if (typeof e !== "object" || e === null) return null;
    const r = e as Record<string, unknown>;
    if (typeof r.path !== "string") return null;
    const sha = r.sha === null ? null : r.sha;
    if (sha !== null && typeof sha !== "string") return null;
    const size = r.size === null ? null : r.size;
    if (size !== null && typeof size !== "number") return null;
    const mtime = r.mtime === null ? null : r.mtime;
    if (mtime !== null && typeof mtime !== "number") return null;
    entries.push({ path: r.path, sha, size, mtime });
  }
  return { v: 1, id: o.id, createdAt: o.createdAt, entries };
}
