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
});
