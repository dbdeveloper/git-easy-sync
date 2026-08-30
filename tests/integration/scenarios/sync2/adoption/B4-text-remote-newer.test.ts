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

// B4 — first sync after install where the SAME text file diverges
// between local and remote, but local has NOT been touched since
// before the remote's HEAD commit was authored. Sync2 falls back to
// atomic mtime resolution: remote newer → overwrite local in place
// and recordSync. (The README is meant to nudge users toward
// pre-adoption sync via the previous plugin — this branch loses
// local edits and is the riskier of the two outcomes.)

describe.skipIf(!integrationEnabled())(
  "sync2 B4 — adoption: text divergence, remote HEAD newer than local mtime",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b4-text-remote-newer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local notes.md is older than remote head → remote bytes overwrite local",
      async () => {
        await writeRemoteFile(
          branch,
          "notes.md",
          "remote version of notes\n",
          "[seed] remote notes",
        );

        client = await createSync2Client({ branch });
        await client.vault.adapter.write(
          "notes.md",
          "local version of notes\n",
        );

        // Force local mtime to one minute IN THE PAST relative to
        // wall-clock NOW. The remote HEAD commit landed mere seconds
        // ago in this test, so local-older-than-HEAD is guaranteed.
        const notesPath = path.join(client.vaultPath, "notes.md");
        const pastTs = (Date.now() - 60_000) / 1000;
        fs.utimesSync(notesPath, pastTs, pastTs);

        await sync2AllAndAssertNoErrors(client);

        // Local copy was overwritten with the remote bytes.
        expect(fs.readFileSync(notesPath, "utf8")).toBe(
          "remote version of notes\n",
        );

        // Remote unchanged (sync2 didn't pile a "local won" push on top).
        expect(await readRemoteFile(branch, "notes.md")).toBe(
          "remote version of notes\n",
        );

        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
