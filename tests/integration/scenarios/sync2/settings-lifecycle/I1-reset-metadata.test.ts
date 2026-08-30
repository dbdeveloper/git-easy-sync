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
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// I1 — reset metadata (snapshot store). After a normal sync, wipe
// the snapshot store and sync again. sync2 must re-build snapshot
// state from the remote without re-pushing every file as "new" —
// the no-op-tree-skip elides any spurious commit because the SHAs
// match. The vault contents and the remote both stay intact.

describe.skipIf(!integrationEnabled())(
  "sync2 I1 — reset snapshot store",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let baselineCommits = 0;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i1-reset");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
      baselineCommits = await countBranchCommits(branch);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "snapshot reset → next sync re-aligns without re-pushing identical content",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");
        await client.vault.adapter.write("b.md", "b\n");
        await sync2AllAndAssertNoErrors(client);
        const afterFirstPush = await countBranchCommits(branch);
        expect(afterFirstPush - baselineCommits).toBe(1);

        // Reset the snapshot store. Mirrors what a "Reset metadata"
        // button would do — wipes everything sync2 knows about prior
        // pushes. The vault files are NOT touched.
        await client.baselines.clear();
        await client.hotMeta.update({
          lastSyncCommitSha: null,
          lastSyncTreeSha: null,
          lastCommitMtime: null,
          remoteIdentity: null,
          conflictBranch: null,
        });

        // Sync again. findChanges will see a.md and b.md as "added"
        // (snapshot is empty), but the upload path computes their
        // SHAs, sees they already exist remotely, and the new tree
        // ends up identical to the parent tree — no-op-tree-skip
        // kicks in, no new commit.
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("b\n");
        const afterReset = await countBranchCommits(branch);
        expect(afterReset - baselineCommits).toBe(1);
      },
      240_000,
    );
  },
);
