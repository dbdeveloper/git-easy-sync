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

// E5 — TODO §28: a plugin folder must NEVER grow a `*.conflict-from.*`
// sibling. styles.css is version-coupled to the bundle: it follows the
// side whose main.js/manifest won (rule 1), it is NEVER 3-way-merged,
// and it never registers a conflict. Here the "other device" ships a
// real update (manifest bumped 1.0.0 → 2.0.0, new main.js + new
// styles.css) while this device has an unrelated local styles.css edit.
// The higher semver wins the whole bundle → the local styles.css edit
// is overwritten by the server's, with no conflict sibling anywhere.

const pluginRoot = ".obsidian/plugins/styles-atomic-plugin";
const mainJsPath = `${pluginRoot}/main.js`;
const manifestPath = `${pluginRoot}/manifest.json`;
const stylesPath = `${pluginRoot}/styles.css`;

const manifestWithVersion = (v: string): string =>
  JSON.stringify({
    id: "styles-atomic-plugin",
    name: "Styles Atomic Plugin",
    version: v,
    minAppVersion: "1.0.0",
  });

const minifiedJs = (label: string): string =>
  `(()=>{"use strict";const LABEL="${label}";module.exports={LABEL};})();`;

// Recursively collect any conflict-sibling files under the vault.
function listConflictSiblings(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes(".conflict-from-")) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!integrationEnabled())(
  "sync2 E5 — plugin styles.css resolves atomically, never a conflict sibling",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e5-plugin-styles");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "remote bumps the plugin (higher semver) while local edited styles.css → server bundle wins, no conflict sibling",
      async () => {
        client = await createSync2Client({ branch });
        // Prime the plugin at 1.0.0 and push it.
        await client.vault.adapter.write(manifestPath, manifestWithVersion("1.0.0"));
        await client.vault.adapter.write(mainJsPath, minifiedJs("prime"));
        await client.vault.adapter.write(stylesPath, ".prime{color:black}");
        await sync2AllAndAssertNoErrors(client);

        // Other device ships a real update: manifest 2.0.0 + new bundle.
        await writeRemoteFile(branch, manifestPath, manifestWithVersion("2.0.0"), "[other] bump to 2.0.0");
        await writeRemoteFile(branch, mainJsPath, minifiedJs("v2"), "[other] new main.js");
        await writeRemoteFile(branch, stylesPath, ".v2{color:red}", "[other] new styles.css");

        // This device: an unrelated local styles.css edit (no version bump).
        await client.vault.adapter.write(stylesPath, ".local{color:green}");

        await sync2AllAndAssertNoErrors(client);

        // The higher-semver bundle won the whole group — styles.css
        // followed main.js/manifest to the server version.
        const localStyles = fs.readFileSync(path.join(client.vaultPath, stylesPath), "utf8");
        expect(localStyles).toBe(".v2{color:red}");
        expect(fs.readFileSync(path.join(client.vaultPath, mainJsPath), "utf8")).toContain('LABEL="v2"');
        expect(await readRemoteFile(branch, stylesPath)).toBe(".v2{color:red}");

        // The whole point of §28: no conflict sibling anywhere in the vault.
        expect(listConflictSiblings(client.vaultPath)).toEqual([]);
      },
      240_000,
    );
  },
);
