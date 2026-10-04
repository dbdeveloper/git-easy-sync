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
  // `red` = the positions where the defect bites today: the commit has to
  // finish AFTER the queue was read and BEFORE the bin is. Finishing on
  // entry to the queue read is safe in any order (the queue sees it) —
  // kept as a control so the pin cannot pass by testing nothing.
  for (const [during, red] of [
    ["queue", false],
    ["journal", true],
    ["conflicts", true],
  ] as const) {
    (red ? it.fails : it)(`A: a deletion committed while the sweep reads "${during}" keeps its Deleted-bin bytes`, async () => {
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

  // C: the bin finds the blob ALREADY present (an unreferenced leftover
  // with the same content), skips the save, records it — and the
  // sweep's removal loop, whose references were collected before the
  // record existed, deletes it. Recorded as restorable, restorable from
  // nothing; reconcile() drops the record on the next load.
  it.fails("C: a delete captured during the sweep's removal loop keeps bytes the bin finds already present", async () => {
    const content = new TextEncoder().encode("same content\n").buffer as ArrayBuffer;
    const sha = await calculateGitBlobSHA(content);
    await syncStore.saveBlobToSyncStore(sha, content); // unreferenced leftover
    fs.writeFileSync(path.join(dir, "f.md"), "same content\n");

    // A store whose remove(blob) first lets the user's delete run — i.e.
    // the delete lands inside the removal loop, after collection.
    const real = vault as unknown as Record<string, unknown>;
    const hooked = new Proxy(real, {
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
              if (p.endsWith(sha)) {
                await bin.captureForDelete("f.md");
                fs.rmSync(path.join(dir, "f.md")); // Obsidian's delete proceeds
              }
              return fn.call(aa, p);
            };
          },
        });
      },
    });
    const sweeping = new SyncStore({ vault: hooked as never, selfPluginId: PLUGIN_ID });
    await sweeping.sweep([async () => bin.referencedShas()]);

    expect(bin.peek("f.md")).toBe(sha);
    expect(await syncStore.existInSyncStore(sha)).toBe(true);
  });
});
