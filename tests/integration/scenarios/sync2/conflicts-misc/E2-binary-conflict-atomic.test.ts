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
  trackedSiblingPathsFor,
} from "../helpers";

// E2 (pseudo-merge rewrite) — binary conflict: both sides modified
// the same binary file. Pseudo-merge mode replaces the legacy silent
// atomic-mtime resolution with explicit register-as-conflict. A
// sibling file lands in the vault carrying theirs bytes; the local
// file stays at ours; remote stays at theirs until the user
// resolves via standard file ops (sibling delete / copy onto base).
//
// This collapses E2's two prior sub-tests (local-newer / local-older)
// into a single "register" assertion — mtime is no longer a tie-break.

describe.skipIf(!integrationEnabled())(
  "sync2 E2 — binary conflict registers as modify-vs-modify",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-e2-binary-conflict");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "binary differs on both sides → modify-vs-modify registered, no silent overwrite",
      async () => {
        client = await createSync2Client({ branch });
        const initial = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          initial.buffer.slice(
            initial.byteOffset,
            initial.byteOffset + initial.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(client);

        const remoteBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbb,
        ]);
        await writeRemoteFile(
          branch,
          "img.png",
          remoteBytes,
          "[other] modify img.png",
        );

        const localBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xcc,
        ]);
        await client.vault.adapter.writeBinary(
          "img.png",
          localBytes.buffer.slice(
            localBytes.byteOffset,
            localBytes.byteOffset + localBytes.byteLength,
          ) as ArrayBuffer,
        );

        await sync2AllAndAssertNoErrors(client);

        // Pseudo-merge contract: conflict registered, no silent
        // overwrite. Local stays at ours; remote stays at theirs.
        const records = trackedSiblingPathsFor(client, "img.png");
        expect(records).toHaveLength(1);

        const localAfter = fs.readFileSync(path.join(client.vaultPath, "img.png"));
        expect(localAfter.equals(localBytes)).toBe(true);

        // Sibling file has theirs bytes.
        const siblingAbs = path.join(client.vaultPath, records[0]);
        expect(fs.existsSync(siblingAbs)).toBe(true);
        const siblingBytes = fs.readFileSync(siblingAbs);
        expect(siblingBytes.equals(remoteBytes)).toBe(true);

        // Remote still has theirs (push skipped the path).
        const { files } = await client.client.getRepoContent({ retry: true });
        const blob = await client.client.getBlob({
          sha: files["img.png"].sha,
          retry: true,
        });
        const remoteRaw = Buffer.from(blob.content, "base64");
        expect(remoteRaw.equals(remoteBytes)).toBe(true);
      },
      240_000,
    );
  },
);
