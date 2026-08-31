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

// Pseudo-merge multi-sibling resolution. Two consecutive
// register-conflict events on the same path produce two sibling
// files. Deleting the first one leaves the second pending — sync
// still excludes the path. Deleting the second one finally closes
// the conflict; the next sync pushes ours.
//
// Pre-ConflictWatcher: classifier driven manually after each
// sibling delete.

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — multi-sibling: resolve one at a time",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-multi");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "two siblings on one path → resolve both → final push goes through",
      async () => {
        await writeRemoteFile(
          branch,
          "shared.md",
          "v0 baseline\n",
          "[seed]",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // First conflict.
        fs.writeFileSync(
          path.join(client.vaultPath, "shared.md"),
          "ours v1\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "shared.md",
          "theirs v1\n",
          "[web] divergent v1",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(trackedSiblingPathsFor(client, "shared.md")).toHaveLength(1);

        // Second conflict: theirs changes again on remote; ours
        // stays locked at v1 because the path is filtered out of
        // enqueue (hasPending).
        await writeRemoteFile(
          branch,
          "shared.md",
          "theirs v2\n",
          "[web] divergent v2",
        );
        // Small wait to keep the second record's id distinct (UUIDs
        // are random; this is defensive).
        await new Promise((r) => setTimeout(r, 5));
        await sync2AllAndAssertNoErrors(client);
        const records = trackedSiblingPathsFor(client, "shared.md");
        expect(records).toHaveLength(2);

        // Resolve sibling 1 (older). Classifier case 1 → drop that
        // record; path stays pending because sibling 2 is still
        // there.
        fs.rmSync(path.join(client.vaultPath, records[0]));
        await reconcileConflictsForTest(client);
        expect(client.conflictStore.hasBase("shared.md")).toBe(true);
        expect(trackedSiblingPathsFor(client, "shared.md")).toHaveLength(1);

        // Sync after first resolve — path still blocked, remote
        // unchanged.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "theirs v2\n",
        );

        // Resolve sibling 2 — path closes.
        fs.rmSync(path.join(client.vaultPath, records[1]));
        await reconcileConflictsForTest(client);
        expect(client.conflictStore.hasBase("shared.md")).toBe(false);

        // Now sync pushes ours.
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "ours v1\n",
        );
      },
      300_000,
    );
  },
);
