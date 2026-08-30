import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import BatchWriter from "../../src/sync2/batch-writer";
import BatchClaimer from "../../src/sync2/get-batch";
import {
  ATTEMPTED_COMMIT_MARKER,
  ATTEMPTED_MARKER,
  BATCH_META_FILE,
  BatchMetafile,
  parseBatchMetafile,
} from "../../src/sync2/batch-metafile";
import { calculateGitBlobSHA } from "../../src/utils";
import { FileChange } from "../../src/sync2/types";

// Phase 2 group B — the COMMIT side of the new batch format
// (MASTER-PLAN §2.2). Pins the §12.4 write order, the R3b
// commit-side claim, the §7.2 mtime-through-consolidation fix and
// the §7.3 explicit path dedup (§VIII L), plus the crash pairing
// with BatchClaimer's recovery.

const PLUGIN_ID = "git-easy-sync";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("BatchWriter (Phase 2 group B)", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let warnings: string[];
  let clock: number;

  const queueAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "push-queue");
  const storeAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "sync_store");

  const makeWriter = (opts?: {
    autoCanonicalize?: boolean;
    vault?: unknown;
    syncStore?: SyncStore;
  }): BatchWriter =>
    new BatchWriter({
      vault: (opts?.vault ?? vault) as never,
      selfPluginId: PLUGIN_ID,
      syncStore: opts?.syncStore ?? syncStore,
      autoCanonicalize: () => opts?.autoCanonicalize ?? true,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
      // Advancing clock: unique ids without real-time collisions.
      now: () => new Date((clock += 1000)),
    });

  // The mock Vault's `get adapter()` mints a FRESH object per access,
  // so stubbing instance methods is a no-op. This wrapper exposes a
  // STABLE proxy adapter that logs each op and lets a test override
  // individual methods.
  type AnyFn = (...a: unknown[]) => unknown;
  const wrapVault = (
    overrides: Record<string, AnyFn> = {},
    ops?: string[],
  ): unknown => {
    const adapter = new Proxy(
      {},
      {
        get: (_t, m: string) => {
          return (...a: unknown[]) => {
            if (ops && typeof a[0] === "string") ops.push(`${m}:${a[0]}`);
            const ov = overrides[m];
            if (ov) return ov(...a);
            return (
              vault.adapter as unknown as Record<string, AnyFn>
            )[m](...a);
          };
        },
      },
    );
    return { configDir: vault.configDir, adapter };
  };

  const modified = (p: string): FileChange => ({
    kind: "modified",
    path: p,
    size: 0,
    mtime: 0,
    previousRemoteSha: "prev",
  });
  const deleted = (p: string): FileChange => ({
    kind: "deleted",
    path: p,
    previousRemoteSha: "prev",
  });

  const putVaultFile = (p: string, content: string, mtimeMs?: number): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    if (mtimeMs !== undefined) {
      fs.utimesSync(abs, mtimeMs / 1000, mtimeMs / 1000);
    }
  };

  const readMeta = (id: string): BatchMetafile => {
    const raw = fs.readFileSync(
      path.join(queueAbs(), id, BATCH_META_FILE),
      "utf8",
    );
    const meta = parseBatchMetafile(raw);
    expect(meta).not.toBeNull();
    return meta!;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "batch-writer-test-"));
    vault = new Vault(dir);
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    warnings = [];
    clock = Date.UTC(2026, 7, 30, 12, 0, 0);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── writeBatch basics ─────────────────────────────────────────────

  it("writeBatch: meta.json entries carry {path, sha, size, mtime}; bytes land in sync_store; no markers left", async () => {
    putVaultFile("note.md", "hello\n", 1_700_000_000_000);
    const id = await makeWriter().writeBatch([modified("note.md")]);
    expect(id).toMatch(/^\d{17}$/);

    const meta = readMeta(id!);
    expect(meta.id).toBe(id);
    expect(meta.entries).toHaveLength(1);
    const entry = meta.entries[0];
    const expectedSha = await calculateGitBlobSHA(enc("hello\n"));
    expect(entry).toEqual({
      path: "note.md",
      sha: expectedSha,
      size: 6,
      mtime: 1_700_000_000_000,
    });

    expect(fs.existsSync(path.join(storeAbs(), expectedSha))).toBe(true);
    expect(
      fs.existsSync(path.join(queueAbs(), id!, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false);
    // The batch dir holds exactly meta.json — no vault/ copy, no
    // deleted-paths.txt.
    expect(fs.readdirSync(path.join(queueAbs(), id!))).toEqual([
      BATCH_META_FILE,
    ]);
  });

  it("writeBatch: a deletion is the sha:null sentinel entry — no blob written", async () => {
    const id = await makeWriter().writeBatch([deleted("gone.md")]);
    const meta = readMeta(id!);
    expect(meta.entries).toEqual([
      { path: "gone.md", sha: null, size: null, mtime: null },
    ]);
    expect(fs.existsSync(storeAbs())).toBe(false);
  });

  it("writeBatch: empty changes → null, nothing on disk", async () => {
    expect(await makeWriter().writeBatch([])).toBeNull();
    expect(fs.existsSync(queueAbs())).toBe(false);
  });

  it("writeBatch: file vanished between detection and commit → entry skipped LOUDLY, rest survives", async () => {
    putVaultFile("stays.md", "a\n");
    const id = await makeWriter().writeBatch([
      modified("stays.md"),
      modified("ghost.md"),
    ]);
    const meta = readMeta(id!);
    expect(meta.entries.map((e) => e.path)).toEqual(["stays.md"]);
    expect(warnings.some((w) => w.includes("file gone"))).toBe(true);
  });

  // ── §12.4 order + R3b claim ───────────────────────────────────────

  it("§12.4: .attempted-commit first, meta.json before ANY sync_store blob, marker removed last", async () => {
    putVaultFile("a.md", "aaa\n");
    putVaultFile("b.png", "\x89PNG-bytes");
    const ops: string[] = [];
    const instrumented = wrapVault({}, ops);
    // The SyncStore must ride the SAME instrumented vault so blob
    // writes land in the op log too.
    const loggedStore = new SyncStore({
      vault: instrumented as never,
      selfPluginId: PLUGIN_ID,
    });

    const id = await makeWriter({
      vault: instrumented,
      syncStore: loggedStore,
    }).writeBatch([modified("a.md"), modified("b.png")]);

    const queueOps = ops.filter((o) => o.includes(".runtime"));
    const markerWrite = queueOps.findIndex(
      (o) => o.startsWith("write:") && o.includes(ATTEMPTED_COMMIT_MARKER),
    );
    const metaWrite = queueOps.findIndex(
      (o) => o.startsWith("write:") && o.includes(BATCH_META_FILE),
    );
    const firstBlob = queueOps.findIndex((o) => o.includes("sync_store"));
    const markerRemove = queueOps.findIndex(
      (o) => o.startsWith("remove:") && o.includes(ATTEMPTED_COMMIT_MARKER),
    );
    expect(markerWrite).toBeGreaterThanOrEqual(0);
    expect(metaWrite).toBeGreaterThan(markerWrite);
    expect(firstBlob).toBeGreaterThan(metaWrite);
    expect(markerRemove).toBeGreaterThan(firstBlob);
    expect(id).not.toBeNull();
  });

  it("sync_store dedup: a blob already present is not rewritten", async () => {
    putVaultFile("one.md", "same\n");
    putVaultFile("two.md", "same\n");
    let saves = 0;
    const origSave = syncStore.saveBlobToSyncStore.bind(syncStore);
    syncStore.saveBlobToSyncStore = async (sha, bytes) => {
      saves += 1;
      return origSave(sha, bytes);
    };
    await makeWriter().writeBatch([modified("one.md"), modified("two.md")]);
    expect(saves).toBe(1); // identical content → one blob
  });

  // ── crash pairing with BatchClaimer (RED-first for the §12.4 gap) ──

  it("crash between meta.json and blobs → claimer's onload recovery repairs from the live vault", async () => {
    putVaultFile("big.md", "content-v1\n");
    const origSave = syncStore.saveBlobToSyncStore.bind(syncStore);
    syncStore.saveBlobToSyncStore = async () => {
      throw new Error("power loss");
    };
    await expect(
      makeWriter().writeBatch([modified("big.md")]),
    ).rejects.toThrow("power loss");

    // The torn state §12.4 promises: manifest complete, marker
    // standing, blob missing.
    const ids = fs.readdirSync(queueAbs());
    expect(ids).toHaveLength(1);
    const batchDir = path.join(queueAbs(), ids[0]);
    expect(fs.existsSync(path.join(batchDir, ATTEMPTED_COMMIT_MARKER))).toBe(
      true,
    );
    expect(fs.existsSync(storeAbs())).toBe(false);

    syncStore.saveBlobToSyncStore = origSave;
    const claimer = new BatchClaimer({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    await claimer.recoverStaleCommitClaims();

    expect(fs.existsSync(path.join(batchDir, ATTEMPTED_COMMIT_MARKER))).toBe(
      false,
    );
    const sha = await calculateGitBlobSHA(enc("content-v1\n"));
    expect(fs.existsSync(path.join(storeAbs(), sha))).toBe(true);

    const claimed = await claimer.getBatch();
    expect(claimed!.meta.entries).toHaveLength(1);
    expect(claimed!.meta.entries[0].sha).toBe(sha);
  });

  it("crash: an entry whose blob already LANDED needs no repair — it survives a later vault edit; the unlanded one repairs from the unchanged vault", async () => {
    putVaultFile("volatile.md", "v1\n");
    putVaultFile("stable.md", "s\n");
    const origSave = syncStore.saveBlobToSyncStore.bind(syncStore);
    let failed = false;
    syncStore.saveBlobToSyncStore = async (sha, bytes) => {
      // First blob succeeds, second "crashes" — order within the
      // batch is entry order (stable.md listed second below).
      if (failed) throw new Error("power loss");
      failed = true;
      return origSave(sha, bytes);
    };
    await expect(
      makeWriter().writeBatch([modified("volatile.md"), modified("stable.md")]),
    ).rejects.toThrow("power loss");
    syncStore.saveBlobToSyncStore = origSave;

    putVaultFile("volatile.md", "v2 — changed after the crash\n");

    const claimer = new BatchClaimer({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    await claimer.recoverStaleCommitClaims();
    const claimed = await claimer.getBatch();
    const paths = claimed!.meta.entries.map((e) => e.path);
    // volatile.md was the one whose blob landed before the crash —
    // it needs no repair. stable.md's blob is repairable from the
    // unchanged vault copy. Neither is dropped here; the drop case
    // needs BOTH a missing blob AND a changed vault file:
    expect(paths).toContain("stable.md");
    expect(paths).toContain("volatile.md");
  });

  it("crash where the missing blob's vault file changed → THAT entry is dropped", async () => {
    putVaultFile("volatile.md", "v1\n");
    syncStore.saveBlobToSyncStore = async () => {
      throw new Error("power loss");
    };
    await expect(
      makeWriter().writeBatch([modified("volatile.md")]),
    ).rejects.toThrow("power loss");
    syncStore.saveBlobToSyncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    }).saveBlobToSyncStore.bind(syncStore);

    putVaultFile("volatile.md", "v2 — different size\n");

    const claimer = new BatchClaimer({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    await claimer.recoverStaleCommitClaims();
    const claimed = await claimer.getBatch();
    expect(claimed!.meta.entries).toHaveLength(0); // П11 empty-batch skip is the caller's job
    expect(warnings.some((w) => w.includes("unrepairable"))).toBe(true);
  });

  // ── §7.3 explicit dedup (§VIII L) ────────────────────────────────

  it("§7.3: duplicate paths in one writeBatch dedupe explicitly, last wins", async () => {
    putVaultFile("dup.md", "final\n");
    const id = await makeWriter().writeBatch([
      modified("dup.md"),
      deleted("dup.md"),
      modified("dup.md"),
    ]);
    const meta = readMeta(id!);
    expect(meta.entries).toHaveLength(1);
    expect(meta.entries[0].sha).toBe(await calculateGitBlobSHA(enc("final\n")));
  });

  it("§7.3: modified-then-deleted collapses to the single sha:null entry", async () => {
    putVaultFile("doomed.md", "x\n");
    const id = await makeWriter().writeBatch([
      modified("doomed.md"),
      deleted("doomed.md"),
    ]);
    expect(readMeta(id!).entries).toEqual([
      { path: "doomed.md", sha: null, size: null, mtime: null },
    ]);
  });

  // ── consolidateIntoTail ──────────────────────────────────────────

  it("consolidateIntoTail: appends new paths, replaces same-path entries in place (no duplicates)", async () => {
    putVaultFile("a.md", "a1\n");
    const writer = makeWriter();
    const id = await writer.writeBatch([modified("a.md")]);

    putVaultFile("a.md", "a2\n");
    putVaultFile("b.md", "b\n");
    const target = await writer.consolidateIntoTail([
      modified("a.md"),
      modified("b.md"),
    ]);
    expect(target).toBe(id);

    const meta = readMeta(id!);
    expect(meta.entries.map((e) => e.path)).toEqual(["a.md", "b.md"]);
    expect(meta.entries[0].sha).toBe(await calculateGitBlobSHA(enc("a2\n")));
    // Both content generations remain in the store — a1 is still
    // referenced by nothing but harmless until a sweep (Phase 4).
    expect(
      fs.existsSync(
        path.join(storeAbs(), await calculateGitBlobSHA(enc("a2\n"))),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(queueAbs(), id!, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false);
  });

  it("§7.2: consolidation refreshes mtime for the path it touches", async () => {
    putVaultFile("note.md", "v1\n", 1_700_000_000_000);
    const writer = makeWriter();
    const id = await writer.writeBatch([modified("note.md")]);
    expect(readMeta(id!).entries[0].mtime).toBe(1_700_000_000_000);

    putVaultFile("note.md", "v2\n", 1_700_000_999_000);
    await writer.consolidateIntoTail([modified("note.md")]);
    expect(readMeta(id!).entries[0].mtime).toBe(1_700_000_999_000);
  });

  it("consolidateIntoTail: modified→deleted transition replaces the upload entry with the sentinel", async () => {
    putVaultFile("note.md", "v1\n");
    const writer = makeWriter();
    const id = await writer.writeBatch([modified("note.md")]);
    await writer.consolidateIntoTail([deleted("note.md")]);
    expect(readMeta(id!).entries).toEqual([
      { path: "note.md", sha: null, size: null, mtime: null },
    ]);
  });

  it("consolidateIntoTail: empty queue → null; caller appends instead", async () => {
    putVaultFile("a.md", "a\n");
    expect(await makeWriter().consolidateIntoTail([modified("a.md")])).toBe(
      null,
    );
    expect(fs.existsSync(queueAbs())).toBe(false);
  });

  it("R3b: tail claimed by the drain (.attempted) → back off, release own marker, tail untouched", async () => {
    putVaultFile("a.md", "a1\n");
    const writer = makeWriter();
    const id = await writer.writeBatch([modified("a.md")]);
    const before = fs.readFileSync(
      path.join(queueAbs(), id!, BATCH_META_FILE),
      "utf8",
    );
    fs.writeFileSync(path.join(queueAbs(), id!, ATTEMPTED_MARKER), "");

    putVaultFile("a.md", "a2\n");
    expect(await writer.consolidateIntoTail([modified("a.md")])).toBeNull();

    expect(
      fs.existsSync(path.join(queueAbs(), id!, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(queueAbs(), id!, BATCH_META_FILE), "utf8"),
    ).toBe(before);
  });

  it("R3b: only the TAIL is considered — older pending batches are never touched", async () => {
    putVaultFile("a.md", "a\n");
    putVaultFile("b.md", "b\n");
    const writer = makeWriter();
    const first = await writer.writeBatch([modified("a.md")]);
    const second = await writer.writeBatch([modified("b.md")]);

    putVaultFile("a.md", "a-updated\n");
    const target = await writer.consolidateIntoTail([modified("a.md")]);
    expect(target).toBe(second); // folded into the tail, NOT into first
    expect(readMeta(first!).entries.map((e) => e.path)).toEqual(["a.md"]);
    expect(readMeta(second!).entries.map((e) => e.path)).toEqual([
      "b.md",
      "a.md",
    ]);
  });

  it("batch cap: consolidation that would exceed 100 paths → back off (split), tail untouched; same-path replacement does NOT count against the cap", async () => {
    const writer = makeWriter();
    // Tail at exactly the cap.
    const first = Array.from({ length: 100 }, (_, i) => {
      putVaultFile(`f-${i}.md`, `v${i}\n`);
      return modified(`f-${i}.md`);
    });
    const id = await writer.writeBatch(first);
    expect(readMeta(id!).entries).toHaveLength(100);

    // Same-path replacement: count stays 100 → merges fine.
    putVaultFile("f-0.md", "v0-updated\n");
    expect(await writer.consolidateIntoTail([modified("f-0.md")])).toBe(id);
    expect(readMeta(id!).entries).toHaveLength(100);

    // A genuinely new path would make 101 → back off, marker released,
    // tail byte-identical; the caller appends a fresh batch.
    const before = fs.readFileSync(
      path.join(queueAbs(), id!, BATCH_META_FILE),
      "utf8",
    );
    putVaultFile("new.md", "new\n");
    expect(await writer.consolidateIntoTail([modified("new.md")])).toBeNull();
    expect(
      fs.readFileSync(path.join(queueAbs(), id!, BATCH_META_FILE), "utf8"),
    ).toBe(before);
    expect(
      fs.existsSync(path.join(queueAbs(), id!, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false);
  });

  it("consolidateIntoTail: corrupt tail metafile → back off cleanly (repair is the claimer's job)", async () => {
    putVaultFile("a.md", "a\n");
    const writer = makeWriter();
    const id = await writer.writeBatch([modified("a.md")]);
    fs.writeFileSync(
      path.join(queueAbs(), id!, BATCH_META_FILE),
      "{ torn json",
    );
    expect(await writer.consolidateIntoTail([modified("a.md")])).toBeNull();
    expect(
      fs.existsSync(path.join(queueAbs(), id!, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false);
    expect(warnings.some((w) => w.includes("unreadable"))).toBe(true);
  });

  // ── canonicalization + size semantics ────────────────────────────

  it("text canonicalization: CRLF/multibyte → LF bytes stored; size is BYTE length; live file written back", async () => {
    putVaultFile("ua.md", "як\r\nтак"); // 2-byte chars + CRLF, no trailing NL
    const id = await makeWriter().writeBatch([modified("ua.md")]);
    const canonical = "як\nтак\n";
    const sha = await calculateGitBlobSHA(enc(canonical));
    const entry = readMeta(id!).entries[0];
    expect(entry.sha).toBe(sha);
    expect(entry.size).toBe(new TextEncoder().encode(canonical).byteLength);
    expect(fs.existsSync(path.join(storeAbs(), sha))).toBe(true);
    // Write-back: the live vault file is canonical now.
    expect(fs.readFileSync(path.join(dir, "ua.md"), "utf8")).toBe(canonical);
  });

  it("autoCanonicalize off → byte-exact snapshot, no write-back", async () => {
    putVaultFile("raw.md", "a\r\nb");
    const id = await makeWriter({ autoCanonicalize: false }).writeBatch([
      modified("raw.md"),
    ]);
    const sha = await calculateGitBlobSHA(enc("a\r\nb"));
    expect(readMeta(id!).entries[0].sha).toBe(sha);
    expect(fs.readFileSync(path.join(dir, "raw.md"), "utf8")).toBe("a\r\nb");
  });

  it("file mutated between hash pass and blob pass → entry dropped LOUDLY, store never poisoned", async () => {
    putVaultFile("hot.md", "pass1\n");
    let reads = 0;
    const mutatingVault = wrapVault({
      read: async (p: unknown) => {
        if (p === "hot.md") {
          reads += 1;
          // Simulate a live edit landing between the two passes.
          if (reads === 2) return "pass2 — mutated\n";
        }
        return (vault.adapter as { read: (q: string) => Promise<string> }).read(
          p as string,
        );
      },
    });

    const id = await makeWriter({ vault: mutatingVault }).writeBatch([
      modified("hot.md"),
    ]);
    expect(readMeta(id!).entries).toHaveLength(0);
    expect(fs.existsSync(storeAbs())).toBe(false);
    expect(warnings.some((w) => w.includes("between hash and blob"))).toBe(
      true,
    );
  });
});
