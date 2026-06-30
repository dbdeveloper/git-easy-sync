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
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// E4 — plugin-js conflict at EQUAL semver. Pseudo-merge's
// `attemptAutoMerge` for `isAtomicPluginFile` paths falls back to
// mtime when `compareSemver` returns 0: whichever main.js was
// touched more recently wins atomically. The plugin-js path is the
// last "silent atomic" survivor in pseudo-merge mode — binary
// files now register as conflicts instead.

const pluginRoot = ".obsidian/plugins/tie-version-plugin";
const mainJsPath = `${pluginRoot}/main.js`;
const manifestPath = `${pluginRoot}/manifest.json`;

const manifestWithVersion = (v: string): string =>
  JSON.stringify({
    id: "tie-version-plugin",
    name: "Tie Version Plugin",
    version: v,
    minAppVersion: "1.0.0",
  });

const minifiedJs = (label: string): string =>
  `(()=>{"use strict";const LABEL="${label}";module.exports={LABEL};})();`;

describe.skipIf(!integrationEnabled())(
  "sync2 E4 — plugin-js conflict at equal semver, mtime decides",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e4-plugin-js-mtime");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "both sides at 1.0.0, local mtime in the future → local main.js wins",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(
          manifestPath,
          manifestWithVersion("1.0.0"),
        );
        await client.vault.adapter.write(mainJsPath, minifiedJs("prime"));
        await sync2AllAndAssertNoErrors(client);

        // Remote: SAME version, different bundle bytes.
        await writeRemoteFile(
          branch,
          mainJsPath,
          minifiedJs("from-other-device"),
          "[other] hand-tweak main.js without bumping version",
        );

        // Local: also hand-tweak, force mtime into the future so
        // local wins the tie-break.
        await client.vault.adapter.write(
          mainJsPath,
          minifiedJs("local-edit"),
        );
        const localPath = path.join(client.vaultPath, mainJsPath);
        const futureTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(localPath, futureTs, futureTs);

        await sync2AllAndAssertNoErrors(client);

        // Local content won — present on both sides.
        expect(fs.readFileSync(localPath, "utf8")).toContain(
          "LABEL=\"local-edit\"",
        );
        expect(await readRemoteFile(branch, mainJsPath)).toContain(
          "LABEL=\"local-edit\"",
        );
      },
      240_000,
    );

    it(
      "both sides at 1.0.0, local mtime in the past → remote main.js overwrites local",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(
          manifestPath,
          manifestWithVersion("1.0.0"),
        );
        await client.vault.adapter.write(mainJsPath, minifiedJs("prime"));
        await sync2AllAndAssertNoErrors(client);

        await writeRemoteFile(
          branch,
          mainJsPath,
          minifiedJs("from-other-device"),
          "[other] hand-tweak main.js without bumping version",
        );

        await client.vault.adapter.write(
          mainJsPath,
          minifiedJs("local-edit"),
        );
        const localPath = path.join(client.vaultPath, mainJsPath);
        const pastTs = (Date.now() - 60_000) / 1000;
        fs.utimesSync(localPath, pastTs, pastTs);

        await sync2AllAndAssertNoErrors(client);

        // Remote bytes overwrote local.
        expect(fs.readFileSync(localPath, "utf8")).toContain(
          "LABEL=\"from-other-device\"",
        );
      },
      240_000,
    );

    it(
      "remote manifest missing/malformed → falls back to mtime regardless of local version",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write(
          manifestPath,
          manifestWithVersion("5.0.0"),
        );
        await client.vault.adapter.write(mainJsPath, minifiedJs("prime"));
        await sync2AllAndAssertNoErrors(client);

        // Remote: bundle changes, manifest stays at prime "5.0.0".
        // The bundle diverges but versions match → semver==0 → mtime
        // fallback. We force local newer so the local bundle wins.
        await writeRemoteFile(
          branch,
          mainJsPath,
          minifiedJs("remote-bytes"),
          "[other] change main.js, leave manifest stale at 5.0.0",
        );

        await client.vault.adapter.write(
          mainJsPath,
          minifiedJs("local-newer"),
        );
        const localPath = path.join(client.vaultPath, mainJsPath);
        const futureTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(localPath, futureTs, futureTs);

        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, mainJsPath)).toContain(
          "LABEL=\"local-newer\"",
        );
      },
      240_000,
    );

    // NB (SYNC2 §7, 2026-06-30): the plugin-js mtime tie-break's "theirs" timestamp is
    // now the FILE's last-change commit date (getLatestCommitDateForPath), not the
    // branch HEAD date — so an unrelated commit advancing HEAD past main.js no longer
    // makes a stale remote bundle win. NO integration test guards this: GitHub's
    // commits-listing (`?path=`) is eventually-consistent, so querying microseconds
    // after a rapid test commit returns stale/HEAD-ish results → inherently flaky (and
    // not a production concern — real remote commits are settled). The regression is
    // pinned DETERMINISTICALLY by unit tests: github-client-large-file.test.ts (the
    // endpoint: parse / author-date / empty→null / error→null) and sync2-manager.test.ts
    // "plugin-js mtime tie-break uses the file's LAST-CHANGE date" (the resolver — proven
    // to fail on the old HEAD-date code).
  },
);
