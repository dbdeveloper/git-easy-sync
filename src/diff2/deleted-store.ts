// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The Deleted bin, re-platformed (HISTORY-DELETED §5.2.1).
//
// Replaces `.trash/<id>/vault/<originalPath>` + a per-entry meta.json
// with the two mechanisms the new engine already has: the
// content-addressed `sync_store/` for the BYTES (deduped, swept by one
// shared rule) and one flat `deleted.json` for the INDEX. The Deleted
// view therefore never scans the filesystem — it reads the list.
//
// ── THE ORDER IS THE SAFETY (replaces trash-recovery case A) ────────
// The old bin wrote the bytes first and its metadata second, so a
// crash in between left content in a directory nothing would ever
// index — and `trash-recovery.sweepOnload` existed to RESTORE those
// bytes back into the vault. That recipe cannot survive the move: a
// content-addressed blob carries no path and no name, so an orphaned
// `sync_store/{sha}` has nowhere to be restored TO.
//
// So the protection moves into the order of operations — the same
// principle the W1 fix established for conflicts (NEW-DRAIN §V): the
// durable record goes BEFORE the irreversible act.
//
//   1. bytes  → sync_store/{sha}      (content-addressed, idempotent)
//   2. record → deleted.json          ← BEFORE the file is removed
//   3. caller removes the file        ← the irreversible step
//
// Crash between 1 and 2: the blob is unreferenced and the next sweep
// reaps it — and the vault file is STILL THERE, untouched. Crash
// between 2 and 3: the file is still there and the record is stale —
// pruned by `reconcile()` on the next load. Neither window
// loses anything, which is WHY no recovery pass is needed here, not an
// oversight that one is missing.
//
// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────
// - `restore(id)` and the Deleted UI — Phase 9b.
// - the compare-session shield (old `liftForCompare`): it must come
//   back as a sweep reference, not as a marker in a per-entry file,
//   and its carrier is an open owner decision (§5.2.1).
// - the hand-off to the batch (`deletedSha`): the next step. Until it
//   lands, a record simply stays here and keeps protecting its blob.

import { normalizePath, type Vault } from "obsidian";
import SyncStore from "../sync2/sync-store";
import { calculateGitBlobSHA } from "../utils";

const DELETED_FILE = "deleted.json";

// One deletion of one path. `sha` names the bytes in sync_store — the
// last LIVE content, which is NOT the same as the last synced content:
// the bin must be able to hand back uncommitted edits too.
export interface DeletedRecord {
  path: string;
  sha: string;
  size: number;
  // The file's own mtime at capture time (not the moment of deletion).
  mtime: number;
  deletedAt: string;
}

export interface DeletedStoreDeps {
  vault: Vault;
  selfPluginId: string;
  syncStore: SyncStore;
  logger?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  now?: () => Date;
}

export default class DeletedStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly syncStore: SyncStore;
  private readonly logger: DeletedStoreDeps["logger"];
  private readonly now: () => Date;
  private records: DeletedRecord[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();
  // The view-session shield (successor of the old `liftedAsSessionId`
  // marker). A sha held here survives BOTH the retention prune and the
  // sync_store sweep, for as long as a diff-editor tab has it open —
  // "поки він не закриє їх або поки не відновиться з них".
  //
  // IN MEMORY on purpose, and that is the whole crash story: a killed
  // Obsidian has no open tabs, so it can have no stale holds. The old
  // bin's persisted marker needed a recovery pass to clear exactly
  // this (trash-recovery case B); here the state cannot outlive the
  // session that owns it. A restored tab re-registers its hold when it
  // mounts, the same way it re-reads everything else.
  private holds = new Set<string>();

  constructor(deps: DeletedStoreDeps) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.syncStore = deps.syncStore;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  private filePath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${DELETED_FILE}`,
    );
  }

  async load(): Promise<void> {
    this.records = [];
    this.loaded = true;
    const p = this.filePath();
    try {
      if (!(await this.vault.adapter.exists(p))) return;
      const raw = JSON.parse(await this.vault.adapter.read(p)) as unknown;
      if (!Array.isArray(raw)) return;
      for (const r of raw) {
        if (typeof r !== "object" || r === null) continue;
        const o = r as Record<string, unknown>;
        if (
          typeof o.path === "string" &&
          typeof o.sha === "string" &&
          typeof o.size === "number" &&
          typeof o.mtime === "number" &&
          typeof o.deletedAt === "string"
        ) {
          this.records.push({
            path: o.path,
            sha: o.sha,
            size: o.size,
            mtime: o.mtime,
            deletedAt: o.deletedAt,
          });
        }
      }
    } catch {
      // Torn/corrupt → an empty bin. Degrading to "nothing to restore"
      // is the safe direction: the alternative is acting on a
      // half-parsed list.
      this.records = [];
    }
  }

  list(): DeletedRecord[] {
    return [...this.records];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Capture step: park the bytes and record them, BEFORE the caller
  // removes the file. Best-effort by contract — the caller proceeds
  // with the delete even if this throws (the bin is a safety net, not
  // a sync blocker), so every failure mode here must leave the vault
  // untouched.
  //
  // Returns the record, or null when there was nothing to capture.
  async captureForDelete(path: string): Promise<DeletedRecord | null> {
    if (!this.loaded) await this.load();
    const normalized = normalizePath(path);
    const stat = await this.vault.adapter.stat(normalized);
    if (stat === null || stat.type !== "file") return null;

    const bytes = await this.vault.adapter.readBinary(normalized);
    const sha = await calculateGitBlobSHA(bytes);
    // Content-addressed: the same content deleted twice costs one blob.
    if (!(await this.syncStore.existInSyncStore(sha))) {
      await this.syncStore.saveBlobToSyncStore(sha, bytes);
    }

    const record: DeletedRecord = {
      path: normalized,
      sha,
      size: bytes.byteLength,
      mtime: stat.mtime,
      deletedAt: this.now().toISOString(),
    };
    // One live record per path: a path deleted again supersedes its
    // previous capture (the older bytes stay reachable only through a
    // committed batch, per §5.2.1 scenario 4).
    this.records = this.records.filter((r) => r.path !== normalized);
    this.records.push(record);
    await this.persist();
    this.notify();
    return record;
  }

  // The sha for a path's pending deletion, without mutating anything —
  // the batch hand-off reads this and releases the record only after
  // its metafile is durable (next step).
  peek(path: string): string | null {
    const normalized = normalizePath(path);
    return this.records.find((r) => r.path === normalized)?.sha ?? null;
  }

  async release(paths: string[]): Promise<void> {
    if (!this.loaded) await this.load();
    const drop = new Set(paths.map((p) => normalizePath(p)));
    const before = this.records.length;
    this.records = this.records.filter((r) => !drop.has(r.path));
    if (this.records.length !== before) {
      await this.persist();
      this.notify();
    }
  }

  // Sweep source №5 (§12.5): every blob the bin still needs — its
  // pending captures PLUS anything a view session is holding open. The
  // hold matters on its own: a user may be looking at a generation
  // whose record already handed off to a batch, and the batch's
  // protection ends when the batch does.
  referencedShas(): Set<string> {
    const out = new Set(this.records.map((r) => r.sha));
    for (const sha of this.holds) out.add(sha);
    return out;
  }

  // Called when a diff-editor tab opens a deleted version, and again
  // when it closes (or after a restore). Idempotent both ways.
  hold(sha: string): void {
    this.holds.add(sha);
  }

  unhold(sha: string): void {
    this.holds.delete(sha);
  }

  isHeld(sha: string): boolean {
    return this.holds.has(sha);
  }

  // Retention (owner's rule, 2026-09-21): at the end of a FULLY
  // successful drain, every record that predates that drain goes —
  // their blobs then fall to the ordinary sweep. This is the successor
  // of the old bin's layer-2 backstop, and it is what bounds the bin:
  // the hand-off only releases deletions that REACH A COMMIT, while
  // siblings, gitignored files and remote-originated deletes never do.
  //
  // Held records are skipped — an open editor keeps its subject alive
  // until it is closed or restored from.
  //
  // The local restore window is therefore "until the next successful
  // drain" by design (§5.2.1: the committed generations' window ends
  // with their batch); the complete list of deletions still comes from
  // GitHub history.
  async pruneBefore(beforeIso: string): Promise<void> {
    if (!this.loaded) await this.load();
    const kept = this.records.filter(
      (r) => r.deletedAt >= beforeIso || this.holds.has(r.sha),
    );
    if (kept.length === this.records.length) return;
    this.logger?.info("deleted-bin: retention prune", {
      dropped: this.records.length - kept.length,
      kept: kept.length,
      before: beforeIso,
    });
    this.records = kept;
    await this.persist();
    this.notify();
  }

  // Load-time reconcile, the successor of trash-recovery's hygiene
  // cases — both cheaper than their predecessors:
  //
  //  (C) record present, blob gone → nothing to restore, drop it. In
  //      the old bin this needed an rmrf of a directory; here it is a
  //      list entry. It is also STRONGER: the store hashes on read, so
  //      a CORRUPT blob is detected too, which the old bin could not
  //      do at all.
  //  (§5.2.1 scenario 2) the path is live again → the record is stale
  //      (either a crash between record and remove, or a delete
  //      followed by a create). Drop it; the blob then falls to the
  //      sweep.
  async reconcile(): Promise<void> {
    if (!this.loaded) await this.load();
    const kept: DeletedRecord[] = [];
    for (const r of this.records) {
      const live = await this.vault.adapter.exists(r.path);
      if (live) {
        this.logger?.info("deleted-bin: path is live again — record dropped", {
          path: r.path,
        });
        continue;
      }
      if (!(await this.syncStore.existInSyncStore(r.sha))) {
        this.logger?.warn("deleted-bin: bytes gone — record dropped", {
          path: r.path,
          sha: r.sha,
        });
        continue;
      }
      kept.push(r);
    }
    if (kept.length !== this.records.length) {
      this.records = kept;
      await this.persist();
      this.notify();
    }
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private async persist(): Promise<void> {
    const dir = normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime`,
    );
    if (!(await this.vault.adapter.exists(dir))) {
      let acc = "";
      for (const part of dir.split("/")) {
        acc = acc === "" ? part : `${acc}/${part}`;
        if (!(await this.vault.adapter.exists(acc))) {
          await this.vault.adapter.mkdir(acc);
        }
      }
    }
    await this.vault.adapter.write(
      this.filePath(),
      JSON.stringify(this.records),
    );
  }
}
