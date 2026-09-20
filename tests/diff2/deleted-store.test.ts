import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DeletedStore from "../../src/diff2/deleted-store";
import { calculateGitBlobSHA } from "../../src/utils";

// The re-platformed Deleted bin (HISTORY-DELETED §5.2.1): bytes in the
// content-addressed sync_store, one flat deleted.json as the index.

const PLUGIN_ID = "git-easy-sync";
const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("DeletedStore (§5.2.1)", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let store: DeletedStore;

  const storeAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "sync_store");
  const indexAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "deleted.json");
  const put = (p: string, content: string): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "deleted-store-test-"));
    fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
    vault = new Vault(dir);
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    store = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
    });
    await store.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── the order is the safety (replaces trash-recovery case A) ──────

  it("🔑 the record is DURABLE before the caller may remove the file", async () => {
    // This is the whole safety argument of the re-platform. The old bin
    // wrote bytes first and metadata second, and a crash in between
    // needed a recovery pass that RESTORED the bytes into the vault.
    // That is impossible here — a content-addressed blob carries no
    // path — so instead nothing irreversible may happen until the
    // record is on disk. `captureForDelete` resolving is the caller's
    // signal that it is safe to delete.
    put("note.md", "live content\n");
    await store.captureForDelete("note.md");

    // On DISK, not just in memory: a crash right here must still find it.
    const onDisk = JSON.parse(fs.readFileSync(indexAbs(), "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].path).toBe("note.md");
    // …and the file the caller is about to remove is still untouched.
    expect(fs.existsSync(path.join(dir, "note.md"))).toBe(true);
    // …with its bytes already parked under their own sha.
    const sha = await calculateGitBlobSHA(enc("live content\n"));
    expect(fs.existsSync(path.join(storeAbs(), sha))).toBe(true);
    expect(onDisk[0].sha).toBe(sha);
  });

  it("capture of a vanished path records nothing (and does not throw)", async () => {
    expect(await store.captureForDelete("ghost.md")).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("content-addressed: the same content deleted twice costs ONE blob", async () => {
    put("a.md", "same\n");
    put("b.md", "same\n");
    await store.captureForDelete("a.md");
    await store.captureForDelete("b.md");

    expect(fs.readdirSync(storeAbs())).toHaveLength(1);
    expect(store.list().map((r) => r.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("a path deleted AGAIN supersedes its earlier record — one live record per path", async () => {
    put("note.md", "v1\n");
    await store.captureForDelete("note.md");
    put("note.md", "v2\n");
    await store.captureForDelete("note.md");

    const live = store.list();
    expect(live).toHaveLength(1);
    expect(live[0].sha).toBe(await calculateGitBlobSHA(enc("v2\n")));
  });

  // ── sweep source №5 ───────────────────────────────────────────────

  it("referencedShas covers every pending capture — the bin's blobs survive a sweep", async () => {
    put("a.md", "aaa\n");
    put("b.md", "bbb\n");
    await store.captureForDelete("a.md");
    await store.captureForDelete("b.md");

    const referenced = store.referencedShas();
    // With the bin as a source, nothing of ours is reaped…
    const kept = await syncStore.sweep([async () => referenced]);
    expect(kept.removed).toBe(0);
    expect(fs.readdirSync(storeAbs())).toHaveLength(2);

    // …and WITHOUT it, both blobs go — which is exactly the silent
    // loss the source exists to prevent.
    const swept = await syncStore.sweep([async () => new Set<string>()]);
    expect(swept.removed).toBe(2);
  });

  it("release() drops records — the hand-off point where protection moves to the batch", async () => {
    put("a.md", "aaa\n");
    await store.captureForDelete("a.md");
    const sha = store.peek("a.md");
    expect(sha).not.toBeNull();

    await store.release(["a.md"]);
    expect(store.peek("a.md")).toBeNull();
    expect(store.referencedShas().size).toBe(0);
  });

  // ── reconcile: the successors of trash-recovery's hygiene cases ───

  it("reconcile drops a record whose path is LIVE again (crash between record and remove, or delete→recreate)", async () => {
    put("note.md", "content\n");
    await store.captureForDelete("note.md");
    // The file was never actually removed — the crash window between
    // step 2 and step 3.
    expect(store.list()).toHaveLength(1);

    await store.reconcile();
    expect(store.list()).toEqual([]);
  });

  it("reconcile drops a record whose bytes are gone (old case C, now one list entry)", async () => {
    put("note.md", "content\n");
    await store.captureForDelete("note.md");
    fs.unlinkSync(path.join(dir, "note.md"));
    const sha = store.peek("note.md")!;
    fs.unlinkSync(path.join(storeAbs(), sha));

    await store.reconcile();
    expect(store.list()).toEqual([]);
  });

  it("a torn index reads as an EMPTY bin, never as a half-parsed one", async () => {
    put("note.md", "content\n");
    await store.captureForDelete("note.md");
    fs.writeFileSync(indexAbs(), '[{"path":"note.md","sha":');

    const reopened = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
    });
    await reopened.load();
    expect(reopened.list()).toEqual([]);
  });

  it("records survive a restart with every field intact", async () => {
    put("note.md", "content\n");
    fs.utimesSync(path.join(dir, "note.md"), 1_700_000, 1_700_000);
    const written = await store.captureForDelete("note.md");
    fs.unlinkSync(path.join(dir, "note.md"));

    const reopened = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
    });
    await reopened.load();
    expect(reopened.list()).toEqual([written]);
  });

  // ── protection never lapses across the hand-off (§5.2.1 step 3) ───

  it("🔑 the blob stays referenced across the hand-off — bin, then queue, never neither", async () => {
    // The bin protects the bytes until the deletion is committed; the
    // batch's deletedSha protects them afterwards. If the two windows
    // failed to overlap, a sweep landing in the gap would reap the
    // bytes and the restore would silently stop working.
    const { default: BatchWriter } = await import(
      "../../src/sync2/batch-writer"
    );
    const { collectQueueReferencedShas } = await import(
      "../../src/sync2/queue-sha-index"
    );

    put("note.md", "precious\n");
    await store.captureForDelete("note.md");
    const sha = store.peek("note.md")!;
    fs.unlinkSync(path.join(dir, "note.md"));

    // BEFORE the commit: only the bin knows.
    expect(store.referencedShas().has(sha)).toBe(true);
    expect(
      (await collectQueueReferencedShas(vault as never, PLUGIN_ID)).has(sha),
    ).toBe(false);

    const writer = new BatchWriter({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => false,
      logger: { info: () => {}, warn: () => {} },
      deletedBin: {
        peek: (p: string) => store.peek(p),
        release: (paths: string[]) => store.release(paths),
      },
    });
    await writer.writeBatch([
      { kind: "deleted", path: "note.md", previousRemoteSha: "prev" },
    ]);

    // AFTER: the bin has let go, and the queue holds the reference.
    expect(store.referencedShas().has(sha)).toBe(false);
    expect(
      (await collectQueueReferencedShas(vault as never, PLUGIN_ID)).has(sha),
    ).toBe(true);

    // And a sweep run with BOTH real sources keeps the bytes.
    const r = await syncStore.sweep([
      () => collectQueueReferencedShas(vault as never, PLUGIN_ID),
      async () => store.referencedShas(),
    ]);
    expect(r.removed).toBe(0);
    expect(fs.existsSync(path.join(storeAbs(), sha))).toBe(true);
  });

  // ── retention: bounded by the drain, except what the user holds ───

  it("pruneBefore drops records that predate the drain, keeps later ones", async () => {
    put("old.md", "old\n");
    put("new.md", "new\n");
    const early = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      now: () => new Date("2026-09-20T10:00:00.000Z"),
    });
    await early.load();
    await early.captureForDelete("old.md");
    const late = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      now: () => new Date("2026-09-20T12:00:00.000Z"),
    });
    await late.load();
    await late.captureForDelete("new.md");

    await late.pruneBefore("2026-09-20T11:00:00.000Z");
    expect(late.list().map((r) => r.path)).toEqual(["new.md"]);
  });

  it("🔑 a record HELD by an open editor survives the prune AND the sweep", async () => {
    // "Крім тих, які користувач відкрив у diff editor — вони висять,
    // поки він не закриє їх або поки не відновиться з них."
    put("watched.md", "precious\n");
    await store.captureForDelete("watched.md");
    const sha = store.peek("watched.md")!;
    fs.unlinkSync(path.join(dir, "watched.md"));

    store.hold(sha); // a diff-editor tab opened this version
    await store.pruneBefore("2099-01-01T00:00:00.000Z"); // prune everything
    expect(store.list().map((r) => r.path)).toEqual(["watched.md"]);

    const swept = await syncStore.sweep([async () => store.referencedShas()]);
    expect(swept.removed).toBe(0);
    expect(fs.existsSync(path.join(storeAbs(), sha))).toBe(true);
  });

  it("a hold outlives its record — the blob stays even after the hand-off released it", async () => {
    // The user may be looking at a generation whose record already
    // moved into a batch; the batch's protection ends with the batch.
    put("watched.md", "precious\n");
    await store.captureForDelete("watched.md");
    const sha = store.peek("watched.md")!;
    store.hold(sha);
    await store.release(["watched.md"]); // the hand-off

    expect(store.list()).toEqual([]);
    expect(store.referencedShas().has(sha)).toBe(true);
  });

  it("closing the tab releases the hold — the next prune takes the record", async () => {
    put("watched.md", "precious\n");
    await store.captureForDelete("watched.md");
    const sha = store.peek("watched.md")!;
    fs.unlinkSync(path.join(dir, "watched.md"));
    store.hold(sha);
    await store.pruneBefore("2099-01-01T00:00:00.000Z");
    expect(store.list()).toHaveLength(1);

    store.unhold(sha);
    await store.pruneBefore("2099-01-01T00:00:00.000Z");
    expect(store.list()).toEqual([]);
  });

  it("holds do NOT survive a restart — a killed app has no open tabs, so no stale shield", async () => {
    put("watched.md", "precious\n");
    await store.captureForDelete("watched.md");
    store.hold(store.peek("watched.md")!);

    const reopened = new DeletedStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
    });
    await reopened.load();
    // This is the whole reason the shield is in memory: the old bin's
    // persisted marker needed a recovery pass to clear exactly this.
    expect(reopened.referencedShas().size).toBe(1); // the RECORD, not a hold
    await reopened.release(["watched.md"]);
    expect(reopened.referencedShas().size).toBe(0);
  });
});
