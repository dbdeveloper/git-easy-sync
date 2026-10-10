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
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// I6 — a settings change that points the plugin at a different remote
// (here: a different branch on the same int-test repo) must re-adopt
// cleanly, without leaking content from the previous one.
//
// ⚠️ MECHANISM HISTORY — re-checked 2026-10-10 against the code. This
// comment once credited `reconcileRemoteIdentity`, a snapshot/queue wipe
// and `bootstrapFromRemote`; all three were deleted at THE SWITCH, and
// the comment was then corrected to the force-push-class explanation.
// `reconcileRemoteIdentity` was RESTORED the same day (2026-10-03,
// sync2-manager.ts) and since 2026-10-10 runs at the start of EVERY
// drain and commit pass, not only syncAll. `bootstrapFromRemote` stays
// gone.
//
// What handles it now: the recorded identity (owner, repo, branch) no
// longer matches settings → the progress log, the drain journal, the
// baselines, the anchor, the conflict-branch name, the queue and the
// conflict records are wiped; the next drain is a COLD START — no
// anchor, discovery diffs the full tree against the (empty) baselines,
// and per-path rules decide.

describe.skipIf(!integrationEnabled())(
  "sync2 I6 — repo/branch switch auto-detects and re-adopts",
  () => {
    let client: Sync2TestClient | undefined;
    let branchA: string;
    let branchB: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branchA = uniqueBranchName("sync2-i6-A");
      branchB = uniqueBranchName("sync2-i6-B");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branchA, head);
      await createBranchFromHead(branchB, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branchA);
      await deleteBranchIfExists(branchB);
    });

    it(
      "branch change in settings → next syncAll adopts the new branch's content into the same vault",
      async () => {
        // Pre-populate branchA with content unique to that branch.
        await writeRemoteFile(
          branchA,
          "from-A.md",
          "content from branch A\n",
          "[seed] branchA payload",
        );
        // Pre-populate branchB with DIFFERENT content.
        await writeRemoteFile(
          branchB,
          "from-B.md",
          "content from branch B\n",
          "[seed] branchB payload",
        );

        // Sync once against branchA — pulls A's content.
        client = await createSync2Client({ branch: branchA });
        await sync2AllAndAssertNoErrors(client);
        expect(
          fs.readFileSync(path.join(client.vaultPath, "from-A.md"), "utf8"),
        ).toBe("content from branch A\n");

        // User changes settings.branch from A to B. Mutate the live
        // settings reference — that's what production does when the
        // user edits the field in the settings tab.
        client.settings.githubBranch = branchB;

        // Next syncAll: reconcileRemoteIdentity sees the branch changed
        // and wipes repo-A state (see the header); the drain then
        // cold-starts against branchB and pulls B's content into the
        // same vault.
        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.readFileSync(path.join(client.vaultPath, "from-B.md"), "utf8"),
        ).toBe("content from branch B\n");
        // Remote branchA stayed untouched — we didn't leak B's
        // content back to A via a stale push-queue batch.
        expect(await readRemoteFile(branchA, "from-A.md")).toBe(
          "content from branch A\n",
        );
        try {
          await readRemoteFile(branchA, "from-B.md");
          throw new Error("from-B.md should not exist on branch A");
        } catch (err) {
          expect(String(err)).toMatch(/not in branch/);
        }
      },
      360_000,
    );
  },
);
