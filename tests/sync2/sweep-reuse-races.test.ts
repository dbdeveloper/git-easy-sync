import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DeletedStore from "../../src/diff2/deleted-store";
import BatchWriter from "../../src/sync2/batch-writer";
import { collectQueueReferencedShas } from "../../src/sync2/queue-sha-index";
import { sweepSyncStore } from "../../src/sync2/drain";
import { calculateGitBlobSHA } from "../../src/utils";
import ChangeDetector from "../../src/sync2/change-detector";
import HotMetadataStore from "../../src/sync2/hot-metadata";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import GI from "../../src/gi";

// COMMIT-PASS-PERF §6 — the sync_store sweep runs at drain end while a
// commit or a user delete can run concurrently (nothing excludes them).
// §12.4's safety argument — list, then collect references, then remove;
// anything written after the listing is safe — covers only NEWLY
// written blobs. These tests pin the two Deleted-bin cases found
// 2026-10-04 by probes on the real components.

const PLUGIN_ID = "git-easy-sync";

describe("sync_store sweep vs a concurrent commit / delete (COMMIT-PASS-PERF §6)", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let bin: DeletedStore;
  let writer: BatchWriter;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "sweep-races-"));
    fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
    vault = new Vault(dir);
    syncStore = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    bin = new DeletedStore({ vault: vault as never, selfPluginId: PLUGIN_ID, syncStore });
    await bin.load();
    writer = new BatchWriter({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => false,
      deletedBin: { peek: (p) => bin.peek(p), release: (ps) => bin.release(ps) },
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The drain's REAL sweep (its real source list and order); each async
  // source can be told to let the concurrent commit finish on entry.
  const drainSweep = (commitDuring: string | null, commit: () => Promise<void>) => {
    const at = async (name: string): Promise<void> => {
      if (name === commitDuring) await commit();
    };
    return sweepSyncStore({
      syncStore,
      queueReferencedShas: async () => {
        await at("queue");
        return collectQueueReferencedShas(vault as never, PLUGIN_ID);
      },
      journal: {
        collectReferencedShas: async () => {
          await at("journal");
          return new Set<string>();
        },
      },
      conflictStore: {
        collectReferencedShas: async () => {
          await at("conflicts");
          return new Set<string>();
        },
      },
      deletedBinReferencedShas: () => bin.referencedShas(),
      logger: { info: () => {}, warn: () => {} },
    } as never);
  };

  // A: the bin's hand-off writes the batch metafile, THEN releases the
  // record (§5.2.1). If that lands between the sweep reading the queue
  // and reading the bin, neither source names the blob. For a file
  // created and deleted between pushes, that blob is the ONLY copy.
  // FIXED 2026-10-04 (it.fails removed in the fixing commit): the bin is
  // now read before the queue. Before the fix the commit bit when it
  // finished AFTER the queue was read and BEFORE the bin was — the
  // "journal" and "conflicts" positions. Finishing on entry to the queue
  // read was safe in either order and is kept as a control.
  for (const during of ["queue", "journal", "conflicts"]) {
    it(`A: a deletion committed while the sweep reads "${during}" keeps its Deleted-bin bytes`, async () => {
      fs.writeFileSync(path.join(dir, "never-pushed.md"), "only copy\n");
      await bin.captureForDelete("never-pushed.md");
      fs.rmSync(path.join(dir, "never-pushed.md"));
      const sha = bin.peek("never-pushed.md")!;

      await drainSweep(during, async () => {
        await writer.writeBatch([
          { kind: "deleted", path: "never-pushed.md", previousRemoteSha: "x" },
        ]);
      });

      // The batch names the bytes as restorable…
      expect(
        (await collectQueueReferencedShas(vault as never, PLUGIN_ID)).has(sha),
      ).toBe(true);
      // …so they must still be there.
      expect(await syncStore.existInSyncStore(sha)).toBe(true);
    });
  }

  // ── C / D / E: reuse of a blob ALREADY in the store (§6) ───────────
  // FIXED 2026-10-04 by retain() + per-blob lock + deferred unpin
  // (§6.1); it.fails removed in the fixing commit.
  //
  // One world, ONE SyncStore shared by the sweep and every actor — as in
  // production, where any lock lives inside that one instance. Its vault
  // lets a test start a concurrent operation at the moment the sweep is
  // about to unlink a given blob: AFTER the references were collected.
  // The operation is raced against a short delay instead of awaited, so
  // the same test runs against code without a lock (the operation
  // finishes first) and with one (it waits on the lock, the unlink
  // proceeds, the operation finishes after).
  const hookedWorld = () => {
    let hook: { sha: string; op: () => Promise<unknown> } | null = null;
    let pending: Promise<unknown> | null = null;
    const real = vault as unknown as Record<string, unknown>;
    const v = new Proxy(real, {
      get(t, prop) {
        if (prop !== "adapter") {
          const x = Reflect.get(t, prop);
          return typeof x === "function" ? x.bind(t) : x;
        }
        const a = Reflect.get(t, "adapter") as Record<string, unknown>;
        return new Proxy(a, {
          get(aa, m) {
            const fn = Reflect.get(aa, m) as (...x: unknown[]) => Promise<unknown>;
            if (m !== "remove") return typeof fn === "function" ? fn.bind(aa) : fn;
            return async (p: string) => {
              if (hook !== null && p.endsWith(hook.sha)) {
                const h = hook;
                hook = null;
                pending = h.op();
                pending.catch(() => {});
                await Promise.race([
                  pending,
                  new Promise((r) => setTimeout(r, 300)),
                ]);
              }
              return fn.call(aa, p);
            };
          },
        });
      },
    }) as never;
    const store = new SyncStore({ vault: v, selfPluginId: PLUGIN_ID });
    return {
      vault: v,
      store,
      bin: new DeletedStore({ vault: v, selfPluginId: PLUGIN_ID, syncStore: store }),
      writer: new BatchWriter({
        vault: v,
        selfPluginId: PLUGIN_ID,
        syncStore: store,
        autoCanonicalize: () => false,
      }),
      // Run `op` when the sweep reaches the unlink of `sha`.
      during(sha: string, op: () => Promise<unknown>): void {
        hook = { sha, op };
      },
      // The concurrent operation's own completion.
      async settle(): Promise<void> {
        if (pending !== null) await pending;
      },
    };
  };

  // A content-addressed leftover: in the store, referenced by nothing.
  const leftover = async (
    store: SyncStore,
    text: string,
  ): Promise<{ sha: string; bytes: ArrayBuffer }> => {
    const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
    const sha = await calculateGitBlobSHA(bytes);
    await store.saveBlobToSyncStore(sha, bytes);
    return { sha, bytes };
  };

  // C: the bin finds the blob ALREADY present, skips the save, records
  // it — and the removal loop, whose references were collected before
  // the record existed, deletes it. Recorded as restorable, restorable
  // from nothing; reconcile() drops the record on the next load.
  it("C: a delete captured during the sweep's removal loop keeps bytes the bin finds already present", async () => {
    const w = hookedWorld();
    await w.bin.load();
    const { sha } = await leftover(w.store, "same content\n");
    fs.writeFileSync(path.join(dir, "f.md"), "same content\n");

    w.during(sha, async () => {
      await w.bin.captureForDelete("f.md");
      fs.rmSync(path.join(dir, "f.md")); // Obsidian's delete proceeds
    });
    await w.store.sweep([async () => w.bin.referencedShas()]);
    await w.settle();

    expect(w.bin.peek("f.md")).toBe(sha);
    expect(await w.store.existInSyncStore(sha)).toBe(true);
  });

  // D: the commit pass's detector stores a PROVEN change whose bytes
  // happen to equal a leftover (a revert to previously pushed content).
  // Its pin lands after the sweep collected references, so the removal
  // loop takes the blob anyway; only the writer's re-read fallback saves
  // the commit. Asserted here: the blob survives on its own.
  it("D: a change the detector stores during the removal loop keeps a blob that was already present", async () => {
    const w = hookedWorld();
    const { sha } = await leftover(w.store, "reverted\n");
    fs.writeFileSync(path.join(dir, "r.md"), "reverted\n");
    const hot = new HotMetadataStore({ vault: w.vault, selfPluginId: PLUGIN_ID });
    await hot.load();
    const detector = new ChangeDetector({
      vault: w.vault,
      hotMeta: hot,
      baselines: new FileBaselinesStore({ vault: w.vault, selfPluginId: PLUGIN_ID }),
      gi: new GI(dir),
      configDir: ".obsidian",
      selfPluginId: PLUGIN_ID,
      vaultRoot: dir,
      syncConfigDir: () => true,
      queue: { peekLatestPathSha: async () => null },
      syncStore: w.store,
    });
    let changes: Awaited<ReturnType<ChangeDetector["findChanges"]>> = [];

    w.during(sha, async () => {
      changes = await detector.findChanges();
    });
    await w.store.sweep([async () => new Set<string>()]);
    await w.settle();

    expect(changes).toEqual([expect.objectContaining({ path: "r.md", sha })]);
    expect(await w.store.existInSyncStore(sha)).toBe(true);
  });

  // E: BatchWriter's blob pass finds the blob already present and skips
  // it — but the sweep collected references BEFORE this batch's metafile
  // existed, and its removal loop takes the blob. The drain can repair
  // from the vault only while the file is unchanged; after an edit the
  // committed version never reaches GitHub (preserve-all-commits).
  it("E: a batch written during the removal loop keeps the blob its metafile names", async () => {
    const w = hookedWorld();
    const { sha } = await leftover(w.store, "identical\n");
    fs.writeFileSync(path.join(dir, "e.md"), "identical\n");
    let id: string | null = null;

    w.during(sha, async () => {
      id = await w.writer.writeBatch([
        { kind: "modified", path: "e.md", size: 0, mtime: 0, previousRemoteSha: "p" },
      ]);
    });
    await w.store.sweep([
      () => collectQueueReferencedShas(w.vault, PLUGIN_ID),
    ]);
    await w.settle();

    expect(id).not.toBeNull();
    expect(
      (await collectQueueReferencedShas(w.vault, PLUGIN_ID)).has(sha),
    ).toBe(true);
    expect(await w.store.existInSyncStore(sha)).toBe(true);
  });
});
