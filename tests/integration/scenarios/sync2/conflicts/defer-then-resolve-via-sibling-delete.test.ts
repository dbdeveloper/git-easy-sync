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

// Pseudo-merge stage 5c: register-conflict + classifier resolution
// via sibling-delete, end to end against real GitHub.
//
// Detection registers the conflict as `modify-vs-modify`. A sibling
// file lands in the vault, the path is excluded from push, and the
// next sync leaves remote untouched. The user deletes the sibling —
// classifier's case 1 (!siblingExists) fires → accept-ours → record
// dropped. Next sync pushes ours to GitHub, replacing theirs.
//
// ConflictWatcher is wired in production; this test invokes the
// classifier manually via evaluateConflictState() because the
// mock-obsidian vault doesn't fire vault.on events for fs ops
// (production Obsidian does — verified end-to-end by
// conflicts/watcher-realtime.test.ts).

describe.skipIf(!integrationEnabled())(
  "sync2 conflict — register + resolve via sibling delete",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-conflict-defer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "overlap → sibling registered → delete sibling → next sync pushes ours",
      async () => {
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "note.md"),
            "utf8",
          ),
        ).toBe("shared baseline\n");

        // Diverge: same-line overlap → 3-way merge fails → register
        // modify-vs-modify.
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

        // Conflict registered. Sibling file in the vault carrying
        // theirs content; ours stays in the base file.
        const records = trackedSiblingPathsFor(client, "note.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0];
        const siblingAbs = path.join(client.vaultPath, siblingPath);
        expect(fs.existsSync(siblingAbs)).toBe(true);
        expect(fs.readFileSync(siblingAbs, "utf8")).toBe(
          "theirs version\n",
        );

        // Local file unchanged.
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "note.md"),
            "utf8",
          ),
        ).toBe("ours version\n");

        // Remote unchanged (push skipped the path).
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "theirs version\n",
        );

        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain(siblingPath);

        // User deletes the sibling — case 1 trigger. ConflictWatcher
        // would auto-fire here; pre-wire, we drive the classifier
        // manually.
        fs.rmSync(siblingAbs);
        await reconcileConflictsForTest(client);
        expect(client.conflictStore.hasBase("note.md")).toBe(false);

        await sync2AllAndAssertNoErrors(client);

        // Remote now has ours.
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "ours version\n",
        );
      },
      300_000,
    );
  },
);
