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
  getRemoteFileSha,
  integrationEnabled,
  removeRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Owner, 2026-10-05: Obsidian's own settings files (every file DIRECTLY
// in .obsidian/) always exist and are re-created by Obsidian, so their
// deletion arriving from the server is an accident: not applied locally,
// back on the server one sync later. Sub-folders (plugins/, themes/,
// snippets/) keep propagating deletions — that is how a user removes a
// plugin or theme on every device.
describe.skipIf(!integrationEnabled())(
  "sync2 self-protection — a remote deletion of an Obsidian settings file is not applied locally",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const APP = ".obsidian/app.json";
    const THEME = ".obsidian/themes/Plain/theme.css";

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-keep-obsidian-settings");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "app.json deleted on GitHub → kept on disk and back on the server; a theme deleted on GitHub IS removed locally",
      async () => {
        client = await createSync2Client({ branch });
        const put = (rel: string, content: string): void => {
          const abs = path.join(client!.vaultPath, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, "utf-8");
        };
        put(APP, '{"readableLineLength":true}\n');
        put(THEME, "body{}\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, APP)).not.toBeNull();
        expect(await getRemoteFileSha(branch, THEME)).not.toBeNull();

        await removeRemoteFile(branch, APP, "clean-up on GitHub");
        await removeRemoteFile(branch, THEME, "remove a theme");
        await sync2AllAndAssertNoErrors(client);
        expect(fs.existsSync(path.join(client.vaultPath, APP))).toBe(true);
        expect(fs.existsSync(path.join(client.vaultPath, THEME))).toBe(false);

        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, APP)).not.toBeNull();
        expect(await getRemoteFileSha(branch, THEME)).toBeNull();
      },
      240_000,
    );
  },
);
