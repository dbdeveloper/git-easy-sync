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
  listRemoteFiles,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import {
  reconcileConflictsForTest,
  trackedSiblingPathsFor,
  conflictEntryCount,
} from "../helpers";

// D6 — same file: local-delete vs remote-modify.
//
// Pseudo-merge contract: reconcile registers a `delete-vs-modify`
// record (sibling carries theirs bytes; base is absent because ours
// was "delete"). The deletion is dropped from the batch. Resolution
// happens via file operations:
//   - delete the sibling → classifier case 1 (accept ours, i.e.
//     confirm the delete) → next sync pushes the delete to remote
//   - rename sibling onto base path (or copy content there) →
//     classifier case 6 (baseSha == siblingSha) → accept-theirs →
//     next sync no-op (remote already had theirs)
//
// Pre-ConflictWatcher: the classifier is invoked manually after
// each filesystem op.

describe.skipIf(!integrationEnabled())(
  "sync2 D6 — same file: local delete + remote modify → conflict",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-d6-same-del-vs-mod");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    async function setupConflict(): Promise<Sync2TestClient> {
      const c = await createSync2Client({ branch });
      await c.vault.adapter.write("x.md", "x v1\n");
      await sync2AllAndAssertNoErrors(c);
      await c.vault.adapter.remove("x.md");
      await writeRemoteFile(
        branch,
        "x.md",
        "x v2 from other device\n",
        "[other] modify x.md",
      );
      await sync2AllAndAssertNoErrors(c);
      return c;
    }

    it(
      "registers delete-vs-modify on detection",
      async () => {
        client = await setupConflict();
        expect(client.conflictStore.hasBase("x.md")).toBe(true);
        const records = trackedSiblingPathsFor(client, "x.md");
        expect(records).toHaveLength(1);

        // Sibling file in vault with theirs content.
        const siblingPath = records[0];
        expect(fs.existsSync(path.join(client.vaultPath, siblingPath))).toBe(true);
        expect(
          fs.readFileSync(path.join(client.vaultPath, siblingPath), "utf8"),
        ).toBe("x v2 from other device\n");

        // Base file (x.md) does not exist — we deleted it.
        expect(fs.existsSync(path.join(client.vaultPath, "x.md"))).toBe(false);

        // Remote untouched: deletion dropped from batch.
        expect(await readRemoteFile(branch, "x.md")).toBe(
          "x v2 from other device\n",
        );
      },
      240_000,
    );

    it(
      "user deletes the sibling → classifier accept-ours → next sync removes x on remote",
      async () => {
        client = await setupConflict();
        const records = trackedSiblingPathsFor(client, "x.md");
        const siblingAbs = path.join(client.vaultPath, records[0]);

        fs.rmSync(siblingAbs);
        await reconcileConflictsForTest(client);

        expect(client.conflictStore.hasBase("x.md")).toBe(false);

        await sync2AllAndAssertNoErrors(client);

        expect(fs.existsSync(path.join(client.vaultPath, "x.md"))).toBe(false);
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain("x.md");
      },
      240_000,
    );

    it(
      "user copies sibling onto base path → case 6 → x restored locally, remote unchanged",
      async () => {
        client = await setupConflict();
        const records = trackedSiblingPathsFor(client, "x.md");
        const siblingPath = records[0];

        // User accepts theirs by copying sibling content over to
        // base. baseSha now equals siblingSha → classifier fires
        // case 6 (accept-theirs) → record + sibling dropped.
        const theirsBytes = await client.vault.adapter.readBinary(siblingPath);
        await client.vault.adapter.writeBinary("x.md", theirsBytes);
        await reconcileConflictsForTest(client);

        expect(client.conflictStore.hasBase("x.md")).toBe(false);
        expect(
          fs.readFileSync(path.join(client.vaultPath, "x.md"), "utf8"),
        ).toBe("x v2 from other device\n");
        expect(await readRemoteFile(branch, "x.md")).toBe(
          "x v2 from other device\n",
        );
      },
      240_000,
    );
  },
);
