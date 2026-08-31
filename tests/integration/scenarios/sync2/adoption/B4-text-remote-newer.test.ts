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

        // Vault keeps OURS (mtime does NOT decide any more — §6.4).
        expect(fs.readFileSync(notesPath, "utf8")).toBe(
          "local version of notes\n",
        );

        // Main keeps THEIRS.
        expect(await readRemoteFile(branch, "notes.md")).toBe(
          "remote version of notes\n",
        );

        // Registered conflict + sibling carrying theirs.
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
