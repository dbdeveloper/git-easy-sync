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
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// B6 — first sync after install where the SAME binary file diverges
// and local mtime is OLDER than remote HEAD. Atomic mtime resolution
// picks the remote side: local bytes get overwritten with the remote
// blob in place, snapshot recorded.

describe.skipIf(!integrationEnabled())(
  "sync2 B6 — adoption: binary divergence, remote HEAD newer than local mtime",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b6-bin-remote-newer");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "local img.png is older than remote head → remote bytes overwrite local",
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
        const pastTs = (Date.now() - 60_000) / 1000;
        fs.utimesSync(imgPath, pastTs, pastTs);

        await sync2AllAndAssertNoErrors(client);

        // Local binary was overwritten with the remote bytes.
        const localAfter = fs.readFileSync(imgPath);
        expect(localAfter.equals(remoteBytes)).toBe(true);

        // Remote unchanged.
        const { files } = await client.client.getRepoContent({ retry: true });
        const remoteImg = files["attachments/img.png"];
        expect(remoteImg).toBeDefined();
        const remoteBlob = await client.client.getBlob({
          sha: remoteImg.sha,
          retry: true,
        });
        const remoteFinalBytes = Buffer.from(remoteBlob.content, "base64");
        expect(remoteFinalBytes.equals(remoteBytes)).toBe(true);

        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);
