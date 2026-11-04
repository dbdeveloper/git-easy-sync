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
  countBranchCommits,
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
  trackedSiblingPathsFor,
} from "../helpers";
import { bucketIdForPath } from "../../../../../src/sync2/file-baselines";

// K6 — ONE baseline bucket is lost, and a path in it has meanwhile changed
// on the server. K1 covers "every bucket lost, content equal on both
// sides"; this is the remaining corner (owner, 2026-11-04): a PARTIAL loss
// with DIVERGENT content.
//
// Without its baseline the path has no common ancestor, so the drain
// cannot tell "only the server changed it" from "both sides wrote it
// independently". The safe answer is a conflict copy: the local version
// stays, the server's version lands beside it, main is not overwritten.
// What the loss must NOT cost: the unchanged neighbour in the same bucket
// is re-aligned without a push, and a path in an intact bucket still
// pulls cleanly.

const RUNTIME_REL = ".obsidian/plugins/git-easy-sync/.runtime";

// Paths chosen so that P and Q share a bucket and R lives in another one.
function pickPaths(): { p: string; q: string; r: string } {
  const p = "lost/p.md";
  const bucket = bucketIdForPath(p);
  let q: string | null = null;
  let r: string | null = null;
  for (let i = 0; i < 10_000 && (q === null || r === null); i++) {
    const candidate = `lost/n${i}.md`;
    if (bucketIdForPath(candidate) === bucket) q ??= candidate;
    else r ??= candidate;
  }
  if (q === null || r === null) throw new Error("could not pick test paths");
  return { p, q, r };
}

describe.skipIf(!integrationEnabled())(
  "sync2 K6 — one baseline bucket lost, its path changed on the server",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranch: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-k6-bucket-lost");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      client = undefined;
      await deleteBranchIfExists(branch);
      if (conflictBranch) await deleteBranchIfExists(conflictBranch);
      conflictBranch = undefined;
    });

    it(
      "🔑 the path in the lost bucket becomes a conflict copy — nothing overwritten, nothing re-pushed",
      async () => {
        const { p, q, r } = pickPaths();

        // First session: push all three normally.
        const first = await createSync2Client({ branch, ownsVaultPath: false });
        const vaultPath = first.vaultPath;
        client = {
          ...first,
          cleanup: () => {
            try {
              fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {}
          },
        };
        fs.mkdirSync(path.join(vaultPath, "lost"), { recursive: true });
        await first.vault.adapter.write(p, "p local\n");
        await first.vault.adapter.write(q, "q same\n");
        await first.vault.adapter.write(r, "r base\n");
        await sync2AllAndAssertNoErrors(first);
        expect(await readRemoteFile(branch, p)).toBe("p local\n");

        // Lose P's bucket (Q's too — same file). R's bucket stays intact.
        const bucketFile = path.join(
          vaultPath,
          RUNTIME_REL,
          "file-baselines",
          `${bucketIdForPath(p)}.json`,
        );
        expect(fs.existsSync(bucketFile)).toBe(true);
        fs.writeFileSync(bucketFile, "{not valid json,;\n");

        // Meanwhile the server changes P (lost base) and R (intact base).
        await writeRemoteFile(branch, p, "p theirs\n", "[web] edit p");
        await writeRemoteFile(branch, r, "r theirs\n", "[web] edit r");
        const beforeSync = await countBranchCommits(branch);

        // Restart over the same vault: the bucket cache starts cold, as
        // after the crash that would have torn the file.
        client = await createSync2Client({
          branch,
          vaultPath,
          ownsVaultPath: true,
        });
        await sync2AllAndAssertNoErrors(client);

        // P: the local version is kept, the server's version sits beside
        // it as a conflict copy, and main still holds the server's version.
        expect(fs.readFileSync(path.join(vaultPath, p), "utf8")).toBe("p local\n");
        const copies = trackedSiblingPathsFor(client, p);
        expect(copies).toHaveLength(1);
        expect(fs.readFileSync(path.join(vaultPath, copies[0]), "utf8")).toBe(
          "p theirs\n",
        );
        expect(await readRemoteFile(branch, p)).toBe("p theirs\n");
        conflictBranch = client.hotMeta.getConflictBranch()?.name;

        // R (intact bucket): an ordinary clean pull, no copy.
        expect(fs.readFileSync(path.join(vaultPath, r), "utf8")).toBe("r theirs\n");
        expect(trackedSiblingPathsFor(client, r)).toEqual([]);

        // Q (lost bucket, same on both sides): re-aligned, not re-pushed.
        expect(await readRemoteFile(branch, q)).toBe("q same\n");
        expect(trackedSiblingPathsFor(client, q)).toEqual([]);
        expect((await client.baselines.get(q))?.baselineSha).toBeTruthy();

        // Nothing of ours reached main: no sync commit re-sending P or Q.
        expect(await countBranchCommits(branch)).toBe(beforeSync);
      },
      300_000,
    );
  },
);
