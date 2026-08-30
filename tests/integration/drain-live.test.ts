import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as nodePath from "path";
import * as crypto from "crypto";
import { Vault as MockVault, base64ToArrayBuffer } from "../../mock-obsidian";
import Logger from "../../src/logger";
import GithubClient from "../../src/github/client";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import {
  drainOnce,
  DrainClient,
  DrainDeps,
  VaultFileReader,
} from "../../src/sync2/drain";
import { getChangedFilesFromGitHubRepo } from "../../src/sync2/discovery";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import { calculateGitBlobSHA } from "../../src/utils";
import {
  requireEnv,
  uniqueBranchName,
  getDefaultBranchHead,
  deleteBranchIfExists,
  integrationEnabled,
} from "./helpers";

// The Phase 4 live anchor: drainOnce() driven DIRECTLY (not through
// syncAll — the cutover is Phase 5.5) against real GitHub.
//
// T3.6 (same-line rolling base) — the Phase 0 finding that REFUTED
// П3/П4 (memory + SYNC2-FIX §10): with a static base every successive
// same-line edit self-conflicted against the device's own previous
// push. Rolling base (§II.3/II.4) is the cure, and this test is its
// first live proof: three batches editing THE SAME LINE chain into
// three clean commits, zero conflicts.
//
// P.13 — Layer 1 + Layer 2 on the REAL truncation trigger: a 301-file
// remote commit (compare() truncates at 300 → tree fallback) that also
// touches a path with a parallel local edit; after the drain the
// remote content must not be lost.

const PLUGIN_ID = "git-easy-sync";

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

class MemVaultFiles implements VaultFileReader {
  readonly files = new Map<string, { content: string; mtime: number }>();
  async stat(p: string) {
    const f = this.files.get(p);
    return f
      ? { size: new TextEncoder().encode(f.content).byteLength, mtime: f.mtime }
      : null;
  }
  async read(p: string) {
    const f = this.files.get(p);
    if (!f) return null;
    const bytes = enc(f.content);
    return {
      size: bytes.byteLength,
      mtime: f.mtime,
      sha: await calculateGitBlobSHA(bytes),
      blob: bytes,
    };
  }
  async write(p: string, bytes: ArrayBuffer) {
    this.files.set(p, { content: dec(bytes), mtime: 999_999 });
  }
  async remove(p: string) {
    this.files.delete(p);
  }
}

function adaptClient(client: GithubClient): DrainClient {
  return {
    // The monotonic guard is manager-level plumbing; a single-actor
    // test reads the head raw.
    getGuardedHead: () => client.getBranchHeadSha({ retry: true }),
    getCommit: (args) => client.getCommit(args),
    createTree: (args) => client.createTree(args),
    createBlob: (args) => client.createBlob(args),
    pushCommitFromTree: (args) =>
      client.pushCommitFromTree({ ...args, retry: true }),
    getContentsMetadataAtRef: (path, ref) =>
      client.getContentsMetadataViaHead({ path, ref, retry: true }),
    getBlobFromRepo: async (sha) => {
      try {
        const blob = await client.getBlob({ sha, retry: true });
        return base64ToArrayBuffer(blob.content.replace(/\n/g, ""));
      } catch {
        return null;
      }
    },
  };
}

describe.skipIf(!integrationEnabled())(
  "drainOnce vs real GitHub (T3.6 + P.13)",
  () => {
    it("T3.6: three batches editing the SAME LINE chain cleanly — rolling base, three commits, ZERO conflicts", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const branch = uniqueBranchName("t36-same-line");
      const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "t36-"));
      const vault = new MockVault(tmpRoot);
      const logger = new Logger({} as never, PLUGIN_ID, false);
      const client = new GithubClient(
        {
          ...DEFAULT_SETTINGS,
          githubToken: env.token,
          githubOwner: env.owner,
          githubRepo: env.repo,
          githubBranch: branch,
        },
        logger,
      );

      const filePath = `t36-${Date.now()}/note.md`;
      const V0 = "alpha\nbeta\ngamma\n";
      try {
        // Seed the branch: main head + our file at V0.
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });
        const seedTree = await client.createTree({
          tree: {
            tree: [
              { path: filePath, mode: "100644", type: "blob", content: V0 },
            ],
            base_tree: mainCommit.tree.sha,
          },
          retry: true,
        });
        const seedCommit = await client.createCommit({
          message: "test: T3.6 seed",
          treeSha: seedTree,
          parent: mainHead,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: seedCommit,
          retry: true,
        });

        const syncStore = new SyncStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        const journal = new DrainJournal({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        const baselines = new FileBaselinesStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        await baselines.set(filePath, {
          baselineSha: await calculateGitBlobSHA(enc(V0)),
          mtime: 50,
          size: enc(V0).byteLength,
        });
        const vaultFiles = new MemVaultFiles();

        // Three successive edits of LINE 2 — the exact shape that
        // self-conflicted under a static base.
        const versions = [
          "alpha\nbeta-1\ngamma\n",
          "alpha\nbeta-2\ngamma\n",
          "alpha\nbeta-3\ngamma\n",
        ];
        const batchQueue: Array<{ id: string; entries: BatchEntry[] }> = [];
        for (const [i, content] of versions.entries()) {
          const s = await calculateGitBlobSHA(enc(content));
          await syncStore.saveBlobToSyncStore(s, enc(content));
          batchQueue.push({
            id: `t36-${i}`,
            entries: [
              {
                path: filePath,
                sha: s,
                size: enc(content).byteLength,
                mtime: 100 + i,
              },
            ],
          });
        }
        vaultFiles.files.set(filePath, {
          content: versions[2],
          mtime: 102,
        });

        const drainClient = adaptClient(client);
        let cursor = 0;
        const deps: DrainDeps = {
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          client: drainClient,
          syncStore,
          journal,
          retry: new NetworkRetry({
            vault: vault as never,
            selfPluginId: PLUGIN_ID,
            sleep: async () => {},
          }),
          claimBatch: async () =>
            cursor < batchQueue.length
              ? {
                  id: batchQueue[cursor].id,
                  dir: `queue/${batchQueue[cursor].id}`,
                  meta: {
                    v: 1,
                    id: batchQueue[cursor].id,
                    createdAt: 0,
                    entries: batchQueue[cursor].entries,
                  },
                }
              : null,
          removeBatchDir: async () => {
            cursor += 1;
          },
          baselines: { get: async (p) => baselines.get(p) },
          discoverChangedFiles: (base, head) =>
            getChangedFilesFromGitHubRepo(
              {
                client: {
                  compare: (args) => client.compare({ ...args, retry: true }),
                  getRepoTree: (args) =>
                    client.getRepoTree({ ...args, retry: true }),
                },
                baselines,
                isSyncable: () => true,
              },
              base,
              head,
            ),
          hot: { getLastSyncCommitSha: () => seedCommit },
          tokenExpired: async () => false,
          vaultFiles,
          mergeBlobs: mergeBlobsWithMainThreadDiff3,
          computeSha: calculateGitBlobSHA,
          maxAutoMergeFileSize: () => 10_000_000,
          deviceLabel: () => "t36-device",
          commitMessage: () => "Sync at t36 (t36-device)",
          now: () => Date.now(),
        };

        const r = await drainOnce(deps);
        console.log(
          `[T3.6] status=${r.status} pushed=${r.pushedCommits.length} ` +
            `conflicts=${r.conflictVerdicts.length} layer2=${r.layer2Corrections.length}`,
        );
        expect(r.status).toBe("ok");
        expect(r.pushedCommits).toHaveLength(3); // one commit per batch, chained
        expect(r.conflictVerdicts).toEqual([]); // the T3.6 essence: NO self-conflict
        expect(r.layer2Corrections).toEqual([]);

        // The branch tip holds the LAST edit — nothing lost mid-chain.
        const live = await client.getContentsMetadataViaHead({
          path: filePath,
          ref: r.pushedCommits[2],
          retry: true,
        });
        expect(live!.sha).toBe(await calculateGitBlobSHA(enc(versions[2])));
      } finally {
        await deleteBranchIfExists(branch);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }, 240_000);

    it("P.13: a 301-file remote commit (real truncation → tree fallback) + a parallel local edit → remote content survives the drain", async () => {
      const env = requireEnv();
      const mainHead = await getDefaultBranchHead();
      if (!mainHead) throw new Error("default branch missing");

      const branch = uniqueBranchName("p13-trunc");
      const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "p13-"));
      const vault = new MockVault(tmpRoot);
      const logger = new Logger({} as never, PLUGIN_ID, false);
      const client = new GithubClient(
        {
          ...DEFAULT_SETTINGS,
          githubToken: env.token,
          githubOwner: env.owner,
          githubRepo: env.repo,
          githubBranch: branch,
        },
        logger,
      );

      const prefix = `p13-${Date.now()}`;
      const notePath = `${prefix}/note.md`;
      const V0 = "one\ntwo\nthree\n";
      try {
        // Seed branch at V0 (this is the drain's base).
        const mainCommit = await client.getCommit({ sha: mainHead, retry: true });
        const seedTree = await client.createTree({
          tree: {
            tree: [{ path: notePath, mode: "100644", type: "blob", content: V0 }],
            base_tree: mainCommit.tree.sha,
          },
          retry: true,
        });
        const seedCommit = await client.createCommit({
          message: "test: P.13 seed",
          treeSha: seedTree,
          parent: mainHead,
          retry: true,
        });
        await client.createReference({
          ref: `refs/heads/${branch}`,
          sha: seedCommit,
          retry: true,
        });

        // The "other device": 300 new files + an edit of note.md line 3
        // in ONE commit → compare(seed..this) returns exactly-300-cut
        // files[] → discovery MUST take the tree fallback.
        const entries = Array.from({ length: 300 }, (_, i) => ({
          path: `${prefix}/bulk/f-${i}.md`,
          mode: "100644",
          type: "blob",
          content: `bulk ${i} ${crypto.randomBytes(4).toString("hex")}`,
        }));
        entries.push({
          path: notePath,
          mode: "100644",
          type: "blob",
          content: "one\ntwo\nREMOTE\n",
        });
        const bigTree = await client.createTree({
          tree: { tree: entries, base_tree: seedTree },
          retry: true,
        });
        const bigCommit = await client.createCommit({
          message: "test: P.13 bulk 301",
          treeSha: bigTree,
          parent: seedCommit,
          retry: true,
        });
        await client.updateReference({
          ref: `heads/${branch}`,
          sha: bigCommit,
          retry: true,
        });

        const syncStore = new SyncStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        const journal = new DrainJournal({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        const baselines = new FileBaselinesStore({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        });
        await baselines.set(notePath, {
          baselineSha: await calculateGitBlobSHA(enc(V0)),
          mtime: 50,
          size: enc(V0).byteLength,
        });
        const vaultFiles = new MemVaultFiles();

        // The parallel local edit (line 1), committed as one batch.
        const localContent = "LOCAL\ntwo\nthree\n";
        const localSha = await calculateGitBlobSHA(enc(localContent));
        await syncStore.saveBlobToSyncStore(localSha, enc(localContent));
        vaultFiles.files.set(notePath, { content: localContent, mtime: 100 });

        let removed = false;
        const r = await drainOnce({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          client: adaptClient(client),
          syncStore,
          journal,
          retry: new NetworkRetry({
            vault: vault as never,
            selfPluginId: PLUGIN_ID,
            sleep: async () => {},
          }),
          claimBatch: async () =>
            removed
              ? null
              : {
                  id: "p13",
                  dir: "queue/p13",
                  meta: {
                    v: 1,
                    id: "p13",
                    createdAt: 0,
                    entries: [
                      {
                        path: notePath,
                        sha: localSha,
                        size: enc(localContent).byteLength,
                        mtime: 100,
                      },
                    ],
                  },
                },
          removeBatchDir: async () => {
            removed = true;
          },
          baselines: { get: async (p) => baselines.get(p) },
          discoverChangedFiles: (base, head) =>
            getChangedFilesFromGitHubRepo(
              {
                client: {
                  compare: (args) => client.compare({ ...args, retry: true }),
                  getRepoTree: (args) =>
                    client.getRepoTree({ ...args, retry: true }),
                },
                baselines,
                isSyncable: (p) => p.startsWith(prefix),
              },
              base,
              head,
            ),
          hot: { getLastSyncCommitSha: () => seedCommit },
          tokenExpired: async () => false,
          vaultFiles,
          mergeBlobs: mergeBlobsWithMainThreadDiff3,
          computeSha: calculateGitBlobSHA,
          maxAutoMergeFileSize: () => 10_000_000,
          deviceLabel: () => "p13-device",
          commitMessage: () => "Sync at p13 (p13-device)",
          now: () => Date.now(),
        });
        console.log(
          `[P.13] status=${r.status} pushed=${r.pushedCommits.length} ` +
            `conflicts=${r.conflictVerdicts.length} layer2=${r.layer2Corrections.length} ` +
            `vaultErr=${r.vaultStepErrors.length}`,
        );
        expect(r.status).toBe("ok");
        // Layer 1 was honest via the tree fallback → no Layer-2 firing.
        expect(r.layer2Corrections).toEqual([]);
        expect(r.conflictVerdicts).toEqual([]);
        expect(r.pushedCommits).toHaveLength(1);

        // The push must NOT have lost the remote edit hidden inside
        // the 301-file commit: the merged note.md carries BOTH edits.
        const merged = await client.getContentsAtRef({
          path: notePath,
          ref: r.pushedCommits[0],
          retry: true,
        });
        expect(
          dec(base64ToArrayBuffer(merged!.content.replace(/\n/g, ""))),
        ).toBe("LOCAL\ntwo\nREMOTE\n");
        // And the vault received the 300 bulk files + the merge.
        expect(vaultFiles.files.get(notePath)!.content).toBe(
          "LOCAL\ntwo\nREMOTE\n",
        );
        expect(
          [...vaultFiles.files.keys()].filter((p) =>
            p.startsWith(`${prefix}/bulk/`),
          ).length,
        ).toBe(300);
      } finally {
        await deleteBranchIfExists(branch);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
