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

// K5 — manifest with lastSync intact but files: {}. Mimics a
// partial corruption where lastSync/lastSyncTreeSha survive but the
// per-file SHA cache is gone (e.g. user-induced trim). findChanges
// re-emits everything as "added" via the snapshot-empty path; the
// SHAs match what's on remote, so the tree-build skips the commit.

const MANIFEST_REL = ".obsidian/git-easy-sync-metadata.json";

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

        // Wipe just the files map; leave lastSync* alone.
        const manifestAbs = path.join(vaultPath, MANIFEST_REL);
        const raw = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
        raw.files = {};
        fs.writeFileSync(manifestAbs, JSON.stringify(raw));

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
