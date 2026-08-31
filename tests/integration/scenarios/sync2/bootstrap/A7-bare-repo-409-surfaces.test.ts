import { describe, it, beforeEach, afterEach, expect } from "vitest";
import {
  bootstrapEnabled,
  countBranchCommits,
  getBranchHead,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import { calculateGitBlobSHA } from "../../../../../src/utils";

// A7 — EVERY place a bare repo can answer 409 "Git Repository is
// empty". Written after the gate audit (2026-08-31), because the
// SWITCH first tried to live WITHOUT the Contents-API seed and the
// whole bootstrap suite died on a single unmapped 409 — that class of
// hole deserves its own dedicated coverage instead of being implied.
//
// GitHub's rule: while a repository has NO ref, EVERY ref read and
// EVERY Git Data write answers 409. The engine's surfaces, one row
// per real call site:
//
//   1. main head read        getBranchHeadSha        → must read null
//   2. conflict head read    getBranchHeadShaByName  → must read null
//                            (§II.7 reads it LIVE on every drain start,
//                            so it fires even when no conflict exists)
//   3. first Git Data write  createTree/-Commit/-Blob → impossible;
//                            the Contents-API seed is the only door
//   4. deletion-only batch   createTree with no base_tree → nothing to
//                            delete; the entry must be dropped, not sent
//   5. every SUBSEQUENT sync must take the normal Git Data path
//
// Needs the classic PAT (public_repo + delete_repo) on the ephemeral
// public repo: delete+recreate is the only way back to bare state.

const SELF = "git-easy-sync";

describe.skipIf(!bootstrapEnabled())(
  "sync2 A7 — bare-repo 409 surfaces",
  () => {
    let client: Sync2TestClient | undefined;
    // A bare repo has no branches at all; the first commit creates
    // this one (same convention as sync2-bare-repo.test.ts).
    const branch = "main";

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv()); // → truly bare
    });

    afterEach(() => {
      client?.cleanup();
      client = undefined;
    });

    it(
      "surfaces 1+2+3: a first sync on a bare repo reads BOTH heads as null and births the branch through the seed",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });
        await client.vault.adapter.write("note.md", "hello\n");

        // Count the ref reads that a bare repo answers with 409, and
        // prove the engine treats each as "does not exist".
        const gh = client.client as unknown as {
          getBranchHeadSha: (a?: { retry?: boolean }) => Promise<string>;
          getBranchHeadShaByName: (a: {
            branch: string;
            retry?: boolean;
          }) => Promise<string | null>;
        };
        const origMain = gh.getBranchHeadSha.bind(gh);
        const origByName = gh.getBranchHeadShaByName.bind(gh);
        let mainReads = 0;
        let byNameReads = 0;
        let byNameNulls = 0;
        gh.getBranchHeadSha = async (a) => {
          mainReads += 1;
          const r = await origMain(a);
          return r;
        };
        gh.getBranchHeadShaByName = async (a) => {
          byNameReads += 1;
          const r = await origByName(a);
          if (r === null) byNameNulls += 1;
          return r;
        };

        // The whole point: this must NOT throw a ConflictError.
        await sync2AllAndAssertNoErrors(client);

        expect(mainReads).toBeGreaterThan(0);
        // The conflict-branch head is read live on every drain start
        // (§II.7) — on a bare repo that read is a 409 and MUST answer
        // null, which is what let the drain proceed at all.
        expect(byNameReads).toBeGreaterThan(0);
        expect(byNameNulls).toBe(byNameReads);

        // Surface 3: the branch exists and carries the content.
        expect(await getBranchHead(branch, env)).not.toBeNull();
        expect(await readRemoteFile(branch, "note.md", env)).toBe("hello\n");
        // seed + sync (the seed carries ONE of our files, the sync the rest).
        expect(await countBranchCommits(branch, env)).toBe(2);
      },
      210_000,
    );

    it(
      "surface 4: a DELETION-ONLY first sync on a bare repo is a clean no-op — no 409, no phantom commit",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        // Make the engine believe a path used to be synced, then
        // delete it locally, so the batch carries a DELETION entry
        // against a repo that has nothing. Without the accumulator
        // guard that entry went into a createTree with no base_tree
        // (bare repo → 409) or against a tree lacking the path
        // (→ 422 BadObjectState).
        //
        // ⚠️ The fake baseline sha must look like REAL content: 40
        // zeros IS git's null sha, i.e. DELETED_SHA_HASH, and the
        // engine then reads the row as "base was already deleted" →
        // rule 4.6.b → a manual conflict (a test artifact, not a
        // defect — cost one gate cycle to learn).
        const ghostBytes = new TextEncoder().encode("was here\n")
          .buffer as ArrayBuffer;
        await client.vault.adapter.write("ghost.md", "was here\n");
        await client.baselines.setMany([
          {
            path: "ghost.md",
            baselineSha: await calculateGitBlobSHA(ghostBytes),
            mtime: 1,
            size: ghostBytes.byteLength,
          },
        ]);
        await client.vault.adapter.remove("ghost.md");

        await sync2AllAndAssertNoErrors(client);

        // The deletion had nothing to delete: the repo may still be
        // bare (no ref) OR hold only the invariant gitignores from
        // enforce() — either way NO error and no ghost.md anywhere.
        const head = await getBranchHead(branch, env);
        if (head !== null) {
          const files = await listRemoteFiles(branch, env);
          expect(files).not.toContain("ghost.md");
        }
        // And the baseline row is gone, so the next scan is quiet.
        expect(await client.baselines.get("ghost.md")).toBeUndefined();
      },
      210_000,
    );

    it(
      "surface 5: after the seed, subsequent syncs use the NORMAL Git Data path (no seed, no 409, incremental commits)",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });
        await client.vault.adapter.write("a.md", "v1\n");
        await sync2AllAndAssertNoErrors(client);
        const afterFirst = await countBranchCommits(branch, env);

        // Count Contents-API PUTs: the seed must fire EXACTLY once,
        // ever — a second one would mean we re-seed a live repo.
        const gh = client.client as unknown as {
          createFile: (a: {
            path: string;
            content: string;
            message: string;
            retry?: boolean;
          }) => Promise<unknown>;
        };
        const origCreateFile = gh.createFile.bind(gh);
        let seeds = 0;
        gh.createFile = async (a) => {
          seeds += 1;
          return origCreateFile(a);
        };

        await client.vault.adapter.write("a.md", "v2\n");
        await client.vault.adapter.write("b.md", "fresh\n");
        await sync2AllAndAssertNoErrors(client);

        expect(seeds).toBe(0); // no re-seed on a non-bare repo
        expect(await countBranchCommits(branch, env)).toBe(afterFirst + 1);
        expect(await readRemoteFile(branch, "a.md", env)).toBe("v2\n");
        expect(await readRemoteFile(branch, "b.md", env)).toBe("fresh\n");
      },
      210_000,
    );

    it(
      "surface 2 (isolated): the conflict-branch head read answers null on a bare repo instead of throwing",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });
        // Direct call — the drain does this on EVERY start (§II.7).
        const r = await client.client.getBranchHeadShaByName({
          branch: `${SELF}-conflicts-probe-does-not-exist`,
          retry: true,
        });
        expect(r).toBeNull();
        // Same for the MAIN head via the drain's own adapter path:
        // a bare repo has no ref at all, and the cold-start signal is
        // null, not an exception.
        expect(await getBranchHead(branch, env)).toBeNull();
      },
      120_000,
    );
  },
);
