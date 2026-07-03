// Pending-deletions queue — explicit replacement for the phantom-
// snapshot trick that 2.0.1-beta2 introduced in pull-side sanitize
// (and that 2.0.1-beta3 partially defused via pre-flight validation
// in createTree).
//
// See docs/PSEUDO-MERGE-MODE.md §3.2 for design rationale. In one
// line: when pull-side sanitize rewrites a GitHub-side forbidden path
// to a canonical local path, we need to "remember to delete the
// forbidden path on the next push." Phase 1 (beta3) recorded that
// intent by writing a fake SnapshotStore entry with mtime=0 / size=0.
// That broke the SnapshotStore invariant ("every entry is a path we
// observed on GitHub at this SHA") and the phantom entries were
// confusingly persistent across reset/uninstall edges. Phase 2 moves
// the intent out into this dedicated store whose semantics are
// transparent: an entry here means "we want to delete this path from
// GitHub on the next push."
//
// On-disk layout (one folder per entry — matches conflict-store and
// push-queue conventions so the recovery / reset / fault-injection
// pieces look familiar):
//
//   <configDir>/plugins/<self>/.pending-deletions/
//     <entryId>/
//       meta.json          ← PendingDeletion JSON (atomic write)
//
// Plugin Reset (Settings → Reset) wipes the whole directory. Plugin
// uninstall removes <configDir>/plugins/<self>/ recursively (Obsidian
// does this for us). Either way, no entry can outlive the plugin
// install — that's the §3.2 "Reset semantics" line.

import { Vault } from "obsidian";
import { safeRename } from "./cross-platform";

const PENDING_DIRNAME = ".runtime/pending-deletions";
const META_FILE = "meta.json";
const META_TMP_FILE = "meta.json.tmp";

// Where the intent came from. Useful for the activity log when a
// pre-flight drops an entry as stale — knowing whether the entry was
// born from sanitize, a one-time migration, or a manual operator
// action distinguishes "expected churn" from "something weird."
export type PendingDeletionSource =
  | "pull-side-sanitize"
  | "migration-from-snapshot"
  | "manual";

export interface PendingDeletion {
  // crypto.randomUUID(). Collision-impossible in practice; used as
  // the directory name on disk.
  id: string;
  // Vault path the entry targets. Index key — at most ONE entry per
  // path is allowed. add() is idempotent against the same path.
  path: string;
  source: PendingDeletionSource;
  // Last commit SHA at which we observed the path present on GitHub.
  // Set at add() time; not updated on subsequent add() calls (the
  // first observation is the durable record).
  observedAtCommit: string;
  // Blob SHA of the file at that commit. Carried for diagnostics and
  // for potential idempotency checks in future phases (e.g., "this
  // path's content drifted on GitHub since we recorded the intent —
  // re-verify before pushing the deletion"). Optional because the
  // migration source may not have it (phantom-snapshot entries
  // recorded remoteSha but not their commit).
  remoteSha: string | null;
  createdAt: number;
}

interface PendingDeletionsConfig {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  now?: () => number;
}

export default class PendingDeletionsStore {
  private readonly vault: Vault;
  private readonly dirPath: string;
  private readonly now: () => number;
  // Index by vault path. The on-disk source of truth is the
  // <id>/meta.json files; this map is the in-memory cache rebuilt
  // every load(). Mutations write through to disk before updating
  // the cache so a crash mid-mutation leaves consistent state.
  private byPath: Map<string, PendingDeletion> = new Map();

  constructor(config: PendingDeletionsConfig) {
    this.vault = config.vault;
    this.dirPath = `${config.configDir}/plugins/${config.selfPluginId}/${PENDING_DIRNAME}`;
    this.now = config.now ?? (() => Date.now());
  }

  // Build the in-memory index from disk. Idempotent — calling load()
  // twice on the same disk state produces the same cache. Skips
  // entries whose meta.json is missing or invalid (these can be
  // crash leftovers from a half-written add()); future add()s for
  // the same path will overwrite via the normal idempotent path.
  async load(): Promise<void> {
    this.byPath.clear();
    if (!(await this.vault.adapter.exists(this.dirPath))) return;
    const listing = await this.vault.adapter.list(this.dirPath);
    for (const subDir of listing.folders ?? []) {
      const metaPath = `${subDir}/${META_FILE}`;
      if (!(await this.vault.adapter.exists(metaPath))) continue;
      let parsed: PendingDeletion;
      try {
        const raw = await this.vault.adapter.read(metaPath);
        parsed = JSON.parse(raw) as PendingDeletion;
      } catch {
        // Corrupt meta.json — could be a torn write from a crash
        // mid-add. Leave it on disk for now (subsequent add() calls
        // would overwrite); a future cleanup sweep can prune
        // orphans if this becomes a problem.
        continue;
      }
      if (typeof parsed.path !== "string" || parsed.path.length === 0) continue;
      this.byPath.set(parsed.path, parsed);
    }
  }

  // Record an intent to delete `path` on the next push. Idempotent
  // against the same path — the first call wins (its `id`,
  // `observedAtCommit`, `createdAt` are durable); subsequent add()
  // calls for the same path are a no-op. Reason for first-write-wins:
  // a path that's been pending since commit A should not "appear
  // freshly observed at commit C" just because pull ran again at C.
  // The original observation IS the durable record; refreshing it
  // would mask drift.
  //
  // Returns the resulting record (new or existing).
  async add(
    path: string,
    args: {
      source: PendingDeletionSource;
      observedAtCommit: string;
      remoteSha?: string | null;
    },
  ): Promise<PendingDeletion> {
    const existing = this.byPath.get(path);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const record: PendingDeletion = {
      id,
      path,
      source: args.source,
      observedAtCommit: args.observedAtCommit,
      remoteSha: args.remoteSha ?? null,
      createdAt: this.now(),
    };
    await this.ensureDirChain(`${this.dirPath}/${id}`);
    await this.persistRecord(id, record);
    this.byPath.set(path, record);
    return record;
  }

  // Snapshot of current state. Returned array is a shallow copy so
  // callers can iterate while concurrent mutations happen elsewhere.
  // Order is the insertion order of the in-memory Map (which mirrors
  // load()-discovery order — alphabetical-ish per the adapter's
  // listing semantics).
  getAll(): PendingDeletion[] {
    return [...this.byPath.values()];
  }

  // O(1) lookup. Returns undefined when the path isn't pending —
  // distinct from "the path was pending and just got cleared."
  getByPath(path: string): PendingDeletion | undefined {
    return this.byPath.get(path);
  }

  // Clear a single pending entry. Called after a successful push (the
  // deletion landed on GitHub) OR after pre-flight validation drops
  // the entry as stale (the path's already absent at currentHead).
  // No-op when no entry matches — callers don't have to predicate.
  async remove(path: string): Promise<void> {
    const existing = this.byPath.get(path);
    if (!existing) return;
    const entryDir = `${this.dirPath}/${existing.id}`;
    if (await this.vault.adapter.exists(entryDir)) {
      // Remove meta then directory. Order matters on Capacitor where
      // removing a non-empty directory throws on some adapters.
      const metaPath = `${entryDir}/${META_FILE}`;
      if (await this.vault.adapter.exists(metaPath)) {
        await this.vault.adapter.remove(metaPath);
      }
      const tmpPath = `${entryDir}/${META_TMP_FILE}`;
      if (await this.vault.adapter.exists(tmpPath)) {
        await this.vault.adapter.remove(tmpPath);
      }
      await this.vault.adapter.rmdir(entryDir, true);
    }
    this.byPath.delete(path);
  }

  // Plugin Reset: wipe everything. The whole .pending-deletions/
  // directory is removed; the in-memory cache is cleared. Idempotent
  // — calling clear() on an empty store is a no-op.
  async clear(): Promise<void> {
    this.byPath.clear();
    if (!(await this.vault.adapter.exists(this.dirPath))) return;
    await this.vault.adapter.rmdir(this.dirPath, true);
  }

  // Count — for diagnostics and for the future ribbon-badge work
  // (Phase 6). Cheap; reads in-memory Map size.
  size(): number {
    return this.byPath.size;
  }

  // ── private helpers ──────────────────────────────────────────────

  private async persistRecord(
    id: string,
    record: PendingDeletion,
  ): Promise<void> {
    const dir = `${this.dirPath}/${id}`;
    const tmpPath = `${dir}/${META_TMP_FILE}`;
    const finalPath = `${dir}/${META_FILE}`;
    await this.vault.adapter.write(tmpPath, JSON.stringify(record));
    // Capacitor portability via the centralised helper
    // (cross-platform.ts § safeRename).
    await safeRename(this.vault.adapter, tmpPath, finalPath);
  }

  // adapter.mkdir is non-recursive on some platforms; build the chain
  // a step at a time. Idempotent against partial existence.
  private async ensureDirChain(dirPath: string): Promise<void> {
    if (await this.vault.adapter.exists(dirPath)) return;
    const parts = dirPath.split("/");
    let acc = "";
    for (const part of parts) {
      if (part.length === 0) {
        continue;
      }
      acc = acc.length === 0 ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }
}
