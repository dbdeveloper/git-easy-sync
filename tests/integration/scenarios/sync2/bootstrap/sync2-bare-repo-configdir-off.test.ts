import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  listRemoteFiles,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// A-cfg-off — bare-repo bootstrap with syncConfigDir = false.
//
// Companion to sync2-bare-repo-configdir-on. Pins the safer default:
// the whole <configDir>/ subtree is off-limits, symmetrically. NO
// configDir paths land on remote — not even the invariant gitignores
// (each device keeps them canonical locally via
// GitignoreInvariants.enforce() on plugin load). Only the root
// .gitignore (vault root, outside configDir) and root user files
// propagate.

(bootstrapEnabled() ? describe : describe.skip)(
  "sync2 A-cfg-off — bare-repo bootstrap with syncConfigDir = false",
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
      "configDir is entirely off-limits; only root .gitignore + Welcome.md land",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({
          branch,
          env,
          syncConfigDir: false,
        });

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
        // Root-level .gitignore (outside configDir) and Welcome.md land.
        expect(remoteFiles).toContain(".gitignore");
        expect(remoteFiles).toContain("Welcome.md");
        // OFF: NOTHING under configDir lands — not even the invariant
        // gitignores. The seed commit (root .gitignore) + a single
        // follow-up commit with Welcome.md is the full set.
        expect(remoteFiles).not.toContain(".obsidian/.gitignore");
        expect(remoteFiles).not.toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
        expect(remoteFiles).not.toContain(".obsidian/snippets/dark.css");
        expect(remoteFiles).not.toContain(".obsidian/app.json");
        expect(remoteFiles).toHaveLength(2);
      },
      210_000,
    );
  },
);
