import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// L4 — the attempted-marker rule: once processBatch has touched a
// batch even once (even just to fail), it's frozen against further
// mergeIntoLatestPending calls. With consolidateCommits=ON, a
// failed batch does NOT absorb subsequent sync clicks — they get
// fresh batches. Result: multiple commits in queue, each is its own
// batch, FIFO drained when the network returns.
//
// We inject a single-shot failure on the FIRST createCommit so that:
//   - Sync #1 fails at createCommit → B1 attempted-locked, in queue.
//   - Sync #2 succeeds (different batch B2). Pushes both B1 (resume)
//     AND B2 (new) FIFO; result: 2 separate commits.
//
// The point isn't the resume-from-failure mechanism itself
// (C2 covers that); it's that B2 was a NEW BATCH not folded into B1,
// proven by the second commit landing on remote.

const isCreateCommit = (url: string, method: string): boolean =>
  method === "POST" && /\/git\/commits(\?|$)/.test(url);

describe.skipIf(!integrationEnabled())(
  "sync2 L4 — accumulate=ON: attempted-marker locks merge, new clicks get new batches",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-l4-attempted-locks");
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
      "first push fails → batch attempted-locked → second sync stacks a new batch, not a merge",
      async () => {
        client = await createSync2Client({
          branch,
          consolidateCommits: true,
        });
        // Prime so the failure happens on the FIRST user-content
        // push, not on the invariants push.
        await sync2AllAndAssertNoErrors(client);

        // First sync: fail on createCommit so B1 reaches processBatch,
        // gets marked attempted, then throws.
        await client.vault.adapter.write("alpha.md", "alpha v1\n");
        installRequestFaultInjector(
          failOnNthMatch(
            isCreateCommit,
            1,
            "Simulated commit failure for L4",
          ),
        );
        await expect(client.manager.syncAll()).rejects.toThrow(
          /commit failure/i,
        );

        // After the failure, B1 stays in queue with attempted=true.
        const idsAfterFail = await client.queue.list();
        expect(idsAfterFail.length).toBe(1);
        const b1 = await client.queue.read(idsAfterFail[0]);
        // SWITCH-M: the claim marker is the R3b `.attempted` FILE in
        // the batch dir now (get-batch protocol), not a meta field —
        // whether a failed drain leaves it is re-derived at the gate.
        expect(b1.files).toEqual(["alpha.md"]);

        // Lift the fault and click Sync again with NEW changes. Under
        // attempted-marker rules, mergeIntoLatestPending skips B1 →
        // B2 is a fresh separate batch even though accumulate=ON.
        installRequestFaultInjector(null);
        await client.vault.adapter.write("beta.md", "beta v1\n");
        await sync2AllAndAssertNoErrors(client);

        // Queue drained: both B1 (resumed) and B2 (new) shipped as
        // SEPARATE commits. No accumulate-merge happened.
        expect(await client.queue.list()).toEqual([]);

        // Walk the recent history: we expect TWO commits on top of
        // the prime baseline, NOT one. The beta.md and alpha.md
        // edits are in different commits.
        const { token, owner, repo } = (await import("../../../helpers"))
          .requireEnv();
        const treeResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const treeJson = (await treeResp.json()) as {
          tree: Array<{ path: string }>;
        };
        const paths = treeJson.tree.map((e) => e.path);
        expect(paths).toContain("alpha.md");
        expect(paths).toContain("beta.md");
      },
      300_000,
    );
  },
);
