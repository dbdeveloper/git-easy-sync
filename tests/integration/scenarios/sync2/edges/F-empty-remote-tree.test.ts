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
  requireEnv,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import { EMPTY_TREE_SHA } from "../../../../../src/github/client";

// A branch whose every file has been deleted points at git's canonical
// EMPTY TREE, and GitHub answers 404 for that object — measured, and not
// eventual consistency: the 404 held for a full 20 s probe (DOT-FILES
// §10, side finding of 2026-09-20).
//
// It was recorded then as low-reachability. That was too generous: the
// plugin can produce the state ITSELF. Deleting every file in the vault
// and syncing sends deletion entries whose resulting tree is empty, and
// the NEXT sync then died in discovery with a NotFoundError — a dead end
// walked into by the plugin, not only something a user could do from the
// GitHub web UI.
//
// Distinct from a BARE repo (no commits at all), which analyzeRemoteState
// detects separately and answers with bootstrap. Here there IS history;
// it just currently holds nothing.

async function deleteEveryFileOnBranch(branch: string): Promise<void> {
  const env = requireEnv();
  const { token, owner, repo } = env;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const listed = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/?ref=${branch}`,
    { headers },
  );
  const entries = (await listed.json()) as Array<{
    type: string;
    path: string;
    sha: string;
  }>;
  for (const e of entries) {
    if (e.type !== "file") continue;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(e.path)}`,
      {
        method: "DELETE",
        headers,
        body: JSON.stringify({
          message: `test: empty the tree (${e.path})`,
          sha: e.sha,
          branch,
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`delete ${e.path} → ${res.status}: ${await res.text()}`);
    }
  }
}

describe.skipIf(!integrationEnabled())(
  "sync2 F — a remote with NO files at all",
  () => {
    let client: Sync2TestClient | undefined;
    let branch = "";

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("empty-tree");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch has no head");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      await client?.cleanup();
      client = undefined;
      await deleteBranchIfExists(branch);
    });

    it(
      "a cold start against an emptied branch syncs instead of dying on GitHub's 404",
      { retry: 0, timeout: 180_000 },
      async () => {
        await deleteEveryFileOnBranch(branch);

        // Precondition: the branch really does point at the empty tree,
        // so this test cannot pass for the wrong reason.
        const env = requireEnv();
        const head = await getBranchHead(branch, env);
        const commit = await fetch(
          `https://api.github.com/repos/${env.owner}/${env.repo}/git/commits/${head}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${env.token}`,
            },
          },
        );
        expect(((await commit.json()) as { tree: { sha: string } }).tree.sha).toBe(
          EMPTY_TREE_SHA,
        );

        // Cold start: brand-new client, no baselines, pointed at that
        // branch. This is the call that used to throw NotFoundError out
        // of fullTreeDiffAgainstColdBaseline.
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("note.md", "hello\n");
        await sync2AllAndAssertNoErrors(client);

        // And the sync did its job: the vault's file is on the remote.
        const after = await getBranchHead(branch, env);
        expect(after).not.toBe(head);
      },
    );
  },
);
