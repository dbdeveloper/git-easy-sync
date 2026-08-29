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

// K1 — invalid JSON in the snapshot manifest. SnapshotStore.load()'s
// migrate() tolerates garbage by falling back to fresh metadata; the
// next syncAll re-aligns with remote via the no-op tree skip (SHAs
// already match, no spurious commit lands).

const MANIFEST_REL = ".obsidian/git-easy-sync-metadata.json";

describe.skipIf(!integrationEnabled())(
  "sync2 K1 — invalid JSON in snapshot manifest",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let baselineCommits = 0;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k1-bad-json");
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
      "garbage JSON → fresh metadata; re-sync stays no-op (SHAs match)",
      async () => {
        // First "session" — push a couple of files normally.
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
        expect(afterFirst - baselineCommits).toBe(1);

        // Corrupt the manifest. Garbage that's nowhere near JSON.
        const manifestAbs = path.join(vaultPath, MANIFEST_REL);
        fs.writeFileSync(manifestAbs, "{not valid json at all,;\n");

        // Re-instantiate over the same vault. load() catches the
        // parse error and falls back to fresh metadata.
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        // Remote files unchanged.
        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("b\n");
        // No spurious commit — SHAs already matched.
        const afterRecover = await countBranchCommits(branch);
        expect(afterRecover - baselineCommits).toBe(1);
      },
      300_000,
    );
  },
);
