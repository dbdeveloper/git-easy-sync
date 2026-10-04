import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import BatchWriter from "../../src/sync2/batch-writer";
import ChangeDetector from "../../src/sync2/change-detector";
import HotMetadataStore from "../../src/sync2/hot-metadata";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import GI from "../../src/gi";
import { calculateGitBlobSHA } from "../../src/utils";
import { BATCH_META_FILE, parseBatchMetafile } from "../../src/sync2/batch-metafile";
import type WorkerClient from "../../src/worker/worker-client";
import {
  makeRealCpuWorkerClient,
  OVER_WORKER_THRESHOLD,
} from "../helpers/real-cpu-worker";

// The commit path on hashGitBlob, which MOVES each buffer to the worker
// and back (COMMIT-PASS-PERF, 2026-10-04). A caller that reads the
// buffer it handed over sees an EMPTY file — a 0-size metafile entry or
// a 0-byte blob under a real sha — and every other suite is blind to it
// (vitest's WorkerClient never transfers). Here the real detector,
// BatchWriter and SyncStore run against the REAL cpu-worker through a
// transfer-faithful harness, with files above the worker threshold so
// every hash actually crosses the boundary.

const PLUGIN_ID = "git-easy-sync";
const CONFIG_DIR = ".obsidian";

describe("commit path with the buffer moved to the worker and back", () => {
  let dir: string;
  let vault: Vault;
  let client: WorkerClient;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "commit-transfer-"));
    fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
    vault = new Vault(dir);
    client = makeRealCpuWorkerClient();
  });

  afterEach(() => {
    client.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  // Deterministic, NOT canonical-looking binary-ish content of `size`.
  const bigBinary = (seed: number, size = OVER_WORKER_THRESHOLD): Buffer => {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (i * 131 + seed) & 0xff;
    return b;
  };
  // A big TEXT file without its trailing newline: with the canonicalize
  // toggle ON it needs the write-back, so it takes the writer's own path.
  const bigTextNoNewline = (): string =>
    "line of text that is long enough\r\n".repeat(OVER_WORKER_THRESHOLD / 30).trimEnd();

  const put = (rel: string, content: Buffer | string): void => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  const world = async (canonicalize: boolean) => {
    const v = vault as unknown as import("obsidian").Vault;
    const syncStore = new SyncStore({ vault: v, selfPluginId: PLUGIN_ID });
    const hot = new HotMetadataStore({ vault: v, selfPluginId: PLUGIN_ID });
    await hot.load();
    const detector = new ChangeDetector({
      vault: v,
      hotMeta: hot,
      baselines: new FileBaselinesStore({ vault: v, selfPluginId: PLUGIN_ID }),
      gi: new GI(dir),
      configDir: CONFIG_DIR,
      selfPluginId: PLUGIN_ID,
      vaultRoot: dir,
      syncConfigDir: () => true,
      queue: { peekLatestPathSha: async () => null },
      syncStore,
      autoCanonicalize: () => canonicalize,
      hashBlob: (b) => client.hashGitBlob(b),
    });
    const writer = new BatchWriter({
      vault: v,
      selfPluginId: PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => canonicalize,
      workerClient: client,
    });
    return { syncStore, detector, writer };
  };

  // Every entry: size == the bytes on disk now, sha == their git sha,
  // and the stored blob IS those bytes. A detached buffer anywhere in
  // the chain breaks at least one of the three.
  const expectBatchMatchesDisk = async (id: string, store: SyncStore): Promise<void> => {
    const raw = fs.readFileSync(
      path.join(dir, CONFIG_DIR, "plugins", PLUGIN_ID, ".runtime", "push-queue", id, BATCH_META_FILE),
      "utf8",
    );
    const meta = parseBatchMetafile(raw)!;
    expect(meta.entries.length).toBeGreaterThan(0);
    for (const e of meta.entries) {
      const disk = fs.readFileSync(path.join(dir, e.path));
      const diskAb = disk.buffer.slice(disk.byteOffset, disk.byteOffset + disk.byteLength) as ArrayBuffer;
      expect(e.size, e.path).toBe(disk.byteLength);
      expect(e.sha, e.path).toBe(await calculateGitBlobSHA(diskAb));
      const blob = await store.getBlobFromSyncStore(e.sha!, new Set());
      expect(blob, e.path).not.toBeNull();
      expect(Buffer.from(blob!).equals(disk), e.path).toBe(true);
    }
  };

  it("first commit, toggle OFF: the detector's carried sha + stored bytes are the file's", async () => {
    put("a.png", bigBinary(1));
    put("b.bin", bigBinary(2, OVER_WORKER_THRESHOLD * 2));
    const w = await world(false);
    const changes = await w.detector.findChanges();
    expect(changes.every((c) => c.kind !== "deleted" && c.sha !== undefined)).toBe(true);
    const id = await w.writer.writeBatch(changes);
    await expectBatchMatchesDisk(id!, w.syncStore);
  });

  it("toggle ON, a big file owed its write-back: both writer sites (snapshot + blob pass) on moved buffers", async () => {
    put("long.md", bigTextNoNewline());
    const w = await world(true);
    const changes = await w.detector.findChanges();
    // Sha-less: the scan does not write the vault, the writer does.
    expect(changes).toHaveLength(1);
    expect("sha" in changes[0] && changes[0].sha).toBeFalsy();
    const id = await w.writer.writeBatch(changes);
    // The live file is canonical now, and the batch describes it.
    expect(fs.readFileSync(path.join(dir, "long.md"), "utf8").endsWith("\n")).toBe(true);
    await expectBatchMatchesDisk(id!, w.syncStore);
  });

  it("single-file sync of a NEW big file (sha-less): the writer hashes and stores the moved bytes correctly", async () => {
    put("new.bin", bigBinary(3));
    const w = await world(false);
    const one = await w.detector.findChangeForPath("new.bin");
    expect(one).not.toBeNull();
    const id = await w.writer.writeBatch([one!]);
    await expectBatchMatchesDisk(id!, w.syncStore);
  });
});
