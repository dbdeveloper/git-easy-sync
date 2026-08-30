// BatchWriter — the COMMIT side of the new batch format (Phase 2
// group B, MASTER-PLAN §2.1/§2.2). Counterpart of BatchClaimer
// (get-batch.ts): the writer appends new-format batches to the queue
// tail, the claimer takes them from the head. The old engine's
// PushQueue is deliberately NOT adapted (owner decision, §2.2 п.1) —
// the live path switches to this writer once, at the Phase 4 cutover.
//
// On-disk shape it produces (batch-metafile.ts):
//   .runtime/push-queue/<batchid>/
//     meta.json          ← BatchMetafile v1 — THE only content list
//     .attempted-commit  ← commit's claim, held for the whole write
//   bytes → .runtime/sync_store/{sha}
//
// Write order is §12.4 — metadata BEFORE blobs — a correctness
// condition, not style: the sweep can never reap a blob whose
// reference already exists, and crash recovery always has the
// manifest of what should have been written. The price: each file is
// read TWICE (hash pass, then blob pass) so peak memory stays one
// file's bytes, never the whole batch.
//
// R3b commit-side protocol (SYNC2-FIX §6):
// - a NEW dir gets `.attempted-commit` immediately on creation and
//   drops it only after the last blob — the claimer waits on the
//   marker instead of reading a half-written dir;
// - consolidation touches ONLY the tail dir, claims it with
//   `.attempted-commit` FIRST, then checks the drain's `.attempted`:
//   present → back off (caller appends a new batch instead), absent →
//   merge and release. Commit never blocks and never writes to a dir
//   the drain is processing.
// ⚠️ Residual TOCTOU (documented, accepted): between mkdir and the
// marker write there is one await-gap where a concurrently running
// getBatch() on an otherwise-empty queue could discard the embryonic
// dir as an incomplete crash leftover. The §12.6 equivalence bounds
// the damage — the vault still holds the content and the next
// detection re-emits it (loud logs on both sides).
//
// Two defects of the old queue are impossible here by construction,
// with tests pinning them:
// - §7.3: the metafile is an array, so consolidation dedupes by
//   `path` EXPLICITLY (the old code leaned on the filesystem
//   overwriting same-named snapshot files);
// - §7.2: consolidation updates `mtime` for every path it touches
//   (the old mergeIntoLatestPending silently kept enqueue-time
//   mtimes, handing .obsidian/ tie-breaks to remote).

import { normalizePath, type Vault } from "obsidian";
import WorkerClient from "../worker/worker-client";
import SyncStore from "./sync-store";
import { normalizeText, shouldCanonicalize } from "./text-normalize";
import { newBatchId, parseTimestampId } from "./timestamp-id";
import { FileChange } from "./types";
import {
  ATTEMPTED_COMMIT_MARKER,
  ATTEMPTED_MARKER,
  BATCH_META_FILE,
  BatchEntry,
  BatchMetafile,
  parseBatchMetafile,
  QUEUE_DIRNAME,
} from "./batch-metafile";

// Owner decision 2026-08-30: `[commit]` slices changes into batches of
// at most 100 paths. Consolidation honours the same cap — a merge that
// would grow the tail past it BACKS OFF (returns null) and the caller
// appends a fresh batch instead ("Consolidate commits" must still
// split once the rolling commit reaches the split size). Same-path
// replacements don't grow the count — only genuinely new paths do.
export const MAX_BATCH_ENTRIES = 100;

export interface BatchWriterLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

export interface BatchWriterDeps {
  vault: Vault;
  selfPluginId: string;
  syncStore: SyncStore;
  logger?: BatchWriterLogger;
  // Same contract as PushQueue: when the toggle is off, text files
  // are stored byte-exact — no CRLF/BOM rewrite. Default on.
  autoCanonicalize?: () => boolean;
  // Shared worker orchestra; when omitted a fallback-mode client
  // hashes inline on the main thread (tests).
  workerClient?: WorkerClient;
  // Clock override for deterministic batch ids in tests.
  now?: () => Date;
}

export default class BatchWriter {
  private readonly vault: Vault;
  private readonly syncStore: SyncStore;
  private readonly logger: BatchWriterLogger | undefined;
  private readonly autoCanonicalize: () => boolean;
  private readonly workerClient: WorkerClient;
  private readonly now: () => Date;

  constructor(deps: BatchWriterDeps) {
    this.vault = deps.vault;
    this.syncStore = deps.syncStore;
    this.logger = deps.logger;
    this.autoCanonicalize = deps.autoCanonicalize ?? (() => true);
    this.workerClient = deps.workerClient ?? new WorkerClient();
    this.now = deps.now ?? (() => new Date());
    this.queueRoot = normalizePath(
      `${deps.vault.configDir}/plugins/${deps.selfPluginId}/${QUEUE_DIRNAME}`,
    );
  }

  private readonly queueRoot: string;

  // Append a NEW batch for `changes`. Returns the batch id, or null
  // when `changes` is empty (nothing to write — no empty dirs).
  async writeBatch(changes: FileChange[]): Promise<string | null> {
    if (changes.length === 0) return null;
    await this.ensureDir(this.queueRoot);
    const id = await this.allocateUniqueId();
    const dir = `${this.queueRoot}/${id}`;
    await this.vault.adapter.mkdir(dir);
    // Claim BEFORE any content lands (R3b step 5) — from here on the
    // claimer waits instead of reading a half-written dir.
    await this.vault.adapter.write(`${dir}/${ATTEMPTED_COMMIT_MARKER}`, "");

    const entries = await this.buildEntries(changes);
    const meta: BatchMetafile = {
      v: 1,
      id,
      // Same injected clock as the id — createdAt feeds the commit
      // message timestamp in Phase 4, so it must be deterministic in
      // tests too.
      createdAt: this.now().getTime(),
      entries,
    };
    // §12.4: the complete manifest FIRST…
    await this.vault.adapter.write(
      `${dir}/${BATCH_META_FILE}`,
      JSON.stringify(meta),
    );
    // …then the bytes.
    await this.writeBlobs(dir, meta);

    await this.vault.adapter.remove(`${dir}/${ATTEMPTED_COMMIT_MARKER}`);
    return id;
  }

  // Fold `changes` into the TAIL batch (offline-accumulate: a streak
  // of commits while disconnected coalesces into one). Returns the
  // tail id, or null when the caller must append a new batch instead:
  // queue empty, tail claimed by the drain (`.attempted`), tail
  // vanished mid-claim, or tail's metafile unreadable (left for the
  // claimer's crash recovery — the writer never repairs).
  //
  // ONLY the tail dir is ever considered (R3b: "commit консолідує
  // лише в незаclaim-ований ОСТАННІЙ каталог"). The old backward walk
  // past claimed batches is gone: commit claims only the tail, drain
  // only the head — they can collide only at queue length 1.
  async consolidateIntoTail(changes: FileChange[]): Promise<string | null> {
    if (changes.length === 0) return null;
    const tailDir = await this.tailBatchDir();
    if (tailDir === null) return null;

    const marker = `${tailDir}/${ATTEMPTED_COMMIT_MARKER}`;
    try {
      // Our claim FIRST, decisive check second (Peterson).
      await this.vault.adapter.write(marker, "");
    } catch {
      // Tail vanished between list and claim (drain finished it and
      // rmdir-ed) — back off to a fresh batch.
      return null;
    }
    if (await this.vault.adapter.exists(`${tailDir}/${ATTEMPTED_MARKER}`)) {
      // Drain claimed it — commit NEVER writes to a dir the drain is
      // processing. Release and append instead.
      await this.removeIfExists(marker);
      return null;
    }

    const metaPath = `${tailDir}/${BATCH_META_FILE}`;
    const raw = (await this.vault.adapter.exists(metaPath))
      ? await this.vault.adapter.read(metaPath)
      : null;
    const meta = raw === null ? null : parseBatchMetafile(raw);
    if (meta === null) {
      // Torn leftover of a crashed commit. Repair belongs to the
      // claimer (getBatch / onload sweep), not the writer — release
      // WITHOUT removing the marker's crash evidence? No: our own
      // fresh marker would masquerade as that crash. Remove ours and
      // back off; the dir keeps whatever state it had.
      this.logger?.warn(
        "consolidateIntoTail: tail metafile unreadable — backing off to a new batch",
        { dir: tailDir },
      );
      await this.removeIfExists(marker);
      return null;
    }

    const merged = await this.mergeEntries(meta.entries, changes);
    if (merged.length > MAX_BATCH_ENTRIES) {
      // The rolling commit reached the split size — the new changes go
      // to a fresh batch (the caller's writeBatch) instead of growing
      // this one without bound. The tail keeps its current content.
      this.logger?.info?.(
        "consolidateIntoTail: merge would exceed the batch cap — splitting",
        { tail: meta.id, mergedCount: merged.length },
      );
      await this.removeIfExists(marker);
      return null;
    }
    const updated: BatchMetafile = { ...meta, entries: merged };
    // §12.4 again: manifest first, bytes second.
    await this.vault.adapter.write(metaPath, JSON.stringify(updated));
    await this.writeBlobs(tailDir, updated);

    await this.removeIfExists(marker);
    return meta.id;
  }

  // ── entry building ──────────────────────────────────────────────

  // One entry per change, EXPLICIT last-wins dedup by path (§7.3 —
  // the metafile is an array; the filesystem no longer dedups for
  // us). A deletion is `sha: null` (the tree-API convention); an
  // upload snapshots the CURRENT vault content: fresh mtime, sha and
  // size of the canonical bytes.
  private async buildEntries(changes: FileChange[]): Promise<BatchEntry[]> {
    const byPath = new Map<string, BatchEntry>();
    for (const c of changes) {
      if (c.kind === "deleted") {
        byPath.set(c.path, {
          path: c.path,
          sha: null,
          size: null,
          mtime: null,
        });
        continue;
      }
      const entry = await this.snapshotEntry(c.path);
      if (entry === null) {
        // File vanished between detection and commit. Not silent
        // loss: the next detection cycle emits the deletion itself.
        this.logger?.warn(
          "BatchWriter: file gone before snapshot — skipped; next detection re-emits",
          { path: c.path },
        );
        continue;
      }
      byPath.set(c.path, entry);
    }
    return [...byPath.values()];
  }

  // Merge consolidation changes into existing entries. Existing order
  // is kept (stable manifest diffs); replaced paths update in place,
  // new paths append. §7.2 fix lives here: an updated path gets a
  // FRESH mtime — never the enqueue-time one.
  private async mergeEntries(
    existing: BatchEntry[],
    changes: FileChange[],
  ): Promise<BatchEntry[]> {
    const fresh = await this.buildEntries(changes);
    const byPath = new Map<string, BatchEntry>(
      existing.map((e) => [e.path, e]),
    );
    for (const e of fresh) byPath.set(e.path, e);
    return [...byPath.values()];
  }

  // Read + hash one vault file WITHOUT writing anything to the queue
  // (pass 1). mtime is captured BEFORE the canonical write-back,
  // which would bump it (same rule as the old enqueue).
  private async snapshotEntry(path: string): Promise<BatchEntry | null> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) return null;
    const bytes = await this.readCanonicalBytes(path, true);
    if (bytes === null) return null;
    const sha = await this.workerClient.computeGitBlobSHA(bytes);
    return { path, sha, size: bytes.byteLength, mtime: stat.mtime };
  }

  // Canonical bytes of a vault file. Text files (when the toggle is
  // on) normalize to LF/no-BOM/trailing-NL; `writeBack` additionally
  // enforces "locally everything is canonical" on the live file —
  // only on real change, to spare mtime. size MUST be the byte length
  // of these bytes (TextEncoder), not the string length — the crash
  // repair compares vault stat.size against it (§12.9).
  private async readCanonicalBytes(
    path: string,
    writeBack: boolean,
  ): Promise<ArrayBuffer | null> {
    if (!(await this.vault.adapter.exists(path))) return null;
    if (
      shouldCanonicalize(path, this.vault.configDir) &&
      this.autoCanonicalize()
    ) {
      const original = await this.vault.adapter.read(path);
      const { content, changed } = normalizeText(original);
      if (changed && writeBack) {
        await this.vault.adapter.write(path, content);
      }
      const encoded = new TextEncoder().encode(content);
      return encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength,
      ) as ArrayBuffer;
    }
    return this.vault.adapter.readBinary(path);
  }

  // Pass 2 (§12.4 "…і ЛИШЕ ПОТІМ blob-и"): re-read each manifest
  // path and store its bytes under the recorded sha. Re-reading (not
  // holding pass-1 bytes) keeps peak memory at one file. If the file
  // changed in the await-gap between the passes, the fresh bytes no
  // longer match the recorded sha — storing them under that name
  // would poison the content-addressed store, so the entry is DROPPED
  // from the manifest instead (loud), and the next detection picks up
  // the file's current state (§12.6 equivalence).
  private async writeBlobs(dir: string, meta: BatchMetafile): Promise<void> {
    const dropped: string[] = [];
    for (const entry of meta.entries) {
      if (entry.sha === null) continue; // deletion — no bytes
      if (await this.syncStore.existInSyncStore(entry.sha)) continue;
      const bytes = await this.readCanonicalBytes(entry.path, false);
      const sha =
        bytes === null
          ? null
          : await this.workerClient.computeGitBlobSHA(bytes);
      if (bytes === null || sha !== entry.sha) {
        this.logger?.warn(
          "BatchWriter: file changed between hash and blob pass — entry dropped; next detection re-emits",
          { path: entry.path, expected: entry.sha, actual: sha },
        );
        dropped.push(entry.path);
        continue;
      }
      await this.syncStore.saveBlobToSyncStore(entry.sha, bytes);
    }
    if (dropped.length > 0) {
      const reduced: BatchMetafile = {
        ...meta,
        entries: meta.entries.filter((e) => !dropped.includes(e.path)),
      };
      await this.vault.adapter.write(
        `${dir}/${BATCH_META_FILE}`,
        JSON.stringify(reduced),
      );
    }
  }

  // ── plumbing ────────────────────────────────────────────────────

  private async tailBatchDir(): Promise<string | null> {
    if (!(await this.vault.adapter.exists(this.queueRoot))) return null;
    const listing = await this.vault.adapter.list(this.queueRoot);
    const ids = listing.folders
      .map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      })
      .filter((name) => /^\d{17}$/.test(name))
      .sort();
    if (ids.length === 0) return null;
    return `${this.queueRoot}/${ids[ids.length - 1]}`;
  }

  private async allocateUniqueId(): Promise<string> {
    // Same collision rule as the old queue: bump the millisecond
    // until the dir doesn't exist (mock clocks can repeat).
    let id = newBatchId(this.now());
    while (await this.vault.adapter.exists(`${this.queueRoot}/${id}`)) {
      id = newBatchId(new Date(parseTimestampId(id) + 1));
    }
    return id;
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (await this.vault.adapter.exists(dirPath)) return;
    let acc = "";
    for (const part of dirPath.split("/")) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.vault.adapter.exists(path)) {
      await this.vault.adapter.remove(path);
    }
  }
}
