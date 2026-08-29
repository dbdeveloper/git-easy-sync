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

// B1 — first sync after install on a vault that's already byte-equal
// to the remote. Simulates "I synced via obsidian-git (or the old
// version of this plugin) on this device just now, then installed
// sync2 and pressed Sync". Expected: no destructive overwrites, no
// per-file network transfers (SHA match means we trust the local
// copy), and lastSyncCommitSha is set so the next sync uses the
// fast path. The only commit landing on the remote is the one that
// publishes sync2's invariant gitignores — they didn't exist on
// either side until enforce() created them.

describe.skipIf(!integrationEnabled())(
  "sync2 B1 — adoption: local and remote are byte-identical",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b1-identical");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "byte-identical files on both sides → no per-file transfer, lastSync set, invariants commit",
      async () => {
        // Seed remote with two user files (canonical bytes — what
        // sync2's normalization would also produce locally).
        await writeRemoteFile(
          branch,
          "alpha.md",
          "alpha line one\nalpha line two\n",
          "[seed] alpha",
        );
        await writeRemoteFile(
          branch,
          "Folder/beta.md",
          "beta line one\nbeta line two\n",
          "[seed] beta",
        );

        // Local vault has the IDENTICAL bytes (as if a prior sync
        // tool just finished). Adoption must not touch these files.
        // The test framework's vault path is a real fs tree, so
        // adapter.write goes through the same path as Obsidian's
        // would.
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(
          "alpha.md",
          "alpha line one\nalpha line two\n",
        );
        await client.vault.adapter.mkdir("Folder");
        await client.vault.adapter.write(
          "Folder/beta.md",
          "beta line one\nbeta line two\n",
        );

        // Capture local mtimes BEFORE sync so we can prove sync2
        // didn't rewrite the files in place.
        const alphaPath = path.join(client.vaultPath, "alpha.md");
        const betaPath = path.join(client.vaultPath, "Folder/beta.md");
        const alphaMtimeBefore = fs.statSync(alphaPath).mtimeMs;
        const betaMtimeBefore = fs.statSync(betaPath).mtimeMs;

        await sync2AllAndAssertNoErrors(client);

        // Files unchanged on disk: same bytes, same mtime.
        expect(fs.readFileSync(alphaPath, "utf8")).toBe(
          "alpha line one\nalpha line two\n",
        );
        expect(fs.readFileSync(betaPath, "utf8")).toBe(
          "beta line one\nbeta line two\n",
        );
        expect(fs.statSync(alphaPath).mtimeMs).toBe(alphaMtimeBefore);
        expect(fs.statSync(betaPath).mtimeMs).toBe(betaMtimeBefore);

        // Remote still carries the user files unchanged.
        expect(await readRemoteFile(branch, "alpha.md")).toBe(
          "alpha line one\nalpha line two\n",
        );
        expect(await readRemoteFile(branch, "Folder/beta.md")).toBe(
          "beta line one\nbeta line two\n",
        );

        // Adoption set the snapshot — next sync would route through
        // the fast path (Case 3) instead of bootstrapIfNeeded.
        expect(client.store.getLastSyncCommitSha()).not.toBeNull();

        // The invariant gitignores didn't exist on either side until
        // enforce() wrote them locally during adoption; the follow-up
        // push lifts them to remote. We assert they're now both
        // present remotely. We don't pin commit count — the seed
        // commits plus the invariants commit is implementation
        // detail; the important property is "no extra user-file
        // commits got created".
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain(".obsidian/.gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
      },
      210_000,
    );
  },
);
