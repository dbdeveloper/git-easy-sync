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

// Owner, 2026-10-05: a .gitignore "cannot not exist", so a deletion of
// one that arrives from the server is suspicious — and in the field it
// was exactly what exposed formerly ignored, private files to the next
// commit. A remote deletion of a .gitignore is not applied locally: the
// file and its rules stay, and the next commit puts it back on the server.
describe.skipIf(!integrationEnabled())(
  "sync2 self-protection — a remote deletion of a .gitignore is not applied locally",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    // The ROOT .gitignore — one of the four places a .gitignore is
    // supported and synced: root, .obsidian/, .obsidian/plugins/,
    // .obsidian/plugins/<id>/ (DOT-FILES D5).
    const GI = ".gitignore";
    const SECRET = "Private/secret.md";

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-keep-gitignore");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "the root .gitignore deleted on GitHub → kept on disk with the user's rule, the secret stays home, and it is back on the server",
      async () => {
        client = await createSync2Client({ branch });
        fs.mkdirSync(path.join(client.vaultPath, "Private"), { recursive: true });
        // The user's own rule, BELOW whatever our managed block becomes.
        await sync2AllAndAssertNoErrors(client); // enforce() seeds the root .gitignore
        fs.appendFileSync(path.join(client.vaultPath, GI), "\nPrivate/secret.md\n", "utf-8");
        fs.writeFileSync(path.join(client.vaultPath, SECRET), "do not upload\n", "utf-8");
        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, GI)).not.toBeNull();
        expect(await getRemoteFileSha(branch, SECRET)).toBeNull();

        await removeRemoteFile(branch, GI, "clean-up on GitHub");
        await sync2AllAndAssertNoErrors(client);
        expect(fs.readFileSync(path.join(client.vaultPath, GI), "utf8")).toContain(
          "Private/secret.md",
        );

        await sync2AllAndAssertNoErrors(client);
        expect(await getRemoteFileSha(branch, GI)).not.toBeNull();
        // The rule never stopped working: the secret never left the device.
        expect(await getRemoteFileSha(branch, SECRET)).toBeNull();
      },
      240_000,
    );
  },
);
