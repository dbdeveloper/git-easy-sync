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
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// I2 — syncConfigDir ON → OFF.
//
// With ON: paths under `<configDir>/` push and pull like any other.
// Toggle to OFF: subsequent syncs skip every configDir path EXCEPT
// the two invariant gitignores. Pre-existing remote configDir files
// stay on GitHub — the toggle is "stop managing", not "wipe remote".
// User notes outside configDir keep syncing normally.

describe.skipIf(!integrationEnabled())(
  "sync2 I2 — syncConfigDir toggle ON → OFF",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i2-cfg-off");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "ON → OFF: configDir files stay on remote; new configDir edits skipped; user notes still sync",
      async () => {
        // Start with ON: push a snippet, a plugin config file, and a
        // user note. All three land on remote.
        client = await createSync2Client({ branch, syncConfigDir: true });
        await client.vault.adapter.mkdir(".obsidian/snippets");
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: white; }\n",
        );
        await client.vault.adapter.mkdir(".obsidian/plugins/example");
        await client.vault.adapter.write(
          ".obsidian/plugins/example/main.js",
          "console.log('example')\n",
        );
        await client.vault.adapter.write("note.md", "user note v1\n");
        await sync2AllAndAssertNoErrors(client);

        let remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain(".obsidian/snippets/dark.css");
        expect(remoteFiles).toContain(".obsidian/plugins/example/main.js");
        expect(remoteFiles).toContain("note.md");

        // Flip OFF.
        client.settings.syncConfigDir = false;

        // Edit BOTH a configDir file and a user note.
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: black; }\n", // changed
        );
        await client.vault.adapter.write("note.md", "user note v2\n");

        await sync2AllAndAssertNoErrors(client);

        // Remote: user note advanced, configDir snippet did NOT.
        expect(await readRemoteFile(branch, "note.md")).toBe(
          "user note v2\n",
        );
        expect(
          await readRemoteFile(branch, ".obsidian/snippets/dark.css"),
        ).toBe(".dark { color: white; }\n");

        // Pre-existing remote configDir files are NOT deleted — the
        // toggle says "stop managing", not "wipe remote".
        remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).toContain(".obsidian/snippets/dark.css");
        expect(remoteFiles).toContain(".obsidian/plugins/example/main.js");

        // Local also unchanged: the OFF toggle doesn't go and edit
        // the user's files.
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, ".obsidian/snippets/dark.css"),
            "utf8",
          ),
        ).toBe(".dark { color: black; }\n");
      },
      300_000,
    );

    it(
      "OFF: invariant gitignores DO NOT propagate either (symmetric gate)",
      async () => {
        // OFF is fully symmetric: configDir is off-limits in both
        // directions. The two invariant gitignores are not exempt
        // either — each device keeps them canonical locally via
        // GitignoreInvariants.enforce().
        client = await createSync2Client({ branch, syncConfigDir: false });
        await client.vault.adapter.write("note.md", "n1\n");
        await sync2AllAndAssertNoErrors(client);

        // Tweak the invariant gitignore locally to make sure sync
        // has something concrete to find under <configDir>/.
        const cdGitignore = ".obsidian/.gitignore";
        const before = await client.vault.adapter.read(cdGitignore);
        const tampered = before + "\n# user tail\n*.tmp\n";
        await client.vault.adapter.write(cdGitignore, tampered);

        await sync2AllAndAssertNoErrors(client);

        // OFF: the configDir gitignore did NOT push.
        const remoteFiles = await listRemoteFiles(branch);
        expect(remoteFiles).not.toContain(cdGitignore);
        expect(remoteFiles).not.toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
      },
      300_000,
    );
  },
);
