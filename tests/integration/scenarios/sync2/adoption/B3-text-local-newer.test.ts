import {
// ⚔️ RE-DERIVED AT THE SWITCH (2026-08-31). This file used to assert
// the OLD `bootstrapFromRemote` adoption heuristic ("adoption is
// local-authority-leaning": mtime decides, the winner lands on both
// sides). That heuristic is GONE — MASTER-PLAN §6.4, owner decision
// (A): cold start with BOTH sides present and DIFFERENT and NO common
// base is a MANUAL CONFLICT ("шторм конфліктів тут не вада, а особлива
// feature"), because a silent mtime winner is data loss. So the
// re-derived contract is: the vault keeps OURS, main keeps THEIRS, a
// sibling carrying theirs appears next to the base file, and the
// conflict is registered in conflicts.json. (In the REAL adoption
// scenario the vault was already synced by the old plugin, so almost
// every path takes rule 2.a — zero conflicts, zero pushes. These
// tests deliberately construct the divergence.)
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
  trackedSiblingPathsFor,
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

        // Vault keeps OURS.
        expect(fs.readFileSync(notesPath, "utf8")).toBe(
          "local version of notes\n",
        );

        // Main keeps THEIRS — no silent mtime winner on the branch.
        expect(await readRemoteFile(branch, "notes.md")).toBe(
          "remote version of notes\n",
        );

        // The divergence is a REGISTERED conflict with a sibling
        // carrying theirs.
        const siblings = trackedSiblingPathsFor(client, "notes.md");
        expect(siblings).toHaveLength(1);
        expect(
          fs.readFileSync(path.join(client.vaultPath, siblings[0]), "utf8"),
        ).toBe("remote version of notes\n");

        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
