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
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
  integrationEnabled,
  listRemoteFiles,
  type RequestFaultInjector,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Resume of an interrupted FIRST pull (cold start: no anchor, no
// baselines). ⚠️ Rewritten 2026-10-10: this used to describe
// `bootstrapFromRemote` and a "snapshot store", both deleted at THE
// SWITCH. The drain now pulls the cold tree in its Vault-step; a drop
// mid-loop leaves the already-written files on disk and the anchor
// (lastSyncCommitSha) still null — it is set only by the epilogue — so
// the next syncAll cold-starts again. Why it does NOT re-download what
// already landed (both verified in drain.ts):
//   1. the progress log (SYNC2-NEW-DRAIN §II.19): every written file got
//      a line, replayed into the baselines first, so cold discovery
//      (full tree vs baselines) does not even list those paths;
//   2. independently, a file whose vault content already equals the
//      remote sha is settled without a blob fetch ("the live vault
//      already holds exactly this content").
//
// This test also serves as the deep-nesting smoke test for sync2:
// seeded paths include depths 1, 2, 3, and 4 — a real-world Obsidian
// vault shape that no other integration test exercises today.

interface CountingInjector extends RequestFaultInjector {
  count: number;
}

function countMatches(
  matcher: (url: string, method: string) => boolean,
): CountingInjector {
  const injector: CountingInjector = {
    count: 0,
    intercept(url, method) {
      if (matcher(url, method)) injector.count += 1;
      return null;
    },
  };
  return injector;
}

const isGetBlob = (url: string, method: string): boolean =>
  method === "GET" && /\/git\/blobs\/[0-9a-f]+/.test(url);

describe.skipIf(!integrationEnabled())(
  "sync2 resume — an interrupted first pull skips already-downloaded files",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-resume-bootstrap");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      // Always reset the global fault injector — even on assertion
      // failure — so the next test runs against a clean requestUrl.
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "kill during the first pull's getBlob loop, then resume → all depths land, no re-download",
      async () => {
        // Seed five syncable files at varying depths, mixing text and
        // binary. Path depth is the headline coverage here — the drain's
        // vault writes call ensureParentDir (vault-file-reader.ts) to
        // create intermediate folders, and no other integration test
        // exercises >1 level.
        await writeRemoteFile(
          branch,
          "root.md",
          "depth-1 text\n",
          "[seed] root",
        );
        await writeRemoteFile(
          branch,
          "Folder/depth2.md",
          "depth-2 text\n",
          "[seed] folder",
        );
        await writeRemoteFile(
          branch,
          "Folder/Sub/depth3.md",
          "depth-3 text\n",
          "[seed] nested",
        );
        await writeRemoteFile(
          branch,
          "A/B/C/D/depth4.md",
          "depth-4 text\n",
          "[seed] deeply nested",
        );
        const pngBytes = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0xaa, 0xbb, 0xcc, 0xdd,
        ]);
        await writeRemoteFile(
          branch,
          "attachments/img.png",
          pngBytes,
          "[seed] binary",
        );

        // The actual syncable file count in the tree includes our 5
        // seeded files PLUS whatever the branch inherits from the
        // default-branch head (today: a single `.gitkeep` written by
        // ensureRepoNotBare). Read it from the tree at runtime so the
        // assertion stays robust to changes in the baseline.
        const totalSyncable = (await listRemoteFiles(branch)).length;
        expect(totalSyncable).toBeGreaterThanOrEqual(5);

        // First syncAll: fail on the 3rd getBlob call. We expect 2
        // files to land before the injected error, the 3rd to fail,
        // and the rest to never be attempted in this run. We don't
        // assert which files landed (Object.keys order isn't spec'd)
        // — only that the count is between 1 and totalSyncable-1.
        client = await createSync2Client({ branch });
        installRequestFaultInjector(
          failOnNthMatch(isGetBlob, 3, "Simulated network drop mid-bootstrap"),
        );
        await expect(client.manager.syncAll()).rejects.toThrow(
          /network drop mid-bootstrap/i,
        );

        // Some files exist on disk; lastSyncCommitSha must still be
        // null because the drain never reached its epilogue.
        expect(client.hotMeta.getLastSyncCommitSha()).toBeNull();
        const filesAfterCrash = listAllUnder(client.vaultPath).filter(
          (p) => !p.startsWith(".obsidian/"),
        );
        expect(filesAfterCrash.length).toBeGreaterThan(0);
        expect(filesAfterCrash.length).toBeLessThan(totalSyncable);

        // Resume run: clear the injector, swap in a counter so we can
        // observe how many getBlob calls the second pass issues.
        const counter = countMatches(isGetBlob);
        installRequestFaultInjector(counter);

        await sync2AllAndAssertNoErrors(client);

        // Resume MUST be strictly cheaper than a from-scratch
        // first pull. Without the two rules above the second pass would
        // call getBlob for every syncable file in the tree
        // (counter.count === totalSyncable). We assert two things:
        //   1. The second pass downloaded fewer than total — proof
        //      the skip kicked in at all.
        //   2. It downloaded at least 1 — proof the resumed pull
        //      actually ran (didn't silently skip everything).
        // We don't pin counter.count to an exact value: the precise
        // number of files landed before the crash varies a bit by
        // GitHub timing (a slow getBlob can shift which call the
        // 3rd-match injector hits), and what matters end-to-end is
        // the "no full re-download" guarantee, not the arithmetic.
        expect(counter.count).toBeGreaterThan(0);
        expect(counter.count).toBeLessThan(totalSyncable);

        // Every seeded file ended up on disk with the expected content.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "root.md"), "utf8"),
        ).toBe("depth-1 text\n");
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "Folder/depth2.md"),
            "utf8",
          ),
        ).toBe("depth-2 text\n");
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "Folder/Sub/depth3.md"),
            "utf8",
          ),
        ).toBe("depth-3 text\n");
        expect(
          fs.readFileSync(
            path.join(client.vaultPath, "A/B/C/D/depth4.md"),
            "utf8",
          ),
        ).toBe("depth-4 text\n");
        const localPng = fs.readFileSync(
          path.join(client.vaultPath, "attachments/img.png"),
        );
        expect(localPng.equals(pngBytes)).toBe(true);

        // The anchor now points at a real head — the next sync is an
        // incremental one (base…head delta), not another cold start.
        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
      },
      210_000,
    );
  },
);

// Local helper: depth-first walk of a vault dir on disk, returning
// vault-relative paths of every file. Used to count what landed
// before the crash without depending on the baselines (which the
// crash might have left half-written).
function listAllUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), next);
      } else if (entry.isFile()) {
        out.push(next);
      }
    }
  };
  walk(root, "");
  return out;
}
