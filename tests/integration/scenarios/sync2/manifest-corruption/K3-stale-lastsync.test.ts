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

// K3 — manifest's lastSync points to a commit that doesn't exist on
// remote (e.g. force-pushed history that GC'd the commit). The
// compare() call returns 404; pullIfNeeded warns and returns
// currentHead so the next push reconciles against the live branch
// head. No crash, no data loss.

const MANIFEST_REL = ".obsidian/git-easy-sync-metadata.json";

describe.skipIf(!integrationEnabled())(
  "sync2 K3 — stale lastSyncCommitSha (unreachable on remote)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k3-stale-sha");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "bogus lastSyncCommitSha → 404 on compare → pullIfNeeded warns; next sync continues",
      async () => {
        const first = await createSync2Client({
          branch,
          ownsVaultPath: false,
        });
        const vaultPath = first.vaultPath;
        client = {
          ...first,
          cleanup: () => {
            try {
              fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {}
          },
        };
        await first.vault.adapter.write("a.md", "a\n");
        await sync2AllAndAssertNoErrors(first);
        const afterFirst = await countBranchCommits(branch);

        // Rewrite the manifest with a SHA that has the right shape
        // but doesn't exist in the repo. compare(bogus, head) → 404.
        const manifestAbs = path.join(vaultPath, MANIFEST_REL);
        const raw = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
        const bogus = "deadbeef".repeat(5); // 40 hex chars, plausible
        raw.lastSyncCommitSha = bogus;
        raw.lastSyncTreeSha = bogus;
        fs.writeFileSync(manifestAbs, JSON.stringify(raw));

        // Re-instantiate. pullIfNeeded should warn & return current
        // head instead of crashing.
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        // Make a local edit to give the next sync something to push.
        await client.vault.adapter.write("a.md", "a v2\n");
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a v2\n");
        const afterRecover = await countBranchCommits(branch);
        // One new commit for our edit; the recovery didn't double-push.
        expect(afterRecover).toBe(afterFirst + 1);
      },
      300_000,
    );
  },
);
