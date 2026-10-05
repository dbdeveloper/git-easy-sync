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
import manifest from "../../../../../manifest.json";

// Owner, 2026-10-05: a deletion that arrives FROM THE SERVER must not
// remove our own plugin. In the field a clean-up of the repo on GitHub
// deleted main.js / manifest.json / styles.css locally and the running
// sync plugin uninstalled itself — on a device without a human at hand,
// sync would simply have stopped. The files stay on disk, and the next
// commit sends them back to the repo (owner's option a).
describe.skipIf(!integrationEnabled())(
  "sync2 self-protection — a remote deletion of our own plugin is not applied locally",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const DIR = `.obsidian/plugins/${manifest.id}`;
    const MAIN = `${DIR}/main.js`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-self-protect");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "our main.js deleted on GitHub → kept on disk, and the next sync puts it back on the server",
      async () => {
        client = await createSync2Client({ branch });
        const local = path.join(client.vaultPath, MAIN);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, "// our plugin bundle\n", "utf-8");
        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, MAIN)).not.toBeNull();

        await removeRemoteFile(branch, MAIN, "clean-up on GitHub");
        await sync2AllAndAssertNoErrors(client);
        // The deletion did NOT reach the disk.
        expect(fs.existsSync(local)).toBe(true);

        // …and the next sync restores it on the server.
        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, MAIN)).not.toBeNull();
      },
      240_000,
    );
  },
);
