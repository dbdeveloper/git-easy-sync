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
  getBranchHead,
  getBranchCommitMessages,
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
import { evaluateConflictState } from "../../../../../src/sync2/conflict-classifier";

// Pseudo-merge stage 7c — edit-while-in-conflict routes to the
// conflict branch, not main.
//
// Setup: trigger a conflict on a path. After registration, the
// user keeps editing the same file locally. The next sync's
// findChanges sees the edit and (post-7c) enqueueOrMerge no longer
// filters in-conflict paths; processBatch's partition step routes
// the edit to the per-device conflict branch as a new commit on
// top of the previous "ours snapshot". Other devices stay
// shielded — main never sees these edits until resolution. After
// the user deletes the sibling, the next sync pushes the
// accumulated ours to main.

describe.skipIf(!integrationEnabled())(
  "sync2 pseudo-merge — edit-while-in-conflict routes to branch (stage 7c)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranchToCleanup: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-pseudo-edit");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
      if (conflictBranchToCleanup) {
        await deleteBranchIfExists(conflictBranchToCleanup);
        conflictBranchToCleanup = undefined;
      }
    });

    it(
      "conflict → edit local file again → next sync lands the edit on the branch, not main",
      async () => {
        // Seed shared baseline.
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Diverge → conflict registered.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours v1\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs\n",
          "[web] divergent",
        );
        await sync2AllAndAssertNoErrors(client);

        const records = client.conflictStore.getByPath("note.md");
        expect(records).toHaveLength(1);
        const cb = client!.hotMeta.getConflictBranch();
        expect(cb).not.toBeNull();
        conflictBranchToCleanup = cb!.name;

        // Branch carries ours v1 (first conflict snapshot commit).
        expect(await readRemoteFile(cb!.name, "note.md")).toBe("ours v1\n");
        const branchHeadAfterRegister = cb!.head;

        // User keeps editing the conflicted file.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours v2 (more edits)\n",
          "utf8",
        );
        await sync2AllAndAssertNoErrors(client);

        // Edit landed on the conflict branch, NOT main.
        expect(await readRemoteFile(cb!.name, "note.md")).toBe(
          "ours v2 (more edits)\n",
        );
        expect(await readRemoteFile(branch, "note.md")).toBe("theirs\n");

        // Branch head advanced to a new commit. Every commit on the
        // conflict-branch — initial registration and
        // edit-while-in-conflict pushes alike — uses the same
        // hardcoded `conflict ({deviceLabel})` message.
        const updatedCb = client!.hotMeta.getConflictBranch();
        expect(updatedCb!.head).not.toBe(branchHeadAfterRegister);
        const messages = await getBranchCommitMessages(updatedCb!.name);
        // At least 2 conflict commits now: initial registration +
        // the edit-while-in-conflict push.
        const conflictCommitCount = messages.filter((m) =>
          m.startsWith("Conflict at "),
        ).length;
        expect(conflictCommitCount).toBeGreaterThanOrEqual(2);

        // ConflictStore still has one active record (resolution
        // hasn't fired). Sibling file is still in the vault.
        expect(client.conflictStore.hasPending("note.md")).toBe(true);
        expect(
          fs.existsSync(
            path.join(client.vaultPath, records[0].siblingPath),
          ),
        ).toBe(true);

        // Resolve via sibling delete. Next sync pushes ours v2 to
        // main and finalizes the branch.
        fs.rmSync(path.join(client.vaultPath, records[0].siblingPath));
        await evaluateConflictState(
          client.conflictStore,
          client.vault as unknown as import("obsidian").Vault,
        );
        expect(client.conflictStore.hasPending("note.md")).toBe(false);

        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "note.md")).toBe(
          "ours v2 (more edits)\n",
        );
        const branchAfter = await getBranchHead(updatedCb!.name);
        expect(branchAfter).toBeNull();
        conflictBranchToCleanup = undefined;
      },
      360_000,
    );
  },
);
