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

// Standalone empirical probe for a question raised while discussing
// SPIKE-COMPARE-300.md: does compare()'s `status: "renamed"` (and, by
// the same underlying git rename-detection algorithm, GitHub's
// per-file History view / `git log --follow`) require the moved
// file's content to be BYTE-IDENTICAL (same blob SHA) at old and new
// path within the same commit, or does it tolerate a partial edit
// alongside the move, based on a content-similarity threshold?
//
// This is NOT about our own sync engine's behaviour (verified
// separately, by reading code, that we don't use this signal for
// anything but a pull-side shortcut) — it's a pure GitHub-platform
// question, checked against the real API rather than recalled from
// memory, per this repo's "don't invent — check" rule.
describe.skipIf(!integrationEnabled())(
  "scratch: does compare() rename-detection require identical content, or a similarity threshold?",
  () => {
    it("same-commit move+minor-edit is still flagged renamed; move+total-rewrite is not", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const client = new GithubClient(
        {
          ...DEFAULT_SETTINGS,
          githubToken: env.token,
          githubOwner: env.owner,
          githubRepo: env.repo,
          githubBranch: "main",
        },
        new Logger(
          {} as unknown as import("obsidian").Vault,
          "git-easy-sync",
          false,
        ),
      );

      const prefix = `spike-rename-${Date.now()}`;
      const branchA = uniqueBranchName("scratch-rename-minor");
      const branchB = uniqueBranchName("scratch-rename-major");

      // A realistic-sized body so a "minor edit" is genuinely minor in
      // similarity terms (changing 1 line out of many) and a "total
      // rewrite" is genuinely near-zero similarity.
      const originalBody = Array.from(
        { length: 40 },
        (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`,
      ).join("\n");
      const minorEditBody = originalBody.replace(
        "line 5:",
        "line 5 EDITED:",
      );
      const majorRewriteBody = Array.from(
        { length: 40 },
        (_, i) => `completely different content block ${i} — nothing shared`,
      ).join("\n");

      try {
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });

        // Both cases need `original.md` to exist in the diff base, so
        // seed a commit with it present, then branch A/B off that seed
        // with the rename applied.
        const seedTree = await client.createTree({
          tree: {
            tree: [
              {
                path: `${prefix}/original.md`,
                mode: "100644",
                type: "blob",
                content: originalBody,
              },
            ],
            base_tree: mainCommit.tree.sha,
          },
          retry: true,
        });
        const seedCommit = await client.createCommit({
          message: `scratch: seed original.md for rename-similarity probe`,
          treeSha: seedTree,
          parent: mainHead,
          retry: true,
        });

        const treeAFromSeed = await client.createTree({
          tree: {
            tree: [
              { path: `${prefix}/original.md`, mode: "100644", type: "blob", sha: null },
              {
                path: `${prefix}/renamed-minor-edit.md`,
                mode: "100644",
                type: "blob",
                content: minorEditBody,
              },
            ],
            base_tree: seedTree,
          },
          retry: true,
        });
        const commitA = await client.createCommit({
          message: `scratch: rename + minor edit, same commit`,
          treeSha: treeAFromSeed,
          parent: seedCommit,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branchA}`,
          sha: commitA,
          retry: true,
        });

        // ---- Case B: rename + total rewrite, same commit ----
        const treeBFromSeed = await client.createTree({
          tree: {
            tree: [
              { path: `${prefix}/original.md`, mode: "100644", type: "blob", sha: null },
              {
                path: `${prefix}/renamed-major-rewrite.md`,
                mode: "100644",
                type: "blob",
                content: majorRewriteBody,
              },
            ],
            base_tree: seedTree,
          },
          retry: true,
        });
        const commitB = await client.createCommit({
          message: `scratch: rename + total rewrite, same commit`,
          treeSha: treeBFromSeed,
          parent: seedCommit,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branchB}`,
          sha: commitB,
          retry: true,
        });

        // ---- Probe: compare(seed, commitA) and compare(seed, commitB) ----
        const cmpA = await client.compare({
          base: seedCommit,
          head: commitA,
          retry: true,
        });
        const cmpB = await client.compare({
          base: seedCommit,
          head: commitB,
          retry: true,
        });

        console.log(
          `[rename-similarity] minor-edit case: ${JSON.stringify(
            cmpA.files.map((f) => ({
              filename: f.filename,
              status: f.status,
              previous_filename: f.previous_filename,
            })),
          )}`,
        );
        console.log(
          `[rename-similarity] total-rewrite case: ${JSON.stringify(
            cmpB.files.map((f) => ({
              filename: f.filename,
              status: f.status,
              previous_filename: f.previous_filename,
            })),
          )}`,
        );

        // The finding: rename-detection is SIMILARITY-based, not an
        // exact-blob-SHA match. A 1-line edit out of 40 (~97.5% shared
        // content) in the SAME commit as the move still links as a
        // rename; a full rewrite (0% shared content) does not — it
        // reports as an unrelated removed+added pair. If GitHub ever
        // changes this threshold, this test's failure is itself the
        // signal to re-derive the guidance given to the repo owner.
        expect(cmpA.files).toHaveLength(1);
        expect(cmpA.files[0].status).toBe("renamed");
        expect(cmpA.files[0].previous_filename).toBe(`${prefix}/original.md`);

        expect(cmpB.files).toHaveLength(2);
        const byStatusB = new Map(cmpB.files.map((f) => [f.status, f]));
        expect(byStatusB.get("removed")?.filename).toBe(`${prefix}/original.md`);
        expect(byStatusB.get("added")?.filename).toBe(
          `${prefix}/renamed-major-rewrite.md`,
        );
      } finally {
        await deleteBranchIfExists(branchA);
        await deleteBranchIfExists(branchB);
      }
    }, 120_000);
  },
);
