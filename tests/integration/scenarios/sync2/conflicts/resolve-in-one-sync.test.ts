import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchHead,
  getDefaultBranchHead,
  getRemoteFileSha,
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

// Field, 2026-10-11 (owner, ~/Obsidian-test): a conflict resolved through
// the FILE SYSTEM (the copy made equal to the base by hand) took TWO syncs.
// The first sync's commit pass still saw a conflict and compared the base
// with the conflict branch — "nothing to commit"; the drain then closed the
// conflict and merged the branch, so main kept the server's version until
// the second sync carried ours up. Other devices meanwhile pulled the side
// the user had rejected.
//
// Owner's rule: the commit pass only READS. A conflict is still in force
// when a tracked copy exists on disk AND differs from the base; only then
// is the base compared with the conflict branch, otherwise with its
// baseline like any file. conflicts.json is changed by the drain alone.
//
// No manual reconcile anywhere in this file: production has none before a
// sync, and calling one here is exactly what hid the defect.

type Mode = "sync" | "split";

describe.skipIf(!integrationEnabled())(
  "sync2 — a conflict resolved through the file system reaches main in ONE sync",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranch: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-resolve-one-sync");
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

    const LOCAL = "ours\n";
    const THEIRS = "theirs\n";

    async function openConflict(): Promise<{ c: Sync2TestClient; copy: string }> {
      await writeRemoteFile(branch, "note.md", "shared\n", "[seed] baseline");
      const c = await createSync2Client({ branch });
      await sync2AllAndAssertNoErrors(c);
      fs.writeFileSync(path.join(c.vaultPath, "note.md"), LOCAL, "utf8");
      await writeRemoteFile(branch, "note.md", THEIRS, "[web] divergent");
      await sync2AllAndAssertNoErrors(c);
      const copies = trackedSiblingPathsFor(c, "note.md");
      expect(copies).toHaveLength(1);
      conflictBranch = c.hotMeta.getConflictBranch()?.name;
      expect(conflictBranch).toBeTruthy();
      return { c, copy: copies[0] };
    }

    // ONE user sync, in either mode the plugin offers.
    async function oneSync(c: Sync2TestClient, mode: Mode): Promise<void> {
      if (mode === "sync") {
        await sync2AllAndAssertNoErrors(c);
      } else {
        await c.manager.commitOnly();
        await c.manager.resumeQueue();
      }
    }

    async function assertSettled(c: Sync2TestClient): Promise<void> {
      expect(await getBranchHead(conflictBranch!)).toBeNull(); // merged + deleted
      await c.manager.commitOnly();
      expect(await c.queue.list()).toEqual([]); // nothing left to send
    }

    for (const mode of ["sync", "split"] as const) {
      it(
        `🔑 [${mode}] the copy edited to equal the base → main holds OUR version after ONE sync`,
        async () => {
          const { c, copy } = await openConflict();
          client = c;
          fs.writeFileSync(path.join(c.vaultPath, copy), LOCAL, "utf8");

          await oneSync(c, mode);

          expect(await readRemoteFile(branch, "note.md")).toBe(LOCAL);
          expect(fs.existsSync(path.join(c.vaultPath, copy))).toBe(false);
          await assertSettled(c);
        },
        300_000,
      );

      it(
        `🔑 [${mode}] the copy deleted (keep mine) → main holds OUR version after ONE sync`,
        async () => {
          const { c, copy } = await openConflict();
          client = c;
          fs.rmSync(path.join(c.vaultPath, copy));

          await oneSync(c, mode);

          expect(await readRemoteFile(branch, "note.md")).toBe(LOCAL);
          await assertSettled(c);
        },
        300_000,
      );
    }

    it(
      "the copy renamed onto the base (take theirs) → nothing to send, main keeps THEIRS, branch merged",
      async () => {
        const { c, copy } = await openConflict();
        client = c;
        fs.rmSync(path.join(c.vaultPath, "note.md"));
        fs.renameSync(path.join(c.vaultPath, copy), path.join(c.vaultPath, "note.md"));

        await oneSync(c, "sync");

        expect(await readRemoteFile(branch, "note.md")).toBe(THEIRS);
        await assertSettled(c);
      },
      300_000,
    );

    it(
      "both files deleted → the deletion reaches main in ONE sync",
      async () => {
        const { c, copy } = await openConflict();
        client = c;
        fs.rmSync(path.join(c.vaultPath, "note.md"));
        fs.rmSync(path.join(c.vaultPath, copy));

        await oneSync(c, "sync");

        expect(await getRemoteFileSha(branch, "note.md")).toBeNull();
        await assertSettled(c);
      },
      300_000,
    );

    it(
      "the server brings a version EQUAL to ours → the conflict closes by itself",
      async () => {
        const { c, copy } = await openConflict();
        client = c;
        await writeRemoteFile(branch, "note.md", LOCAL, "[web] agrees with ours");

        await oneSync(c, "sync"); // the copy folds to OURS = the base
        await oneSync(c, "sync"); // the drain prunes it; FINALIZE

        expect(fs.existsSync(path.join(c.vaultPath, copy))).toBe(false);
        expect(trackedSiblingPathsFor(c, "note.md")).toEqual([]);
        expect(await readRemoteFile(branch, "note.md")).toBe(LOCAL);
        await assertSettled(c);
      },
      300_000,
    );
  },
);
