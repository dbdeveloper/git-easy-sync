import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import FileBaselinesStore, {
  BASELINE_BUCKET_COUNT,
  bucketIdForPath,
  FileBaseline,
} from "../../src/sync2/file-baselines";

// Cold baseline buckets (METAFILE-REFACTOR §2.2 + group pattern
// §2.2.1). The load-bearing contracts:
//   - bucket isolation (a change touches ONE bucket file);
//   - the §2.2.1 group rule: N paths in K buckets = K reads/K writes;
//   - MRU recency = ANY access (cache hits refresh — anti-thrashing);
//   - write-through (dirty is an exception, eviction is a cache drop);
//   - full scans never displace the MRU working set.

const PLUGIN_ID = "git-easy-sync";

const entry = (sha: string): FileBaseline => ({
  baselineSha: sha,
  mtime: 111,
  size: 5,
});

// Deterministic helpers: find n paths that all land in DISTINCT
// buckets, or n paths that share ONE bucket. Search space is plain
// "note-<i>.md" names, so failures reproduce.
function pathsInDistinctBuckets(n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 10_000; i++) {
    const p = `note-${i}.md`;
    const id = bucketIdForPath(p);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  if (out.length < n) throw new Error("search space exhausted");
  return out;
}

function pathsInSameBucket(n: number): string[] {
  const byId = new Map<string, string[]>();
  for (let i = 0; i < 10_000; i++) {
    const p = `note-${i}.md`;
    const id = bucketIdForPath(p);
    const group = byId.get(id) ?? [];
    group.push(p);
    byId.set(id, group);
    if (group.length >= n) return group.slice(0, n);
  }
  throw new Error("search space exhausted");
}

describe("bucketIdForPath", () => {
  it("is deterministic and lands in [0, BUCKET_COUNT)", () => {
    for (let i = 0; i < 500; i++) {
      const id = bucketIdForPath(`dir/file-${i}.md`);
      expect(id).toBe(bucketIdForPath(`dir/file-${i}.md`));
      const idx = parseInt(id, 16);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(BASELINE_BUCKET_COUNT);
      expect(id).toHaveLength(2);
    }
  });
});

describe("FileBaselinesStore", () => {
  let dir: string;
  let vault: Vault;
  let store: FileBaselinesStore;

  const bucketFile = (bucketId: string): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "file-baselines",
      `${bucketId}.json`,
    );

  const freshStore = (mruCapacity?: number): FileBaselinesStore =>
    new FileBaselinesStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      mruCapacity,
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "file-baselines-test-"));
    vault = new Vault(dir);
    store = freshStore();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty store: get → undefined, allPaths → []", async () => {
    expect(await store.get("nope.md")).toBeUndefined();
    expect(await store.allPaths()).toEqual([]);
  });

  it("set/get round-trip, and a fresh instance reads it from disk", async () => {
    await store.set("a.md", entry("sha-a"));
    expect(await store.get("a.md")).toEqual(entry("sha-a"));

    const fresh = freshStore();
    expect(await fresh.get("a.md")).toEqual(entry("sha-a"));
    expect(await fresh.allPaths()).toEqual(["a.md"]);
  });

  it("bucket isolation: a change to one path never rewrites another bucket's file", async () => {
    const [p1, p2] = pathsInDistinctBuckets(2);
    await store.set(p1, entry("s1"));
    await store.set(p2, entry("s2"));
    const b2Bytes = fs.readFileSync(bucketFile(bucketIdForPath(p2)), "utf8");

    await store.set(p1, entry("s1-updated"));
    expect(fs.readFileSync(bucketFile(bucketIdForPath(p2)), "utf8")).toBe(
      b2Bytes,
    );
    expect(await store.get(p1)).toEqual(entry("s1-updated"));
  });

  it("§2.2.1 group contract: N paths in K buckets = K bucket writes / K bucket reads", async () => {
    // 3 buckets: 3 + 3 + 4 paths (the owner's worked example:
    // 10 files whose metadata lives in 3 hash-files → 3 opens,
    // never 10). Build three disjoint same-bucket groups from the
    // deterministic note-<i>.md space.
    const groups = new Map<string, string[]>();
    for (let i = 0; i < 10_000; i++) {
      const p = `note-${i}.md`;
      const id = bucketIdForPath(p);
      if (!groups.has(id) && groups.size >= 3) continue;
      const g = groups.get(id) ?? [];
      g.push(p);
      groups.set(id, g);
      const sizes = [...groups.values()].map((v) => v.length);
      if (groups.size === 3 && sizes.every((n) => n >= 4)) break;
    }
    const [g1, g2, g3] = [...groups.values()];
    const ten = [...g1.slice(0, 3), ...g2.slice(0, 3), ...g3.slice(0, 4)];
    expect(ten).toHaveLength(10);
    expect(new Set(ten.map(bucketIdForPath)).size).toBe(3);

    await store.setMany(ten.map((p, i) => ({ path: p, ...entry(`s${i}`) })));
    expect(store.stats.bucketWrites).toBe(3);
    expect(store.stats.bucketReads).toBe(3); // each bucket loaded once

    const fresh = freshStore();
    const got = await fresh.getMany(ten);
    expect(got.size).toBe(ten.length);
    expect(fresh.stats.bucketReads).toBe(3); // grouped read, not 10
  });

  it("getMany omits missing paths but still costs K bucket reads", async () => {
    const [p1, p2] = pathsInSameBucket(2);
    const [pOther] = pathsInDistinctBuckets(2).filter(
      (p) => bucketIdForPath(p) !== bucketIdForPath(p1),
    );
    await store.setMany([{ path: p1, ...entry("s1") }]);

    const fresh = freshStore();
    // p2 (same bucket, absent) + pOther (other bucket, absent): the
    // result carries only p1, the read cost is 2 buckets — one per
    // touched bucket, absent paths add nothing.
    const got = await fresh.getMany([p1, p2, pOther]);
    expect([...got.keys()]).toEqual([p1]);
    expect(fresh.stats.bucketReads).toBe(2);
  });

  it("removeMany across several buckets = one write per touched bucket", async () => {
    const [pA, pB] = pathsInDistinctBuckets(2);
    await store.setMany([
      { path: pA, ...entry("a") },
      { path: pB, ...entry("b") },
    ]);
    const writesBefore = store.stats.bucketWrites;
    await store.removeMany([pA, pB]);
    expect(store.stats.bucketWrites).toBe(writesBefore + 2);
    const fresh = freshStore();
    expect(await fresh.get(pA)).toBeUndefined();
    expect(await fresh.get(pB)).toBeUndefined();
  });

  it("MRU: recency is ANY access — a cache-hit bucket survives, the stale one is evicted", async () => {
    const small = freshStore(2); // capacity 2 for a deterministic test
    const [pA, pB, pC] = pathsInDistinctBuckets(3);
    await small.set(pA, entry("a")); // cache: A
    await small.set(pB, entry("b")); // cache: A,B
    const readsBefore = small.stats.bucketReads;

    // Touch A via a cache hit (no disk read).
    expect(await small.get(pA)).toEqual(entry("a"));
    expect(small.stats.bucketReads).toBe(readsBefore);

    // Load C → capacity exceeded → the least-recent is B (A was just
    // touched), so B is evicted.
    await small.set(pC, entry("c"));

    // A still cached: no disk read. B evicted: disk read.
    const reads1 = small.stats.bucketReads;
    await small.get(pA);
    expect(small.stats.bucketReads).toBe(reads1);
    await small.get(pB);
    expect(small.stats.bucketReads).toBe(reads1 + 1);
  });

  it("write-through: disk reflects a set immediately; evicting a clean bucket writes nothing", async () => {
    const small = freshStore(1);
    const [pA, pB] = pathsInDistinctBuckets(2);
    await small.set(pA, entry("a"));
    // On disk already (write-through), before any eviction:
    const raw = JSON.parse(
      fs.readFileSync(bucketFile(bucketIdForPath(pA)), "utf8"),
    );
    expect(raw.files[pA].baselineSha).toBe("a");

    const writesBefore = small.stats.bucketWrites;
    await small.get(pB); // loads B's bucket → evicts A's (clean)
    expect(small.stats.bucketWrites).toBe(writesBefore); // eviction wrote nothing
  });

  it("dirty-eviction fallback: a failed flush leaves the bucket dirty; eviction flushes it before dropping", async () => {
    const small = freshStore(1);
    const [pA, pB] = pathsInDistinctBuckets(2);

    // Fail the flush once: setMany mutates in memory, flush throws.
    const realAdapter = vault.adapter;
    const spy = vi.spyOn(vault, "adapter", "get").mockReturnValue({
      ...realAdapter,
      write: async () => {
        throw new Error("disk full");
      },
      writeBinary: async () => {
        throw new Error("disk full");
      },
    } as never);
    await expect(small.set(pA, entry("a"))).rejects.toThrow("disk full");
    spy.mockRestore();

    // The mutation is retained in cache (dirty), not silently lost:
    expect(await small.get(pA)).toEqual(entry("a"));
    expect(fs.existsSync(bucketFile(bucketIdForPath(pA)))).toBe(false);

    // Forcing an eviction (loading another bucket past capacity 1)
    // flushes the dirty bucket first — the data lands on disk.
    await small.get(pB);
    const raw = JSON.parse(
      fs.readFileSync(bucketFile(bucketIdForPath(pA)), "utf8"),
    );
    expect(raw.files[pA].baselineSha).toBe("a");
  });

  it("corrupt bucket file reads as empty (degraded mode) and heals on the next set", async () => {
    await store.set("a.md", entry("good"));
    fs.writeFileSync(bucketFile(bucketIdForPath("a.md")), '{"files": {"a.m');

    const fresh = freshStore();
    expect(await fresh.get("a.md")).toBeUndefined();
    await fresh.set("a.md", entry("healed"));
    expect(await freshStore().get("a.md")).toEqual(entry("healed"));
  });

  it("removeMany persists; removing absent paths writes nothing", async () => {
    const [p1, p2] = pathsInSameBucket(2);
    await store.setMany([
      { path: p1, ...entry("s1") },
      { path: p2, ...entry("s2") },
    ]);
    await store.removeMany([p1]);
    const fresh = freshStore();
    expect(await fresh.get(p1)).toBeUndefined();
    expect(await fresh.get(p2)).toEqual(entry("s2"));

    const writesBefore = store.stats.bucketWrites;
    await store.removeMany(["never-existed.md"]);
    expect(store.stats.bucketWrites).toBe(writesBefore);
  });

  it("forEachBucket sees cached AND disk-only buckets, without displacing the MRU working set", async () => {
    const small = freshStore(1);
    const [pA, pB] = pathsInDistinctBuckets(2);
    // Put B on disk via a separate instance, keep A cached in `small`.
    await freshStore().set(pB, entry("b"));
    await small.set(pA, entry("a")); // small's cache: A only

    const seen = new Map<string, string>();
    await small.forEachBucket((files) => {
      for (const [p, e] of files) seen.set(p, e.baselineSha);
    });
    expect(seen.get(pA)).toBe("a");
    expect(seen.get(pB)).toBe("b");

    // The scan must not have inserted B into the cache: A is still a
    // cache hit (no disk read), B still costs one.
    const reads = small.stats.bucketReads;
    await small.get(pA);
    expect(small.stats.bucketReads).toBe(reads);
    await small.get(pB);
    expect(small.stats.bucketReads).toBe(reads + 1);
  });

  it("clear wipes the directory and the cache", async () => {
    await store.set("a.md", entry("a"));
    await store.clear();
    expect(await store.get("a.md")).toBeUndefined();
    expect(await store.allPaths()).toEqual([]);
    expect(
      fs.existsSync(
        path.join(
          dir,
          ".obsidian",
          "plugins",
          PLUGIN_ID,
          ".runtime",
          "file-baselines",
        ),
      ),
    ).toBe(false);
  });
});
