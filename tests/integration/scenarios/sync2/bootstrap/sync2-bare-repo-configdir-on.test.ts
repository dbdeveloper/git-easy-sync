import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// A-cfg-on — bare-repo bootstrap with syncConfigDir = true.
//
// Companion to sync2-bare-repo-configdir-off. Pins the contract that
// when the user explicitly opts in to "Sync configs", non-invariant
// configDir content (snippets, app.json, etc.) lands on the remote
// alongside the two invariant gitignores and root-level user files.
//
// IMPORTANT — mock-vs-production caveat: the mock vault's getFiles()
// walks every file under the temp dir including <configDir>/, so the
// test sees configDir content the same way it would expect production
// to. Real Obsidian's vault.getFiles() is the *indexed* file list and
// excludes <configDir>/ unless the file is a Markdown/attachment that
// happens to live there. If a user reports "Sync configs ON but my
// configs didn't push" in production, the fix is on the detector side
// (walk <configDir>/ explicitly via vault.adapter.list()), not on the
// settings/gate side this test pins.

(bootstrapEnabled() ? describe : describe.skip)(
  "sync2 A-cfg-on — bare-repo bootstrap with syncConfigDir = true",
  () => {
    let client: Sync2TestClient | undefined;
    const branch = "main";

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      await new Promise((r) => setTimeout(r, 1500));
    });

    afterEach(() => {
      client?.cleanup();
      client = undefined;
    });

    it(
      "user notes + configDir snippet + app.json + invariant gitignores all land on remote",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({
          branch,
          env,
          syncConfigDir: true,
        });

        // Populate the configDir with content a real Obsidian install
        // would have: app-level config + a snippet. Plus a root-level
        // user note so we can assert the user-content path stays
        // unaffected by the toggle.
        await client.vault.adapter.write("Welcome.md", "welcome\n");
        await client.vault.adapter.mkdir(".obsidian/snippets");
        await client.vault.adapter.write(
          ".obsidian/snippets/dark.css",
          ".dark { color: white; }\n",
        );
        await client.vault.adapter.write(
          ".obsidian/app.json",
          JSON.stringify({ promptDelete: false }) + "\n",
        );

        await sync2AllAndAssertNoErrors(client);

        const remoteFiles = await listRemoteFiles(branch, env);
        // The three invariant gitignores always land (seed + Case 2 push).
        expect(remoteFiles).toContain(".gitignore");
        expect(remoteFiles).toContain(".obsidian/.gitignore");
        expect(remoteFiles).toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
        // Root-level user note lands.
        expect(remoteFiles).toContain("Welcome.md");
        // ON: non-invariant configDir content lands.
        expect(remoteFiles).toContain(".obsidian/snippets/dark.css");
        expect(remoteFiles).toContain(".obsidian/app.json");

        // Content sanity-check on one of the configDir files.
        expect(
          await readRemoteFile(branch, ".obsidian/snippets/dark.css", env),
        ).toBe(".dark { color: white; }\n");
      },
      210_000,
    );
  },
);
