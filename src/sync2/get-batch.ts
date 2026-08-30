// getBatch() — the drain-side batch claim, implementing R3b
// (NEW-DRAIN §II.8; the protocol was DECIDED in SYNC2-FIX §6 — this
// implements it, it does not reinvent it).
//
// push_queue/ is shared between commit (appends batches at the tail)
// and drain (claims the oldest from the head). The two-flag
// Peterson-style mutex: `.attempted-commit` is the commit side's
// claim (consolidation in progress), `.attempted` is the drain's.
// The drain sets ITS flag BEFORE the decisive re-check, so the
// TOCTOU window (commit claiming between the first check and the
// mark) resolves by waiting, never by both proceeding.
//
// Waiting is deliberate, not skipping: skipping a non-empty older
// dir would break FIFO and with it I1.
//
// CRASH_RECOVERY (a `.attempted-commit` left by a crashed commit):
// - metafile incomplete → nothing in the dir can be trusted; the dir
//   is discarded LOUDLY (log) and the next batch is claimed. The
//   discarded changes are not lost silently: they still live in the
//   vault, and the next commit-detection re-emits them (§12.6's
//   "repair impossible ⟺ detection must fire" equivalence).
// - metafile complete → per-entry repair: a blob missing from
//   sync_store is re-copied from the LIVE vault when size-then-SHA
//   still matches (§12.9 order: stat is cheap, hashing is not — a
//   size mismatch already proves repair impossible, no hash needed);
//   an unrepairable entry is dropped from the batch (metafile
//   rewritten), the rest proceeds. A batch whose every entry dropped
//   is returned empty — the caller skips it (§11 П11).

import { normalizePath, type Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import SyncStore from "./sync-store";
import {
  ATTEMPTED_COMMIT_MARKER,
  ATTEMPTED_MARKER,
  BATCH_META_FILE,
  BatchMetafile,
  parseBatchMetafile,
  QUEUE_DIRNAME,
} from "./batch-metafile";

export interface GetBatchLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface GetBatchDeps {
  vault: Vault;
  selfPluginId: string;
  syncStore: SyncStore;
  logger?: GetBatchLogger;
  // Peterson-wait tuning — injectable so tests never sleep real time.
  pollMs?: number; // default 300 (§II.8)
  warnAfterMs?: number; // default 5000 — "commit can't be this long"
  giveUpAfterMs?: number; // default 30000 — return null, drain retries next run
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ClaimedBatch {
  id: string;
  dir: string;
  meta: BatchMetafile;
}

export default class BatchClaimer {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly syncStore: SyncStore;
  private readonly logger: GetBatchLogger | undefined;
  private readonly pollMs: number;
  private readonly warnAfterMs: number;
  private readonly giveUpAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: GetBatchDeps) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.syncStore = deps.syncStore;
    this.logger = deps.logger;
    this.pollMs = deps.pollMs ?? 300;
    this.warnAfterMs = deps.warnAfterMs ?? 5000;
    this.giveUpAfterMs = deps.giveUpAfterMs ?? 30_000;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  private queueRoot(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/${QUEUE_DIRNAME}`,
    );
  }

  // Oldest batch dir (FIFO): batch ids are timestamp-ids, so
  // lexicographic order IS chronological order.
  private async oldestBatchDir(): Promise<string | null> {
    const root = this.queueRoot();
    if (!(await this.vault.adapter.exists(root))) return null;
    const listing = await this.vault.adapter.list(root);
    const ids = listing.folders
      .map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      })
      .sort();
    return ids.length === 0 ? null : normalizePath(`${root}/${ids[0]}`);
  }

  // Poll until the commit-side marker disappears. Warns once past
  // warnAfterMs (a healthy consolidation is milliseconds — a long
  // hold smells like a crashed commit, which onload recovery and the
  // corrupted-metafile branch below both handle). Gives up past
  // giveUpAfterMs → false (caller returns null; the next drain
  // retries).
  private async waitForCommitMarker(dir: string): Promise<boolean> {
    const marker = `${dir}/${ATTEMPTED_COMMIT_MARKER}`;
    const started = this.now();
    let warned = false;
    while (await this.vault.adapter.exists(marker)) {
      const elapsed = this.now() - started;
      if (!warned && elapsed >= this.warnAfterMs) {
        warned = true;
        this.logger?.warn(
          "getBatch: commit-side claim held suspiciously long",
          { dir, elapsedMs: elapsed },
        );
      }
      if (elapsed >= this.giveUpAfterMs) return false;
      await this.sleep(this.pollMs);
    }
    return true;
  }

  async getBatch(): Promise<ClaimedBatch | null> {
    const dir = await this.oldestBatchDir();
    if (dir === null) return null;

    // Commit is consolidating into this dir right now — wait, don't
    // skip (FIFO / I1).
    if (
      (await this.vault.adapter.exists(
        `${dir}/${ATTEMPTED_COMMIT_MARKER}`,
      )) &&
      !(await this.waitForCommitMarker(dir))
    ) {
      return null;
    }

    // Our claim BEFORE the decisive check (Peterson).
    await this.vault.adapter.write(`${dir}/${ATTEMPTED_MARKER}`, "");

    // TOCTOU window: commit claimed between our first check and
    // markAttempted → both flags up → we wait for commit to finish
    // (consolidate-and-release, or back off to a NEW dir and release).
    if (
      (await this.vault.adapter.exists(
        `${dir}/${ATTEMPTED_COMMIT_MARKER}`,
      )) &&
      !(await this.waitForCommitMarker(dir))
    ) {
      return null;
    }

    // Safe to read — commit either never touched this dir or has
    // finished with it.
    const metaPath = `${dir}/${BATCH_META_FILE}`;
    const rawMeta = (await this.vault.adapter.exists(metaPath))
      ? await this.vault.adapter.read(metaPath)
      : null;
    const meta = rawMeta === null ? null : parseBatchMetafile(rawMeta);
    if (meta === null) {
      return this.crashRecovery(dir);
    }
    return { id: meta.id, dir, meta };
  }

  // Onload-time sweep (§II.8: "Recovery на старті плагіна вже це
  // лагодить"): a `.attempted-commit` still standing at plugin start
  // can only be a crashed commit's leftover — no live commit exists
  // yet. Repair (or discard) each such dir so getBatch's in-run wait
  // never faces a marker that will never clear.
  async recoverStaleCommitClaims(): Promise<void> {
    const root = this.queueRoot();
    if (!(await this.vault.adapter.exists(root))) return;
    const listing = await this.vault.adapter.list(root);
    for (const folder of listing.folders) {
      const dir = normalizePath(folder);
      if (
        await this.vault.adapter.exists(`${dir}/${ATTEMPTED_COMMIT_MARKER}`)
      ) {
        await this.repairDir(dir);
      }
    }
  }

  private async crashRecovery(dir: string): Promise<ClaimedBatch | null> {
    const outcome = await this.repairDir(dir);
    if (outcome === null) {
      return this.getBatch(); // dir discarded → next dir, or null
    }
    return { id: outcome.id, dir, meta: outcome };
  }

  // Discard-or-repair one batch dir. Returns the (possibly reduced)
  // metafile, or null when the dir was discarded. Always leaves the
  // dir without a `.attempted-commit` marker.
  private async repairDir(dir: string): Promise<BatchMetafile | null> {
    const metaPath = `${dir}/${BATCH_META_FILE}`;
    const rawMeta = (await this.vault.adapter.exists(metaPath))
      ? await this.vault.adapter.read(metaPath)
      : null;
    const meta = rawMeta === null ? null : parseBatchMetafile(rawMeta);

    if (meta === null) {
      // Metafile never finished — no content in the dir can be
      // trusted; the consolidation wasn't atomic. LOUD discard: the
      // changes still live in the vault and the next detection
      // re-emits them (§12.6 equivalence) — not a silent loss.
      this.logger?.warn(
        "getBatch CRASH_RECOVERY: incomplete metafile — discarding batch dir; " +
          "the vault still holds the content and the next commit re-detects it",
        { dir },
      );
      await this.vault.adapter.rmdir(dir, true);
      return null;
    }

    // Metafile complete → per-entry repair.
    const kept = [...meta.entries];
    for (const entry of meta.entries) {
      if (entry.sha === null) continue; // deletion entry — no blob to check
      if (await this.syncStore.existInSyncStore(entry.sha)) continue;

      // Try to repair from the LIVE vault. Size-before-SHA (§12.9):
      // a size mismatch already proves repair impossible — don't hash.
      const stat = await this.vault.adapter.stat(entry.path);
      let repaired = false;
      if (stat && (entry.size === null || stat.size === entry.size)) {
        const bytes = await this.vault.adapter.readBinary(entry.path);
        const sha = await calculateGitBlobSHA(bytes);
        if (sha === entry.sha) {
          await this.syncStore.saveBlobToSyncStore(sha, bytes);
          repaired = true;
        }
      }
      if (!repaired) {
        // Changed or gone since — repair impossible; the next
        // detection cycle picks the CURRENT state up by itself.
        this.logger?.warn(
          "getBatch CRASH_RECOVERY: entry unrepairable — dropped from batch",
          { dir, path: entry.path },
        );
        kept.splice(
          kept.findIndex((e) => e.path === entry.path),
          1,
        );
      }
    }
    const repairedMeta: BatchMetafile = { ...meta, entries: kept };
    if (kept.length !== meta.entries.length) {
      await this.vault.adapter.write(
        metaPath,
        JSON.stringify(repairedMeta),
      );
    }

    const commitMarker = `${dir}/${ATTEMPTED_COMMIT_MARKER}`;
    if (await this.vault.adapter.exists(commitMarker)) {
      await this.vault.adapter.remove(commitMarker);
    }
    // May be empty if every entry dropped — the claiming caller skips
    // it (§11 П11 empty-batch skip).
    return repairedMeta;
  }
}
