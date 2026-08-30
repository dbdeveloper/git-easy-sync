import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getBranchCommitShas,
  getBranchHead,
  getDefaultBranchHead,
  getRemoteFileSha,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// T2.2 (SYNC2-FIX §7, TODO п.2) — the SAME file committed several
// times in a row, then one drain. The direct §40 regression: dedup
// must compare against the NEWEST queued batch, or successive
// versions get folded/dropped.
//
// The invariant here is the project's "preserve all commits" rule:
// every commitOnly the user made is a potential historical artifact —
// after the drain, EACH version must exist as its own commit on the
// branch, in the original order, with nothing folded away (I1).
// Unlike T2.1 the per-version commit count IS the contract, not
// engine shape.

describe.skipIf(!integrationEnabled())(
  "sync2 T2.2 — sequential commits of one file: every version lands, in order",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 4;
    const FILE = "t2-story.md";
    // Version i = lines 1..i — strictly growing, one line per commit.
    const version = (i: number): string =>
      Array.from({ length: i }, (_, k) => `line ${k + 1}`).join("\n") + "\n";

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t2-2-same-file");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "4 commitOnly of v1..v4 → one syncAll → branch history carries v1,v2,v3,v4 as 4 ordered commits",
      async () => {
        client = await createSync2Client({ branch });

        // Prime: invariants commit + snapshot baseline. The file does
        // not exist yet — every version below is queued work.
        await sync2AllAndAssertNoErrors(client);
        const headAfterPrime = await getBranchHead(branch);
        if (!headAfterPrime) throw new Error("branch head missing");

        for (let i = 1; i <= N; i++) {
          await client.vault.adapter.write(FILE, version(i));
          await client.manager.commitOnly();
        }
        expect(
          (await client.queue.list()).length,
          "each version must stay its own batch (§40: no fold into older)",
        ).toBe(N);

        await sync2AllAndAssertNoErrors(client);

        // End state: newest version on the branch, queue drained.
        expect(await readRemoteFile(branch, FILE)).toBe(version(N));
        expect(await client.queue.list()).toEqual([]);

        // History: walk the commits the drain added (newest → oldest,
        // stop at the prime head) and read the file at each one. Every
        // version must be present, in order, one commit each.
        const allShas = await getBranchCommitShas(branch);
        const primeIdx = allShas.indexOf(headAfterPrime);
        expect(primeIdx, "prime head must be an ancestor").toBeGreaterThan(-1);
        const drainShas = allShas.slice(0, primeIdx); // newest first

        const contentsOldestFirst: string[] = [];
        for (const sha of [...drainShas].reverse()) {
          // getRemoteFileSha/readRemoteFile accept any tree-ish.
          const blobSha = await getRemoteFileSha(sha, FILE);
          if (blobSha === null) continue; // commit not touching FILE
          contentsOldestFirst.push(await readRemoteFile(sha, FILE));
        }
        // Dedupe consecutive equal contents: a commit that didn't
        // change FILE (none expected today) must not fail the order
        // check, only a LOST or REORDERED version should.
        const distinct = contentsOldestFirst.filter(
          (c, idx) => idx === 0 || c !== contentsOldestFirst[idx - 1],
        );
        expect(distinct).toEqual(
          Array.from({ length: N }, (_, k) => version(k + 1)),
        );
      },
      300_000,
    );
  },
);
