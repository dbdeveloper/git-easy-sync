import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  countBranchCommits,
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  getRemoteFileSha,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// T2.1 (SYNC2-FIX §7, TODO п.1) — multiple queued batches, one drain.
//
// Rapid successive commitOnly calls (different file each) accumulate
// separate batches in .push-queue WITHOUT a drain in between — the
// state a user creates by hitting [Commit] several times while
// offline or before pressing [Sync]. One syncAll must then drain them
// all.
//
// Per the §7 principle, this asserts INVARIANTS, not a step trace:
//   I1 — every committed change reaches GitHub byte-exact;
//   I4 — the queue is fully drained (no batch skipped or half-done);
//   I5 — queue and snapshot end consistent: every snapshot entry
//        matches the real remote tree (SHA equality for the synced
//        files, no orphan snapshot paths), and lastSyncCommitSha is
//        the real branch head.
// It deliberately does NOT pin how many commits the drain produces —
// that is engine-shape (one per batch today), not an invariant.

describe.skipIf(!integrationEnabled())(
  "sync2 T2.1 — several queued batches drain in one syncAll",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 4;
    const file = (i: number): string => `t2-note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t2-1-multi-batch");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "4 commitOnly clicks (different files) → queue holds 4 batches → one syncAll lands all, snapshot consistent",
      async () => {
        client = await createSync2Client({ branch });

        // Prime: invariant gitignores land in their own commit and the
        // snapshot gets its baseline.
        await sync2AllAndAssertNoErrors(client);
        const commitsAfterPrime = await countBranchCommits(branch);

        // Accumulate: one batch per commitOnly, no drain in between.
        for (let i = 1; i <= N; i++) {
          await client.vault.adapter.write(file(i), `v ${i}\n`);
          await client.manager.commitOnly();
        }
        expect(
          (await client.queue.list()).length,
          "each commitOnly must enqueue its own batch",
        ).toBe(N);

        // One drain for the whole queue.
        await sync2AllAndAssertNoErrors(client);

        // I4 — queue fully drained.
        expect(await client.queue.list()).toEqual([]);

        // I1 — every file landed byte-exact.
        for (let i = 1; i <= N; i++) {
          expect(await readRemoteFile(branch, file(i))).toBe(`v ${i}\n`);
        }

        // Sanity: the drain advanced the branch (shape-agnostic — we
        // don't pin the commit count, only that history moved).
        expect(await countBranchCommits(branch)).toBeGreaterThan(
          commitsAfterPrime,
        );

        // I5 — snapshot ↔ remote consistency.
        // (a) The synced files' snapshot SHAs equal the real remote
        //     blob SHAs.
        for (let i = 1; i <= N; i++) {
          const snap = await client.baselines.get(file(i));
          expect(snap, `${file(i)} must have a baseline entry`).toBeDefined();
          expect(snap!.baselineSha).toBe(
            await getRemoteFileSha(branch, file(i)),
          );
        }
        // (b) No orphan baseline entries: every recorded path exists
        //     on the remote tree.
        const remotePaths = new Set(await listRemoteFiles(branch));
        for (const p of await client.baselines.allPaths()) {
          expect(remotePaths.has(p), `orphan baseline entry: ${p}`).toBe(true);
        }
        // (c) The recorded lastSync head is the branch's real head.
        expect(client.hotMeta.getLastSyncCommitSha()).toBe(
          await getBranchHead(branch),
        );
      },
      300_000,
    );
  },
);
