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
  getBranchHead,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// FIELD BUG 2026-10-05 (owner's vault, "auto canonicalize" ON). A file
// already on the server in canonical form reappears on disk WITHOUT its
// trailing newline (the owner restored a folder from an un-synced
// original). Its canonical form equals the baseline, but the write-back
// is still due, so the commit emits it — and the batch entry's sha is
// exactly the baseline. The drain then met local == base with the remote
// confirmed unchanged, a combination _diff3's standard branch had no rule
// for: every sync failed with "Cannot read properties of null (reading
// 'slice')" in getBlob, and the queue stayed stuck.
//
// The contract pinned here: the second sync succeeds, the live file is
// canonical again, and main gets NO new commit — the server already holds
// exactly these bytes.
describe.skipIf(!integrationEnabled())(
  "sync2 normalization — a write-back whose result equals the baseline",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-writeback-eq-base");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "canonical file synced, then its trailing newline lost on disk → next sync: no error, no new commit, file canonical again",
      async () => {
        client = await createSync2Client({ branch, autoCanonicalize: true });
        await sync2AllAndAssertNoErrors(client);

        const file = path.join(client.vaultPath, "secret-test1.md");
        fs.writeFileSync(file, "# secret-test1\nsecret\n", "utf-8");
        await sync2AllAndAssertNoErrors(client);
        expect(await readRemoteFile(branch, "secret-test1.md")).toBe(
          "# secret-test1\nsecret\n",
        );
        const headAfterFirst = await getBranchHead(branch);

        // The un-synced original's bytes come back: no trailing newline.
        fs.writeFileSync(file, "# secret-test1\nsecret", "utf-8");
        await sync2AllAndAssertNoErrors(client);

        expect(fs.readFileSync(file, "utf8")).toBe("# secret-test1\nsecret\n");
        expect(await getBranchHead(branch)).toBe(headAfterFirst);
      },
      180_000,
    );
  },
);
