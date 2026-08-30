import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
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
  removeRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Mandatory rule: gitignore is a two-way mute. A path matched by any
// .gitignore rule is invisible to sync2 in BOTH directions:
// local edits, local deletes, remote adds/edits/deletes — none of
// them affect the other side. Renames across the gitignore boundary
// pass through `findChanges()` naturally.

describe.skipIf(!integrationEnabled())(
  "sync2 gitignore is a two-way mute",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-gi");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local-edit-of-ignored-file: produces no commit",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        // Set up gitignore + ignored file locally; push to align state.
        await client.vault.adapter.write(".gitignore", "secret/\n");
        await client.vault.adapter.mkdir("secret");
        await sync2AllAndAssertNoErrors(client);

        const beforeCommit = await client.client.getBranchHeadSha({});
        // Add a file under the ignored prefix and edit it.
        await client.vault.adapter.write(
          "secret/diary.md",
          "personal stuff",
        );
        await sync2AllAndAssertNoErrors(client);
        await client.vault.adapter.write(
          "secret/diary.md",
          "more personal",
        );
        await sync2AllAndAssertNoErrors(client);

        // No new commits on remote.
        expect(await client.client.getBranchHeadSha({})).toBe(beforeCommit);
        expect(await listRemoteFiles(branch)).not.toContain(
          "secret/diary.md",
        );
      },
      90_000,
    );

    it(
      "local-delete-of-ignored-file: produces no commit",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write(".gitignore", "secret/\n");
        await client.vault.adapter.mkdir("secret");
        await client.vault.adapter.write("secret/diary.md", "private");
        await sync2AllAndAssertNoErrors(client);

        const beforeCommit = await client.client.getBranchHeadSha({});
        await client.vault.adapter.remove("secret/diary.md");
        await sync2AllAndAssertNoErrors(client);

        expect(await client.client.getBranchHeadSha({})).toBe(beforeCommit);
      },
      90_000,
    );

    it(
      "remote-delete-of-ignored-file: local copy survives",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        // Place a file on remote AND a local copy of the same file.
        // Then locally make it ignored. Then web-UI deletes it. The
        // local copy must remain.
        await writeRemoteFile(
          branch,
          "shared/note.md",
          "shared content\n",
          "[web] add",
        );
        await client.vault.adapter.mkdir("shared");
        await client.vault.adapter.write(
          "shared/note.md",
          "shared content\n",
        );
        await client.vault.adapter.write(".gitignore", "shared/\n");
        await sync2AllAndAssertNoErrors(client);

        // Web UI deletes shared/note.md.
        await removeRemoteFile(branch, "shared/note.md", "[web] rm");
        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.existsSync(path.join(client.vaultPath, "shared/note.md")),
        ).toBe(true);
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "shared/note.md"),
            "utf8",
          ),
        ).toBe("shared content\n");
      },
      120_000,
    );

    it(
      "remote-modify-of-ignored-file: local copy not overwritten",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await writeRemoteFile(
          branch,
          "shared/note.md",
          "v1",
          "[web] add",
        );
        await client.vault.adapter.mkdir("shared");
        await client.vault.adapter.write("shared/note.md", "v1");
        await client.vault.adapter.write(".gitignore", "shared/\n");
        await sync2AllAndAssertNoErrors(client);

        await writeRemoteFile(
          branch,
          "shared/note.md",
          "v2-from-web",
          "[web] edit",
        );
        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "shared/note.md"),
            "utf8",
          ),
        ).toBe("v1");
      },
      120_000,
    );

    it(
      "remote-add-of-ignored-file: not pulled locally",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write(".gitignore", "secret/\n");
        await sync2AllAndAssertNoErrors(client);

        // Web UI adds a file matching the local rule.
        await writeRemoteFile(
          branch,
          "secret/from-web.md",
          "secret remote",
          "[web] add",
        );
        await sync2AllAndAssertNoErrors(client);

        expect(
          fs.existsSync(path.join(client.vaultPath, "secret/from-web.md")),
        ).toBe(false);
      },
      90_000,
    );

    it(
      "became-ignored: snapshot drops, remote untouched",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        // Track a file normally.
        await client.vault.adapter.write("notes/draft.md", "draft");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain("notes/draft.md");

        // Now add a gitignore rule that hides it.
        await client.vault.adapter.write(".gitignore", "notes/\n");
        await sync2AllAndAssertNoErrors(client);

        // Snapshot for notes/draft.md is gone; remote copy still there.
        expect(await client.baselines.get("notes/draft.md")).toBeUndefined();
        expect(await listRemoteFiles(branch)).toContain("notes/draft.md");
      },
      90_000,
    );

    it(
      "became-syncable: pre-existing local file surfaces as added",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        // Stash a file under an ignored path. It's tracked by neither
        // sync2 nor remote.
        await client.vault.adapter.write(".gitignore", "drafts/\n");
        await client.vault.adapter.mkdir("drafts");
        await client.vault.adapter.write(
          "drafts/idea.md",
          "private idea\n",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).not.toContain(
          "drafts/idea.md",
        );

        // Loosen gitignore so drafts/ is now syncable.
        await client.vault.adapter.write(".gitignore", "");
        await sync2AllAndAssertNoErrors(client);

        expect(await listRemoteFiles(branch)).toContain("drafts/idea.md");
        expect(await readRemoteFile(branch, "drafts/idea.md")).toBe(
          "private idea\n",
        );
      },
      90_000,
    );
  },
);

describe.skipIf(!integrationEnabled())(
  "sync2 rename × gitignore boundary",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-rename");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "syncable → ignored: remote delete of old path, file stays locally untracked",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write(".gitignore", "archive/\n");
        await client.vault.adapter.mkdir("drafts");
        await client.vault.adapter.write("drafts/note.md", "content\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain("drafts/note.md");

        // Move into ignored zone.
        await client.vault.adapter.mkdir("archive");
        const content = await client.vault.adapter.read("drafts/note.md");
        await client.vault.adapter.write("archive/note.md", content);
        await client.vault.adapter.remove("drafts/note.md");
        await sync2AllAndAssertNoErrors(client);

        expect(await listRemoteFiles(branch)).not.toContain(
          "drafts/note.md",
        );
        expect(await listRemoteFiles(branch)).not.toContain(
          "archive/note.md",
        );
        // Local copy survives in archive/.
        expect(
          fs.existsSync(path.join(client.vaultPath, "archive/note.md")),
        ).toBe(true);
      },
      120_000,
    );

    it(
      "ignored → syncable: file appears on remote",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write(".gitignore", "archive/\n");
        await client.vault.adapter.mkdir("archive");
        await client.vault.adapter.write(
          "archive/note.md",
          "from-archive\n",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).not.toContain(
          "archive/note.md",
        );

        // Move into syncable zone.
        await client.vault.adapter.mkdir("drafts");
        await client.vault.adapter.write(
          "drafts/note.md",
          "from-archive\n",
        );
        await client.vault.adapter.remove("archive/note.md");
        await sync2AllAndAssertNoErrors(client);

        expect(await listRemoteFiles(branch)).toContain("drafts/note.md");
        expect(await readRemoteFile(branch, "drafts/note.md")).toBe(
          "from-archive\n",
        );
      },
      120_000,
    );

    it(
      "syncable → syncable: delete(old) + add(new) in one tree",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.mkdir("drafts");
        await client.vault.adapter.write("drafts/a.md", "content\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain("drafts/a.md");

        // Rename a.md → b.md within the syncable zone.
        await client.vault.adapter.write("drafts/b.md", "content\n");
        await client.vault.adapter.remove("drafts/a.md");
        await sync2AllAndAssertNoErrors(client);

        const remote = await listRemoteFiles(branch);
        expect(remote).toContain("drafts/b.md");
        expect(remote).not.toContain("drafts/a.md");
      },
      120_000,
    );

    it(
      "rename cycle: syncable → ignored → syncable freshly tracks again",
      async () => {
        client = await createSync2Client({ branch });
        // Trigger native bootstrap so the snapshot store reflects the
        // branch's current tree before we write any test files.
        await sync2AllAndAssertNoErrors(client);

        await client.vault.adapter.write(".gitignore", "archive/\n");
        await client.vault.adapter.mkdir("drafts");
        await client.vault.adapter.write("drafts/note.md", "content\n");
        await sync2AllAndAssertNoErrors(client);

        // Rename into ignored zone.
        await client.vault.adapter.mkdir("archive");
        await client.vault.adapter.write("archive/note.md", "content\n");
        await client.vault.adapter.remove("drafts/note.md");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).not.toContain(
          "drafts/note.md",
        );
        expect(await listRemoteFiles(branch)).not.toContain(
          "archive/note.md",
        );

        // Rename back into syncable zone.
        await client.vault.adapter.write("drafts/note.md", "content\n");
        await client.vault.adapter.remove("archive/note.md");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).toContain("drafts/note.md");
      },
      150_000,
    );
  },
);
