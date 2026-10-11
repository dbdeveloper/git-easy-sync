import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
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

// Field, 2026-10-11 (owner, ~/Obsidian-test): while a conflict stayed
// open, EVERY interval tick logged "committed 1: modified Untitled.md"
// and a drain with pushedCommits 0. The base file holds OUR version,
// which already sits on the conflict branch; the baseline is the
// server's (STEP2 sets base = R_m by design), so the commit pass saw a
// change every time and the drain dropped it every time.
//
// The commit pass must compare a conflicted base with what is on its
// CONFLICT BRANCH (conflicts.json conflictBase.sha), not with main. The
// old engine did (TODO §26, fcbf756); the wiring was dropped at THE
// SWITCH. Owner, 2026-10-11: the §6.3 "accepted churn" was about a
// deferred drain, never about an open conflict.

describe.skipIf(!integrationEnabled())(
  "sync2 — an open conflict is not re-committed on every sync",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranch: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-no-recommit");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      client = undefined;
      await deleteBranchIfExists(branch);
      if (conflictBranch) await deleteBranchIfExists(conflictBranch);
      conflictBranch = undefined;
    });

    async function openConflict(local: string | null): Promise<Sync2TestClient> {
      await writeRemoteFile(branch, "note.md", "shared\n", "[seed] baseline");
      const c = await createSync2Client({ branch });
      await sync2AllAndAssertNoErrors(c);
      const abs = path.join(c.vaultPath, "note.md");
      if (local === null) fs.rmSync(abs);
      else fs.writeFileSync(abs, local, "utf8");
      await writeRemoteFile(branch, "note.md", "theirs\n", "[web] divergent");
      await sync2AllAndAssertNoErrors(c);
      expect(trackedSiblingPathsFor(c, "note.md")).toHaveLength(1);
      conflictBranch = c.hotMeta.getConflictBranch()?.name;
      return c;
    }

    it(
      "🔑 base edited → conflict → a commit pass with no new edit queues NOTHING",
      async () => {
        client = await openConflict("ours\n");

        await client.manager.commitOnly();
        await client.manager.commitOnly();

        expect(await client.queue.list()).toEqual([]);
      },
      240_000,
    );

    it(
      "🔑 base DELETED → conflict → a commit pass does not report the deletion again",
      async () => {
        client = await openConflict(null);

        await client.manager.commitOnly();

        expect(await client.queue.list()).toEqual([]);
      },
      240_000,
    );

    it(
      "a REAL edit of the base while in conflict is committed exactly once, onto the conflict branch",
      async () => {
        client = await openConflict("ours\n");
        fs.writeFileSync(path.join(client.vaultPath, "note.md"), "ours, edited again\n", "utf8");

        await client.manager.commitOnly();
        expect(await client.queue.list()).toHaveLength(1);
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(conflictBranch!, "note.md")).toBe("ours, edited again\n");
        expect(await readRemoteFile(branch, "note.md")).toBe("theirs\n"); // main untouched
        await client.manager.commitOnly();
        expect(await client.queue.list()).toEqual([]);
      },
      240_000,
    );
  },
);
