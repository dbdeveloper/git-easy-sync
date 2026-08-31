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

// text canonicalisation — UTF-8 BOM at the start of a remote text file is the
// canonical-violation case GitHub's web view renders as a literal
// "﻿" glyph at the top of the page. Sync2 strips it locally and
// republishes the cleaned version so the server displays the file
// without the artifact.

describe.skipIf(!integrationEnabled())(
  "sync2 normalization — pull of UTF-8 BOM from web",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-norm-bom");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "BOM-prefixed remote text → local LF without BOM + server cleans up too",
      async () => {
        // Build the bytes by hand: EF BB BF as the BOM, then the body.
        // Pass as a Buffer so writeRemoteFile preserves the exact byte
        // sequence rather than re-encoding via the JS string path.
        const bytes = Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from("# header\n\nbody.\n", "utf-8"),
        ]);
        await writeRemoteFile(branch, "doc.md", bytes, "[web] add BOM");

        // Server really has the BOM in its bytes.
        const remoteBefore = await readRemoteFile(branch, "doc.md");
        expect(remoteBefore.charCodeAt(0)).toBe(0xfeff);

        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Local file is BOM-free.
        const local = fs.readFileSync(
          path.join(client.vaultPath, "doc.md"),
          "utf8",
        );
        expect(local.charCodeAt(0)).toBe("#".charCodeAt(0));
        expect(local).toBe("# header\n\nbody.\n");

        // ⚔️ RE-DERIVED AT THE SWITCH (R2 "call me again"): the
        // republish lands on the NEXT sync — the pull happens in the
        // drain's Vault-step, after this sync's findChanges. See the
        // CRLF sibling test for the full rationale.
        await sync2AllAndAssertNoErrors(client);
        const remoteAfter = await readRemoteFile(branch, "doc.md");
        expect(remoteAfter.charCodeAt(0)).toBe("#".charCodeAt(0));
        expect(remoteAfter).toBe("# header\n\nbody.\n");
      },
      180_000,
    );
  },
);
