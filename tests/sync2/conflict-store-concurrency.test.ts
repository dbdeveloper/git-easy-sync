// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// Two writers, one file.
//
// ⚠️ Why this file exists: the store is the single mutation point for
// conflicts, and it was single-writer BY CONVENTION with nothing enforcing
// it. The field log shows the convention failing 15 times since
// 2026-09-26 — `reconcileConflictsV2` is called from onload (un-awaited)
// AND from the restored diff2 panel, so two passes raced to save(). Both
// observed errors are that race:
//
//   "Destination file already exists!"        ← the other run created the
//                                               destination between our
//                                               check and our rename
//   "ENOENT … unlink conflicts.ges-bak.json"  ← the other run had already
//                                               cleaned the backup
//
// The owner's question was the right one: do we not have tests for this
// class? We did not. atomicWriteFile is not concurrency-safe for one path
// and never claimed to be — the protection belongs at the writer, and
// nothing checked that it was there.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import ConflictStoreV2, {
  emptyConflictsState,
  type ConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { emptyFileInfo } from "../../src/sync2/diff3";

const SELF = "git-easy-sync";
let root: string;

afterEach(() => {
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function freshStore(): Promise<ConflictStoreV2> {
  root = path.join(os.tmpdir(), `cs-race-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF,
  });
  await store.load();
  return store;
}

function stateWith(paths: string[]): ConflictsState {
  const state = emptyConflictsState();
  for (const p of paths) {
    state.entries.set(p, {
      conflictBase: { ...emptyFileInfo(), path: p, sha: `sha-${p}` },
      siblings: [
        { ...emptyFileInfo(), path: p, mtime: 1, deviceLabel: "Phone" },
      ],
    });
  }
  return state;
}

describe("ConflictStoreV2.save under concurrent callers", () => {
  it("🔑 overlapping saves do not throw — the write is serialised", async () => {
    // The exact shape of the field failure: several callers save without
    // waiting for each other. Before the fix this reliably produced
    // "Destination file already exists!" or an ENOENT on the backup.
    const store = await freshStore();
    const saves = [
      store.save(stateWith(["a.md"])),
      store.save(stateWith(["b.md"])),
      store.save(stateWith(["c.md"])),
      store.save(stateWith(["d.md"])),
    ];
    await expect(Promise.all(saves)).resolves.toBeDefined();
  });

  it("🔑 every queued save RUNS — none is dropped, and the last one wins", async () => {
    // Queueing, not coalescing, and the distinction matters: each save
    // carries a DIFFERENT state, so discarding one would silently lose a
    // conflict record. Order is what decides the result, not luck.
    const store = await freshStore();
    await Promise.all([
      store.save(stateWith(["first.md"])),
      store.save(stateWith(["second.md"])),
      store.save(stateWith(["third.md"])),
    ]);

    const reread = await freshStoreAt(root);
    expect([...reread.getCachedState().entries.keys()]).toEqual(["third.md"]);
  });

  it("the file on disk is never left half-written", async () => {
    // What the race actually risks: a reader seeing a truncated or absent
    // file. Parsing it back is the honest check.
    const store = await freshStore();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.save(stateWith([`n${i}.md`]))),
    );
    const file = path.join(
      root,
      `.obsidian/plugins/${SELF}/.runtime/conflicts.json`,
    );
    expect(fs.existsSync(file)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
  });

  it("🔑 a FAILED save does not block the next one — the queue is not poisoned", async () => {
    // Found by mutation probe: dropping the chain's rejection handler
    // passed every other test here. It matters because a chain that stops
    // on the first error would leave conflicts.json frozen for the rest of
    // the session, and the next caller has its own state and its own right
    // to be written — a transient failure must not become permanent.
    root = path.join(os.tmpdir(), `cs-poison-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    // ⚠️ The injection needs a STABLE adapter. mock-obsidian exposes
    // `get adapter()` returning a BRAND-NEW object literal on every
    // access, so `vault.adapter.writeBinary = …` mutates a throwaway and
    // injects nothing — a test written that way passes while testing
    // nothing. Snapshot it once and serve that same object through a
    // proxy.
    const real = new Vault(root);
    const snapshot = real.adapter;
    let failNext = true;
    const patched = {
      ...snapshot,
      writeBinary: async (p: string, data: ArrayBuffer) => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full");
        }
        return snapshot.writeBinary(p, data);
      },
    };
    const vault = new Proxy(real, {
      get: (target, prop, receiver) =>
        prop === "adapter" ? patched : Reflect.get(target, prop, receiver),
    });
    const store = new ConflictStoreV2({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF,
    });
    await store.load();

    await expect(store.save(stateWith(["doomed.md"]))).rejects.toThrow();
    // The very next save must land, and land on disk.
    await store.save(stateWith(["survivor.md"]));
    const reread = await freshStoreAt(root);
    expect([...reread.getCachedState().entries.keys()]).toEqual([
      "survivor.md",
    ]);
  });

  it("a sequential save still works — the guard must not deadlock itself", async () => {
    // Without this, a lock that never released would pass every test
    // above (they all await together) and hang the plugin in production.
    const store = await freshStore();
    await store.save(stateWith(["one.md"]));
    await store.save(stateWith(["two.md"]));
    const reread = await freshStoreAt(root);
    expect([...reread.getCachedState().entries.keys()]).toEqual(["two.md"]);
  });
});

// Re-open the same vault so the assertion reads DISK, not the in-memory
// cache the writer just rebuilt.
async function freshStoreAt(at: string): Promise<ConflictStoreV2> {
  const vault = new Vault(at);
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF,
  });
  await store.load();
  return store;
}
