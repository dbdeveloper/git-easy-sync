import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import BatchWriter from "../../src/sync2/batch-writer";
import { buildQueueShaIndex } from "../../src/sync2/queue-sha-index";
import { DELETED_SHA_HASH } from "../../src/sync2/discovery";
import { calculateGitBlobSHA } from "../../src/utils";
import type { FileChange } from "../../src/sync2/types";

// Phase 5.5 S1 — the findChanges dedup reference over the new queue
// format. Real composition: batches written by the REAL BatchWriter.

const PLUGIN_ID = "git-easy-sync";

describe("buildQueueShaIndex", () => {
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
    dir = mkdtempSync(path.join(tmpdir(), "queue-idx-test-"));
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

  it("empty queue (even without the dir) → null for everything", async () => {
    const idx = await buildQueueShaIndex(vault as never, PLUGIN_ID);
    expect(await idx.peekLatestPathSha("a.md")).toBeNull();
  });

  it("NEWEST batch wins per path; unqueued paths answer null", async () => {
    put("note.md", "v1\n");
    await writer().writeBatch([modified("note.md")]);
    put("note.md", "v2\n");
    await writer().writeBatch([modified("note.md")]);

    const idx = await buildQueueShaIndex(vault as never, PLUGIN_ID);
    expect(await idx.peekLatestPathSha("note.md")).toBe(
      await calculateGitBlobSHA(new TextEncoder().encode("v2\n").buffer as ArrayBuffer),
    );
    expect(await idx.peekLatestPathSha("other.md")).toBeNull();
  });

  it("§40 revert-class pin: a queued DELETION answers the DELETED sentinel, DISTINCT from null — delete-then-recreate-as-baseline must re-emit", async () => {
    put("note.md", "x\n");
    await writer().writeBatch([deleted("note.md")]);

    const idx = await buildQueueShaIndex(vault as never, PLUGIN_ID);
    const got = await idx.peekLatestPathSha("note.md");
    expect(got).toBe(DELETED_SHA_HASH);
    expect(got).not.toBeNull();
    // The detector compares current-file sha !== this value → a
    // re-created file (ANY content, incl. baseline content) differs
    // from the sentinel → emitted, not dedup-dropped.
  });

  it("a deletion in an OLDER batch is overwritten by a newer content entry (delete → recreate → commit)", async () => {
    put("note.md", "x\n");
    await writer().writeBatch([deleted("note.md")]);
    put("note.md", "recreated\n");
    await writer().writeBatch([modified("note.md")]);

    const idx = await buildQueueShaIndex(vault as never, PLUGIN_ID);
    expect(await idx.peekLatestPathSha("note.md")).toBe(
      await calculateGitBlobSHA(
        new TextEncoder().encode("recreated\n").buffer as ArrayBuffer,
      ),
    );
  });

  it("a torn metafile contributes nothing (repair is the claimer's job)", async () => {
    put("note.md", "x\n");
    const id = await writer().writeBatch([modified("note.md")]);
    const metaAbs = path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "push-queue",
      id!,
      "meta.json",
    );
    fs.writeFileSync(metaAbs, '{"v":1,');
    const idx = await buildQueueShaIndex(vault as never, PLUGIN_ID);
    expect(await idx.peekLatestPathSha("note.md")).toBeNull();
  });
});
