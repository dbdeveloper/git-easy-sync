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
  getBranchHead,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// text canonicalisation — pull-side text canonicalisation against a real GitHub
// branch. Web-UI committed a CRLF-laden file before our sync ever
// touched it; the first syncAll must:
//   1. Write the LF version locally.
//   2. Auto-republish the canonical version back to GitHub in the
//      same syncAll call (the "preferred clean server" rule).
// After convergence the second sync is a no-op (covered by the
// idempotency suite).

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — pull of CRLF from web",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-crlf");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "CRLF on remote → local LF + remote also becomes LF after sync",
      async () => {
        // Web-UI commits a file with CRLF line endings — bytes are
        // preserved exactly as we send them through the Contents API.
        const crlf = "first line\r\nsecond line\r\nthird line\r\n";
        await writeRemoteFile(branch, "doc.md", crlf, "[web] add CRLF");

        // Sanity: the bytes really are CRLF on the server.
        const remoteBefore = await readRemoteFile(branch, "doc.md");
        expect(remoteBefore).toBe(crlf);

        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Local file is canonical (LF + trailing-NL invariant) — the
        // pull-side canonicalize (VaultFileReader.write).
        const local = fs.readFileSync(
          path.join(client.vaultPath, "doc.md"),
          "utf8",
        );
        expect(local).toBe("first line\nsecond line\nthird line\n");

        // ⚔️ RE-DERIVED AT THE SWITCH (R2 "call me again", SYNC2-FIX
        // §6): the republish lands on the NEXT sync, not this one. In
        // the new engine a sync is commit-pass → drain, and the pull
        // happens inside the drain's Vault-step — i.e. AFTER
        // findChanges already ran. So sync #1 makes the vault
        // canonical, sync #2 pushes it, sync #3 is quiescent. The old
        // engine converged in one click because its pull ran inside
        // the same batch loop as the push.
        await sync2AllAndAssertNoErrors(client);
        const remoteAfter = await readRemoteFile(branch, "doc.md");
        expect(remoteAfter).toBe("first line\nsecond line\nthird line\n");

        // Quiescence: a third sync changes nothing (no thrashing).
        const headAfterConverge = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(client);
        expect(await getBranchHead(branch)).toBe(headAfterConverge);
      },
      180_000,
    );
  },
);
