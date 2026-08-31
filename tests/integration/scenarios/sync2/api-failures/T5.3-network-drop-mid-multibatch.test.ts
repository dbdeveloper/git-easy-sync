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
  failOnNthMatch,
  getBranchHead,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
  conflictEntryCount,
} from "../helpers";

// T5.3 (SYNC2-FIX §7) — transient network death MID multi-batch drain
// (the owner's "users have far worse connectivity than we do"). Three
// queued batches; the SECOND batch's createCommit throws a hard
// (non-retriable) error — the drain dies with work still queued.
//
// Invariants:
//   I1 — nothing queued is lost: the un-pushed batches survive the
//        failed drain on disk;
//   I3/I6 — the failed sync exits cleanly (an error, not a hang), and
//        the NEXT sync drains the remainder to full convergence.
//
// J4 pins the single-batch flavor ("throw on first call"); this is
// the multi-batch flavor where the failure lands between batches, so
// partial progress + retained tail must coexist.

describe.skipIf(!integrationEnabled())(
  "sync2 T5.3 — hard network error between batches: tail survives, next sync converges",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 3;
    const file = (i: number): string => `note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t5-3-net-drop");
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
      "3 batches, createCommit #2 throws → queue keeps the tail; recovery sync lands all 3",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `base ${i}\n`);
        }
        await sync2AllAndAssertNoErrors(client);

        // Three separate batches.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
          await client.manager.commitOnly();
        }
        expect((await client.queue.list()).length).toBe(N);

        // Kill the SECOND batch's commit creation with a hard error
        // (a plain Error is not socket-class, so the client's tier-1
        // retry must NOT absorb it — the drain has to fail).
        let fired = 0;
        installRequestFaultInjector(
          failOnNthMatch(
            (url, method) => {
              const hit =
                method === "POST" && /\/git\/commits(\?|$)/.test(url);
              if (hit) fired += 1;
              return hit;
            },
            2,
            "Simulated network drop between batches",
          ),
        );

        // The failing drain — the injected error propagates out of
        // syncAll (same as J4); what matters is state, not the throw.
        await client.manager.syncAll().catch(() => {});
        installRequestFaultInjector(null);
        expect(fired, "the drop must actually have fired").toBeGreaterThanOrEqual(2);

        // I1 — the tail survived: queued work remains on disk, and
        // the not-yet-pushed files are still at base on the remote.
        const queuedAfterFail = await client.queue.list();
        expect(queuedAfterFail.length).toBeGreaterThan(0);

        // Recovery: plain next sync drains the remainder.
        await sync2AllAndAssertNoErrors(client);

        // I3 — full convergence, nothing lost, nothing duplicated.
        for (let i = 1; i <= N; i++) {
          expect(await readRemoteFile(branch, file(i))).toBe(`ours ${i}\n`);
        }
        expect(await client.queue.list()).toEqual([]);
        expect(conflictEntryCount(client)).toBe(0);
        expect(client.hotMeta.getLastSyncCommitSha()).toBe(
          await getBranchHead(branch),
        );
      },
      300_000,
    );
  },
);
