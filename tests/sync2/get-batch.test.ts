import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import BatchClaimer from "../../src/sync2/get-batch";
import {
  ATTEMPTED_COMMIT_MARKER,
  ATTEMPTED_MARKER,
  BATCH_META_FILE,
  BatchMetafile,
  parseBatchMetafile,
} from "../../src/sync2/batch-metafile";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII category H — getBatch()/R3b (NEW-DRAIN §II.8) + the
// T4.4/T4.5 crash classes. Time is fully faked: `sleep` advances a
// virtual clock, so Peterson waits cost no real seconds.

const PLUGIN_ID = "git-easy-sync";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("BatchClaimer (§VIII H)", () => {
  let dir: string;
  let vault: Vault;
  let syncStore: SyncStore;
  let clock: number;
  let warnings: string[];

  const queueAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "push-queue");
  const storeAbs = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "sync_store");

  const makeClaimer = (opts?: {
    onSleep?: () => void;
  }): BatchClaimer =>
    new BatchClaimer({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      logger: {
        info: () => {},
        warn: (m) => warnings.push(m),
      },
      pollMs: 300,
      warnAfterMs: 5000,
      giveUpAfterMs: 30_000,
      sleep: async (ms) => {
        clock += ms;
        opts?.onSleep?.();
      },
      now: () => clock,
    });

  const writeBatch = (
    id: string,
    entries: BatchMetafile["entries"],
  ): string => {
    const batchDir = path.join(queueAbs(), id);
    fs.mkdirSync(batchDir, { recursive: true });
    const meta: BatchMetafile = { v: 1, id, createdAt: clock, entries };
    fs.writeFileSync(path.join(batchDir, BATCH_META_FILE), JSON.stringify(meta));
    return batchDir;
  };

  const putBlob = async (content: string): Promise<string> => {
    const sha = await calculateGitBlobSHA(enc(content));
    await syncStore.saveBlobToSyncStore(sha, enc(content));
    return sha;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "get-batch-test-"));
    vault = new Vault(dir);
    syncStore = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    clock = 1_000_000;
    warnings = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty queue → null; FIFO: the OLDEST dir is claimed and .attempted is set", async () => {
    expect(await makeClaimer().getBatch()).toBeNull();

    const sha = await putBlob("x");
    writeBatch("20260830T2", [{ path: "b.md", sha, size: 1, mtime: 5 , deletedSha: null}]);
    writeBatch("20260830T1", [{ path: "a.md", sha, size: 1, mtime: 5 , deletedSha: null}]);

    const claimed = await makeClaimer().getBatch();
    expect(claimed!.id).toBe("20260830T1"); // oldest, lexicographic
    expect(
      fs.existsSync(path.join(queueAbs(), "20260830T1", ATTEMPTED_MARKER)),
    ).toBe(true);
  });

  // ── §VIII D — a `.attempted` left standing by a CRASHED drain ─────
  //
  // Phase 6, crash matrix. Every other crash cell asks what the redo
  // does with work; this one asks what it does with the MARKER the
  // dead run left behind — the state a reader is most likely to
  // mistake for "someone is already working on this".
  //
  // The answer is asymmetric, and both halves are pinned below,
  // because the symmetric reading is the plausible wrong one:
  //
  //   • the DRAIN never reads its own flag — `.attempted` is written
  //     and never tested — so a stale one cannot deadlock the redo;
  //   • COMMIT does read it, and correctly declines to consolidate
  //     into that dir. The cost is one lost consolidation, paid once:
  //     the appended batch becomes the new tail and carries no marker.
  //
  // ⚠️ The first half is a property of an ABSENCE, which is the kind
  // that rots silently. Adding an "is this dir already claimed?" guard
  // to getBatch would look like a safety improvement and would strand
  // every batch a crashed drain had touched.
  it("D: a `.attempted` from a crashed drain blocks nothing — the redo claims the SAME dir", async () => {
    const sha = await putBlob("x");
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: 1, mtime: 5, deletedSha: null },
    ]);
    // Exactly what a drain that died mid-batch leaves: its own claim
    // marker, and the dir still full of work.
    fs.writeFileSync(path.join(bdir, ATTEMPTED_MARKER), "");

    const claimed = await makeClaimer().getBatch();
    expect(claimed!.id).toBe("20260830T1");
    expect(claimed!.meta.entries).toHaveLength(1); // the work, intact
    expect(warnings).toEqual([]); // not an anomaly — nothing to report
  });

  it("D: …and COMMIT declines that dir once — the loss is one consolidation, not a batch", async () => {
    // The other half, stated from the commit side. Its back-off is
    // CORRECT (it cannot know the claimer is dead), so the thing worth
    // pinning is the bound on the damage, not the behaviour.
    const sha = await putBlob("x");
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: 1, mtime: 5, deletedSha: null },
    ]);
    fs.writeFileSync(path.join(bdir, ATTEMPTED_MARKER), "");

    // The marker is the ONLY reason to decline: the dir is otherwise a
    // perfectly healthy tail. (BatchWriter's own suite drives
    // consolidateIntoTail; here we pin the precondition it reads, so
    // the two halves cannot drift apart unnoticed.)
    expect(fs.existsSync(path.join(bdir, ATTEMPTED_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER))).toBe(false);
    expect(parseBatchMetafile(
      fs.readFileSync(path.join(bdir, BATCH_META_FILE), "utf8"),
    )).not.toBeNull();
    // …and the claim still succeeds, which is what makes the loss
    // temporary: this dir gets processed and removed like any other.
    expect((await makeClaimer().getBatch())!.id).toBe("20260830T1");
  });

  it("H: commit-side claim present → drain WAITS (never skips to a newer dir) and proceeds once released", async () => {
    const sha = await putBlob("x");
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: 1, mtime: 5 , deletedSha: null},
    ]);
    writeBatch("20260830T2", [{ path: "b.md", sha, size: 1, mtime: 5 , deletedSha: null}]);
    const marker = path.join(bdir, ATTEMPTED_COMMIT_MARKER);
    fs.writeFileSync(marker, "");

    // The commit "finishes" after two poll cycles.
    let sleepCount = 0;
    const claimer = makeClaimer({
      onSleep: () => {
        sleepCount += 1;
        if (sleepCount === 2) fs.rmSync(marker);
      },
    });
    const claimed = await claimer.getBatch();
    expect(claimed!.id).toBe("20260830T1"); // waited, did NOT skip
    expect(sleepCount).toBe(2);
  });

  it("H: give-up ceiling — a marker that never clears returns null (next drain retries), with the long-hold warning", async () => {
    const sha = await putBlob("x");
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: 1, mtime: 5 , deletedSha: null},
    ]);
    fs.writeFileSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER), "");

    const claimed = await makeClaimer().getBatch();
    expect(claimed).toBeNull();
    expect(warnings.some((w) => w.includes("suspiciously long"))).toBe(true);
    // Queue untouched — nothing discarded by a mere timeout.
    expect(fs.existsSync(path.join(bdir, BATCH_META_FILE))).toBe(true);
  });

  it("H TOCTOU: commit claims BETWEEN the first check and markAttempted → both flags up → drain waits it out", async () => {
    const sha = await putBlob("x");
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: 1, mtime: 5 , deletedSha: null},
    ]);
    const commitMarker = path.join(bdir, ATTEMPTED_COMMIT_MARKER);

    // Simulate the race via the adapter: the commit marker appears
    // the moment the drain writes ITS marker, and clears after one
    // poll.
    const realAdapter = vault.adapter;
    const vaultProxy = {
      configDir: vault.configDir,
      adapter: {
        ...realAdapter,
        write: async (p: string, data: string) => {
          await realAdapter.write(p, data);
          if (p.endsWith(ATTEMPTED_MARKER)) {
            fs.writeFileSync(commitMarker, ""); // commit sneaks in
          }
        },
      },
    };
    let polls = 0;
    const claimer = new BatchClaimer({
      vault: vaultProxy as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      pollMs: 300,
      warnAfterMs: 5000,
      giveUpAfterMs: 30_000,
      sleep: async (ms) => {
        clock += ms;
        polls += 1;
        fs.rmSync(commitMarker, { force: true }); // commit releases
      },
      now: () => clock,
    });

    const claimed = await claimer.getBatch();
    expect(claimed!.id).toBe("20260830T1");
    expect(polls).toBeGreaterThan(0); // the decisive re-check DID wait
    expect(fs.existsSync(path.join(bdir, ATTEMPTED_MARKER))).toBe(true);
  });

  it("H CRASH_RECOVERY (T4.5): incomplete metafile → dir discarded LOUDLY, next batch claimed", async () => {
    const bad = path.join(queueAbs(), "20260830T1");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, BATCH_META_FILE), '{"v":1,"id":"20260'); // torn
    fs.writeFileSync(path.join(bad, ATTEMPTED_COMMIT_MARKER), "");
    const sha = await putBlob("good");
    writeBatch("20260830T2", [{ path: "b.md", sha, size: 4, mtime: 5 , deletedSha: null}]);

    // Production order (§II.8): the onload sweep repairs stale
    // commit claims FIRST; getBatch itself only waits on a live one.
    const claimer = makeClaimer();
    await claimer.recoverStaleCommitClaims();
    expect(fs.existsSync(bad)).toBe(false); // discarded by the sweep
    expect(warnings.some((w) => w.includes("incomplete metafile"))).toBe(true);

    const claimed = await claimer.getBatch();
    expect(claimed!.id).toBe("20260830T2");
  });

  it("H CRASH_RECOVERY repair (F.8): missing blob re-copied from the vault when size-then-SHA matches", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "vault content");
    const sha = await calculateGitBlobSHA(enc("vault content"));
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: "vault content".length, mtime: 5 , deletedSha: null},
    ]);
    // Blob NEVER made it to sync_store (crash between metadata and
    // blobs — the §12.4 order guarantees the metadata exists).
    fs.writeFileSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER), "");

    // Corrupt metafile? No — complete. Trigger recovery via the
    // corrupted path? The claim path parses fine and returns the
    // batch; the stale-marker case goes through the onload sweep:
    await makeClaimer().recoverStaleCommitClaims();

    expect(await syncStore.existInSyncStore(sha)).toBe(true); // repaired
    expect(
      fs.existsSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER)),
    ).toBe(false); // claim released
    // And the blob content is the real vault bytes.
    const bytes = await syncStore.getBlobFromSyncStore(sha, new Set());
    expect(new TextDecoder().decode(bytes!)).toBe("vault content");
  });

  it("H: unrepairable entry drops from the batch (metafile rewritten), the rest continues", async () => {
    fs.writeFileSync(path.join(dir, "changed.md"), "NEW content"); // differs from sha
    const missingSha = await calculateGitBlobSHA(enc("OLD content"));
    const okSha = await putBlob("intact");
    const bdir = writeBatch("20260830T1", [
      { path: "changed.md", sha: missingSha, size: "OLD content".length, mtime: 5 , deletedSha: null},
      { path: "ok.md", sha: okSha, size: 6, mtime: 5 , deletedSha: null},
      { path: "gone.md", sha: null, size: null, mtime: null, deletedSha: null }, // deletion — no blob needed
    ]);
    fs.writeFileSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER), "");

    await makeClaimer().recoverStaleCommitClaims();

    const meta = parseBatchMetafile(
      fs.readFileSync(path.join(bdir, BATCH_META_FILE), "utf8"),
    )!;
    expect(meta.entries.map((e) => e.path)).toEqual(["ok.md", "gone.md"]);
    expect(warnings.some((w) => w.includes("unrepairable"))).toBe(true);
  });

  it("H: a batch whose EVERY entry dropped is returned empty — the caller's П11 skip, not a crash", async () => {
    const missingSha = await calculateGitBlobSHA(enc("nowhere"));
    const bdir = writeBatch("20260830T1", [
      { path: "gone-from-vault.md", sha: missingSha, size: 7, mtime: 5 , deletedSha: null},
    ]);
    fs.writeFileSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER), "");

    await makeClaimer().recoverStaleCommitClaims();
    const claimed = await makeClaimer().getBatch();
    expect(claimed!.id).toBe("20260830T1");
    expect(claimed!.meta.entries).toEqual([]);
  });

  it("size-before-SHA repair order: a size mismatch skips hashing entirely (vault file with wrong length is not read as repair)", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "different length content");
    const sha = await calculateGitBlobSHA(enc("short"));
    const bdir = writeBatch("20260830T1", [
      { path: "a.md", sha, size: "short".length, mtime: 5 , deletedSha: null},
    ]);
    fs.writeFileSync(path.join(bdir, ATTEMPTED_COMMIT_MARKER), "");
    await makeClaimer().recoverStaleCommitClaims();
    // Entry dropped (size proved repair impossible), blob still absent.
    expect(await syncStore.existInSyncStore(sha)).toBe(false);
    const meta = parseBatchMetafile(
      fs.readFileSync(path.join(bdir, BATCH_META_FILE), "utf8"),
    )!;
    expect(meta.entries).toEqual([]);
  });

  // R3b staging (owner 2026-10-04): a NEW batch dir is born in
  // push-queue-staging/ with its marker and renamed into the queue. A
  // staged dir outlives its writeBatch only through a crash before that
  // rename — holding nothing but the marker — and is swept on start.
  it("onload: a staged batch dir left by a crashed commit is removed; the queue is left alone", async () => {
    const stagingAbs = path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "push-queue-staging");
    fs.mkdirSync(path.join(stagingAbs, "20261004120000000"), { recursive: true });
    fs.writeFileSync(path.join(stagingAbs, "20261004120000000", ATTEMPTED_COMMIT_MARKER), "");
    const queued = writeBatch("20261004110000000", []);

    await makeClaimer().recoverStaleCommitClaims();

    expect(fs.existsSync(stagingAbs)).toBe(false);
    expect(fs.existsSync(path.join(queued, BATCH_META_FILE))).toBe(true);
    expect(warnings.some((w) => w.includes("staged batch dir"))).toBe(true);
  });

  it("onload: no staging area → nothing to do, nothing logged", async () => {
    await makeClaimer().recoverStaleCommitClaims();
    expect(warnings).toEqual([]);
  });
});
