// Queue-sha index (Phase 5.5 S1) — the findChanges dedup reference
// over the NEW queue format (SYNC2-FIX §12.7 / TODO §40 lineage:
// "changed since the LAST COMMITTED version?", newest batch wins).
// Replaces the old PushQueue.peekLatestPathSha at THE SWITCH; the
// detector's structural dep ({peekLatestPathSha}) is served by ONE
// index built per commit-pass (metafiles are read once, not per
// path).
//
// ⚠️ DELETION-ENTRY CONTRACT (the §40 revert class, pinned by test):
// a deletion entry (sha:null in the metafile) answers with the
// DELETED_SHA_HASH sentinel — DISTINCT from "no queued entry" (null).
// If it answered null, the detector would fall back to baselineSha,
// and a queued-delete followed by re-creating the file with baseline
// content would dedup as "unchanged" — the re-creation silently
// dropped. With the sentinel the current sha never equals it, so the
// detector emits.
//
// Torn/incomplete metafiles contribute nothing (repair belongs to the
// claimer, same read-only rule as BatchHistorySource).

import { normalizePath, type Vault } from "obsidian";
import {
  BATCH_META_FILE,
  QUEUE_DIRNAME,
  parseBatchMetafile,
} from "./batch-metafile";
import { DELETED_SHA_HASH } from "./discovery";

export interface QueueShaIndex {
  peekLatestPathSha(path: string): Promise<string | null>;
}

export async function buildQueueShaIndex(
  vault: Vault,
  selfPluginId: string,
): Promise<QueueShaIndex> {
  const root = normalizePath(
    `${vault.configDir}/plugins/${selfPluginId}/${QUEUE_DIRNAME}`,
  );
  const latest = new Map<string, string>();
  if (await vault.adapter.exists(root)) {
    const listing = await vault.adapter.list(root);
    const ids = listing.folders
      .map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      })
      .sort(); // timestamp-ids: lexicographic == chronological
    for (const id of ids) {
      // Oldest→newest: a later batch's entry OVERWRITES an earlier
      // one — "latest" by construction.
      const p = normalizePath(`${root}/${id}/${BATCH_META_FILE}`);
      if (!(await vault.adapter.exists(p))) continue;
      let meta;
      try {
        meta = parseBatchMetafile(await vault.adapter.read(p));
      } catch {
        continue;
      }
      if (meta === null) continue;
      for (const e of meta.entries) {
        latest.set(e.path, e.sha ?? DELETED_SHA_HASH);
      }
    }
  }
  return {
    peekLatestPathSha: async (path) => latest.get(path) ?? null,
  };
}
