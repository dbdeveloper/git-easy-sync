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
import ConflictStoreV2, {
  emptyConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { emptyFileInfo } from "../../src/sync2/diff3";
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
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
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

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Register one TRACKED conflict on Notes/note.md the v2 way (entry +
// sibling file at the derived name; save rebuilds the cached indexes).
const SIB_MTIME = Date.UTC(2026, 5, 5, 0, 0, 0);
async function trackNote(
  f: ReturnType<typeof fixture>,
): Promise<{ siblingPath: string }> {
  const state = emptyConflictsState();
  state.entries.set("Notes/note.md", {
    conflictBase: { ...emptyFileInfo(), path: "Notes/note.md", sha: "cb" },
    siblings: [
      {
        ...emptyFileInfo(),
        path: "Notes/note.md",
        mtime: SIB_MTIME,
        deviceLabel: "Phone",
        sha: "t",
      },
    ],
  });
  const siblingPath = buildSiblingFilePath("Notes/note.md", SIB_MTIME, "Phone");
  writeVaultFile(f.root, siblingPath, "theirs\n");
  await f.store.save(state);
  return { siblingPath };
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
    await trackNote(f);
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
    const rec = await trackNote(f);
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
    const rec = await trackNote(f);
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
    await trackNote(f);
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
