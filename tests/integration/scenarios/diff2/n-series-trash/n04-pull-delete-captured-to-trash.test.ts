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
  removeRemoteFile,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../../sync2/helpers";

// n04 — R3.4 pull-delete capture + R3.5 recovery-window semantics.
//
// Sequence:
//   1. Remote has a file. Local syncs → file lands in vault.
//   2. Remote deletes the file.
//   3. Local syncs → the Vault-step fires trashHooks.captureForDelete
//      BEFORE adapter.remove → the bin records the file's
//      original bytes. File then removed from vault.
//   4. The entry's id is GREATER than this drain's drain.startedAt
//      (capture happened mid-drain). Layer 2 sweep at end of THIS
//      drain skips (id > threshold) — recovery window stays open.
//   5. Next sync (drain.startedAt_2 > entry.id). Layer 2 wipes.
//
// Verifies the entire R3.4 contract: pull-delete IS captured (against
// the older "bypass" reading), recovery survives exactly one drain
// cycle, second drain reclaims.

describe.skipIf(!integrationEnabled())(
  "sync2 diff2 n04 — pull-delete captured to trash, swept after one drain",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-n04");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote delete → local pull captures to trash → next sync sweeps",
      async () => {
        const filePath = "Notes/idea.md";
        const content = "remote-authored\n";
        await writeRemoteFile(branch, filePath, content, "[seed] add note");

        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);
        const localAbs = path.join(client.vaultPath, filePath);
        expect(fs.existsSync(localAbs)).toBe(true);

        // Remote-side delete from another device.
        await removeRemoteFile(branch, filePath, "[web] remove note");

        // Local sync — applyRemoteDeletion captures bytes into trash
        // BEFORE adapter.remove. File leaves vault; recovery window opens.
        await sync2AllAndAssertNoErrors(client);

        expect(fs.existsSync(localAbs)).toBe(false);
        const captured = client.deletedStore.list();
        expect(captured.map((r) => r.path)).toEqual([filePath]);
        // Bytes preserved in the content-addressed store — the user
        // could restore within the window.
        const blob = path.join(
          client.vaultPath,
          ".obsidian/plugins/git-easy-sync/.runtime/sync_store",
          captured[0].sha,
        );
        expect(fs.existsSync(blob)).toBe(true);
        expect(fs.readFileSync(blob, "utf8")).toBe(content);

        // A second sync: its drain starts AFTER the capture, so the
        // §5.2.1 retention prune takes the record. A remote-originated
        // delete never reaches a commit, so nothing else would ever
        // release it — this is exactly the class the prune exists for.
        await sync2AllAndAssertNoErrors(client);
        expect(client.deletedStore.list()).toEqual([]);
      },
      300_000,
    );
  },
);
