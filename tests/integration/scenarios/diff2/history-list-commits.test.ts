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
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
} from "../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../sync2/helpers";

// Phase 7 (History) 7a.0 — `GithubClient.listCommitsForPath` against real
// GitHub. Backs HISTORY-DELETED §4.7 7a.0 ("Acceptance: version list builds
// from both sources"): here the GitHub source, plus pagination + `since`.
// Not a TDD driver (pnpm build && pnpm test is the gate) — this is the
// real-server contract check.

describe.skipIf(!integrationEnabled())(
  "diff2 7a.0 — listCommitsForPath",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-7a0-list-commits");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "returns a path's commits newest-first, and honors per_page/page + since",
      async () => {
        client = await createSync2Client({ branch });
        const PATH = "History/note.md";

        // Three commits that touch PATH (each syncAll = one commit).
        await client.vault.adapter.write(PATH, "v1\n");
        await sync2AllAndAssertNoErrors(client);
        await client.vault.adapter.write(PATH, "v1\nv2\n");
        await sync2AllAndAssertNoErrors(client);
        await client.vault.adapter.write(PATH, "v1\nv2\nv3\n");
        await sync2AllAndAssertNoErrors(client);

        const all = await client.client.listCommitsForPath({
          path: PATH,
          branch,
          retry: true,
        });
        // At least our 3 (the branch may carry a bootstrap commit that
        // does not touch PATH, so filter is by path — expect exactly 3).
        expect(all.length).toBe(3);
        // Newest-first: dates non-increasing.
        const ms = all.map((c) => Date.parse(c.date));
        expect(ms).toEqual([...ms].sort((a, b) => b - a));
        for (const c of all) {
          expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
          expect(typeof c.message).toBe("string");
        }

        // Pagination: one per page.
        const page1 = await client.client.listCommitsForPath({
          path: PATH,
          branch,
          perPage: 1,
          page: 1,
          retry: true,
        });
        expect(page1).toHaveLength(1);
        expect(page1[0].sha).toBe(all[0].sha);
        const page2 = await client.client.listCommitsForPath({
          path: PATH,
          branch,
          perPage: 1,
          page: 2,
          retry: true,
        });
        expect(page2).toHaveLength(1);
        expect(page2[0].sha).toBe(all[1].sha);

        // `since` after the newest commit → empty (GitHub `since` is
        // inclusive on the commit date; +1s past the newest excludes all).
        const since = new Date(Date.parse(all[0].date) + 1000).toISOString();
        const none = await client.client.listCommitsForPath({
          path: PATH,
          branch,
          since,
          retry: true,
        });
        expect(none).toHaveLength(0);
      },
      120_000,
    );
  },
);
