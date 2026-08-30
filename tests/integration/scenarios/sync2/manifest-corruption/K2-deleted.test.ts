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

// K2 — all metadata files DELETED (hot pair + the whole baseline
// bucket dir). Both stores read missing files as fresh/empty; the
// recovery shape is the same as K1: re-align without a re-push.

const RUNTIME_REL = ".obsidian/plugins/git-easy-sync/.runtime";

describe.skipIf(!integrationEnabled())(
  "sync2 K2 — manifest file deleted",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let baselineCommits = 0;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k2-deleted");
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
      "manifest unlink → fresh metadata; sync re-aligns without re-pushing",
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

        // Delete every metadata file.
        const bucketsDir = path.join(vaultPath, RUNTIME_REL, "file-baselines");
        expect(fs.existsSync(bucketsDir)).toBe(true);
        fs.rmSync(bucketsDir, { recursive: true, force: true });
        for (const slot of ["a", "b"]) {
          fs.rmSync(
            path.join(vaultPath, RUNTIME_REL, `metadata-${slot}.json`),
            { force: true },
          );
        }

        // Re-instantiate. Both stores see nothing → fresh state.
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        // No new commit — content matches what's already there.
        const afterRecover = await countBranchCommits(branch);
        expect(afterRecover).toBe(afterFirst);
      },
      300_000,
    );
  },
);
