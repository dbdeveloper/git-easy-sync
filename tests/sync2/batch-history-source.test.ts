import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import BatchWriter from "../../src/sync2/batch-writer";
import BatchHistorySource from "../../src/sync2/batch-history-source";
import type { FileChange } from "../../src/sync2/types";
import {
  enumeratePushQueueVersions,
  mergeVersionList,
} from "../../src/diff2/history-versions";

// Phase 5.5 step 3c — the History timeline's local-version reader over
// the NEW queue format. Real composition: batches are written by the
// REAL BatchWriter, then read back through BatchHistorySource AND
// through diff2's enumeratePushQueueVersions (the QueueVersionSource
// contract) — no stub batches.

const PLUGIN_ID = "git-easy-sync";

describe("BatchHistorySource", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let clock: number;

  const writer = (): BatchWriter =>
    new BatchWriter({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => false,
      logger: { info: () => {}, warn: () => {} },
      now: () => new Date((clock += 1000)),
    });

  const source = (): BatchHistorySource =>
    new BatchHistorySource({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
    });

  const put = (p: string, content: string): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
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

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "batch-hist-test-"));
    vault = new Vault(dir);
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    clock = Date.UTC(2026, 7, 31, 12, 0, 0);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty queue → list [] (also when the queue dir never existed)", async () => {
    expect(await source().list()).toEqual([]);
  });

  it("real composition: BatchWriter-written batches enumerate as history versions with createdAt + files; bytes round-trip from sync_store", async () => {
    put("note.md", "v1 content\n");
    const id1 = (await writer().writeBatch([modified("note.md")]))!;
    put("note.md", "v2 content\n");
    put("other.md", "other\n");
    const id2 = (await writer().writeBatch([
      modified("note.md"),
      modified("other.md"),
    ]))!;

    const s = source();
    expect(await s.list()).toEqual([id1, id2]); // lexicographic = chronological

    const b2 = await s.read(id2);
    expect(b2.createdAt).toBeGreaterThan(0);
    expect(b2.files.sort()).toEqual(["note.md", "other.md"]);

    // diff2's QueueVersionSource contract over the same instance.
    const versions = await enumeratePushQueueVersions(s, "note.md", "this-dev");
    expect(versions.map((v) => v.id)).toEqual([id1, id2]);
    expect(versions.every((v) => v.local)).toBe(true);
    const merged = mergeVersionList(versions, []);
    expect(merged[0].id).toBe(id2); // newest-first

    // Bytes come back exactly as snapshotted, per batch (the queue
    // held TWO versions of note.md at once — content-addressed store).
    const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
    expect(dec(await s.readFileBytes(id1, "note.md"))).toBe("v1 content\n");
    expect(dec(await s.readFileBytes(id2, "note.md"))).toBe("v2 content\n");
  });

  it("a deletion entry is NOT a version: excluded from files, and its bytes throw loudly", async () => {
    put("note.md", "content\n");
    const id = (await writer().writeBatch([
      modified("note.md"),
      deleted("gone.md"),
    ]))!;

    const s = source();
    const b = await s.read(id);
    expect(b.files).toEqual(["note.md"]); // no gone.md
    await expect(s.readFileBytes(id, "gone.md")).rejects.toThrow(
      /no content/,
    );
    await expect(s.readFileBytes(id, "never-there.md")).rejects.toThrow();
  });

  it("a torn metafile contributes an EMPTY batch (repair is the claimer's job, History never races it)", async () => {
    put("note.md", "x\n");
    const id = (await writer().writeBatch([modified("note.md")]))!;
    // Tear the metafile the way a crash would.
    const metaAbs = path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "push-queue",
      id,
      "meta.json",
    );
    fs.writeFileSync(metaAbs, '{"v":1,"id":');

    const s = source();
    expect((await s.read(id)).files).toEqual([]); // no versions, no throw
    await expect(s.readFileBytes(id, "note.md")).rejects.toThrow();
    // And the batch dir is UNTOUCHED — read-only contract.
    expect(fs.existsSync(metaAbs)).toBe(true);
  });

  it("a corrupted sync_store blob throws instead of serving wrong bytes (hash-on-read)", async () => {
    put("note.md", "true content\n");
    const id = (await writer().writeBatch([modified("note.md")]))!;
    // Corrupt the blob behind the sha.
    const storeDir = path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "sync_store",
    );
    const blobs = fs.readdirSync(storeDir);
    expect(blobs.length).toBeGreaterThan(0);
    fs.writeFileSync(path.join(storeDir, blobs[0]), "garbage");

    await expect(source().readFileBytes(id, "note.md")).rejects.toThrow();
  });
});
