// BatchHistorySource (Phase 5.5 step 3c) — the History timeline's
// local-versions reader over the NEW queue format (meta.json + blobs
// in the content-addressed sync_store). Implements diff2's
// QueueVersionSource contract (history-versions.ts: list/read) plus
// the byte fetch for opening a local version.
//
// NOT WIRED YET: main.ts still serves History from the old PushQueue
// (the live queue stays on the old format until THE SWITCH). Wiring
// this in earlier would kill local history for the interim for no
// gain; the swap happens in the same commit that flips commitOnly to
// BatchWriter.
//
// Read-only by design — it never claims, repairs, or removes batch
// dirs (that is BatchClaimer's job under R3b). A torn/incomplete
// metafile simply contributes no versions: repair belongs to the
// claimer, History must not race it.

import { normalizePath, type Vault } from "obsidian";
import {
  BATCH_META_FILE,
  QUEUE_DIRNAME,
  parseBatchMetafile,
} from "./batch-metafile";
import type SyncStore from "./sync-store";

export default class BatchHistorySource {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly syncStore: SyncStore;
  // Per-instance verified-sha scope (same ownership rule as the
  // drain's: the scope belongs to the caller/instance, never the
  // module).
  private readonly verifiedShas = new Set<string>();

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    syncStore: SyncStore;
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.syncStore = deps.syncStore;
  }

  private queueRoot(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/${QUEUE_DIRNAME}`,
    );
  }

  // Batch ids, oldest-first (ids are timestamp-ids — lexicographic
  // order IS chronological order; mergeVersionList re-sorts by date
  // anyway).
  async list(): Promise<string[]> {
    const root = this.queueRoot();
    if (!(await this.vault.adapter.exists(root))) return [];
    const listing = await this.vault.adapter.list(root);
    return listing.folders
      .map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      })
      .sort();
  }

  // QueueVersionSource.read — the timeline row's data. `files` lists
  // only CONTENT entries (a deletion entry, sha null, has no bytes to
  // open — it is not a "version of the file" History can show).
  // A torn/missing metafile reads as an empty batch, deliberately.
  async read(
    id: string,
  ): Promise<{ id: string; createdAt: number; files: string[] }> {
    const meta = await this.readMeta(id);
    if (meta === null) return { id, createdAt: 0, files: [] };
    return {
      id,
      createdAt: meta.createdAt,
      files: meta.entries
        .filter((e) => e.sha !== null)
        .map((e) => e.path),
    };
  }

  // Bytes of `path` as batch `id` snapshotted them — from the
  // content-addressed store, hash-verified on read. Throws on any
  // miss: the caller (History open) surfaces the error; a silent null
  // would render an empty version as if the user saved one.
  async readFileBytes(id: string, path: string): Promise<ArrayBuffer> {
    const meta = await this.readMeta(id);
    const entry = meta?.entries.find((e) => e.path === path) ?? null;
    if (entry === null || entry.sha === null) {
      throw new Error(
        `BatchHistorySource: batch ${id} holds no content for ${path}`,
      );
    }
    const bytes = await this.syncStore.getBlobFromSyncStore(
      entry.sha,
      this.verifiedShas,
    );
    if (bytes === null) {
      throw new Error(
        `BatchHistorySource: blob ${entry.sha} for ${path} missing from sync_store`,
      );
    }
    this.verifiedShas.add(entry.sha);
    return bytes;
  }

  private async readMeta(
    id: string,
  ): Promise<ReturnType<typeof parseBatchMetafile>> {
    const p = normalizePath(`${this.queueRoot()}/${id}/${BATCH_META_FILE}`);
    if (!(await this.vault.adapter.exists(p))) return null;
    try {
      return parseBatchMetafile(await this.vault.adapter.read(p));
    } catch {
      return null;
    }
  }
}
