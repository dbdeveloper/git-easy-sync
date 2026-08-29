import { describe, it, expect } from "vitest";
import Logger from "../../src/logger";
import GithubClient from "../../src/github/client";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import {
  requireEnv,
  uniqueBranchName,
  getDefaultBranchHead,
  deleteBranchIfExists,
  integrationEnabled,
} from "./helpers";
import { Vault as MockVault } from "../../mock-obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// PERMANENT regression suite backing docs/tasks/SPIKE-COMPARE-300.md
// and SYNC2-NEW-DRAIN.md §VII.1's hybrid discovery design
// (`getChangedFilesFromGitHubRepo`). Not a one-off "scratch" probe —
// do not delete. Pins two live-GitHub facts the hybrid design's
// correctness depends on:
//   - GitHub's Compare API (`GET /compare/{base}...{head}`) caps
//     `files[]` at 300 entries with no truncation flag in the
//     response (Probe A below).
//   - The design's TRUNCATION_GUARD_THRESHOLD (100) — the file count
//     below which the design trusts compare() alone, without a
//     tree-diff cross-check — must stay safely below GitHub's real
//     cap (CANARY, last test in this file). If GitHub ever lowers
//     the real cap towards or below 100, that test goes red and it
//     is a real finding, not flakiness — see its own comment.
// It also probes two candidate data sources for a >300-file fallback:
//   - `GET /repos/{o}/{r}/commits/{sha}` (Repos API) — does ITS
//     `files[]` also cap at 300, and does it expose anything the
//     Compare API doesn't?
//   - `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` (Git Data API,
//     the same endpoint `GithubClient.getRepoContent` already calls)
//     — does it expose a `truncated` flag Compare lacks, and does our
//     own `getRepoContent` currently read it (spoiler: no — see the
//     assertion below, which is itself a finding).
describe.skipIf(!integrationEnabled())(
  "GitHub Compare/Commits/Trees API truncation behaviour (SPIKE-COMPARE-300 regression pins)",
  () => {
    it("compare() caps files[] at 300 with no truncation signal; commits/trees APIs probed for a fallback", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const tmpRoot = path.join(
        os.tmpdir(),
        `scratch-compare300-${crypto.randomBytes(4).toString("hex")}`,
      );
      fs.mkdirSync(tmpRoot, { recursive: true });
      const mockVault = new MockVault(tmpRoot);
      const logger = new Logger(
        mockVault as unknown as import("obsidian").Vault,
        "git-easy-sync",
        true, // enabled=true so the probe's info() lines actually reach console/log — see run output
      );
      const client = new GithubClient(
        {
          ...DEFAULT_SETTINGS,
          githubToken: env.token,
          githubOwner: env.owner,
          githubRepo: env.repo,
          githubBranch: "main",
        },
        logger,
      );

      const FILE_COUNT = 301; // one past GitHub's documented 300-file cap
      const branch = uniqueBranchName("scratch-compare300");
      const prefix = `spike-compare-300-${Date.now()}`;

      try {
        // 1. Base state: main HEAD's tree, as base_tree for the new commit.
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });

        // 2. One createTree call, 301 distinct new files, inline content
        //    (no separate blob uploads needed — GitHub creates the blobs
        //    for us from `content`).
        const entries = Array.from({ length: FILE_COUNT }, (_, i) => ({
          path: `${prefix}/file-${i}.md`,
          mode: "100644",
          type: "blob",
          content: `probe file ${i} — ${crypto.randomBytes(4).toString("hex")}`,
        }));
        const newTreeSha = await client.createTree({
          tree: { tree: entries, base_tree: mainCommit.tree.sha },
          retry: true,
        });

        const newCommitSha = await client.createCommit({
          message: `scratch: ${FILE_COUNT} new files for compare-300 probe`,
          treeSha: newTreeSha,
          parent: mainHead,
          retry: true,
        });

        // Publish as a branch so the commit isn't dangling (and so
        // cleanup is one deleteReference call, matching project
        // convention for disposable test state).
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: newCommitSha,
          retry: true,
        });

        // ---- Probe A: Compare API ----
        const cmp = await client.compare({
          base: mainHead,
          head: newCommitSha,
          retry: true,
        });
        void logger.info(
          `[spike-300] compare() files.length=${cmp.files.length} (created ${FILE_COUNT})`,
        );
        // The documented cap. If this ever fails, GitHub changed the
        // limit — the spike's numbers need re-deriving, not the test
        // loosened blindly.
        expect(cmp.files.length).toBe(300);

        // ---- Probe B: Repos "get commit" API (files[] + any pagination signal) ----
        const commitResp = await fetch(
          `https://api.github.com/repos/${env.owner}/${env.repo}/commits/${newCommitSha}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${env.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        const commitJson = (await commitResp.json()) as {
          files?: unknown[];
          stats?: { total?: number };
          [k: string]: unknown;
        };
        void logger.info(
          `[spike-300] GET /commits/{sha} status=${commitResp.status} ` +
            `files.length=${commitJson.files?.length} stats.total=${commitJson.stats?.total} ` +
            `linkHeader=${commitResp.headers.get("link")} topLevelKeys=${Object.keys(commitJson).join(",")}`,
        );
        expect(commitResp.status).toBe(200);
        // Same 300-file cap applies to this endpoint's files[] too —
        // confirms it's NOT a usable full-fidelity fallback on its own,
        // and (Link header) whether GitHub signals pagination for it.
        expect(commitJson.files?.length).toBeLessThanOrEqual(300);

        // ---- Probe C: Git Data "get tree" API (truncated flag) ----
        const treeResp = await fetch(
          `https://api.github.com/repos/${env.owner}/${env.repo}/git/trees/${newTreeSha}?recursive=1`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${env.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        const treeText = await treeResp.text();
        const treeJson = JSON.parse(treeText) as {
          tree?: unknown[];
          truncated?: boolean;
          [k: string]: unknown;
        };
        // Bytes-per-entry, measured not guessed — backs the §5
        // vault-size cost note in SPIKE-COMPARE-300.md (extrapolate
        // treeText.length / tree.length × real vault entry count for
        // an actual MB figure, instead of an assumed one).
        void logger.info(
          `[spike-300] GET /git/trees/{sha}?recursive=1 status=${treeResp.status} ` +
            `tree.length=${treeJson.tree?.length} truncated=${treeJson.truncated} ` +
            `topLevelKeys=${Object.keys(treeJson).join(",")} ` +
            `responseBytes=${treeText.length} bytesPerEntry=${(treeText.length / (treeJson.tree?.length ?? 1)).toFixed(1)}`,
        );
        expect(treeResp.status).toBe(200);
        // The key structural fact this probe exists to confirm: unlike
        // compare() and the commits endpoint, the tree endpoint DOES
        // carry an explicit truncation flag — at this small scale it
        // must read false (we're nowhere near GitHub's tree-size
        // threshold), which is itself the finding: the flag EXISTS
        // and is readable, Compare's silence is Compare-specific, not
        // a GitHub-wide limitation.
        expect(treeJson.truncated).toBe(false);
        // At full depth (not just our 301 probe files) the tree must
        // contain every file we created — confirms this endpoint does
        // NOT share Compare's 300-file cap.
        expect((treeJson.tree ?? []).length).toBeGreaterThanOrEqual(FILE_COUNT);

        // ---- Probe D: does our OWN getRepoContent() read `truncated`? ----
        // (finding, not a GitHub-behaviour probe) — see client.ts
        // getRepoContent: it destructures response.json.tree and
        // response.json.sha only. This assertion exists so a future
        // read of this test file states the gap in code, not just in
        // the spike doc's prose.
        const repoContentSrc = fs.readFileSync(
          path.join(__dirname, "../../src/github/client.ts"),
          "utf8",
        );
        const getRepoContentBody = repoContentSrc.slice(
          repoContentSrc.indexOf("async getRepoContent("),
          repoContentSrc.indexOf("async createTree("),
        );
        expect(getRepoContentBody).not.toContain("truncated");
      } finally {
        await deleteBranchIfExists(branch);
        try {
          fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {}
      }
    }, 120_000);

    // Probe E: does compare()'s `commits[]` list follow standard GitHub
    // Link-header pagination (page/per_page), independent of the 300-file
    // cap on `files[]`? This backs the "hop to an intermediate commit via
    // commits[]" mechanism proposed as an alternative to fallback (б)/(в)
    // in SPIKE-COMPARE-300.md. Cheap on purpose: creates only 3 tiny
    // sequential commits and forces pagination with `per_page=1` — this
    // confirms the MECHANISM (Link header present, per_page honoured),
    // not the exact page size GitHub uses at production scale
    // (hundreds of commits after weeks offline). That larger-scale
    // number is NOT verified here — see the spike's "NEEDS PROBE" note.
    it("compare()'s commits[] list paginates via Link header, independent of files[]'s 300 cap", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const branch = uniqueBranchName("scratch-compare300-commits");
      const prefix = `spike-compare-300-commits-${Date.now()}`;
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

      try {
        let parent = mainHead;
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });
        let treeSha = mainCommit.tree.sha;
        const COMMIT_COUNT = 3;
        for (let i = 0; i < COMMIT_COUNT; i++) {
          treeSha = await client.createTree({
            tree: {
              tree: [
                {
                  path: `${prefix}/file-${i}.md`,
                  mode: "100644",
                  type: "blob",
                  content: `probe commit ${i}`,
                },
              ],
              base_tree: treeSha,
            },
            retry: true,
          });
          parent = await client.createCommit({
            message: `scratch: commit ${i}/${COMMIT_COUNT} for commits[]-pagination probe`,
            treeSha,
            parent,
            retry: true,
          });
        }
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: parent,
          retry: true,
        });

        const res = await fetch(
          `https://api.github.com/repos/${env.owner}/${env.repo}/compare/${mainHead}...${parent}?per_page=1`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${env.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        );
        const json = (await res.json()) as { commits?: unknown[] };
        console.log(
          `[spike-300-commits] status=${res.status} commits.length=${json.commits?.length} ` +
            `linkHeader=${res.headers.get("link")}`,
        );
        expect(res.status).toBe(200);
        // per_page=1 with 3 real commits in the window: if GitHub honours
        // per_page for compare()'s commits[] the same way it does for
        // ordinary list endpoints, we get exactly 1 back plus a Link
        // header pointing at more pages — CONFIRMS the pagination
        // mechanism exists here, independent of the files[] 300-cap
        // (which has no such escape hatch).
        expect(json.commits?.length).toBe(1);
        expect(res.headers.get("link")).toMatch(/rel="next"/);
      } finally {
        await deleteBranchIfExists(branch);
      }
    }, 60_000);

    // Probe F — CANARY for TRUNCATION_GUARD_THRESHOLD (100), the
    // constant SPIKE-COMPARE-300.md §3.в's hybrid design trusts
    // compare() below without cross-checking against a tree-diff.
    // That trust is only sound as long as GitHub's real truncation
    // point stays above 100. This creates 101 changed files (one
    // past the threshold) and asserts compare() returns all 101,
    // unstruncated — proof the real cap is still comfortably above
    // our trust boundary. If GitHub ever lowers the real cap to or
    // below 100, this is the test that catches it: `cmp.files.length`
    // would come back < 101, and per the design, ANY count below 100
    // here means files silently vanish from every pull's discovery
    // phase without the cross-check ever firing. Do not raise this
    // threshold to "fix" a failure without first re-deriving
    // TRUNCATION_GUARD_THRESHOLD in the spike — a red run here is a
    // real finding, not test flakiness.
    it("CANARY: compare() must not truncate below TRUNCATION_GUARD_THRESHOLD=100", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const TRUNCATION_GUARD_THRESHOLD = 100;
      const FILE_COUNT = TRUNCATION_GUARD_THRESHOLD + 1;
      const branch = uniqueBranchName("canary-compare-100");
      const prefix = `canary-compare-100-${Date.now()}`;
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

      try {
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });
        const entries = Array.from({ length: FILE_COUNT }, (_, i) => ({
          path: `${prefix}/file-${i}.md`,
          mode: "100644",
          type: "blob",
          content: `canary file ${i} — ${crypto.randomBytes(4).toString("hex")}`,
        }));
        const newTreeSha = await client.createTree({
          tree: { tree: entries, base_tree: mainCommit.tree.sha },
          retry: true,
        });
        const newCommitSha = await client.createCommit({
          message: `test: ${FILE_COUNT} new files for TRUNCATION_GUARD_THRESHOLD canary`,
          treeSha: newTreeSha,
          parent: mainHead,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: newCommitSha,
          retry: true,
        });

        const cmp = await client.compare({
          base: mainHead,
          head: newCommitSha,
          retry: true,
        });
        console.log(
          `[canary-100] compare() files.length=${cmp.files.length} (created ${FILE_COUNT}, threshold=${TRUNCATION_GUARD_THRESHOLD})`,
        );
        expect(cmp.files.length).toBe(FILE_COUNT);
      } finally {
        await deleteBranchIfExists(branch);
      }
    }, 60_000);
  },
);
