// Shared fake-GitHub harness for drainOnce test suites (Phase 4 B/P/L/E
// + Phase 5 C/E conflict suites). A WORLD with real tree/commit/422
// semantics on the MAIN ref plus a branch map for the conflict
// branches; two independent eyes (truth vs discoveryAnswer) are the
// callers' business — the world only serves truth.

import { calculateGitBlobSHA } from "../../src/utils";
import { DrainClient } from "../../src/sync2/drain";
import { ValidationError } from "../../src/errors";

export const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
export const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);
export const sha = (s: string): Promise<string> =>
  calculateGitBlobSHA(enc(s));


export type RepoFiles = Map<string, { sha: string; bytes: ArrayBuffer }>;

export class FakeWorld {
  head: string | null = null;
  commitSeq = 0;
  private treeSeq = 0;
  readonly commitTrees = new Map<string, string>(); // commit → tree
  readonly trees = new Map<string, RepoFiles>(); // tree → files
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly commits: string[] = [];
  readonly branchHeads = new Map<string, string>(); // conflict branches
  readonly commitParents = new Map<string, string[]>();
  committedAt = 1_700_000_000_000;

  // Reachability over recorded parents (BFS) — powers compareStatus.
  isReachable(ancestor: string, from: string): boolean {
    const queue = [from];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const c = queue.pop()!;
      if (c === ancestor) return true;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const p of this.commitParents.get(c) ?? []) queue.push(p);
    }
    return false;
  }

  filesAt(ref: string): RepoFiles {
    const tree = this.commitTrees.get(ref);
    if (!tree) throw new Error(`fake world: unknown ref ${ref}`);
    return this.trees.get(tree)!;
  }

  headFiles(): RepoFiles {
    if (this.head === null) return new Map();
    return this.filesAt(this.head);
  }

  async commitFiles(
    changes: Record<string, string | null>,
  ): Promise<string> {
    const base: RepoFiles = this.head === null ? new Map() : this.headFiles();
    const next: RepoFiles = new Map(base);
    for (const [p, content] of Object.entries(changes)) {
      if (content === null) {
        next.delete(p);
        continue;
      }
      const s = await sha(content);
      next.set(p, { sha: s, bytes: enc(content) });
      this.blobs.set(s, enc(content));
    }
    const treeSha = `tree-${++this.treeSeq}`;
    this.trees.set(treeSha, next);
    const commitSha = `commit-${++this.commitSeq}`;
    this.commitTrees.set(commitSha, treeSha);
    this.commitParents.set(commitSha, this.head === null ? [] : [this.head]);
    this.commits.push(commitSha);
    this.head = commitSha;
    return commitSha;
  }

  makeClient(): DrainClient {
    const applyEntries = (
      baseTree: string | undefined,
      entries: Array<{
        path: string;
        sha?: string | null;
        content?: string;
      }>,
    ): string => {
      const base: RepoFiles = baseTree
        ? new Map(this.trees.get(baseTree)!)
        : new Map();
      for (const e of entries) {
        if (e.sha === null) {
          base.delete(e.path);
          continue;
        }
        if (typeof e.content === "string") {
          const bytes = enc(e.content);
          // GitHub assigns the sha server-side for inline entries.
          base.set(e.path, { sha: `pending-${e.path}`, bytes });
          continue;
        }
        const blob = this.blobs.get(e.sha!);
        if (!blob) {
          throw new ValidationError(
            `tree references unknown blob ${e.sha} (GC-ed?)`,
          );
        }
        base.set(e.path, { sha: e.sha!, bytes: blob });
      }
      const treeSha = `tree-${++this.treeSeq}`;
      this.trees.set(treeSha, base);
      return treeSha;
    };

    return {
      getGuardedHead: async () => this.head,
      getCommit: async ({ sha: commitSha }) => ({
        tree: { sha: this.commitTrees.get(commitSha)! },
      }),
      createTree: async ({ tree }) =>
        applyEntries(tree.base_tree, tree.tree as never),
      createBlob: async ({ content }) => {
        const bytes = Buffer.from(content, "base64");
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const s = await calculateGitBlobSHA(buf);
        this.blobs.set(s, buf);
        return { sha: s };
      },
      pushCommitFromTree: async ({ treeSha, parent }) => {
        if (parent !== this.head) {
          throw new ValidationError(
            `422: head moved (${this.head}), commit built on ${parent}`,
          );
        }
        // Resolve pending inline shas now (the server computed them).
        const files = this.trees.get(treeSha)!;
        for (const [p, f] of files) {
          if (f.sha.startsWith("pending-")) {
            f.sha = await calculateGitBlobSHA(f.bytes);
            this.blobs.set(f.sha, f.bytes);
          }
          void p;
        }
        const commitSha = `commit-${++this.commitSeq}`;
        this.commitTrees.set(commitSha, treeSha);
        this.commitParents.set(commitSha, parent === null ? [] : [parent]);
        this.commits.push(commitSha);
        this.head = commitSha;
        return { sha: commitSha, committedAt: (this.committedAt += 1000) };
      },
      getContentsMetadataAtRef: async (p, ref) => {
        const f = this.filesAt(ref).get(p);
        return f ? { sha: f.sha, size: f.bytes.byteLength } : null;
      },
      getBlobFromRepo: async (s) => this.blobs.get(s) ?? null,
      getBranchHeadSha: async (branch) => this.branchHeads.get(branch) ?? null,
      pushCommitToBranch: async ({ branch, parent, entries }) => {
        const cur = this.branchHeads.get(branch) ?? null;
        if (parent !== cur) {
          throw new ValidationError("422: conflict branch head moved");
        }
        const baseTree = cur === null ? undefined : this.commitTrees.get(cur);
        const treeSha = applyEntries(
          baseTree,
          entries.map((e) => ({ path: e.path, sha: e.sha })),
        );
        const commitSha = `cbranch-${++this.commitSeq}`;
        this.commitTrees.set(commitSha, treeSha);
        this.commitParents.set(commitSha, cur === null ? [] : [cur]);
        this.branchHeads.set(branch, commitSha);
        return { sha: commitSha };
      },
      getCommitInfoForPath: async () => ({
        deviceLabel: "other-device",
        committedAtMs: this.committedAt,
      }),
      createMergeCommit: async ({ treeSha, parents }) => {
        const commitSha = `merge-${++this.commitSeq}`;
        this.commitTrees.set(commitSha, treeSha);
        this.commitParents.set(commitSha, [...parents]);
        return { sha: commitSha };
      },
      updateMainRef: async (sha) => {
        // Non-force fast-forward semantics: the new commit must have
        // the CURRENT head among its ancestors.
        if (this.head !== null && !this.isReachable(this.head, sha)) {
          throw new ValidationError("422: not a fast forward");
        }
        this.commits.push(sha);
        this.head = sha;
      },
      compareStatus: async (base, head) => {
        if (base === head) return "identical";
        if (this.isReachable(base, head)) return "ahead";
        if (this.isReachable(head, base)) return "behind";
        return "diverged";
      },
      deleteBranch: async (branch) => {
        this.branchHeads.delete(branch); // 404-tolerant by construction
      },
    };
  }
}

export class FakeVaultFiles {
  readonly files = new Map<string, { content: string; mtime: number }>();
  reads = 0;
  writes: string[] = [];
  removed: string[] = [];

  async stat(p: string): Promise<{ size: number; mtime: number } | null> {
    const f = this.files.get(p);
    return f
      ? { size: new TextEncoder().encode(f.content).byteLength, mtime: f.mtime }
      : null;
  }

  async read(p: string) {
    const f = this.files.get(p);
    if (!f) return null;
    this.reads += 1;
    const bytes = enc(f.content);
    return {
      size: bytes.byteLength,
      mtime: f.mtime,
      sha: await calculateGitBlobSHA(bytes),
      blob: bytes,
    };
  }

  async write(p: string, bytes: ArrayBuffer): Promise<void> {
    this.writes.push(p);
    this.files.set(p, { content: dec(bytes), mtime: 999_999 });
  }

  async remove(p: string): Promise<void> {
    this.removed.push(p);
    this.files.delete(p);
  }
}

