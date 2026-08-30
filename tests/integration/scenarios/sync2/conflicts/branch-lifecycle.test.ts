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

// Pseudo-merge stage 7b — conflict-branch lifecycle.
//
// End-to-end: trigger a conflict against real GitHub, observe that
// a per-device conflict branch (`git-easy-sync-conflicts-<label>-<ts>-<ms>`)
// gets created at the moment of registration, that the user's local
// version lands on it as a commit (so the pre-conflict state is
// preserved on GitHub even though it's filtered out of main push),
// then resolve via sibling-delete + sync and observe the finalize:
//   - manual merge-commit on main referencing both main.head and
//     branch.head
//   - the conflict branch is deleted
//   - the next sync's lastSyncCommitSha is advanced to the merge
//     commit

describe.skipIf(!integrationEnabled())(
  "sync2 pseudo-merge — conflict-branch lifecycle (stage 7b)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranchToCleanup: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-pseudo-branch");
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
      "register → branch created with ours commit → resolve → finalize merge + deleteRef",
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

        // Diverge: ours rewrites line 1, theirs rewrites the same line.
        // 3-way merge fails → modify-vs-modify registered.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours version\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs version\n",
          "[web] divergent",
        );

        await sync2AllAndAssertNoErrors(client);

        // Conflict registered + branch created on GitHub.
        const records = client.conflictStore.getByPath("note.md");
        expect(records).toHaveLength(1);
        const cb = client!.hotMeta.getConflictBranch();
        expect(cb).not.toBeNull();
        conflictBranchToCleanup = cb!.name;
        expect(cb!.name).toMatch(/^git-easy-sync-conflicts-/);

        // Branch exists on GitHub at the recorded head SHA.
        const remoteBranchHead = await getBranchHead(cb!.name);
        expect(remoteBranchHead).toBe(cb!.head);

        // Branch carries the ours version of note.md (the
        // pre-conflict local state preserved as history).
        expect(await readRemoteFile(cb!.name, "note.md")).toBe(
          "ours version\n",
        );

        // Branch commit messages use the hardcoded format
        // `conflict ({deviceLabel})` — see src/sync2/commit-message.ts.
        const messages = await getBranchCommitMessages(cb!.name);
        expect(messages.some((m) => m.startsWith("Conflict at "))).toBe(true);

        // Main on remote still has theirs (push skipped the path).
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "theirs version\n",
        );

        // Resolve via sibling delete (case 1: accept ours).
        const siblingAbs = path.join(client.vaultPath, records[0].siblingPath);
        fs.rmSync(siblingAbs);
        await evaluateConflictState(
          client.conflictStore,
          client.vault as unknown as import("obsidian").Vault,
        );
        expect(client.conflictStore.hasPending("note.md")).toBe(false);

        // Next sync drains the queue (carries ours), then finalize
        // hook merges the branch back into main + deletes the branch.
        await sync2AllAndAssertNoErrors(client);

        // Main now carries ours.
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "ours version\n",
        );

        // Conflict branch deleted.
        const afterFinalize = await getBranchHead(cb!.name);
        expect(afterFinalize).toBeNull();

        // Local state cleared.
        const cbAfter = client!.hotMeta.getConflictBranch();
        expect(cbAfter).toBeNull();
        conflictBranchToCleanup = undefined;
      },
      360_000,
    );
  },
);
