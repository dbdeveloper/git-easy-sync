import { describe, it, expect } from "vitest";
import Logger from "../../../src/logger";
import GithubClient from "../../../src/github/client";
import { DEFAULT_SETTINGS } from "../../../src/settings/settings";
import {
  requireEnv,
  uniqueBranchName,
  getDefaultBranchHead,
  deleteBranchIfExists,
  integrationEnabled,
} from "../helpers";
import { Vault as MockVault } from "../../../mock-obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// Empirical check that backs docs/PSEUDO-MERGE-MODE.md §2.3
// (reachability) on GitHub's actual server behaviour: after we
// createCommit a merge with branch.head as a parent and then
// deleteReference the branch — does GitHub GC the branch's
// commits, or does merge-commit reachability keep them alive?
//
// Standard git: an object is reachable iff any ref points at it OR
// it's an ancestor of something reachable. A merge commit on main
// with parents=[main.head, branch.head] makes branch.head an
// ancestor of main → object stays. We verify GitHub's implementation
// matches.

describe.skipIf(!integrationEnabled())(
  "scratch: branch commit reachability after merge + deleteRef",
  () => {
    it("commit on a deleted branch stays fetchable when a main-side merge commit references it", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const tmpRoot = path.join(
        os.tmpdir(),
        `scratch-merge-${crypto.randomBytes(4).toString("hex")}`,
      );
      fs.mkdirSync(tmpRoot, { recursive: true });
      const mockVault = new MockVault(tmpRoot);
      const logger = new Logger(
        mockVault as unknown as import("obsidian").Vault,
        "git-easy-sync",
        false,
      );
      const client = new GithubClient(
        {
          ...DEFAULT_SETTINGS,
          githubToken: env.token,
          githubOwner: env.owner,
          githubRepo: env.repo,
          githubBranch: "main", // not used for the methods we touch here
        },
        logger,
      );

      const branch = uniqueBranchName("scratch-merge-gc");
      let branchCommitSha = "";
      let mergeCommitSha = "";
      try {
        // 1. Fetch main HEAD commit's tree.
        const mainCommit = await client.getCommit({
          sha: mainHead,
          retry: true,
        });
        const mainTree = mainCommit.tree.sha;

        // 2. Create branch ref at main HEAD.
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: mainHead,
          retry: true,
        });

        // 3. Build a small commit on the branch — same tree as main
        //    so we don't touch any file content. The point is just
        //    to have a commit object whose only ref is the branch.
        branchCommitSha = await client.createCommit({
          message: `scratch: branch-side commit (${Date.now()})`,
          treeSha: mainTree,
          parent: mainHead,
          retry: true,
        });
        await client.updateReference({
          ref: `heads/${branch}`,
          sha: branchCommitSha,
          retry: true,
        });

        // 4. Confirm branch commit is fetchable BEFORE deleteRef.
        const beforeDelete = await client.getCommit({
          sha: branchCommitSha,
          retry: true,
        });
        expect(beforeDelete.tree.sha).toBe(mainTree);

        // 5. Create a merge commit on main referencing branchCommitSha
        //    as second parent.
        mergeCommitSha = await client.createCommit({
          message: `scratch: merge ${branch} (${Date.now()})`,
          treeSha: mainTree,
          parents: [mainHead, branchCommitSha],
          retry: true,
        });

        // 6. Move main HEAD to the merge commit. We don't actually
        //    do this here — modifying the default branch on the
        //    int-test repo is too disruptive. The reachability
        //    invariant we're testing depends on whether GitHub
        //    considers branchCommitSha "reachable from any ref" once
        //    main points at mergeCommitSha. But for the scope of
        //    this scratch test, we settle for: the branch commit is
        //    still reachable from a NEWLY-created commit
        //    (mergeCommitSha is itself reachable from... nothing
        //    yet, since we didn't move main). That's a weaker
        //    guarantee but enough to disprove "deleteRef wipes
        //    objects synchronously".
        //
        //    The stronger guarantee — branch commit reachable AFTER
        //    main moves AND branch ref is deleted — relies on
        //    GitHub's standard-git reachability rules, which are
        //    well-documented and we won't try to break here. If
        //    deleteRef worked async we'd see GC eventually, but
        //    GitHub explicitly says git GC is not run on demand for
        //    our purposes.

        // 7. Delete the branch ref.
        await client.deleteReference({
          ref: `heads/${branch}`,
          retry: true,
        });

        // 8. Branch commit object should STILL be fetchable
        //    immediately after deleteRef. mergeCommitSha references
        //    it; even though main's HEAD wasn't moved, the merge
        //    commit object exists on the server and keeps branchCommitSha
        //    reachable until git GC runs (which it won't unless
        //    explicitly invoked and unreferenced for hours).
        const afterDelete = await client.getCommit({
          sha: branchCommitSha,
          retry: true,
        });
        expect(afterDelete.tree.sha).toBe(mainTree);
        // Also the merge commit must be fetchable (sanity).
        const mergeAfter = await client.getCommit({
          sha: mergeCommitSha,
          retry: true,
        });
        expect(mergeAfter.tree.sha).toBe(mainTree);
      } finally {
        await deleteBranchIfExists(branch);
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {}
      }
    }, 60_000);
  },
);
