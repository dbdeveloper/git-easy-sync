import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  readRemoteFile,
  respondForFirstN,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// T5.4 (SYNC2-FIX §7) — rate-limit EXHAUSTION. J2 pins the happy
// half (two 429s, backoff, then success); this pins the other half:
// GitHub keeps answering 429 past every retry attempt. The engine
// must give up in BOUNDED time with a clean error — no infinite
// spinner (I6) — and keep the queued batch intact so a later sync
// (rate limit lifted) completes normally.

describe.skipIf(!integrationEnabled())(
  "sync2 T5.4 — persistent 429: bounded retry, state preserved, later sync recovers",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t5-4-persistent-429");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "429 on every tree POST → syncAll settles in bounded time; retry after lift lands the file",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline.
        fs.writeFileSync(path.join(client.vaultPath, "a.md"), "base a\n");
        await sync2AllAndAssertNoErrors(client);

        // One queued batch.
        fs.writeFileSync(path.join(client.vaultPath, "a.md"), "ours a\n");
        await client.manager.commitOnly();
        expect((await client.queue.list()).length).toBe(1);

        // Rate-limit that never lifts (within this sync): every tree
        // POST gets 429. n=99 comfortably exceeds any retry budget —
        // if the engine ever makes 99 attempts, the bounded-time
        // assert below fails first.
        let served = 0;
        installRequestFaultInjector(
          respondForFirstN(
            (url, method) => {
              const hit = method === "POST" && /\/git\/trees\b/.test(url);
              if (hit) served += 1;
              return hit;
            },
            99,
            {
              status: 429,
              headers: { "Retry-After": "1" },
              body: '{"message":"You have exceeded a secondary rate limit."}',
            },
          ),
        );

        // I6 — the sync must SETTLE (resolve or reject) in bounded
        // time. The engine's worst-case retry budget is ~31 s of
        // exponential backoff; 90 s is the generous ceiling that
        // still catches an unbounded spin long before the test
        // timeout.
        const started = Date.now();
        await client.manager.syncAll().catch(() => {});
        const elapsed = Date.now() - started;
        installRequestFaultInjector(null);
        expect(served, "the 429 injector must have fired").toBeGreaterThan(0);
        expect(elapsed, `syncAll took ${elapsed} ms under persistent 429`).toBeLessThan(
          90_000,
        );

        // State preserved: the batch is still queued, remote untouched.
        expect((await client.queue.list()).length).toBe(1);
        expect(await readRemoteFile(branch, "a.md")).toBe("base a\n");

        // Rate limit "lifts" (injector removed) → plain sync lands it.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "a.md")).toBe("ours a\n");
        expect(await client.queue.list()).toEqual([]);
        expect(client.conflictStore.getAll()).toEqual([]);
        expect(client.hotMeta.getLastSyncCommitSha()).toBe(
          await getBranchHead(branch),
        );
      },
      300_000,
    );
  },
);
