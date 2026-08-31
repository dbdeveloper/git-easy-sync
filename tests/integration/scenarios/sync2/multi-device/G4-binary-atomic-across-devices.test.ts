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
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import {
  reconcileConflictsForTest,
  trackedSiblingPathsFor,
  conflictEntryCount,
} from "../helpers";

// G4 (pseudo-merge rewrite) — binary conflict across two real
// sync2 devices. Pseudo-merge mode removes silent atomic-mtime
// resolution for binary: device B's reconcile registers a
// modify-vs-modify conflict, sibling file (carrying A's bytes)
// lands in B's vault, B's local stays at B's bytes, remote stays at
// A's bytes. Resolution happens via standard file ops (here:
// delete the sibling → keep ours → next sync pushes B's bytes).

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

describe.skipIf(!integrationEnabled())(
  "sync2 G4 — binary conflict across two devices, sibling-based resolution",
  () => {
    let deviceA: Sync2TestClient | undefined;
    let deviceB: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g4-binary-conflict");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      deviceA?.cleanup();
      deviceB?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A and B both modify img.png; B's sync registers conflict + sibling; resolve via sibling delete",
      async () => {
        // Seed: A creates + pushes img.png.
        deviceA = await createSync2Client({ branch });
        const seed = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]);
        await deviceA.vault.adapter.writeBinary(
          "img.png",
          seed.buffer.slice(
            seed.byteOffset,
            seed.byteOffset + seed.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(deviceA);

        deviceB = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(deviceB);

        // A modifies + pushes first.
        const aBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa,
        ]);
        await deviceA.vault.adapter.writeBinary(
          "img.png",
          aBytes.buffer.slice(
            aBytes.byteOffset,
            aBytes.byteOffset + aBytes.byteLength,
          ) as ArrayBuffer,
        );
        await sync2AllAndAssertNoErrors(deviceA);

        // B modifies locally without pulling A's commit.
        const bBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xbb,
        ]);
        await deviceB.vault.adapter.writeBinary(
          "img.png",
          bBytes.buffer.slice(
            bBytes.byteOffset,
            bBytes.byteOffset + bBytes.byteLength,
          ) as ArrayBuffer,
        );

        // B's sync sees A's remote modification + own local mod →
        // binary path: pseudo-merge registers modify-vs-modify.
        await sync2AllAndAssertNoErrors(deviceB);

        const records = trackedSiblingPathsFor(deviceB, "img.png");
        expect(records).toHaveLength(1);
        const siblingPath = records[0];
        const siblingAbs = path.join(deviceB.vaultPath, siblingPath);
        expect(fs.existsSync(siblingAbs)).toBe(true);
        expect(bytesEqual(fs.readFileSync(siblingAbs), aBytes)).toBe(true);

        // B's local stays at B's bytes.
        const bImgPath = path.join(deviceB.vaultPath, "img.png");
        expect(bytesEqual(fs.readFileSync(bImgPath), bBytes)).toBe(true);

        // Remote still has A's bytes (B's push skipped the path).
        const { files: filesAfterRegister } =
          await deviceB.client.getRepoContent({ retry: true });
        const blobAfter = await deviceB.client.getBlob({
          sha: filesAfterRegister["img.png"].sha,
          retry: true,
        });
        expect(
          bytesEqual(Buffer.from(blobAfter.content, "base64"), aBytes),
        ).toBe(true);

        // User on B picks "ours" by deleting the sibling. Classifier
        // case 1 → drop record. Next sync pushes B's bytes.
        fs.rmSync(siblingAbs);
        await reconcileConflictsForTest(deviceB);
        expect(deviceB.conflictStore.hasBase("img.png")).toBe(false);

        await sync2AllAndAssertNoErrors(deviceB);

        const { files: filesAfterResolve } =
          await deviceB.client.getRepoContent({ retry: true });
        const blobResolved = await deviceB.client.getBlob({
          sha: filesAfterResolve["img.png"].sha,
          retry: true,
        });
        expect(
          bytesEqual(Buffer.from(blobResolved.content, "base64"), bBytes),
        ).toBe(true);

        // A pulls + converges.
        await sync2AllAndAssertNoErrors(deviceA);
        const aImgPath = path.join(deviceA.vaultPath, "img.png");
        expect(bytesEqual(fs.readFileSync(aImgPath), bBytes)).toBe(true);
      },
      360_000,
    );
  },
);
