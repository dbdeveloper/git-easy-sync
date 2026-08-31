import {
// ⚔️ RE-DERIVED AT THE SWITCH (2026-08-31) — see the B3/B4 note: the
// old `bootstrapFromRemote` mtime heuristic is gone (MASTER-PLAN §6.4,
// owner decision A). A cold-start divergence with no common base is a
// MANUAL CONFLICT: vault keeps OURS, main keeps THEIRS, a sibling
// carries theirs, the conflict is registered. Binary is no exception —
// it simply can never auto-merge.
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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
  trackedSiblingPathsFor,
} from "../helpers";

// B5 — first sync after install where the SAME binary file diverges
// and local mtime is newer than remote HEAD. Same atomic mtime
// resolution as B3, but for a binary path (text canonicalisation is
// off the table; comparison is purely by SHA + mtime).

describe.skipIf(!integrationEnabled())(
  "sync2 B5 — adoption: binary divergence, local mtime newer than remote HEAD",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b5-bin-local-newer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local img.png mtime newer than remote head → local bytes win, land on remote",
      async () => {
        const remoteBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x11, 0x22, 0x33, 0x44,
        ]);
        await writeRemoteFile(
          branch,
          "attachments/img.png",
          remoteBytes,
          "[seed] remote binary",
        );

        client = await createSync2Client({ branch });
        const localBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0xaa, 0xbb, 0xcc, 0xdd,
        ]);
        await client.vault.adapter.writeBinary(
          "attachments/img.png",
          localBytes.buffer.slice(
            localBytes.byteOffset,
            localBytes.byteOffset + localBytes.byteLength,
          ) as ArrayBuffer,
        );

        const imgPath = path.join(client.vaultPath, "attachments/img.png");
        const futureTs = (Date.now() + 60_000) / 1000;
        fs.utimesSync(imgPath, futureTs, futureTs);

        await sync2AllAndAssertNoErrors(client);

        // Vault keeps OURS.
        const localAfter = fs.readFileSync(imgPath);
        expect(localAfter.equals(localBytes)).toBe(true);

        // Remote binary is now the local bytes — push lifted them.
        // We compare via getBlob → bytes round-trip byte-exact for
        // non-text extensions.
        // (We use the same content-fetch helper the binary-byte-exact
        // test uses: listRemoteFiles to confirm presence, then a
        // raw API call to the blob's SHA would be needed for full
        // verification. Here we just confirm the local push happened
        // by checking the file exists on remote with a NEW SHA.)
        // Simplest check: re-read via the test client's GithubClient.
        const { files } = await client.client.getRepoContent({ retry: true });
        const remoteImg = files["attachments/img.png"];
        expect(remoteImg, "img.png still on remote").toBeDefined();

        const remoteBlob = await client.client.getBlob({
          sha: remoteImg.sha,
          retry: true,
        });
        const remoteFinalBytes = Buffer.from(remoteBlob.content, "base64");
        // Main keeps THEIRS (no silent binary winner).
        expect(remoteFinalBytes.equals(remoteBytes)).toBe(true);

        // Registered conflict + sibling carrying theirs.
        const siblings = trackedSiblingPathsFor(client, "attachments/img.png");
        expect(siblings).toHaveLength(1);
        expect(
          fs.readFileSync(path.join(client.vaultPath, siblings[0])).equals(
            remoteBytes,
          ),
        ).toBe(true);

        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
