// Local "smart-trash" for user-driven deletes, with cross-drain cleanup
// hooks that let sync2 reclaim trashed entries as their corresponding
// deletes propagate to GitHub.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3 (Recently deleted / Local trash)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.8–R3.12 (API + algorithms)
//
// Architectural notes worth re-stating in code:
//
//  - Disk is single source of truth. TrashStore holds no in-memory
//    record cache; every query (list/get/iter) scans .trash/ via
//    readdir + parse N×meta.json. Realistic N ≈ 3–20 entries (R3.5
//    cleanup keeps it small), so the scan is microseconds even on
//    mobile. The state TrashStore DOES hold in memory is just the
//    promise-chain for serialization and the listener set.
//
//  - All mutating methods serialize through serialize(). Concurrent
//    invokers don't interleave at the operation level; race surface
//    against external (drain-side) iteration is described in R3.7.
//
//  - Pull-deletes are NOT bypassed (R3.4 reformulated). sync2 calls
//    captureForDelete via the constructor-injected hook before its own
//    adapter.remove. Both user-driven (monkey-patched vault.delete) and
//    pull-driven flows funnel through intercept(path).
//
// PR-3 scope: skeleton, init(), intercept(), serialize(), subscribe(),
// list(), get(). The remaining hooks (confirmDeleted/confirmResolved/
// sweepOlderThan) and operations (liftForCompare/returnFromCompare/
// resetLifts) land in later PRs; their stubs throw so accidental early
// wire-up surfaces loudly.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import { newBatchId, parseTimestampId } from "../sync2/timestamp-id";
import { stripConflictSuffix } from "./strip-conflict-suffix";
import {
  atomicWriteJson,
  ensureParentDirs,
  rmrf,
  tryReadMetaJson,
} from "./trash-disk-helpers";
import { TrashHooks, TrashRecord } from "./types";

const TRASH_DIRNAME = ".runtime/trash";
const VAULT_SUBDIR = "vault";
const META_FILE = "meta.json";

export interface TrashStoreDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // Test-only clock override. Production passes undefined → Date.now().
  now?: () => Date;
}

export class TrashStore {
  private readonly vault: Vault;
  private readonly trashRoot: string;
  private readonly nowFn: () => Date;
  private currentOp: Promise<unknown> = Promise.resolve();
  private listeners: Set<() => void> = new Set();

  constructor(deps: TrashStoreDeps) {
    this.vault = deps.vault;
    this.trashRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${TRASH_DIRNAME}`;
    this.nowFn = deps.now ?? (() => new Date());
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  // Ensure the trash root directory exists. Idempotent. No disk scan —
  // the spec is explicit that TrashStore is stateless w.r.t. records.
  async init(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.trashRoot))) {
      await this.vault.adapter.mkdir(this.trashRoot);
    }
  }

  // Panic-button wipe — removes every .trash/<id>/ entry and re-
  // creates the empty trash root. Called from resetPluginState() in
  // main.ts alongside snapshot/conflict-store/pending-deletions
  // clearAll. Reset semantics are uniform: trash is plugin-managed
  // state and the user opting into Reset explicitly opts out of any
  // pending recovery window for previously-trashed files. Serialized
  // through the same promise-chain as other mutators.
  async clearAll(): Promise<void> {
    return this.serialize(() => this.clearAllImpl());
  }

  private async clearAllImpl(): Promise<void> {
    if (await this.vault.adapter.exists(this.trashRoot)) {
      await rmrf(this.vault.adapter, this.trashRoot);
    }
    await this.vault.adapter.mkdir(this.trashRoot);
    this.notify();
  }

  // ── intercept ─────────────────────────────────────────────────────

  // Copy a vault file's bytes into a fresh .trash/<id>/ entry. The
  // caller is responsible for performing the actual removal from vault
  // AFTER intercept resolves — TrashStore only handles the "save the
  // bytes" half of the protocol.
  //
  // Called from two flows that both predate the actual vault.remove:
  //   (a) trash-watcher's monkey-patched vault.delete/trash (later PR)
  //   (b) asHooks().captureForDelete from sync2.applyRemoteDeletion
  //
  // Returns the persisted TrashRecord. Throws on read/write failure;
  // callers in the monkey-patch wrapper / sync hook should catch and
  // log, but proceed with the underlying delete regardless — TrashStore
  // is a best-effort safety net, not a sync blocker.
  async intercept(path: string): Promise<TrashRecord> {
    return this.serialize(() => this.interceptImpl(path));
  }

  private async interceptImpl(path: string): Promise<TrashRecord> {
    const id = await this.allocateUniqueId();
    const adapter = this.vault.adapter;

    const fileContent = await adapter.readBinary(path);
    const sha = await calculateGitBlobSHA(fileContent);
    const stat = await adapter.stat(path);
    const size = stat?.size ?? fileContent.byteLength;
    const mtime = stat?.mtime ?? Date.now();

    const dstFile = `${this.trashRoot}/${id}/${VAULT_SUBDIR}/${path}`;
    await ensureParentDirs(adapter, dstFile);
    await adapter.writeBinary(dstFile, fileContent);

    const meta: TrashRecord = {
      id,
      originalPath: path,
      originalDeletedAt: new Date().toISOString(),
      sha,
      size,
      mtime,
    };
    await atomicWriteJson(
      adapter,
      `${this.trashRoot}/${id}/${META_FILE}`,
      meta,
    );

    this.notify();
    return meta;
  }

  // ── queries (disk-scan; no in-memory index) ───────────────────────

  // Return all valid TrashRecords. Sorts newest-deleted first (by
  // originalDeletedAt desc), matching the "Recently deleted" UI order.
  // Skips trash dirs with missing/invalid meta.json — those are orphan
  // states the recovery sweep (later PR) handles separately.
  async list(): Promise<TrashRecord[]> {
    const records = await this.readAllRecords();
    records.sort((a, b) =>
      b.originalDeletedAt.localeCompare(a.originalDeletedAt),
    );
    return records;
  }

  // Single-record lookup by id. Returns undefined when the record is
  // missing OR its meta.json is invalid.
  async get(id: string): Promise<TrashRecord | undefined> {
    const meta = await tryReadMetaJson<TrashRecord>(
      this.vault.adapter,
      `${this.trashRoot}/${id}/${META_FILE}`,
    );
    return meta && meta.id === id ? meta : undefined;
  }

  // ── cleanup hooks (R3.5 three-layer TTL) ──────────────────────────

  // Layer 1a — base-file deletes confirmed on GitHub. Called by
  // sync2.processBatch after each successful push, with the batch's
  // deleted-paths.txt entries. Matching .trash/ records are wiped.
  // Records with liftedAsSessionId set are skipped (active compare —
  // R3.7 shield).
  async confirmDeleted(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const set = new Set(paths);
    return this.serialize(() =>
      this.sweepBy((rec) => set.has(rec.originalPath)),
    );
  }

  // Layer 1b — conflict resolution confirmed on GitHub. Called by
  // sync2.processBatch after a Phase-B side-batch (one whose
  // meta.resolvesConflictForBasePath is set) successfully pushes. All
  // sibling-trash entries belonging to that base path (matched via
  // stripConflictSuffix) are wiped. Lifted records skipped.
  async confirmResolved(basePath: string): Promise<void> {
    return this.serialize(() =>
      this.sweepBy((rec) => stripConflictSuffix(rec.originalPath) === basePath),
    );
  }

  // Layer 2 — drain-end backstop. Called by Sync2Manager only when the
  // drain succeeded fully (queue empty, no abort). Wipes all records
  // with id < threshold (string compare on 17-digit timestamps).
  // Catches anything 1a/1b missed: orphan/synthetic siblings,
  // gitignored deletes (.log etc), pull-delete entries from earlier
  // drains. Lifted records skipped.
  async sweepOlderThan(threshold: string): Promise<void> {
    return this.serialize(() =>
      this.sweepBy((rec) => rec.id < threshold),
    );
  }

  // Shared cleanup body. Iterates current disk state, applies predicate,
  // rmrfs each match (best-effort — a failed rmrf logs but doesn't stop
  // the loop), notifies once at end if anything changed.
  private async sweepBy(
    predicate: (rec: TrashRecord) => boolean,
  ): Promise<void> {
    const records = await this.readAllRecords();
    let changed = false;
    for (const rec of records) {
      if (rec.liftedAsSessionId) continue; // R3.7 shield
      if (!predicate(rec)) continue;
      try {
        await rmrf(this.vault.adapter, `${this.trashRoot}/${rec.id}`);
        changed = true;
      } catch {
        // Best-effort: a failed rmrf leaves the entry on disk; the next
        // matching cleanup or onload recovery sweep picks it up. Don't
        // poison the loop — other records still need processing.
      }
    }
    if (changed) this.notify();
  }

  // Disk-scan helper shared by list() and the three cleanup hooks. No
  // sort — callers add ordering only when they need it (list()).
  private async readAllRecords(): Promise<TrashRecord[]> {
    const adapter = this.vault.adapter;
    if (!(await adapter.exists(this.trashRoot))) return [];
    const { folders } = await adapter.list(this.trashRoot);
    const out: TrashRecord[] = [];
    for (const dir of folders) {
      const meta = await tryReadMetaJson<TrashRecord>(
        adapter,
        `${dir}/${META_FILE}`,
      );
      // Defensive: dir name must equal meta.id so a half-renamed
      // recovery state can't slip through.
      const dirName = dir.slice(dir.lastIndexOf("/") + 1);
      if (meta && meta.id === dirName) out.push(meta);
    }
    return out;
  }

  // ── compare-lift (R3.7) ───────────────────────────────────────────

  // Mark a trash entry as the focus of an active compare session.
  // Metadata-only: file bytes stay at .trash/<id>/vault/<originalPath>,
  // only meta.json is rewritten with liftedAsSessionId set. The marker
  // shields the entry from all three R3.5 cleanup layers (each guards
  // on `if record.liftedAsSessionId: continue`).
  //
  // Throws if `id` doesn't name an existing trash entry, or if the
  // entry is already lifted (one active compare session per entry —
  // upper layers handle "you're trying to compare a file already
  // being compared elsewhere" with a Notice; see R3.7).
  //
  // Returns the trash-side path the UI should read bytes from, the
  // sessionId to thread through later return, and the updated record.
  async liftForCompare(id: string): Promise<{
    trashPath: string;
    sessionId: string;
    record: TrashRecord;
  }> {
    return this.serialize(() => this.liftForCompareImpl(id));
  }

  private async liftForCompareImpl(id: string): Promise<{
    trashPath: string;
    sessionId: string;
    record: TrashRecord;
  }> {
    const adapter = this.vault.adapter;
    const metaPath = `${this.trashRoot}/${id}/${META_FILE}`;
    const meta = await tryReadMetaJson<TrashRecord>(adapter, metaPath);
    if (!meta || meta.id !== id) {
      throw new Error(`TrashStore.liftForCompare: trash entry ${id} not found`);
    }
    if (meta.liftedAsSessionId) {
      throw new Error(
        `TrashStore.liftForCompare: ${id} already lifted as session ${meta.liftedAsSessionId}`,
      );
    }

    const sessionId = newBatchId(this.nowFn());
    meta.liftedAsSessionId = sessionId;
    await atomicWriteJson(adapter, metaPath, meta);
    this.notify();

    return {
      trashPath: `${this.trashRoot}/${id}/${VAULT_SUBDIR}/${meta.originalPath}`,
      sessionId,
      record: meta,
    };
  }

  // Clear the marker on the record whose liftedAsSessionId matches
  // `sessionId`. Symmetric with liftForCompare: only meta.json is
  // rewritten; the trash file is untouched. After return, the record
  // re-enters the normal three-layer cleanup flow with its original
  // id intact (R3.7 "returned record is treated as if never lifted").
  //
  // Throws if no record claims this sessionId — the UI should treat
  // it as a programmer-error or stale-handle case (the entry may have
  // been wiped while lifted, e.g., resetLifts cleared the marker; the
  // session is meaningless without the record on disk).
  async returnFromCompare(sessionId: string): Promise<void> {
    return this.serialize(() => this.returnFromCompareImpl(sessionId));
  }

  private async returnFromCompareImpl(sessionId: string): Promise<void> {
    const records = await this.readAllRecords();
    const meta = records.find((r) => r.liftedAsSessionId === sessionId);
    if (!meta) {
      throw new Error(
        `TrashStore.returnFromCompare: no record found for session ${sessionId}`,
      );
    }
    meta.liftedAsSessionId = undefined;
    await atomicWriteJson(
      this.vault.adapter,
      `${this.trashRoot}/${meta.id}/${META_FILE}`,
      meta,
    );
    this.notify();
  }

  // Defensive normalizer — clears the liftedAsSessionId marker on
  // every record. Phase 9b UI calls this at the moment the LAST
  // diff2 detail-view tab closes, enforcing the invariant
  //   "0 active detail-view tabs → 0 lifted markers".
  //
  // Primary path is each tab's own returnFromCompare(its sessionId)
  // on close; resetLifts catches escapees (programmer-error,
  // un-caught exceptions, async-race that left a marker without a
  // live session). Idempotent — when nothing is lifted, no notify
  // fires.
  async resetLifts(): Promise<void> {
    return this.serialize(() => this.resetLiftsImpl());
  }

  private async resetLiftsImpl(): Promise<void> {
    const records = await this.readAllRecords();
    let changed = false;
    for (const rec of records) {
      if (!rec.liftedAsSessionId) continue;
      rec.liftedAsSessionId = undefined;
      try {
        await atomicWriteJson(
          this.vault.adapter,
          `${this.trashRoot}/${rec.id}/${META_FILE}`,
          rec,
        );
        changed = true;
      } catch {
        // Best-effort: a single record's failed meta-write doesn't
        // poison the rest of the normalization pass. The next reset
        // attempt or onload recovery sweep picks up the laggard.
      }
    }
    if (changed) this.notify();
  }

  // ── subscription (bare signal; UI re-fetches via list()) ──────────

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Public so trash-recovery.ts can fire one final notify after the
  // onload sweep completes its disk mutations. Internal callers go
  // through the same method.
  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A misbehaving subscriber must not break TrashStore. Swallow
        // and continue — listeners are UI-side and recoverable.
      }
    }
  }

  // ── sync2 cross-edge: TrashHooks adapter ──────────────────────────

  // Returns the bag of callbacks sync2 imports via constructor
  // injection. Wires every hook to the corresponding TrashStore method;
  // sync2-manager is free to call any of them at the appropriate
  // moment in its drain cycle (PR-8 wires the actual integration).
  asHooks(): TrashHooks {
    return {
      captureForDelete: async (path) => {
        await this.intercept(path);
      },
      confirmDeleted: (paths) => this.confirmDeleted(paths),
      confirmResolved: (basePath) => this.confirmResolved(basePath),
      sweepOlderThan: (threshold) => this.sweepOlderThan(threshold),
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  // Serializes mutating operations through a promise-chain. Each public
  // mutator wraps its body in serialize() so concurrent callers never
  // interleave their atomic-write steps. Failure of one operation
  // doesn't poison the chain — the next caller's `await prev` swallows
  // the rejection.
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const prev = this.currentOp;
    const next = (async (): Promise<T> => {
      try {
        await prev;
      } catch {
        // intentionally ignored — see method doc
      }
      return op();
    })();
    this.currentOp = next.catch(() => {});
    return next;
  }

  // Mirrors push-queue.ts::allocateUniqueId: handles the rare case where
  // two intercepts land in the same millisecond by bumping the trailing
  // ms-counter until the directory doesn't yet exist. Keeps the total
  // order monotonic — load-bearing for layer 2 sweep (R3.5) which
  // compares id < drain.startedAt lexicographically.
  private async allocateUniqueId(): Promise<string> {
    let id = newBatchId(this.nowFn());
    while (
      await this.vault.adapter.exists(`${this.trashRoot}/${id}`)
    ) {
      const next = new Date(parseTimestampId(id) + 1);
      id = newBatchId(next);
    }
    return id;
  }
}
