import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  listRemoteFiles,
  readRemoteFile,
  removeRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "./helpers";
import * as fs from "fs";
import * as path from "path";

// Walk through the most common sync2 lifecycle: empty vault on a
// freshly-bootstrapped branch → user adds files → user edits files
// → user deletes files → web-UI adds remotely → pull → web-UI edits
// remotely → pull → web-UI deletes remotely → pull. Each step
// progresses local + remote state and asserts what landed where.
describe.skipIf(!integrationEnabled())(
  "sync2 — full empty-vault lifecycle progression",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-progression");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "lifecycle: add → edit → delete → web-add → web-edit → web-delete",
      async () => {
        client = await createSync2Client({ branch });

        // Step 1: first syncAll runs bootstrap + invariant-gitignore
        // enforce. The two managed gitignores are created locally and
        // pushed; everything else on the branch stays as-is.
        const initialFiles = await listRemoteFiles(branch);
        await sync2AllAndAssertNoErrors(client);
        const afterFirst = (await listRemoteFiles(branch)).sort();
        const expectedAfter = [
          ...initialFiles,
          ".obsidian/.gitignore",
          ".obsidian/plugins/git-easy-sync/.gitignore",
        ]
          .filter((p, i, a) => a.indexOf(p) === i)
          .sort();
        expect(afterFirst).toEqual(expectedAfter);

        // Step 2: add a local note → push.
        await client.vault.adapter.write("Note A.md", "first version\n");
        await sync2AllAndAssertNoErrors(client);
        const filesAfterAdd = await listRemoteFiles(branch);
        expect(filesAfterAdd).toContain("Note A.md");
        expect(await readRemoteFile(branch, "Note A.md")).toBe(
          "first version\n",
        );

        // Step 3: edit the same note → push (modified).
        await client.vault.adapter.write("Note A.md", "second version\n");
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "Note A.md")).toBe(
          "second version\n",
        );

        // Step 4: delete locally → push (sha:null).
        await client.vault.adapter.remove("Note A.md");
        await sync2AllAndAssertNoErrors(client);
        expect(await listRemoteFiles(branch)).not.toContain("Note A.md");

        // Step 5: someone else (web UI) adds a file → pull picks it up.
        await writeRemoteFile(
          branch,
          "Web Note.md",
          "from-web\n",
          "[web] add",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(
          fs.existsSync(path.join(client.vaultPath, "Web Note.md")),
        ).toBe(true);
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "Web Note.md"),
            "utf8",
          ),
        ).toBe("from-web\n");

        // Step 6: web edits the file → pull updates local.
        await writeRemoteFile(
          branch,
          "Web Note.md",
          "from-web-v2\n",
          "[web] edit",
        );
        await sync2AllAndAssertNoErrors(client);
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "Web Note.md"),
            "utf8",
          ),
        ).toBe("from-web-v2\n");

        // Step 7: web deletes the file → pull removes it locally.
        await removeRemoteFile(branch, "Web Note.md", "[web] delete");
        await sync2AllAndAssertNoErrors(client);
        expect(
          fs.existsSync(path.join(client.vaultPath, "Web Note.md")),
        ).toBe(false);
      },
      120_000,
    );
  },
);
