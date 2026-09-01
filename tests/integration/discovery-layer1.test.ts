import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import Logger from "../../src/logger";
import GithubClient from "../../src/github/client";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import {
  getChangedFilesFromGitHubRepo,
  DiscoveryDeps,
} from "../../src/sync2/discovery";
import {
  requireEnv,
  uniqueBranchName,
  getDefaultBranchHead,
  deleteBranchIfExists,
  integrationEnabled,
} from "./helpers";

// §VIII O.10/O.11 (hybrid discovery Layer 1 against REAL GitHub) +
// P.19 (the ETag == sha EQUALITY canary for the Layer-2 HEAD
// transport). Phase 3 gate tests — MASTER-PLAN §Фаза 3.

const PLUGIN_ID = "git-easy-sync";

function makeClient(env: ReturnType<typeof requireEnv>): GithubClient {
  return new GithubClient(
    {
      ...DEFAULT_SETTINGS,
      githubToken: env.token,
      githubOwner: env.owner,
      githubRepo: env.repo,
      githubBranch: "main",
    },
    new Logger({} as never, PLUGIN_ID, false),
  );
}

function makeDeps(
  client: GithubClient,
  baselines: FileBaselinesStore,
): DiscoveryDeps {
  return {
    client,
    baselines,
    isSyncable: () => true,
    logger: { info: () => {}, warn: () => {} },
  };
}

describe.skipIf(!integrationEnabled())(
  "discovery Layer 1 vs real GitHub (§VIII O.10/O.11) + P.19 canary",
  () => {
    it("O.10: a 301-file commit → Layer 1 returns ALL 301 via the tree fallback, no path lost", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");
      const client = makeClient(env);

      const FILE_COUNT = 301;
      const branch = uniqueBranchName("o10-discovery-301");
      const prefix = `o10-discovery-${Date.now()}`;
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "o10-"));
      try {
        const mainCommit = await client.getCommit({
          sha: mainHead,
          retry: true,
        });
        const entries = Array.from({ length: FILE_COUNT }, (_, i) => ({
          path: `${prefix}/file-${i}.md`,
          mode: "100644",
          type: "blob",
          content: `o10 file ${i} — ${crypto.randomBytes(4).toString("hex")}`,
        }));
        const newTreeSha = await client.createTree({
          tree: { tree: entries, base_tree: mainCommit.tree.sha },
          retry: true,
        });
        const newCommitSha = await client.createCommit({
          message: `test: ${FILE_COUNT} files for O.10 discovery gate`,
          treeSha: newTreeSha,
          parent: mainHead,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: newCommitSha,
          retry: true,
        });

        const vault = new MockVault(tmpRoot);
        const baselines = new FileBaselinesStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        const result = (
          await getChangedFilesFromGitHubRepo(
          makeDeps(client, baselines),
          mainHead,
          newCommitSha,
          )
        ).changes;
        const got = new Set(result.map((c) => c.path));
        for (let i = 0; i < FILE_COUNT; i++) {
          expect(got.has(`${prefix}/file-${i}.md`)).toBe(true);
        }
        // Tree-fallback bonus pinned: sizes ride for free.
        const first = result.find((c) => c.path === `${prefix}/file-0.md`)!;
        expect(typeof first.size).toBe("number");
      } finally {
        await deleteBranchIfExists(branch);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }, 180_000);

    it("O.11: unreachable base → compare() 404 handled inside, result is a correct diff vs OUR baselines", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");
      const client = makeClient(env);

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "o11-"));
      try {
        // A base sha that exists nowhere — the same 404 a
        // GC-ed force-pushed-away commit produces.
        const unreachableBase = "d".repeat(40);

        // Seed ONE baseline to match the live head exactly: that
        // path must NOT be reported (it is unchanged vs our memory).
        const tree = await client.getRepoTree({ sha: mainHead, retry: true });
        expect(tree.truncated).toBe(false);
        expect(tree.files.length).toBeGreaterThan(0);
        const anchor = tree.files[0];

        const vault = new MockVault(tmpRoot);
        const baselines = new FileBaselinesStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        await baselines.set(anchor.path, {
          baselineSha: anchor.sha,
          mtime: 0,
          size: anchor.size ?? 0,
        });

        const result = (
          await getChangedFilesFromGitHubRepo(
          makeDeps(client, baselines),
          unreachableBase,
          mainHead,
          )
        ).changes;
        const got = new Set(result.map((c) => c.path));
        expect(got.has(anchor.path)).toBe(false); // matches baseline → silent
        // Every OTHER live file has no baseline → reported as added.
        for (const f of tree.files.slice(1)) {
          expect(got.has(f.path)).toBe(true);
        }
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }, 120_000);

    it("P.19 CANARY — EQUALITY, not shape: HEAD's ETag must literally equal the documented `sha` field", async () => {
      // If GitHub ever puts a RESPONSE hash into ETag it would still
      // be 40 hex — the runtime shape guard passes and only this
      // equality catches the semantic swap. Red here = disable the
      // HEAD path in favour of the GET fallback, don't "fix the test".
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");
      const client = makeClient(env);

      const tree = await client.getRepoTree({ sha: mainHead, retry: true });
      const target = tree.files[0];
      expect(target).toBeDefined();

      const viaHead = await client.getContentsMetadataAtRef({
        path: target.path,
        ref: mainHead,
        retry: true,
      });
      expect(viaHead).not.toBeNull();

      const resp = await fetch(
        `https://api.github.com/repos/${env.owner}/${env.repo}/contents/${encodeURIComponent(
          target.path,
        ).replace(/%2F/g, "/")}?ref=${mainHead}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${env.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as { sha: string; size: number };
      console.log(
        `[P.19 canary] path=${target.path} headSha=${viaHead!.sha} getSha=${json.sha} ` +
          `headSize=${viaHead!.size} getSize=${json.size}`,
      );
      expect(viaHead!.sha).toBe(json.sha);
      expect(viaHead!.size).toBe(json.size);
    }, 60_000);
  },
);
