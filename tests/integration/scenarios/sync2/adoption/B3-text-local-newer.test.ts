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

// B3 — first sync after install where the SAME text file diverges
// between local and remote, and local has been edited more recently
// than the remote's HEAD commit was authored. Sync2 has no history
// to do a real 3-way merge against, so it falls back to atomic
// mtime resolution. Local newer → keep the local copy untouched;
// findChanges emits the path as "added" (no snapshot entry), and
// the follow-up push lifts the local version onto the remote.

describe.skipIf(!integrationEnabled())(
  "sync2 B3 — adoption: text divergence, local mtime newer than remote HEAD",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b3-text-local-newer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local notes.md edited LATER than remote head → local content wins, lands on remote",
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

        // Force local mtime to one minute IN THE FUTURE relative to
        // wall-clock NOW. The remote HEAD commit landed earlier in
        // this test (it's a GitHub-side timestamp from `writeRemoteFile`
        // above), so local-newer-than-HEAD is guaranteed regardless of
        // millisecond-level race with the GitHub API.
        const notesPath = path.join(client.vaultPath, "notes.md");
        const futureTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(notesPath, futureTs, futureTs);

        await sync2AllAndAssertNoErrors(client);

        // Local copy untouched.
        expect(fs.readFileSync(notesPath, "utf8")).toBe(
          "local version of notes\n",
        );

        // Remote ends up carrying the local version — the push
        // following adoption lifted it onto the branch.
        expect(await readRemoteFile(branch, "notes.md")).toBe(
          "local version of notes\n",
        );

        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
