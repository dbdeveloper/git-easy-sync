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

// K5 — the whole baseline map is gone (every bucket file deleted)
// while the hot pair (lastSync anchor) survives. Next sync re-aligns:
// identical content is NOT re-pushed (no-op tree skip on matching
// SHAs), no commit lands.

const RUNTIME_REL = ".obsidian/plugins/git-easy-sync/.runtime";

describe.skipIf(!integrationEnabled())(
  "sync2 K5 — empty files map but lastSync set",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k5-empty-files");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "files map cleared → next sync re-aligns without re-pushing identical content",
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
        await first.vault.adapter.write("b.md", "b\n");
        await sync2AllAndAssertNoErrors(first);
        const afterFirst = await countBranchCommits(branch);

        // Wipe just the baseline buckets; leave the hot pair alone.
        fs.rmSync(path.join(vaultPath, RUNTIME_REL, "file-baselines"), {
          recursive: true,
          force: true,
        });

        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("b\n");
        // Same SHAs → no-op tree skip → no new commit.
        const afterRecover = await countBranchCommits(branch);
        expect(afterRecover).toBe(afterFirst);
      },
      300_000,
    );
  },
);
