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

// B2 — first sync with non-overlapping changes on each side. Local
// has files the remote doesn't, and the remote has files the local
// doesn't, but there's no same-path divergence. After adoption:
//   - shared (identical) files → recordSync, no transfer.
//   - remote-only files → pull into vault.
//   - local-only files → left alone in vault; findChanges emits them
//     as "added"; push lifts them to remote.
// One push commit lands on the remote carrying both the local-only
// user files AND the invariant gitignores.

describe.skipIf(!integrationEnabled())(
  "sync2 B2 — adoption: non-overlapping changes on each side",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b2-non-overlap");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "shared identical + remote-only + local-only → all three classes land correctly",
      async () => {
        // Seed remote with shared.md (will match local) and
        // remote-only.md (will be pulled into local).
        await writeRemoteFile(
          branch,
          "shared.md",
          "shared content\n",
          "[seed] shared",
        );
        await writeRemoteFile(
          branch,
          "Folder/remote-only.md",
          "from another device\n",
          "[seed] remote-only",
        );

        // Local: write the shared file with identical bytes, plus a
        // local-only file the remote doesn't know about yet.
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("shared.md", "shared content\n");
        await client.vault.adapter.mkdir("Notes");
        await client.vault.adapter.write(
          "Notes/local-only.md",
          "private journal\n",
        );

        const sharedPath = path.join(client.vaultPath, "shared.md");
        const sharedMtimeBefore = fs.statSync(sharedPath).mtimeMs;

        await sync2AllAndAssertNoErrors(client);

        // Shared: untouched on disk, same mtime.
        expect(fs.readFileSync(sharedPath, "utf8")).toBe("shared content\n");
        expect(fs.statSync(sharedPath).mtimeMs).toBe(sharedMtimeBefore);

        // Remote-only: pulled into local with its content.
        const remoteOnlyLocal = path.join(
          client.vaultPath,
          "Folder/remote-only.md",
        );
        expect(fs.existsSync(remoteOnlyLocal)).toBe(true);
        expect(fs.readFileSync(remoteOnlyLocal, "utf8")).toBe(
          "from another device\n",
        );

        // Local-only: still on disk (we never touched it).
        const localOnly = path.join(client.vaultPath, "Notes/local-only.md");
        expect(fs.readFileSync(localOnly, "utf8")).toBe("private journal\n");

        // Remote: now has both sides' files plus the invariant
        // gitignores.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain("shared.md");
        expect(remoteFiles).toContain("Folder/remote-only.md");
        expect(remoteFiles).toContain("Notes/local-only.md");
        expect(remoteFiles).toContain(".obsidian/.gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
        expect(await readRemoteFile(branch, "Notes/local-only.md")).toBe(
          "private journal\n",
        );
        expect(await readRemoteFile(branch, "shared.md")).toBe(
          "shared content\n",
        );

        expect(client.store.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
