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
import {
  reconcileConflictsForTest,
  trackedSiblingPathsFor,
  conflictEntryCount,
} from "../helpers";

// Classifier row 6 — siblingSha == baseSha → accept-theirs.
//
// Scenario: user resolves a modify-vs-modify conflict by copying
// the sibling file's contents onto the base path (the common
// "accept remote" gesture from CLI: `cp <sibling> <base>`). The
// classifier sees the two SHAs converge and drops the record
// silently — no further user action needed.
//
// Why this matters: it's the cheapest way for a power user to say
// "keep remote", parallel to "delete sibling = keep local". The
// integration check verifies that the cache-hit + cache-miss paths
// both reach the same decision against real GitHub round-trips.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — classifier row 6: copy-sibling-onto-base → accept-theirs",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-case6-accept-theirs");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "user copies sibling onto base → classifier accepts theirs + drops record",
      async () => {
        // Baseline: shared content on both sides.
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Diverge on the same line.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "local edit\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "remote edit\n",
          "[web] divergent",
        );
        await sync2AllAndAssertNoErrors(client);

        // Conflict registered: base unchanged, sibling holds remote.
        const records = trackedSiblingPathsFor(client, "note.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0];
        const siblingAbs = path.join(client.vaultPath, siblingPath);
        expect(fs.readFileSync(siblingAbs, "utf8")).toBe("remote edit\n");

        // User copies sibling content onto base (the "accept remote"
        // gesture). siblingSha and freshly-computed baseSha now
        // match — that's the row 6 trigger.
        const siblingContent = fs.readFileSync(siblingAbs, "utf8");
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          siblingContent,
          "utf8",
        );

        // Drive the classifier (production has ConflictWatcher; mock
        // vault doesn't auto-fire events on fs writes).
        await reconcileConflictsForTest(client);

        // Record dropped, sibling removed by the classifier (case 6
        // sweeps the now-redundant sibling), base stays at remote
        // content.
        expect(client.conflictStore.hasBase("note.md")).toBe(false);
        expect(fs.existsSync(siblingAbs)).toBe(false);
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "note.md"),
            "utf8",
          ),
        ).toBe("remote edit\n");

        // Next sync is a no-op for the path on GitHub — remote
        // already holds the same bytes. Convergence is silent.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "remote edit\n",
        );
      },
      300_000,
    );
  },
);
