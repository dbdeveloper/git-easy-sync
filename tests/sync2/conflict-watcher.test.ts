// ConflictWatcher tests. See src/sync2/conflict-watcher.ts +
// docs/PSEUDO-MERGE-MODE.md §5 — the watcher is READ-ONLY and its
// only side effect is calling `counter.markDirty()` on relevant
// vault events.
//
// What's covered:
//   - start()/stop() register & unregister listeners; idempotent
//   - handle() on irrelevant path → no markDirty call
//   - handle() on base or sibling path → markDirty called
//   - rename event drives BOTH new and old paths through handle()

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import ConflictStore, {
  type CreateArgs,
} from "../../src/sync2/conflict-store";
import { ConflictWatcher } from "../../src/sync2/conflict-watcher";
import { ConflictCounter } from "../../src/sync2/conflict-counter";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `conflict-watcher-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let counter = 0;
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => Date.now(),
    idFactory: () =>
      `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`,
  });
  // Counter is mocked with a spy on markDirty so tests can assert
  // the watcher's only side effect. We don't exercise the counter's
  // own behavior here — that's covered in conflict-counter.test.ts.
  const markDirty = vi.fn();
  const conflictCounter = {
    markDirty,
  } as unknown as ConflictCounter;
  return { root, vault, store, conflictCounter, markDirty };
}

function arr(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer.slice(0) as ArrayBuffer;
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function baseArgs(over: Partial<CreateArgs> = {}): CreateArgs {
  return {
    vaultPath: "Notes/note.md",
    kind: "modify-vs-modify",
    theirsContent: arr("theirs\n"),
    theirsBlobSha: "t",
    oursBlobSha: "o",
    baseMtime: null,
    baseSize: null,
    baseSha: null,
    remoteDevice: "Phone",
    ...over,
  };
}

describe("ConflictWatcher (counter-only listener)", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  // ─── Fast-path Set check ────────────────────────────────────────────

  it("handle(): irrelevant path → no markDirty call", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });

    watcher.handle("unrelated/file.md");

    expect(f.markDirty).not.toHaveBeenCalled();
  });

  it("handle(): SYNTHETIC sibling path (no store record) → markDirty called (TODO #7)", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });

    // A `*.conflict-from-*` sibling the store does NOT know about — without the
    // synthetic check the badge would stay stale vs the diff-panel.
    watcher.handle("Notes/note.conflict-from-Phone-2026-06-05T00-00-00Z.md");

    expect(f.markDirty).toHaveBeenCalledTimes(1);
  });

  it("handle(): base path with active conflict → markDirty called", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    await f.store.create(baseArgs());
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });

    watcher.handle("Notes/note.md");

    expect(f.markDirty).toHaveBeenCalledTimes(1);
  });

  it("handle(): sibling path → markDirty called (fast-path includes siblings)", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });

    watcher.handle(rec.siblingPath);

    expect(f.markDirty).toHaveBeenCalledTimes(1);
  });

  // ─── start / stop ───────────────────────────────────────────────────

  it("start() registers delete/modify/rename listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });
    expect(
      (f.vault as unknown as { listeners: unknown[] }).listeners.length,
    ).toBe(0);
    watcher.start();
    const subscribed = (
      f.vault as unknown as {
        listeners: { event: string }[];
      }
    ).listeners;
    expect(subscribed.map((l) => l.event).sort()).toEqual([
      "delete",
      "modify",
      "rename",
    ]);
  });

  it("start() is idempotent — calling twice does NOT duplicate listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });
    watcher.start();
    watcher.start();
    const count = (f.vault as unknown as { listeners: unknown[] }).listeners
      .length;
    expect(count).toBe(3); // 3 events, not 6
  });

  it("stop() unsubscribes all listeners", async () => {
    await f.store.load();
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });
    watcher.start();
    watcher.stop();
    expect(
      (f.vault as unknown as { listeners: unknown[] }).listeners.length,
    ).toBe(0);
  });

  // ─── End-to-end via mock fireEvent ──────────────────────────────────

  it("end-to-end: vault.fireEvent('delete', sibling) → markDirty called", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    const rec = await f.store.create(baseArgs());
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });
    watcher.start();

    f.vault.fireEvent("delete", { path: rec.siblingPath });

    expect(f.markDirty).toHaveBeenCalledTimes(1);
  });

  it("end-to-end: vault.fireEvent('rename', new, old) → both paths trigger handle", async () => {
    writeVaultFile(f.root, "Notes/note.md", "local\n");
    await f.store.load();
    await f.store.create(baseArgs());
    const watcher = new ConflictWatcher({
      vault: f.vault as unknown as import("obsidian").Vault,
      store: f.store,
      counter: f.conflictCounter,
    });
    watcher.start();

    // Rename event: new path is unrelated, old path was the base.
    // Old-path check should match (hasPending).
    f.vault.fireEvent(
      "rename",
      { path: "unrelated/new.md" },
      "Notes/note.md",
    );

    expect(f.markDirty).toHaveBeenCalledTimes(1);
  });
});
