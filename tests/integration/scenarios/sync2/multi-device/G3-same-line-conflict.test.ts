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

// G3 — two devices edit the SAME line of the same file. 3-way merge
// cannot resolve, so the device that syncs second registers a
// `modify-vs-modify` conflict (sibling file appears in B's vault).
// Resolution happens via standard Obsidian file ops — here we model
// "user picks ours" by deleting the sibling. The next sync pushes
// ours to remote.

describe.skipIf(!integrationEnabled())(
  "sync2 G3 — same-line conflict across two devices, resolved via sibling delete",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g3-same-line");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      deviceA?.cleanup();
      deviceB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "both devices edit line 1 → second pusher registers conflict; resolve via sibling delete",
      async () => {
        // Shared baseline pushed by A.
        deviceA = await createSync2Client({ branch });
        await deviceA.vault.adapter.write(
          "note.md",
          "shared line\nline 2\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        // B pulls baseline.
        deviceB = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(deviceB);
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "note.md"), "utf8"),
        ).toBe("shared line\nline 2\n");

        // Both edit line 1 — different content.
        await deviceA.vault.adapter.write(
          "note.md",
          "line by A\nline 2\n",
        );
        await sync2AllAndAssertNoErrors(deviceA);

        await deviceB.vault.adapter.write(
          "note.md",
          "line by B\nline 2\n",
        );
        // B's syncAll now sees A's commit on remote → 3-way merge
        // fails on the overlap → modify-vs-modify registered.
        await sync2AllAndAssertNoErrors(deviceB);

        // Conflict surfaced on B: sibling with A's version sits next
        // to note.md.
        const records = trackedSiblingPathsFor(deviceB, "note.md");
        expect(records).toHaveLength(1);
        const siblingPath = records[0];
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, siblingPath), "utf8"),
        ).toBe("line by A\nline 2\n");
        // Local on B still carries ours.
        expect(
          fs.readFileSync(path.join(deviceB.vaultPath, "note.md"), "utf8"),
        ).toBe("line by B\nline 2\n");
        // Remote still has A's version (B's push skipped the path).
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "line by A\nline 2\n",
        );

        // User on B picks "ours" by deleting the sibling. Classifier
        // case 1 → drop record. Next sync pushes ours to remote.
        fs.rmSync(path.join(deviceB.vaultPath, siblingPath));
        await reconcileConflictsForTest(deviceB);
        expect(deviceB.conflictStore.hasBase("note.md")).toBe(false);

        await sync2AllAndAssertNoErrors(deviceB);

        expect(await readRemoteFile(branch, "note.md")).toBe(
          "line by B\nline 2\n",
        );

        // A pulls and converges to B's resolution.
        await sync2AllAndAssertNoErrors(deviceA);
        expect(
          fs.readFileSync(path.join(deviceA.vaultPath, "note.md"), "utf8"),
        ).toBe("line by B\nline 2\n");
      },
      360_000,
    );
  },
);
