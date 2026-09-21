import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../../sync2/helpers";

// n04b — R3.4 "Design boundary" documentation test.
//
// The bin captures only the two expected channels:
//   (a) vault.delete / vault.trash via the trash-watcher monkey-patch
//       (user-driven UI deletes), and
//   (b) sync2.applyRemoteDeletion via the captureForDelete hook
//       (pull-driven deletes).
//
// A direct adapter.remove(path) call — what a third-party plugin or
// script might do — does NOT route through either channel. This is
// intentional (R3.4 "Design boundary"), not a v1 gap. The test
// documents the boundary by demonstrating: a manual adapter.remove
// followed by sync DOES propagate the deletion to GitHub (sync's own
// findChanges sees vault diverged from snapshot and pushes the delete)
// but DOES NOT leave a trash entry behind.

describe.skipIf(!integrationEnabled())(
  "sync2 diff2 n04b — adapter.remove bypasses trash (by design)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("diff2-n04b");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "direct adapter.remove → sync deletes on GitHub but no trash entry created",
      async () => {
        client = await createSync2Client({ branch });
        const filePath = "Notes/idea.md";
        await client.vault.adapter.write(filePath, "content\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain(filePath);

        // Direct adapter.remove — bypasses both expected channels.
        // No TrashStore.intercept call, no monkey-patched vault.delete,
        // no sync2.applyRemoteDeletion. findChanges WILL still see the
        // delete via snapshot-vs-vault diff and enqueue it.
        await client.vault.adapter.remove(filePath);

        // Sync — push propagates the deletion to GitHub. No trash
        // entry exists at any point for this path.
        await sync2AllAndAssertNoErrors(client);

        const trashState = client.deletedStore.list();
        expect(trashState).toEqual([]);
        expect(await listRemoteFiles(branch)).not.toContain(filePath);
      },
      210_000,
    );
  },
);
