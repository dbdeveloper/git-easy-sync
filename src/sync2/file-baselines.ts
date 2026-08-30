// Cold per-file baseline map — hash buckets + MRU cache
// (METAFILE-REFACTOR §2.2, group access pattern §2.2.1).
//
// The per-file baseline (`baselineSha` + the {mtime,size} stat pair
// recorded with it) is the diff3 BASE for every synced path — NOT
// disposable state (§1.C). It is "cold" by SHAPE (many small per-file
// records), not by importance: the map is split into BUCKET_COUNT
// hash buckets stored as `.runtime/file-baselines/<hash>.json`, so a
// one-file change rewrites one bucket (write-amplification
// O(vault) → O(bucket)) and a torn write can hurt one bucket only.
//
// ⚠ FROZEN ON-DISK LAYOUT: the hash function (FNV-1a 32-bit) and
// BUCKET_COUNT together decide which file a path's baseline lives in.
// Changing either reshuffles every bucket on every vault. The blank
// slate made this free to choose once — it is expensive to change.
//
// MRU cache (capacity MRU_CAPACITY, memory-only tunable): recency is
// the time of ANY access, cache hits included (§2.2 — a hot bucket
// that is read often but never written must not age out and thrash).
// Write-through: a mutated bucket is flushed to disk immediately via
// atomicWriteFile, so dirty buckets in cache are an exception (a
// failed flush), not the norm; eviction of such a bucket flushes it
// first (§2.2 fallback).
//
// GROUP ACCESS (§2.2.1, owner decision 2026-08-30): reading/updating
// a GROUP of paths must group them by bucket first — 10 paths living
// in 3 buckets cost exactly 3 bucket opens. With only MRU_CAPACITY
// buckets in memory, an unordered per-path loop over more buckets
// than that thrashes the cache on the hottest path. getMany/setMany/
// removeMany are therefore the PRIMARY API; a caller-side
// `for (path) { store.set(path, …) }` loop is the anti-pattern the
// spec forbids. Full scans go through forEachBucket, which reads each
// bucket exactly once and does NOT insert scan-only buckets into the
// cache (a 64-bucket scan must not wipe the 6-slot MRU).

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";

// Frozen on-disk layout — see header.
export const BASELINE_BUCKET_COUNT = 64;
// Memory-only: how many buckets the cache holds. Tunable at runtime,
// injectable in tests.
export const BASELINE_MRU_CAPACITY = 6;

export interface FileBaseline {
  // Git blob SHA last recorded as the remote/baseline state of this
  // path — the diff3 base.
  baselineSha: string;
  // Local stat pair at the moment baselineSha was recorded; the
  // change detector's short-circuit compares against it.
  mtime: number;
  size: number;
}

// FNV-1a 32-bit over the path's UTF-16 code units, mod BUCKET_COUNT,
// as a two-hex-char bucket id ("00".."3f" for 64).
export function bucketIdForPath(filePath: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    h ^= filePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const idx = h % BASELINE_BUCKET_COUNT;
  return idx.toString(16).padStart(2, "0");
}

interface CachedBucket {
  files: Map<string, FileBaseline>;
  // Monotonic access stamp (counter, not a clock — recency needs
  // ORDER, and a ms clock ties/steps; same reasoning as hot §2.1.1).
  lastAccess: number;
  // Mutated in memory and not yet on disk. Write-through keeps this
  // false except between a failed flush and its retry.
  dirty: boolean;
}

function entryFromRaw(raw: unknown): FileBaseline | null {
  const r = raw as Partial<FileBaseline> | null;
  if (
    r &&
    typeof r === "object" &&
    typeof r.baselineSha === "string" &&
    typeof r.mtime === "number" &&
    typeof r.size === "number"
  ) {
    return { baselineSha: r.baselineSha, mtime: r.mtime, size: r.size };
  }
  return null;
}

export default class FileBaselinesStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly mruCapacity: number;
  private readonly cache = new Map<string, CachedBucket>();
  private accessCounter = 0;
  // Disk-op counters — used by the write-amplification measurement
  // (METAFILE §4) and by unit tests asserting the §2.2.1 group
  // contract ("N paths in K buckets = K reads / K writes").
  readonly stats = { bucketReads: 0, bucketWrites: 0 };

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    mruCapacity?: number;
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.mruCapacity = deps.mruCapacity ?? BASELINE_MRU_CAPACITY;
  }

  private baselinesDir(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/file-baselines`,
    );
  }

  private bucketPath(bucketId: string): string {
    return normalizePath(`${this.baselinesDir()}/${bucketId}.json`);
  }

  private touch(bucket: CachedBucket): void {
    bucket.lastAccess = ++this.accessCounter;
  }

  // Raw disk read of one bucket. Missing file → empty map. A corrupt
  // bucket also reads as empty: that is the §3 degraded mode — the
  // torn bucket's baselines re-derive from the remote (the engine
  // treats the paths as never-seen and re-aligns), never a global
  // loss. atomicWriteFile's staging + the onload recovery sweep make
  // this window rare.
  private async readBucketFromDisk(
    bucketId: string,
  ): Promise<Map<string, FileBaseline>> {
    this.stats.bucketReads += 1;
    const p = this.bucketPath(bucketId);
    const files = new Map<string, FileBaseline>();
    if (!(await this.vault.adapter.exists(p))) return files;
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as {
        files?: Record<string, unknown>;
      };
      if (raw && typeof raw === "object" && raw.files) {
        for (const [path, value] of Object.entries(raw.files)) {
          const entry = entryFromRaw(value);
          if (entry !== null) files.set(path, entry);
        }
      }
    } catch {
      // corrupt/torn → empty (degraded mode above)
    }
    return files;
  }

  private async flushBucket(
    bucketId: string,
    bucket: CachedBucket,
  ): Promise<void> {
    await this.ensureDir();
    const filesObj: Record<string, FileBaseline> = {};
    for (const [path, entry] of bucket.files) filesObj[path] = entry;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ v: 1, files: filesObj }),
    );
    await atomicWriteFile(
      this.vault,
      this.bucketPath(bucketId),
      bytes.buffer as ArrayBuffer,
    );
    this.stats.bucketWrites += 1;
    bucket.dirty = false;
  }

  // Cache-through load of one bucket. Cache hit refreshes recency
  // (any access counts — §2.2's anti-thrashing rule); miss reads the
  // disk, inserts, and evicts the least-recent bucket past capacity.
  private async loadBucket(bucketId: string): Promise<CachedBucket> {
    const hit = this.cache.get(bucketId);
    if (hit !== undefined) {
      this.touch(hit);
      return hit;
    }
    const files = await this.readBucketFromDisk(bucketId);
    const bucket: CachedBucket = { files, lastAccess: 0, dirty: false };
    this.touch(bucket);
    this.cache.set(bucketId, bucket);
    await this.evictOverCapacity();
    return bucket;
  }

  // Evict least-recently-accessed buckets past capacity. Write-through
  // means the victim is normally clean — eviction is a plain cache
  // drop. A dirty victim (a previous flush failed) is flushed FIRST
  // via the same atomicWriteFile (§2.2 fallback); a flush failure
  // propagates and leaves the bucket cached — retried by the next
  // eviction or mutation.
  private async evictOverCapacity(): Promise<void> {
    while (this.cache.size > this.mruCapacity) {
      let victimId: string | null = null;
      let victimAccess = Infinity;
      for (const [id, bucket] of this.cache) {
        if (bucket.lastAccess < victimAccess) {
          victimAccess = bucket.lastAccess;
          victimId = id;
        }
      }
      if (victimId === null) return;
      const victim = this.cache.get(victimId)!;
      if (victim.dirty) await this.flushBucket(victimId, victim);
      this.cache.delete(victimId);
    }
  }

  // ---- single-path API (for genuinely single-path call sites) ----

  async get(path: string): Promise<FileBaseline | undefined> {
    const bucket = await this.loadBucket(bucketIdForPath(path));
    return bucket.files.get(path);
  }

  async set(path: string, entry: FileBaseline): Promise<void> {
    await this.setMany([{ path, ...entry }]);
  }

  async remove(path: string): Promise<void> {
    await this.removeMany([path]);
  }

  // ---- group API (§2.2.1 — the PRIMARY interface) ----

  // Group by bucket, open each bucket exactly once.
  async getMany(paths: string[]): Promise<Map<string, FileBaseline>> {
    const out = new Map<string, FileBaseline>();
    for (const [id, group] of groupByBucket(paths)) {
      const bucket = await this.loadBucket(id);
      for (const path of group) {
        const entry = bucket.files.get(path);
        if (entry !== undefined) out.set(path, entry);
      }
    }
    return out;
  }

  // Group by bucket; each touched bucket is mutated once and flushed
  // once (write-through).
  async setMany(
    entries: Array<{ path: string } & FileBaseline>,
  ): Promise<void> {
    const byBucket = new Map<string, Array<{ path: string } & FileBaseline>>();
    for (const e of entries) {
      const id = bucketIdForPath(e.path);
      const group = byBucket.get(id);
      if (group === undefined) byBucket.set(id, [e]);
      else group.push(e);
    }
    for (const [id, group] of byBucket) {
      const bucket = await this.loadBucket(id);
      for (const { path, baselineSha, mtime, size } of group) {
        bucket.files.set(path, { baselineSha, mtime, size });
      }
      bucket.dirty = true;
      await this.flushBucket(id, bucket);
    }
  }

  // Group by bucket; a bucket is only flushed when something was
  // actually removed from it.
  async removeMany(paths: string[]): Promise<void> {
    for (const [id, group] of groupByBucket(paths)) {
      const bucket = await this.loadBucket(id);
      let changed = false;
      for (const path of group) {
        if (bucket.files.delete(path)) changed = true;
      }
      if (changed) {
        bucket.dirty = true;
        await this.flushBucket(id, bucket);
      }
    }
  }

  // ---- full scans (§2.2.1) ----

  // Visit every bucket exactly once, in bucket order. Cached buckets
  // are served from cache (and touched); disk-only buckets are read
  // WITHOUT being inserted into the cache — a full scan must not
  // wipe the MRU working set.
  async forEachBucket(
    fn: (
      files: ReadonlyMap<string, FileBaseline>,
      bucketId: string,
    ) => void | Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < BASELINE_BUCKET_COUNT; i++) {
      const id = i.toString(16).padStart(2, "0");
      const cached = this.cache.get(id);
      if (cached !== undefined) {
        this.touch(cached);
        await fn(cached.files, id);
        continue;
      }
      const files = await this.readBucketFromDisk(id);
      if (files.size > 0) await fn(files, id);
    }
  }

  async allPaths(): Promise<string[]> {
    const out: string[] = [];
    await this.forEachBucket((files) => {
      for (const path of files.keys()) out.push(path);
    });
    return out;
  }

  // Wipe everything (reset flow). Drops the whole baselines dir and
  // the cache; the next access starts from empty.
  async clear(): Promise<void> {
    this.cache.clear();
    const dir = this.baselinesDir();
    if (await this.vault.adapter.exists(dir)) {
      await this.vault.adapter.rmdir(dir, true);
    }
  }

  private async ensureDir(): Promise<void> {
    const dir = this.baselinesDir();
    if (await this.vault.adapter.exists(dir)) return;
    let acc = "";
    for (const part of dir.split("/")) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }
}

function groupByBucket(paths: string[]): Map<string, string[]> {
  const byBucket = new Map<string, string[]>();
  for (const path of paths) {
    const id = bucketIdForPath(path);
    const group = byBucket.get(id);
    if (group === undefined) byBucket.set(id, [path]);
    else group.push(path);
  }
  return byBucket;
}
