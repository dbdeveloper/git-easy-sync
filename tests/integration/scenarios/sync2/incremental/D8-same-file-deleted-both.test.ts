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
  listRemoteFiles,
  removeRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// D8 — same file deleted on both sides. Per the user's rule, this
// is a no-op: nothing to push (already gone on remote), nothing to
// pull (already gone locally), snapshot just drops the entry.

describe.skipIf(!integrationEnabled())(
  "sync2 D8 — same file deleted on both sides → no-op",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d8-same-del-both");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "delete x both sides → x stays gone on both, sync succeeds without errors",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("x.md", "x v1\n");
        await client.vault.adapter.write("y.md", "y stays\n");
        await sync2AllAndAssertNoErrors(client);

        // Local: delete x.md.
        await client.vault.adapter.remove("x.md");
        // Remote: another device also deleted x.md.
        await removeRemoteFile(branch, "x.md", "[other] delete x.md");

        await sync2AllAndAssertNoErrors(client);

        // x.md still gone on both sides; y.md unaffected.
        expect(fs.existsSync(path.join(client.vaultPath, "x.md"))).toBe(false);
        expect(fs.existsSync(path.join(client.vaultPath, "y.md"))).toBe(true);
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("x.md");
        expect(remoteFiles).toContain("y.md");

        // Snapshot dropped x.md (no orphan entry).
        expect(await client.baselines.allPaths()).not.toContain("x.md");
      },
      240_000,
    );
  },
);
