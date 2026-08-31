import {
// ⏸️ SUSPENDED AT THE SWITCH (2026-08-31, recorded in MASTER-PLAN §5.5.0):
// the interim plugin-core collision rule is pure mtime (newest wins,
// remote on ambiguity) — SEMVER priority (§28) deliberately returns
// with PLUGIN-UPDATE-COMPAT (Phase 7). Un-skip when that lands.
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
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// E3 — plugin-js conflict resolved by semver. Two cases prove the
// branch fires symmetrically:
//   3a) remote plugin has HIGHER semver → remote main.js wins,
//       local copy is overwritten.
//   3b) local plugin has HIGHER semver → local main.js stays,
//       push lifts it onto remote.
// Both sides keep a valid manifest.json with a parseable version
// string; mtime is irrelevant — only semver decides.

const pluginRoot = ".obsidian/plugins/some-third-party-plugin";
const mainJsPath = `${pluginRoot}/main.js`;
const manifestPath = `${pluginRoot}/manifest.json`;

const manifestWithVersion = (v: string): string =>
  JSON.stringify({
    id: "some-third-party-plugin",
    name: "Some Third-party Plugin",
    version: v,
    minAppVersion: "1.0.0",
  });

const minifiedJs = (n: number): string =>
  // Single-line "minified bundle" with a marker byte we can assert
  // on. Real bundles are megabytes; a short string serves the test.
  `(()=>{"use strict";const VERSION_MARKER=${n};module.exports={VERSION_MARKER};})();`;

describe.skip(
  "sync2 E3 — plugin-js conflict resolved by semver",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e3-plugin-js-semver");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote plugin version 2.0.0 > local 1.0.0 → remote main.js wins",
      async () => {
        client = await createSync2Client({ branch });
        // Prime: local plugin at 1.0.0.
        await client.vault.adapter.write(manifestPath, manifestWithVersion("1.0.0"));
        await client.vault.adapter.write(mainJsPath, minifiedJs(1));
        await sync2AllAndAssertNoErrors(client);

        // Remote: another device updated the plugin to 2.0.0.
        await writeRemoteFile(
          branch,
          manifestPath,
          manifestWithVersion("2.0.0"),
          "[other] bump plugin to 2.0.0",
        );
        await writeRemoteFile(
          branch,
          mainJsPath,
          minifiedJs(2),
          "[other] bump plugin bundle",
        );

        // Local: user edits main.js too (broken hand-tweak). It
        // doesn't matter — remote semver is higher and wins.
        await client.vault.adapter.write(
          mainJsPath,
          minifiedJs(9999), // local-edit marker
        );

        await sync2AllAndAssertNoErrors(client);

        // Remote main.js stays at "2" — local edit was discarded.
        expect(await readRemoteFile(branch, mainJsPath)).toContain(
          "VERSION_MARKER=2",
        );
        // Local main.js was overwritten with the remote (winning) bytes.
        expect(
          fs.readFileSync(path.join(client.vaultPath, mainJsPath), "utf8"),
        ).toContain("VERSION_MARKER=2");
      },
      240_000,
    );

    it(
      "local plugin version 3.0.0 > remote 1.5.0 → local main.js wins, lifts to remote",
      async () => {
        client = await createSync2Client({ branch });
        // Prime: local + remote both at 1.0.0.
        await client.vault.adapter.write(manifestPath, manifestWithVersion("1.0.0"));
        await client.vault.adapter.write(mainJsPath, minifiedJs(1));
        await sync2AllAndAssertNoErrors(client);

        // Remote: another device bumped to 1.5.0.
        await writeRemoteFile(
          branch,
          manifestPath,
          manifestWithVersion("1.5.0"),
          "[other] bump plugin to 1.5.0",
        );
        await writeRemoteFile(
          branch,
          mainJsPath,
          minifiedJs(15),
          "[other] update bundle for 1.5.0",
        );

        // Local: user pulled a 3.0.0 manually (e.g. via Community
        // Plugins) — both manifest and main.js bumped.
        await client.vault.adapter.write(manifestPath, manifestWithVersion("3.0.0"));
        await client.vault.adapter.write(mainJsPath, minifiedJs(3));

        await sync2AllAndAssertNoErrors(client);

        // Local 3.0.0 won; remote main.js now carries the local bytes.
        expect(await readRemoteFile(branch, mainJsPath)).toContain(
          "VERSION_MARKER=3",
        );
        // Local main.js untouched — still the 3.0.0 bytes.
        expect(
          fs.readFileSync(path.join(client.vaultPath, mainJsPath), "utf8"),
        ).toContain("VERSION_MARKER=3");
      },
      240_000,
    );

    // Plain .js outside a plugin folder must still go through the
    // standard text-merge path, not semver resolution. We prove
    // that by editing a top-level .js on both sides with disjoint
    // line changes and asserting both edits land (clean 3-way
    // merge), not "whichever has a higher 'version' field" (which
    // would be undefined anyway — these aren't plugin files).
    it(
      "non-plugin .js falls through to standard text 3-way merge",
      async () => {
        client = await createSync2Client({ branch });
        // Prime with a multi-line script — the merge needs distinct
        // anchor lines to cleanly resolve disjoint edits.
        await client.vault.adapter.write(
          "scripts/build.js",
          "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        );
        await sync2AllAndAssertNoErrors(client);

        // Remote: edit the FIRST line.
        await writeRemoteFile(
          branch,
          "scripts/build.js",
          "const a = 999;\nconst b = 2;\nconst c = 3;\n",
          "[other] edit a",
        );

        // Local: edit the LAST line.
        await client.vault.adapter.write(
          "scripts/build.js",
          "const a = 1;\nconst b = 2;\nconst c = 777;\n",
        );

        await sync2AllAndAssertNoErrors(client);

        // Both edits survived — 3-way merge worked because this is
        // a regular text file, not a minified plugin bundle.
        const remote = await readRemoteFile(branch, "scripts/build.js");
        expect(remote).toContain("const a = 999;");
        expect(remote).toContain("const c = 777;");
      },
      240_000,
    );
  },
);
