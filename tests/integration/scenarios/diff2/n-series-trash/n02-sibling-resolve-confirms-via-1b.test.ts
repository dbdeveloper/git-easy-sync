import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as path from "path";
import * as fs from "fs";
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
} from "../../sync2/helpers";
import {
  reconcileConflictsForTest,
  trackedSiblingPathsFor,
  conflictEntryCount,
} from "../../sync2/helpers";

// n02 — R3.5 layer 1b (confirmResolved) end-to-end.
//
// Conflict scenario: overlap → modify-vs-modify registered → sibling
// file lands in vault. User deletes the sibling via trash (simulated
// by intercept + adapter.remove). Phase A on next sync drops the
// record; Phase B synthesizes a side-batch with
// meta.resolvesConflictForBasePath = "note.md". processBatch success
// fires trashHooks.confirmResolved("note.md") → layer 1b wipes the
// sibling-trash entry.
//
// Independent verification: confirmDeleted does NOT match here
// (the sibling path isn't a base-file delete, and the side-batch's
// deleted-paths.txt is empty since it writes content). Only layer 1b
// could remove this entry from trash before layer 2's drain-end sweep.

describe.skipIf(!integrationEnabled())(
  "sync2 diff2 n02 — sibling-resolve confirms via layer 1b",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-n02");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "sibling-delete → layer 1b wipes sibling-trash on resolve-push",
      async () => {
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Diverge to produce modify-vs-modify.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours version\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs version\n",
          "[web] divergent edit",
        );

        await sync2AllAndAssertNoErrors(client);

        const records = trackedSiblingPathsFor(client, "note.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0];
        const siblingAbs = path.join(client.vaultPath, siblingPath);
        expect(fs.existsSync(siblingAbs)).toBe(true);

        // Simulate user-driven sibling delete: capture to trash, then
        // remove from vault. After this, Phase A on next drain sees
        // the sibling missing and drops the record; Phase B synthesizes
        // a side-batch with resolvesConflictForBasePath = "note.md".
        await client.trashStore.intercept(siblingPath);
        await client.vault.adapter.remove(siblingPath);

        // ConflictWatcher's markDirty would fire via vault.on('delete')
        // in production; the integration fixture's mock vault doesn't
        // emit those events, so drive the classifier manually so Phase A
        // runs on the next drain.
        await reconcileConflictsForTest(client);
        expect(client.conflictStore.hasBase("note.md")).toBe(false);

        // Pre-sync state: trash has exactly the sibling entry.
        const beforeSync = await client.trashStore.list();
        expect(beforeSync.map((r) => r.originalPath)).toEqual([siblingPath]);

        // Sync — Phase B side-batch with resolvesConflictForBasePath
        // pushes ours to main, processBatch fires confirmResolved
        // ("note.md") → layer 1b wipes the sibling-trash entry.
        await sync2AllAndAssertNoErrors(client);

        const afterSync = await client.trashStore.list();
        expect(afterSync).toEqual([]);
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "ours version\n",
        );
      },
      300_000,
    );
  },
);
