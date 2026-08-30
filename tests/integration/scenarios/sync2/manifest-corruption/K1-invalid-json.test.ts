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

// K1 — every metadata file is garbage: both hot slots (each reads as
// seq −1 → fresh state, next write self-heals the pair) and every
// baseline bucket (each reads as empty — the §3 degraded mode). The
// invariant carried over from the monolith era: corrupt metadata is
// total amnesia, never data loss and never a re-push — the next
// syncAll re-aligns via the no-op tree skip (SHAs already match).

const RUNTIME_REL = ".obsidian/plugins/git-easy-sync/.runtime";

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

        // Corrupt EVERYTHING: both hot slots and every bucket.
        for (const slot of ["a", "b"]) {
          fs.writeFileSync(
            path.join(vaultPath, RUNTIME_REL, `metadata-${slot}.json`),
            "{not valid json at all,;\n",
          );
        }
        const bucketsDir = path.join(vaultPath, RUNTIME_REL, "file-baselines");
        for (const f of fs.readdirSync(bucketsDir)) {
          fs.writeFileSync(path.join(bucketsDir, f), "{not valid json,;\n");
        }

        // Re-instantiate over the same vault. Both stores degrade to
        // fresh/empty instead of crashing.
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
