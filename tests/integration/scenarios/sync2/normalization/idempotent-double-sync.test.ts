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
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// text canonicalisation — convergence + idempotency. The first syncAll after a
// noisy remote pull should converge in exactly two commits (the
// remote's noisy commit + sync2's auto-republish). The second
// syncAll, with no further changes anywhere, must produce ZERO new
// commits — otherwise we have a thrashing loop where every sync
// re-normalizes and re-pushes.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — second sync after normalize is a no-op",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-idem");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "double sync after normalize-republish: no thrashing loop",
      async () => {
        // Web puts a CRLF file on the branch.
        await writeRemoteFile(
          branch,
          "doc.md",
          "alpha\r\nbeta\r\n",
          "[web] CRLF",
        );

        client = await createSync2Client({ branch });

        // ⚔️ RE-DERIVED AT THE SWITCH (R2 "call me again", SYNC2-FIX
        // §6): convergence takes TWO syncs now — sync #1 pulls and
        // canonicalizes the vault (the drain's Vault-step runs after
        // this sync's findChanges), sync #2 republishes. What this
        // test actually guards is unchanged and is the point: the
        // loop must TERMINATE.
        const headBefore = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        const headAfterConverge = await getBranchHead(branch);
        expect(headAfterConverge).not.toBe(headBefore); // the republish landed

        // Every later sync is a no-op — no thrashing loop.
        await sync2AllAndAssertNoErrors(client);
        expect(await getBranchHead(branch)).toBe(headAfterConverge);
        await sync2AllAndAssertNoErrors(client);
        expect(await getBranchHead(branch)).toBe(headAfterConverge);
      },
      180_000,
    );
  },
);
