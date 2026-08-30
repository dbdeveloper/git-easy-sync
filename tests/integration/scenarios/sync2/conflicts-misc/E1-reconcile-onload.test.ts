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

// E1 — reconcile after the plugin was "disabled" between syncs.
// Sync2 has no events-listener (deliberately, post-pseudo-merge cutover), so file
// changes that happened while the plugin was inactive get picked up
// by findChanges' full vault walk on the next click. This test
// proves that disable + offline edit + re-enable doesn't lose the
// changes: a NEW client instance over the SAME vault dir finds the
// edits via its snapshot watermark and pushes them.

describe.skipIf(!integrationEnabled())(
  "sync2 E1 — reconcile after disable/edit/re-enable",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e1-reconcile-onload");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "edit vault file with no client running → re-instantiated client picks it up on next sync",
      async () => {
        // First "session" — instantiate client, prime, edit, sync.
        const first = await createSync2Client({
          branch,
          ownsVaultPath: false,
        });
        const vaultPath = first.vaultPath;
        // Track the temp dir so afterEach cleans it even if the test
        // throws before the second client is created.
        client = {
          ...first,
          cleanup: () => {
            try {
              fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {}
          },
        };

        await first.vault.adapter.write("note.md", "v1\n");
        await sync2AllAndAssertNoErrors(first);
        expect(await readRemoteFile(branch, "note.md")).toBe("v1\n");

        // "Disable" the plugin: discard the client (no further syncs).
        // Vault state, snapshot store, and push-queue stay on disk.

        // User edits the file directly (e.g., outside Obsidian, or
        // inside Obsidian while sync2 is disabled). For the test
        // this is just a raw fs.writeFileSync — bypasses any vault
        // adapter event the missing client wouldn't have caught
        // anyway.
        fs.writeFileSync(
          path.join(vaultPath, "note.md"),
          "v2 edited while disabled\n",
          "utf-8",
        );

        // "Re-enable" the plugin: brand-new client over the same
        // on-disk vault. The metadata stores read the persisted
        // lastSyncCommitSha; findChanges walks the vault on the
        // next click and detects the edit purely by stat+SHA
        // (snapshot watermark works regardless of whether the
        // client was running when the edit happened).
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "note.md")).toBe(
          "v2 edited while disabled\n",
        );
      },
      210_000,
    );
  },
);
