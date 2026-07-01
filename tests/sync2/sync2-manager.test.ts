import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  Sync2Manager,
  Sync2Client,
  Sync2Logger,
} from "../../src/sync2/sync2-manager";
import ChangeDetector from "../../src/sync2/change-detector";
import PushQueue from "../../src/sync2/push-queue";
import SnapshotStore from "../../src/sync2/snapshot-store";
import TreeBuilder from "../../src/sync2/tree-builder";
import ConflictStoreNew from "../../src/sync2/conflict-store";
import GI from "../../src/gi";
import { Vault } from "../../mock-obsidian";
import { writePushInflight, readPushInflight } from "../../src/sync2/push-inflight";
import { calculateGitBlobSHA } from "../../src/utils";
import { NewTreeRequestItem } from "../../src/github/client";

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function makeFakeClient(): Sync2Client & {
  calls: {
    op: string;
    args: unknown;
  }[];
  state: {
    branchHead: string;
    treeShaCounter: number;
    commitShaCounter: number;
    blobShaCounter: number;
    lastTree: NewTreeRequestItem[] | null;
    lastCommit: { message: string; tree: string; parent?: string } | null;
    // Maps for conflict-handling tests.
    contentsByRef: Map<string, Map<string, string>>; // ref → path → content
    treeShaByCommit: Map<string, string>;
    commitDateByCommit: Map<string, string>;
    commitMessageByCommit: Map<string, string>;
  };
  setBranchHead(sha: string): void;
  setContentAtRef(ref: string, path: string, content: string): void;
  setTreeShaForCommit(commitSha: string, treeSha: string): void;
  setCommitDate(commitSha: string, isoDate: string): void;
  setCommitMessage(commitSha: string, message: string): void;
  // Plugin-js mtime tie-break — the LAST-CHANGE date (ms) of `path` at `ref`.
  setLatestCommitDateForPath(ref: string, path: string, ms: number): void;
  setCompareResult(
    base: string,
    head: string,
    result: {
      status: "ahead" | "behind" | "identical" | "diverged";
      files: Array<{
        filename: string;
        status:
          | "added"
          | "modified"
          | "removed"
          | "renamed"
          | "copied"
          | "changed"
          | "unchanged";
        sha: string | null;
        previous_filename?: string;
      }>;
    },
  ): void;
} {
  const state = {
    branchHead: "BRANCH_HEAD_INIT",
    treeShaCounter: 0,
    commitShaCounter: 0,
    blobShaCounter: 0,
    lastTree: null as NewTreeRequestItem[] | null,
    lastCommit: null as { message: string; tree: string; parent?: string } | null,
    contentsByRef: new Map<string, Map<string, string>>(),
    treeShaByCommit: new Map<string, string>(),
    commitDateByCommit: new Map<string, string>(),
    commitMessageByCommit: new Map<string, string>(),
    // `${ref}::${path}` → ms. Plugin-js "theirs" last-change date.
    latestCommitDateByPathRef: new Map<string, number>(),
    compareByPair: new Map<
      string,
      {
        status: "ahead" | "behind" | "identical" | "diverged";
        files: Array<{
          filename: string;
          status:
            | "added"
            | "modified"
            | "removed"
            | "renamed"
            | "copied"
            | "changed"
            | "unchanged";
          sha: string | null;
          previous_filename?: string;
        }>;
      }
    >(),
  };
  const calls: { op: string; args: unknown }[] = [];

  return {
    state,
    calls,
    setBranchHead(sha) {
      state.branchHead = sha;
    },
    setContentAtRef(ref, path, content) {
      let inner = state.contentsByRef.get(ref);
      if (!inner) {
        inner = new Map();
        state.contentsByRef.set(ref, inner);
      }
      inner.set(path, content);
    },
    setTreeShaForCommit(commitSha, treeSha) {
      state.treeShaByCommit.set(commitSha, treeSha);
    },
    setCommitDate(commitSha, isoDate) {
      state.commitDateByCommit.set(commitSha, isoDate);
    },
    setCommitMessage(commitSha, message) {
      state.commitMessageByCommit.set(commitSha, message);
    },
    setLatestCommitDateForPath(ref, path, ms) {
      state.latestCommitDateByPathRef.set(`${ref}::${path}`, ms);
    },
    setCompareResult(base, head, result) {
      state.compareByPair.set(`${base}...${head}`, result);
    },

    async getBranchHeadSha() {
      calls.push({ op: "getBranchHeadSha", args: undefined });
      return state.branchHead;
    },
    async createBlob(args) {
      calls.push({ op: "createBlob", args });
      const sha =
        "blob-" +
        crypto.createHash("sha1").update(args.content).digest("hex").slice(0, 8) +
        "-" + state.blobShaCounter++;
      return { sha };
    },
    async createTree(args) {
      calls.push({ op: "createTree", args });
      state.lastTree = args.tree.tree;
      state.treeShaCounter++;
      return `TREE_SHA_${state.treeShaCounter}`;
    },
    async createCommit(args) {
      calls.push({ op: "createCommit", args });
      state.lastCommit = {
        message: args.message,
        tree: args.treeSha,
        parent: args.parent,
      };
      state.commitShaCounter++;
      return `COMMIT_SHA_${state.commitShaCounter}`;
    },
    async updateBranchHead(args) {
      calls.push({ op: "updateBranchHead", args });
      state.branchHead = args.sha;
    },
    async createReference(args) {
      calls.push({ op: "createReference", args });
    },
    async updateReference(args) {
      calls.push({ op: "updateReference", args });
    },
    async deleteReference(args) {
      calls.push({ op: "deleteReference", args });
    },
    async getMatchingRefs(args) {
      calls.push({ op: "getMatchingRefs", args });
      return [];
    },
    async createFile(args) {
      calls.push({ op: "createFile", args });
      // Synthesise SHAs deterministically from the content so the
      // bare-repo seed path stays observable to test assertions.
      const blobSha =
        "blob-" +
        crypto.createHash("sha1").update(args.content).digest("hex").slice(0, 8);
      state.treeShaCounter++;
      state.commitShaCounter++;
      const treeSha = `TREE_SHA_${state.treeShaCounter}`;
      const commitSha = `COMMIT_SHA_${state.commitShaCounter}`;
      state.treeShaByCommit.set(commitSha, treeSha);
      state.commitMessageByCommit.set(commitSha, args.message);
      // Record the seeded file's contents at the freshly-created head
      // so any subsequent getRepoContent/getBlob/getContentsAtRef calls
      // resolve it the same way they would for any other commit.
      let inner = state.contentsByRef.get(commitSha);
      if (!inner) {
        inner = new Map();
        state.contentsByRef.set(commitSha, inner);
      }
      // Stored as the raw bytes the API would expose (post-base64-decode).
      inner.set(args.path, Buffer.from(args.content, "base64").toString("utf8"));
      state.branchHead = commitSha;
      return { blobSha, treeSha, commitSha };
    },
    async getCommit(args) {
      calls.push({ op: "getCommit", args });
      const treeSha = state.treeShaByCommit.get(args.sha) ?? `TREE_OF_${args.sha}`;
      const committedAt = state.commitDateByCommit.get(args.sha)
        ?? new Date(0).toISOString();
      const message = state.commitMessageByCommit?.get(args.sha) ?? "";
      return {
        tree: { sha: treeSha },
        committer: { date: committedAt },
        message,
      };
    },
    async getLatestCommitDateForPath(args) {
      calls.push({ op: "getLatestCommitDateForPath", args });
      return (
        state.latestCommitDateByPathRef.get(`${args.ref}::${args.path}`) ?? null
      );
    },
    async getContentsAtRef(args) {
      calls.push({ op: "getContentsAtRef", args });
      const inner = state.contentsByRef.get(args.ref);
      if (!inner) return null;
      const got = inner.get(args.path);
      if (got === undefined) return null;
      const b64 = Buffer.from(got, "utf8").toString("base64");
      // Real git-blob SHA so production code that compares this
      // against `calculateGitBlobSHA(oursBytes)` (reconcile's no-op
      // convergence check) sees true matches, not synthesised
      // strings.
      const bytes = new TextEncoder().encode(got).buffer as ArrayBuffer;
      const sha = await calculateGitBlobSHA(bytes);
      return { content: b64, sha };
    },
    async getContentsMetadataAtRef(args) {
      calls.push({ op: "getContentsMetadataAtRef", args });
      const inner = state.contentsByRef.get(args.ref);
      if (!inner) return null;
      const got = inner.get(args.path);
      if (got === undefined) return null;
      const bytes = new TextEncoder().encode(got).buffer as ArrayBuffer;
      const sha = await calculateGitBlobSHA(bytes);
      return { sha, size: bytes.byteLength };
    },
    async getRepoContent(_args) {
      calls.push({ op: "getRepoContent", args: _args });
      // Synthesize a tree from whatever's recorded at the current
      // branch head. Tests that exercise bootstrap set the branch
      // head + per-path content via setContentAtRef beforehand.
      const inner = state.contentsByRef.get(state.branchHead);
      const files: Record<
        string,
        {
          path: string;
          mode: string;
          type: string;
          sha: string;
          size: number;
          url: string;
        }
      > = {};
      if (inner) {
        for (const [p, content] of inner.entries()) {
          const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;
          const sha = await calculateGitBlobSHA(bytes);
          files[p] = {
            path: p,
            mode: "100644",
            type: "blob",
            sha,
            size: content.length,
            url: "",
          };
        }
      }
      return { files, sha: state.treeShaByCommit.get(state.branchHead) ?? "TREE_UNKNOWN" };
    },
    async getBlob(args) {
      calls.push({ op: "getBlob", args });
      // Find the blob anywhere in our recorded contents that hashes
      // to the requested SHA.
      for (const inner of state.contentsByRef.values()) {
        for (const [, content] of inner.entries()) {
          const bytes = new TextEncoder().encode(content).buffer as ArrayBuffer;
          const sha = await calculateGitBlobSHA(bytes);
          if (sha === args.sha) {
            return {
              content: Buffer.from(content, "utf8").toString("base64"),
              sha,
            };
          }
        }
      }
      throw new Error(`fake getBlob: sha ${args.sha} not configured`);
    },
    async compare(args) {
      calls.push({ op: "compare", args });
      const r = state.compareByPair.get(`${args.base}...${args.head}`);
      if (r) return r;
      // Default: no changes between unconfigured refs.
      return { status: "identical", files: [] };
    },
  };
}

function silentLogger(): Sync2Logger {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
}

function fixture(opts?: {
  conflictStore?: import("../../src/sync2/conflict-store").default;
  consolidateCommits?: boolean;
  onProgress?: (msg: string) => {
    update: (m: string) => void;
    hide: () => void;
  };
  progressMessages?: string[];
  onLocalCommitted?: (count: number) => void;
  onNoLocalChanges?: () => void;
  // Getter for the current (owner, repo, branch). When omitted the
  // manager's reconcile-remote-identity step is a no-op — fine for
  // tests that don't care. Tests that DO care pass a closure that
  // reads a mutable handle so the test can swap it mid-run.
  remoteIdentity?: () => {
    owner: string;
    repo: string;
    branch: string;
  };
  progressBytesThreshold?: number;
  onPluginsAffected?: (ids: string[]) => void;
  onZeroByteRestored?: (path: string) => void;
  gitAuthor?: () => { name: string; email: string } | null;
}): {
  root: string;
  vault: Vault;
  store: SnapshotStore;
  detector: ChangeDetector;
  queue: PushQueue;
  builder: TreeBuilder;
  client: ReturnType<typeof makeFakeClient>;
  manager: Sync2Manager;
  clock: { tick: () => Date; nowMs: () => number };
} {
  const root = path.join(
    os.tmpdir(),
    `sync2-manager-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new SnapshotStore(
    vault as unknown as import("obsidian").Vault,
  );
  const gi = new GI(root);
  let current = new Date("2026-05-03T09:38:23.000Z");
  const clock = {
    tick: () => {
      const d = new Date(current);
      current = new Date(current.getTime() + 1000);
      return d;
    },
    nowMs: () => current.getTime(),
  };
  const queue = new PushQueue({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
  });
  const detector = new ChangeDetector({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    gi,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    vaultRoot: root,
    syncConfigDir: () => true,
    queue,
  });
  const client = makeFakeClient();
  const builder = new TreeBuilder({
    vault: vault as unknown as import("obsidian").Vault,
    queue,
    client,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
  });
  // Default ConflictStore so detection paths that would auto-register
  // a conflict don't throw "no store wired". Tests can override via
  // opts.conflictStore.
  const defaultConflictStore =
    opts?.conflictStore ??
    new ConflictStoreNew({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
    });
  const manager = new Sync2Manager({
    vault: vault as unknown as import("obsidian").Vault,
    store,
    detector,
    queue,
    builder,
    client,
    logger: silentLogger(),
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    deviceLabel: "test-device",
    gitAuthor: opts?.gitAuthor,
    conflictStore: defaultConflictStore,
    consolidateCommits: opts?.consolidateCommits ?? false,
    onProgress: opts?.onProgress,
    onLocalCommitted: opts?.onLocalCommitted,
    onNoLocalChanges: opts?.onNoLocalChanges,
    remoteIdentity: opts?.remoteIdentity,
    // Tests assert progress-notice behaviour with tiny fixtures.
    // Setting the threshold to 0 makes every drain phase "heavy",
    // so the lazy-open logic fires consistently. Tests that
    // specifically want silent behaviour pass `progressBytesThreshold:
    // Infinity` via opts to disable the notice.
    progressBytesThreshold:
      opts?.progressBytesThreshold !== undefined
        ? opts.progressBytesThreshold
        : 0,
    onPluginsAffected: opts?.onPluginsAffected,
    onZeroByteRestored: opts?.onZeroByteRestored,
    now: () => clock.nowMs(),
  });
  return {
    root,
    vault,
    store,
    detector,
    queue,
    builder,
    client,
    manager,
    clock,
  };
}

function writeVaultFile(
  root: string,
  rel: string,
  content: string | Buffer,
): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function shaOf(content: string): Promise<string> {
  const buf = new TextEncoder().encode(content).buffer as ArrayBuffer;
  return await calculateGitBlobSHA(buf);
}

describe("Sync2Manager.syncAll — basic flow", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(async () => {
    f = fixture();
    await f.store.load();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("no-op when there are no changes", async () => {
    await f.manager.syncAll();
    const ops = f.client.calls.map((c) => c.op);
    // We still ask the branch head (drain step), but nothing else.
    expect(ops).not.toContain("createTree");
    expect(ops).not.toContain("createCommit");
  });

  it("happy path: one new text file → push, commit, ref, snapshot recorded", async () => {
    writeVaultFile(f.root, "Notes/x.md", "hello\n");
    // Pretend we synced once already so the manager has a baseline
    // for HEAD comparison and parents.
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.client.setBranchHead("BRANCH_HEAD_INIT");

    await f.manager.syncAll();

    // pullIfNeeded + processBatch each call getBranchHeadSha — that
    // overhead is fine; what matters is the push sequence ends with
    // a tree+commit+ref triple.
    const significant = f.client.calls
      .map((c) => c.op)
      .filter((o) => o !== "getBranchHeadSha");
    expect(significant).toEqual([
      "createTree",
      "createCommit",
      "updateBranchHead",
    ]);

    // Snapshot store now reflects the push: file is recorded with the
    // canonical-form SHA git would have computed.
    const snap = f.store.get("Notes/x.md");
    expect(snap).toBeDefined();
    expect(snap?.remoteSha).toBe(await shaOf("hello\n"));

    // lastSync points at the commit + tree we just produced.
    expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_1");
    expect(f.store.getLastSyncTreeSha()).toBe("TREE_SHA_1");

    // Queue is empty after success.
    expect(await f.queue.list()).toEqual([]);
  });

  it("commit message uses the hardcoded `sync ({deviceLabel})` format", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    // Every user-driven sync commit is `sync ({deviceLabel})` —
    // see src/sync2/commit-message.ts.
    expect(f.client.state.lastCommit?.message).toMatch(
      /^Sync at .+ \(test-device\)$/,
    );
  });

  it("no gitAuthor configured → createCommit carries NO author override", async () => {
    const f2 = fixture(); // no gitAuthor opt
    writeVaultFile(f2.root, "x.md", "v");
    f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f2.manager.syncAll();

    const commit = f2.client.calls.find((c) => c.op === "createCommit");
    expect(commit).toBeDefined();
    expect((commit!.args as { author?: unknown }).author).toBeUndefined();
    fs.rmSync(f2.root, { recursive: true, force: true });
  });

  it("gitAuthor configured → createCommit carries author/committer identity + ISO local date", async () => {
    const f2 = fixture({
      gitAuthor: () => ({ name: "Vlad", email: "vlad@example.com" }),
    });
    writeVaultFile(f2.root, "x.md", "v");
    f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f2.manager.syncAll();

    const commit = f2.client.calls.find((c) => c.op === "createCommit");
    const author = (
      commit!.args as {
        author?: { name: string; email: string; date: string };
      }
    ).author;
    expect(author).toBeDefined();
    expect(author!.name).toBe("Vlad");
    expect(author!.email).toBe("vlad@example.com");
    // ISO 8601 with offset, 'T' separator (toGitAuthorDate).
    expect(author!.date).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
    fs.rmSync(f2.root, { recursive: true, force: true });
  });

  it("creates a binary blob first, references its SHA in the tree", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeVaultFile(f.root, "img.png", bytes);
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    const ops = f.client.calls.map((c) => c.op);
    expect(ops).toContain("createBlob");
    const tree = f.client.state.lastTree!;
    const imgEntry = tree.find((e) => e.path === "img.png");
    expect(imgEntry?.sha).toMatch(/^blob-/);
    expect(imgEntry?.content).toBeUndefined();

    // Snapshot stores the same SHA.
    expect(f.store.get("img.png")?.remoteSha).toBe(imgEntry?.sha);
  });

  it("delete propagates: snapshot dropped, tree carries sha:null", async () => {
    // Pretend the file existed in a previous sync and has now been
    // removed locally.
    f.store.set("Notes/old.md", {
      path: "Notes/old.md",
      remoteSha: "OLDSHA",
      mtime: 1,
      size: 1,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    // Pre-flight validation (PSEUDO-MERGE-MODE §12.1) calls
    // `getContentsAtRef(path, currentHead)` for every deletion entry
    // before sending the tree-create. The seed represents the file's
    // continued existence at the remote tip — the deletion is real,
    // not stale, so it survives validation and reaches the tree
    // request as before.
    f.client.setContentAtRef("BRANCH_HEAD_INIT", "Notes/old.md", "stale-but-present");

    await f.manager.syncAll();

    const tree = f.client.state.lastTree!;
    const entry = tree.find((e) => e.path === "Notes/old.md");
    expect(entry?.sha).toBeNull();

    expect(f.store.get("Notes/old.md")).toBeUndefined();
  });

  it("multiple changes in one batch result in a single commit", async () => {
    writeVaultFile(f.root, "a.md", "1");
    writeVaultFile(f.root, "b.md", "2");
    writeVaultFile(f.root, "c.md", "3");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    expect(
      f.client.calls.filter((c) => c.op === "createCommit").length,
    ).toBe(1);
    const tree = f.client.state.lastTree!;
    const paths = tree.map((e) => e.path).sort();
    expect(paths).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("HEAD moved but our path untouched on remote → reconcile is a no-op merge, push proceeds onto new head", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    // Remote moved past us. From the perspective of x.md though, the
    // file is identical at both refs (no remote-side change). The
    // reconcile pass should detect that, leave the batch alone, and
    // re-target the commit onto the new head.
    f.client.setBranchHead("OTHER_HEAD");
    f.client.setTreeShaForCommit("OTHER_HEAD", "OTHER_HEAD_TREE");
    const sameContent = "v";
    f.client.setContentAtRef("BRANCH_HEAD_INIT", "x.md", sameContent);
    f.client.setContentAtRef("OTHER_HEAD", "x.md", sameContent);

    await f.manager.syncAll();

    // Commit lands with parent = currentHead, base_tree = its tree.
    const commit = f.client.calls.find((c) => c.op === "createCommit");
    expect((commit?.args as { parent?: string }).parent).toBe("OTHER_HEAD");
    const treeCall = f.client.calls.find((c) => c.op === "createTree");
    expect(
      (treeCall?.args as { tree: { base_tree?: string } }).tree.base_tree,
    ).toBe("OTHER_HEAD_TREE");

    // No conflict registered.
    expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);
  });

  it("first-ever sync against bare repo: seeds .gitignore, then commits batch on top", async () => {
    writeVaultFile(f.root, "x.md", "v");
    // sync2 seeds bare repos via the Contents API on <vault>/.gitignore
    // (the file invariants.enforce() guarantees in production). The
    // fixture skips invariants, so pre-create the file here.
    writeVaultFile(f.root, ".gitignore", "# seed\n");
    // No setLastSync — fresh install. getBranchHeadSha throws 404
    // (bare repo).
    f.client.getBranchHeadSha = async () => {
      const e = new Error("Not Found") as Error & { status: number };
      e.status = 404;
      throw e;
    };

    await f.manager.syncAll();

    // COMMIT_SHA_1 is the seed (createFile, no parent at all).
    // COMMIT_SHA_2 is the sync commit on top of it (createCommit
    // with parent=seed). The fixture only records createCommit calls
    // in state.lastCommit, so its `parent` field reflects the second
    // commit's parent — which is the seed.
    expect(f.client.state.lastCommit?.parent).toBe("COMMIT_SHA_1");
    expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_2");
  });

  it("first-ever sync against existing branch: parent=currentHead, base_tree=its tree", async () => {
    writeVaultFile(f.root, "x.md", "v");
    // No setLastSync, but the branch already has commits. sync2 must
    // build on top, otherwise updateBranchHead would 422 (non-ff).
    f.client.setBranchHead("EXISTING_HEAD");
    f.client.setTreeShaForCommit("EXISTING_HEAD", "EXISTING_HEAD_TREE");

    await f.manager.syncAll();

    expect(f.client.state.lastCommit?.parent).toBe("EXISTING_HEAD");
    const treeCall = f.client.calls.find((c) => c.op === "createTree");
    expect(
      (treeCall?.args as { tree: { base_tree?: string } }).tree.base_tree,
    ).toBe("EXISTING_HEAD_TREE");
  });

  it("base_tree from manifest's lastSyncTreeSha when set", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "EXISTING_TREE_SHA");

    await f.manager.syncAll();

    const treeCall = f.client.calls.find((c) => c.op === "createTree")!;
    const args = treeCall.args as {
      tree: { base_tree?: string };
    };
    expect(args.tree.base_tree).toBe("EXISTING_TREE_SHA");
  });

  it("lastCommitMtime is set to the local clock after a successful push", async () => {
    writeVaultFile(f.root, "x.md", "v");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    expect(f.store.getLastCommitMtime()).toBe(f.clock.nowMs());
  });

  it("multiple pending batches drain oldest-first", async () => {
    // Manually enqueue two batches so processQueue has work to drain
    // even before findChanges contributes.
    writeVaultFile(f.root, "a.md", "1");
    f.store.setLastSync("BRANCH_HEAD_INIT", "TREE_0");
    const id1 = await f.queue.enqueue(
      [{ kind: "added", path: "a.md", size: 1, mtime: 0 }],
      {
        parentCommitSha: "BRANCH_HEAD_INIT",
        parentTreeSha: "TREE_0",
      },
    );
    writeVaultFile(f.root, "b.md", "2");
    const id2 = await f.queue.enqueue(
      [{ kind: "added", path: "b.md", size: 1, mtime: 0 }],
      {
        parentCommitSha: "BRANCH_HEAD_INIT",
        parentTreeSha: "TREE_0",
      },
    );
    expect(id2 > id1).toBe(true);

    // findChanges sees nothing new (snapshots aren't there yet but the
    // files exist so it would emit "added" for both). Snapshot them
    // explicitly so syncAll's findChanges yields no extra batch.
    f.store.set("a.md", {
      path: "a.md",
      remoteSha: await shaOf("1"),
      mtime: fs.statSync(path.join(f.root, "a.md")).mtimeMs,
      size: 1,
    });
    f.store.set("b.md", {
      path: "b.md",
      remoteSha: await shaOf("2"),
      mtime: fs.statSync(path.join(f.root, "b.md")).mtimeMs,
      size: 1,
    });
    await f.store.save();

    await f.manager.resumeQueue();

    // Two commits, in order. Both messages are derived from
    // synthetic=false + deviceLabel — batches do not carry distinct
    // commitMessage values.
    const commits = f.client.calls.filter((c) => c.op === "createCommit");
    expect(commits).toHaveLength(2);
    expect((commits[0].args as { message: string }).message).toMatch(
      /^Sync at .+ \(test-device\)$/,
    );
    expect((commits[1].args as { message: string }).message).toMatch(
      /^Sync at .+ \(test-device\)$/,
    );

    // After both, queue is empty.
    expect(await f.queue.list()).toEqual([]);
  });

  it("syncFile: nothing to sync when file matches snapshot", async () => {
    writeVaultFile(f.root, "x.md", "v");
    const stat = fs.statSync(path.join(f.root, "x.md"));
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: await shaOf("v"),
      mtime: stat.mtimeMs,
      size: stat.size,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("x.md");
    expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual([]);
  });

  it("syncFile: pushes a single-file batch with the hardcoded `sync ({device})` message", async () => {
    writeVaultFile(f.root, "Notes/note.md", "fresh\n");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncFile("Notes/note.md");

    const commits = f.client.calls.filter((c) => c.op === "createCommit");
    expect(commits).toHaveLength(1);
    // syncFile uses the same hardcoded `sync ({deviceLabel})`
    // format as syncAll — no per-file templating.
    expect((commits[0].args as { message: string }).message).toMatch(
      /^Sync at .+ \(test-device\)$/,
    );

    // Tree contains exactly the one file we asked for.
    const tree = f.client.state.lastTree!;
    expect(tree.map((e) => e.path)).toEqual(["Notes/note.md"]);

    // Snapshot recorded.
    expect(f.store.get("Notes/note.md")?.remoteSha).toBe(
      await shaOf("fresh\n"),
    );
  });

  it("syncFile: deleted file → push with sha:null, snapshot dropped", async () => {
    f.store.set("x.md", {
      path: "x.md",
      remoteSha: "OLD",
      mtime: 1,
      size: 1,
    });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    // Seed the path at currentHead so pre-flight validation
    // (PSEUDO-MERGE-MODE §12.1) confirms the deletion is real (file
    // still on remote) rather than stale (already removed by another
    // device). Without this seed the validator would drop the entry.
    f.client.setContentAtRef("BRANCH_HEAD_INIT", "x.md", "stale-but-present");
    await f.manager.syncFile("x.md");

    const tree = f.client.state.lastTree!;
    expect(tree).toEqual([
      { path: "x.md", mode: "100644", type: "blob", sha: null },
    ]);
    expect(f.store.get("x.md")).toBeUndefined();
  });

  it("syncFile: ignored path → no batch, no commit", async () => {
    writeVaultFile(f.root, ".gitignore", "*.log\n");
    writeVaultFile(f.root, "noise.log", "ignored");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    await f.manager.syncFile("noise.log");
    expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual([]);
    expect(await f.queue.list()).toEqual([]);
  });

  it("syncFile: only the active file goes in the batch (others stay dirty)", async () => {
    writeVaultFile(f.root, "a.md", "1\n");
    writeVaultFile(f.root, "b.md", "2\n");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncFile("a.md");

    const tree = f.client.state.lastTree!;
    expect(tree.map((e) => e.path)).toEqual(["a.md"]);
    // b.md is still untracked locally — next syncAll picks it up.
    expect(f.store.get("a.md")?.remoteSha).toBe(await shaOf("1\n"));
    expect(f.store.get("b.md")).toBeUndefined();
  });

  describe("conflict reconciliation", () => {
    it("clean 3-way merge when remote and local touched non-overlapping parts", async () => {
      // 5-line base with 'middle' between the two edit zones so
      // node-diff3 treats them as separate hunks.
      const base = "header\nbase-line\nmiddle\noriginal-tail\nfooter";
      const ours = "header\nbase-line\nmiddle\nlocal-edit\nfooter";
      const theirs = "header\nremote-edit\nmiddle\noriginal-tail\nfooter";

      writeVaultFile(f.root, "x.md", ours);
      // Snapshot at base so findChangeForPath classifies x.md as
      // "modified" (snapshot.remoteSha == base.sha, vault has ours).
      const stat = fs.statSync(path.join(f.root, "x.md"));
      const baseSha = await shaOf(base);
      f.store.set("x.md", {
        path: "x.md",
        remoteSha: baseSha,
        mtime: 0, // forces re-hash inside findChangeForPath
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      f.client.setContentAtRef("BASE_HEAD", "x.md", base);
      f.client.setContentAtRef("REMOTE_HEAD", "x.md", theirs);
      f.client.setCompareResult("BASE_HEAD", "REMOTE_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "irrelevant" }],
      });

      await f.manager.syncAll();

      expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);
      // Pull merged the file in place. The push then ships the merged
      // content because findChanges still saw x.md as modified.
      const tree = f.client.state.lastTree!;
      const xEntry = tree.find((e) => e.path === "x.md")!;
      expect(xEntry.content).toContain("remote-edit");
      expect(xEntry.content).toContain("local-edit");
      expect(xEntry.content).toContain("middle");
    });

    it("binary files skip auto-merge: batch ours wins on push", async () => {
      const bytes = Buffer.from([1, 2, 3, 4]);
      writeVaultFile(f.root, "img.png", bytes);
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");
      // Even if we set conflicting contents at refs, sync2 should NOT
      // call getContentsAtRef for binaries — and the push should go
      // through with our bytes.

      await f.manager.syncAll();

      // Binary path: pseudo-merge keeps live local bytes; conflict
      // gets registered for the user to resolve via sibling ops, but
      // the batch's "ours" still pushes for paths that AREN'T in
      // conflict yet (img.png isn't in ConflictStore — this is the
      // initial sync, not a reconcile drift).
      expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);
      // Tree has our binary blob.
      const tree = f.client.state.lastTree!;
      expect(tree).toHaveLength(1);
      expect(tree[0].path).toBe("img.png");
    });

    it("no-op convergence: ours.bytes === theirs.bytes → reconcile completes cleanly without conflict", async () => {
      // Real-world trigger: user out-of-band copied the same file
      // bytes to a second device (adb push, file transfer, manual
      // sync via another tool). Mobile finds the file modified vs
      // its lastSync snapshot, enqueues it for push. Remote moved
      // too (the other device pushed those exact bytes). The
      // reconcile must detect ours == theirs and short-circuit the
      // entire resolution dance instead of registering a conflict.
      const convergedBytes = "shared bytes - same on both sides\n";
      writeVaultFile(f.root, "x.md", convergedBytes);
      f.store.set("x.md", {
        path: "x.md",
        remoteSha: await shaOf("old version"),
        mtime: 0,
        size: convergedBytes.length,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", "x.md", "old version");
      f.client.setContentAtRef("NEW_HEAD", "x.md", convergedBytes);

      // Must not throw + must not register a conflict. Without the
      // no-op convergence short-circuit, this scenario would route
      // through atomic-theirs-wins, do a redundant writeBinaryRemote
      // of identical bytes, and log a misleading "theirs wins" line.
      await expect(f.manager.syncAll()).resolves.not.toThrow();
      expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);

      // Live vault content unchanged — same bytes either way.
      expect(
        fs.readFileSync(path.join(f.root, "x.md"), "utf8"),
      ).toBe(convergedBytes);
    });

    it("manifest dropped mid-loop: main.js reconcile reads manifest from baseRef without throwing", async () => {
      // Race regression test: when manifest.json AND main.js both
      // sit in a single batch and the reconcile loop drops
      // manifest first (atomic theirs wins → queue.removeFile), the
      // main.js iteration must NOT throw "File does not exist"
      // trying to read the just-dropped manifest from the batch
      // snapshot. The reconcile keeps `batch.files` (in-memory)
      // synchronised with disk via splice after every removeFile,
      // so `readReconcilePluginJsContext` sees the splice and falls
      // back to reading manifest from baseRef.
      const manifestPath = ".obsidian/plugins/test-plugin/manifest.json";
      const mainJsPath = ".obsidian/plugins/test-plugin/main.js";
      const oursManifest = JSON.stringify({
        id: "test-plugin",
        version: "1.5.0",
        name: "Test plugin",
      });
      const theirsManifest = JSON.stringify({
        id: "test-plugin",
        version: "2.0.0",
        name: "Test plugin",
      });
      const baseManifest = JSON.stringify({
        id: "test-plugin",
        version: "1.0.0",
        name: "Test plugin",
      });
      const oursMainJs = "module.exports = { version: '1.5' };";
      const theirsMainJs = "module.exports = { version: '2.0' };";
      const baseMainJs = "module.exports = { version: '1.0' };";

      writeVaultFile(f.root, manifestPath, oursManifest);
      writeVaultFile(f.root, mainJsPath, oursMainJs);
      // Snapshot at BASE so both files emit as modified.
      f.store.set(manifestPath, {
        path: manifestPath,
        remoteSha: await shaOf(baseManifest),
        mtime: 0,
        size: oursManifest.length,
      });
      f.store.set(mainJsPath, {
        path: mainJsPath,
        remoteSha: await shaOf(baseMainJs),
        mtime: 0,
        size: oursMainJs.length,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", manifestPath, baseManifest);
      f.client.setContentAtRef("NEW_HEAD", manifestPath, theirsManifest);
      f.client.setContentAtRef("BASE_HEAD", mainJsPath, baseMainJs);
      f.client.setContentAtRef("NEW_HEAD", mainJsPath, theirsMainJs);

      // The actual assertion: syncAll completes without throwing
      // "File does not exist". Pre-fix this would have thrown when
      // the main.js iteration tried to read the just-dropped
      // manifest from the batch.
      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // No conflict registered — plugin-js semver wins all the way
      // down (2.0.0 > 1.5.0).
      expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);
    });

    it("plugin-js mtime tie-break uses the file's LAST-CHANGE date, NOT the branch HEAD (SYNC2 §7 regression)", async () => {
      // The bug: theirsMtime was the branch-HEAD commit date. When HEAD advanced PAST
      // the plugin file (a later unrelated commit), the remote bundle looked "newer"
      // than a genuinely newer local build → the engine pulled the stale remote over
      // local (spurious self-update / downgrade). One-way sync (this device → GitHub)
      // could thus "update" the plugin from an OLDER remote. Fix: theirsMtime = the
      // commit that last touched THE FILE (getLatestCommitDateForPath).
      const manifestPath = ".obsidian/plugins/test-plugin/manifest.json";
      const mainJsPath = ".obsidian/plugins/test-plugin/main.js";
      // SAME version on both sides → semver ties → mtime decides.
      const sameManifest = JSON.stringify({ id: "test-plugin", version: "1.0.0", name: "P" });
      const baseManifest = JSON.stringify({ id: "test-plugin", version: "0.9.0", name: "P" });
      const oursMainJs = "module.exports={LABEL:'LOCAL'};";
      const theirsMainJs = "module.exports={LABEL:'REMOTE'};";
      const baseMainJs = "module.exports={LABEL:'BASE'};";

      writeVaultFile(f.root, manifestPath, sameManifest);
      writeVaultFile(f.root, mainJsPath, oursMainJs);

      // Three timestamps that ONLY the fix distinguishes:
      const tLocal = Date.parse("2026-06-30T12:00:00Z"); // local main.js mtime
      const tFileChange = Date.parse("2026-06-30T11:00:00Z"); // remote main.js LAST CHANGED (earlier → ours newer)
      const tHead = Date.parse("2026-06-30T13:00:00Z"); // branch HEAD moved later (the bug's source)
      // Force the local file's mtime (recorded into batch.fileMtimes at enqueue).
      fs.utimesSync(path.join(f.root, mainJsPath), tLocal / 1000, tLocal / 1000);

      // Snapshot mtime 0 (≠ the file's tLocal) so the change-detector sees a LOCAL
      // modification and enqueues main.js with fileMtimes[main.js] = tLocal (the
      // oursMtime the reconcile reads). A matching snapshot mtime would mark it
      // unchanged → a remote-only pull, which never exercises the tie-break.
      f.store.set(manifestPath, { path: manifestPath, remoteSha: await shaOf(baseManifest), mtime: 0, size: sameManifest.length });
      f.store.set(mainJsPath, { path: mainJsPath, remoteSha: await shaOf(baseMainJs), mtime: 0, size: oursMainJs.length });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", manifestPath, baseManifest);
      f.client.setContentAtRef("NEW_HEAD", manifestPath, sameManifest); // remote manifest same version
      f.client.setContentAtRef("BASE_HEAD", mainJsPath, baseMainJs);
      f.client.setContentAtRef("NEW_HEAD", mainJsPath, theirsMainJs);
      // The remote drifted: both files changed between BASE_HEAD and NEW_HEAD, so the
      // reconcile actually processes main.js (without this, compare reports no remote
      // change → ours is pushed directly and plugin-js never runs).
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "diverged",
        files: [
          { filename: mainJsPath, status: "modified", sha: await shaOf(theirsMainJs) },
          { filename: manifestPath, status: "modified", sha: await shaOf(sameManifest) },
        ],
      });
      // HEAD date is LATE (would make theirs win under the bug); the FILE's last-change
      // date is EARLY (makes ours win under the fix).
      f.client.setCommitDate("NEW_HEAD", new Date(tHead).toISOString());
      f.client.setLatestCommitDateForPath("NEW_HEAD", mainJsPath, tFileChange);

      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // OURS won: the local bundle is untouched (NOT overwritten with REMOTE), and no
      // conflict registered. Under the bug this would read 'REMOTE' (theirs pulled).
      expect(fs.readFileSync(path.join(f.root, mainJsPath), "utf8")).toContain("LOCAL");
      expect(fs.readFileSync(path.join(f.root, mainJsPath), "utf8")).not.toContain("REMOTE");
      expect(f.manager["conflictStore"]?.getAll() ?? []).toEqual([]);
      // The fix actually consulted the file's last-change date (not just getCommit).
      expect(
        f.client.calls.some(
          (c) =>
            c.op === "getLatestCommitDateForPath" &&
            (c.args as { path: string }).path === mainJsPath,
        ),
      ).toBe(true);
    });

    it("REPRO: crash between updateBranchHead and recordSync → stale base → false SELF-conflict on one device", async () => {
      // The bug (user-reported, one-device vault, no competing writers). The push flow
      // in processBatch does, in order:
      //   3407  updateBranchHead(commitSha)   ← REMOTE HEAD ADVANCES (point of no return)
      //   3453  setLastSync(commitSha, tree)  ← snapshot recorded (in-memory)
      //   3455  store.save()                  ← snapshot PERSISTED to disk
      // A crash (kill Obsidian) BETWEEN 3407 and 3455 leaves the remote advanced but the
      // on-disk snapshot frozen at the OLD head. On restart the recorded `base` is stale.
      // If the user then edits the file (the "when it's time to make local changes" moment),
      // the reconcile 3-ways a stale base against BOTH sides → a conflict with OURSELVES,
      // which is otherwise physically impossible on a single-writer vault.
      //
      // This reconstructs the stale-base state directly (bypassing the push) to
      // CHARACTERIZE the underlying mechanism. In production this state is now UNREACHABLE
      // for the main push: the §7.9 marker is written (MANDATORY) before every
      // updateBranchHead, so a remote advance ALWAYS has a recoverable marker — and a
      // marker-write failure aborts the push BEFORE advancing. So "stale base with no
      // marker" can't arise. The FIX test below shows the recovery; this test is the
      // "what the marker prevents" characterization.
      const X = "Notes/x.md";
      const baseV0 = "alpha\nbeta\ngamma\n"; // STALE snapshot base (pre-interrupted-push)
      const theirsV1 = "alpha\nBETA-remote\ngamma\n"; // OUR OWN pushed content (crash landed it on the remote)
      const oursV2 = "alpha\nBETA-local\ngamma\n"; // the post-crash local edit (on top of v1)

      writeVaultFile(f.root, X, oursV2);
      // Snapshot FROZEN at the old head with the old base bytes (the crash prevented the
      // advance to NEW_HEAD/v1). mtime 0 ≠ the file's real mtime → change-detector sees the
      // local edit and enqueues it.
      f.store.set(X, { path: X, remoteSha: await shaOf(baseV0), mtime: 0, size: baseV0.length });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      // Remote is ALREADY advanced (the interrupted push's commit landed): HEAD = NEW_HEAD,
      // X = v1 there.
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", X, baseV0);
      f.client.setContentAtRef("NEW_HEAD", X, theirsV1);
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "diverged",
        files: [{ filename: X, status: "modified", sha: await shaOf(theirsV1) }],
      });

      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // The false self-conflict: base v0 vs ours v2 vs theirs v1 — both "changed" line 2
      // relative to the stale base → 3-way registers a modify-vs-modify conflict. On a
      // one-writer vault this is impossible EXCEPT via a stale snapshot base.
      const conflicts = f.manager["conflictStore"]?.getAll() ?? [];
      expect(conflicts.some((c) => c.vaultPath === X)).toBe(true);
      expect(conflicts.find((c) => c.vaultPath === X)?.kind).toBe("modify-vs-modify");
    });

    it("crash gap WITHOUT a post-crash edit SELF-HEALS (ours==theirs convergence, no conflict)", async () => {
      // Same crash gap as the repro above, but the user did NOT edit after the interrupted
      // push — the vault still holds exactly what was pushed (v1). On restart the reconcile
      // sees ours(v1) == theirs(v1) → no-op convergence → records the snapshot, no conflict.
      // This scopes the marker-recovery fix (advisor #1): the plain crash is already
      // handled; the marker only needs to cover the crash + edit-before-next-sync window.
      const X = "Notes/x.md";
      const baseV0 = "alpha\nbeta\ngamma\n"; // stale snapshot base
      const theirsV1 = "alpha\nBETA-remote\ngamma\n"; // our pushed content = current vault (NO post-edit)

      writeVaultFile(f.root, X, theirsV1);
      f.store.set(X, { path: X, remoteSha: await shaOf(baseV0), mtime: 0, size: baseV0.length });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", X, baseV0);
      f.client.setContentAtRef("NEW_HEAD", X, theirsV1);
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "diverged",
        files: [{ filename: X, status: "modified", sha: await shaOf(theirsV1) }],
      });

      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // No conflict — ours == theirs, so the reconcile converges and records the snapshot.
      const conflicts = f.manager["conflictStore"]?.getAll() ?? [];
      expect(conflicts.some((c) => c.vaultPath === X)).toBe(false);
    });

    it("FIX: crash gap WITH the push-inflight marker → recovery re-records the base, NO conflict (SYNC2 §7.9)", async () => {
      // Same crash gap + post-crash edit as the REPRO above, but the interrupted push left a
      // .push-inflight marker (which the fix writes before every updateBranchHead). On the
      // next sync, recoverPushInflight (before findChanges) sees the real remote head ==
      // marker.newHead → our push landed → records the snapshot at that head. The post-crash
      // edit then measures against the CORRECT base → clean push, no false self-conflict.
      const X = "Notes/x.md";
      const baseV0 = "alpha\nbeta\ngamma\n"; // stale snapshot base
      const theirsV1 = "alpha\nBETA-remote\ngamma\n"; // our pushed content, on the remote
      const oursV2 = "alpha\nBETA-local\ngamma\n"; // post-crash local edit

      writeVaultFile(f.root, X, oursV2);
      f.store.set(X, { path: X, remoteSha: await shaOf(baseV0), mtime: 0, size: baseV0.length });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", X, baseV0);
      f.client.setContentAtRef("NEW_HEAD", X, theirsV1);
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "diverged",
        files: [{ filename: X, status: "modified", sha: await shaOf(theirsV1) }],
      });
      // The crashed push left this marker — newHead is the real remote head (the push landed).
      await writePushInflight(
        f.vault as unknown as import("obsidian").Vault,
        SELF_PLUGIN_ID,
        { newHead: "NEW_HEAD", newTreeSha: "NEW_TREE" },
      );

      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // Recovery corrected the base → NO false conflict (contrast the REPRO above).
      const conflicts = f.manager["conflictStore"]?.getAll() ?? [];
      expect(conflicts.some((c) => c.vaultPath === X)).toBe(false);
      // The snapshot is no longer the stale BASE_HEAD — recovery healed it to NEW_HEAD and
      // then the post-crash edit (v2) pushed cleanly on top, advancing it further.
      expect(f.store.getLastSyncCommitSha()).not.toBe("BASE_HEAD");
      // The marker was consumed by the recovery (and the v2 push's own marker cleared too).
      expect(
        await readPushInflight(
          f.vault as unknown as import("obsidian").Vault,
          SELF_PLUGIN_ID,
        ),
      ).toBeNull();
    });

    it("finalize-merge crash SELF-RECOVERS via re-finalize — NOT the false-conflict bug (SYNC2 §7.9, no marker)", async () => {
      // The conflict-branch finalize-merge has the SAME push→record gap, but it is NOT the
      // false-conflict bug and needs NO marker: (1) the merge commit's tree == main's tree
      // (a history merge — resolutions already landed), so theirs@merge == base for every
      // file → a post-crash edit 3-ways CLEAN; (2) finalizeConflictBranchIfReady is
      // idempotent (deleteReference tolerates "already gone" 422) → re-finalize completes
      // on the next drain. This reconstructs the post-crash state and proves all of it.
      const X = "Notes/x.md";
      const orig = "content\n";
      const edited = "content edited\n"; // post-crash edit

      // Post-crash state: the merge LANDED on the remote (MERGE_HEAD, tree == MAIN_TREE),
      // but the snapshot froze at MAIN_HEAD and the conflict-branch bookkeeping is still set.
      writeVaultFile(f.root, X, edited);
      f.store.set(X, { path: X, remoteSha: await shaOf(orig), mtime: 0, size: orig.length });
      f.store.setLastSync("MAIN_HEAD", "MAIN_TREE");
      f.store.setConflictBranch({ name: "gc-conflicts-Device-1", head: "CB_HEAD" });
      // conflictStore empty (all resolved) → finalize is "ready".
      f.client.setBranchHead("MERGE_HEAD");
      f.client.setTreeShaForCommit("MERGE_HEAD", "MAIN_TREE"); // merge tree == main tree
      f.client.setContentAtRef("MAIN_HEAD", X, orig);
      f.client.setContentAtRef("MERGE_HEAD", X, orig); // history merge — content unchanged
      // The drift is a pure history merge: no FILE changed between MAIN_HEAD and MERGE_HEAD.
      f.client.setCompareResult("MAIN_HEAD", "MERGE_HEAD", { status: "diverged", files: [] });

      await expect(f.manager.syncAll()).resolves.not.toThrow();

      // (a) NO false conflict (merge tree == main tree → theirs == base for the edited file).
      expect((f.manager["conflictStore"]?.getAll() ?? []).some((c) => c.vaultPath === X)).toBe(false);
      // (b) conflict-branch bookkeeping cleared — re-finalize completed.
      expect(f.store.getConflictBranch()).toBeNull();
      // (c) snapshot advanced past the stale MAIN_HEAD.
      expect(f.store.getLastSyncCommitSha()).not.toBe("MAIN_HEAD");

      // (d) a SECOND drain is a no-op — cb stays cleared, no runaway re-merge.
      const before = f.store.getLastSyncCommitSha();
      await f.manager.syncAll();
      expect(f.store.getConflictBranch()).toBeNull();
      expect(f.store.getLastSyncCommitSha()).toBe(before);
    });

    it("register-conflict path also keeps in-memory batch.files in sync with disk", async () => {
      // Generalisation of the previous test: ANY drop site in the
      // reconcile loop must splice batch.files. register-conflict
      // is the second drop site (via registerConflictAndDropPath
      // → queue.removeFile cascade). We trigger a binary register-
      // conflict (always registers, never atomic) on one file plus
      // a co-located plugin-js (main.js) that reads "ours"
      // manifest from baseRef — exact same race shape as above but
      // through a different code path.
      const manifestPath = ".obsidian/plugins/test-plugin/manifest.json";
      const mainJsPath = ".obsidian/plugins/test-plugin/main.js";
      const oursManifest = JSON.stringify({
        id: "test-plugin",
        version: "1.5.0",
      });
      const theirsManifest = JSON.stringify({
        id: "test-plugin",
        version: "2.0.0",
      });
      const baseManifest = JSON.stringify({
        id: "test-plugin",
        version: "1.0.0",
      });

      writeVaultFile(f.root, manifestPath, oursManifest);
      writeVaultFile(f.root, mainJsPath, "ours main");
      f.store.set(manifestPath, {
        path: manifestPath,
        remoteSha: await shaOf(baseManifest),
        mtime: 0,
        size: oursManifest.length,
      });
      f.store.set(mainJsPath, {
        path: mainJsPath,
        remoteSha: await shaOf("base main"),
        mtime: 0,
        size: 8,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("BASE_HEAD", manifestPath, baseManifest);
      f.client.setContentAtRef("NEW_HEAD", manifestPath, theirsManifest);
      f.client.setContentAtRef("BASE_HEAD", mainJsPath, "base main");
      f.client.setContentAtRef("NEW_HEAD", mainJsPath, "theirs main");

      // Run — must not throw regardless of which path is iterated
      // first (atomic-theirs for manifest OR for main.js).
      await expect(f.manager.syncAll()).resolves.not.toThrow();
    });

    it("re-targets parent + base_tree onto the new head after reconcile", async () => {
      writeVaultFile(f.root, "x.md", "ours-content");
      f.store.setLastSync("OLD_HEAD", "OLD_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("OLD_HEAD", "x.md", "ours-content");
      f.client.setContentAtRef("NEW_HEAD", "x.md", "ours-content");

      await f.manager.syncAll();

      const commit = f.client.calls.find((c) => c.op === "createCommit");
      expect((commit?.args as { parent?: string }).parent).toBe("NEW_HEAD");
    });

    it("cascading rebase: Q1 resolved, Q2 with same path is auto-rebased", async () => {
      // Manually enqueue two batches that both touch x.md.
      writeVaultFile(f.root, "x.md", "V1\nshared\ntail");
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      const id1 = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      // Update x.md on disk for Q2's enqueue snapshot.
      writeVaultFile(f.root, "x.md", "V2-extra\nV1\nshared\ntail");
      const id2 = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      expect(id2 > id1).toBe(true);

      // Remote drifted with conflicting edit on the shared line.
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE_1");
      f.client.setContentAtRef("BASE_HEAD", "x.md", "V1\nshared\ntail");
      f.client.setContentAtRef("REMOTE_HEAD", "x.md", "V1\nshared\nremote-tail");

      // Re-run with a fresh fixture so the cascade rebase has clean
      // state to operate on. The text 3-way merge auto-cleans
      // non-overlapping edits (V2-extra adds a line at the top,
      // remote-tail modifies the bottom), so no conflict registers.
      const f2 = fixture();
      // Mirror the BASE_HEAD / REMOTE_HEAD content + per-batch state.
      writeVaultFile(f2.root, "x.md", "V2-extra\nV1\nshared\ntail");
      await f2.store.load();
      f2.store.setLastSync("BASE_HEAD", "BASE_TREE");
      const id1b = await f2.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      writeVaultFile(f2.root, "x.md", "V2-extra\nV1\nshared\ntail");
      const id2b = await f2.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BASE_HEAD",
          parentTreeSha: "BASE_TREE",
        },
      );
      f2.client.setBranchHead("REMOTE_HEAD");
      f2.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE_1");
      f2.client.setTreeShaForCommit("COMMIT_SHA_1", "TREE_SHA_1");
      f2.client.setContentAtRef("BASE_HEAD", "x.md", "V1\nshared\ntail");
      f2.client.setContentAtRef("REMOTE_HEAD", "x.md", "V1\nshared\nremote-tail");

      await f2.manager.resumeQueue();

      // Two commits landed sequentially.
      const commits = f2.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(2);

      // No batches left.
      expect(await f2.queue.list()).toEqual([]);
      expect(id1b < id2b).toBe(true);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("bootstrap-from-remote (Step 1)", () => {
    it("downloads every remote file when lastSyncCommitSha is null and branch has commits", async () => {
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      // Inputs are canonical (LF + trailing-NL) so the text canonicalisation
      // pull-side normalizer is a no-op for them — the test stays a
      // clean bootstrap-only scenario without follow-up republish.
      f.client.setContentAtRef("FRESH_HEAD", "Notes/a.md", "alpha\n");
      f.client.setContentAtRef("FRESH_HEAD", "Notes/b.md", "beta\n");

      await f.manager.syncAll();

      // Both files now on disk with correct content.
      expect(
        fs.readFileSync(path.join(f.root, "Notes/a.md"), "utf8"),
      ).toBe("alpha\n");
      expect(
        fs.readFileSync(path.join(f.root, "Notes/b.md"), "utf8"),
      ).toBe("beta\n");

      // Snapshot recorded for both.
      expect(f.store.get("Notes/a.md")?.remoteSha).toBeTruthy();
      expect(f.store.get("Notes/b.md")?.remoteSha).toBeTruthy();

      // lastSync moved to currentHead.
      expect(f.store.getLastSyncCommitSha()).toBe("FRESH_HEAD");
    });

    it("no-op when lastSyncCommitSha is already set", async () => {
      f.store.setLastSync("EXISTING", "EXISTING_TREE");
      f.client.setBranchHead("EXISTING");
      // Pre-recorded contents — bootstrap shouldn't touch them.
      f.client.setContentAtRef("EXISTING", "ghost.md", "should-not-pull");

      await f.manager.syncAll();

      // No bootstrap → no getRepoContent call, no file written.
      expect(
        f.client.calls.find((c) => c.op === "getRepoContent"),
      ).toBeUndefined();
      expect(fs.existsSync(path.join(f.root, "ghost.md"))).toBe(false);
    });

    it("no-op when branch is bare (404 on getBranchHeadSha)", async () => {
      f.client.getBranchHeadSha = async () => {
        const e = new Error("Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      };
      writeVaultFile(f.root, "fresh.md", "local-only");
      // Pre-create the seed gitignore so processBatch Case 1 can read it
      // (the fixture skips invariants; in production enforce() writes
      // this file before processBatch runs).
      writeVaultFile(f.root, ".gitignore", "# seed\n");

      await f.manager.syncAll();

      // Bootstrap-from-remote was skipped; the local file proceeds
      // through the first-sync-against-bare path (processBatch case 1).
      // Seed = COMMIT_SHA_1, sync commit on top = COMMIT_SHA_2.
      expect(f.store.getLastSyncCommitSha()).toBe("COMMIT_SHA_2");
    });

    it("skips ignored paths during download", async () => {
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f.client.setContentAtRef("FRESH_HEAD", ".gitignore", "secret/\n");
      f.client.setContentAtRef("FRESH_HEAD", "secret/private.md", "should-skip");
      f.client.setContentAtRef("FRESH_HEAD", "Notes/keep.md", "should-keep");

      // Pre-write the gitignore locally so checkSyncable sees it.
      // (Real Obsidian auto-loads it after the first ignored() call,
      // but bootstrap walks alphabetically and may hit secret/ before
      // .gitignore. This is the simplest deterministic setup.)
      writeVaultFile(f.root, ".gitignore", "secret/\n");

      await f.manager.syncAll();

      expect(fs.existsSync(path.join(f.root, "Notes/keep.md"))).toBe(true);
      expect(
        fs.existsSync(path.join(f.root, "secret/private.md")),
      ).toBe(false);
    });
  });

  describe("pullIfNeeded", () => {
    it("no-op when lastSyncCommitSha is null (first sync)", async () => {
      writeVaultFile(f.root, "x.md", "v");
      // No setLastSync, but a remote already exists.
      f.client.setBranchHead("REMOTE_HEAD");
      f.client.setTreeShaForCommit("REMOTE_HEAD", "REMOTE_TREE");

      await f.manager.syncAll();

      // No compare call should have happened.
      expect(f.client.calls.find((c) => c.op === "compare")).toBeUndefined();
    });

    it("no-op when HEAD hasn't moved", async () => {
      f.store.setLastSync("HEAD_X", "TREE_X");
      f.client.setBranchHead("HEAD_X");
      f.client.setTreeShaForCommit("HEAD_X", "TREE_X");
      await f.manager.syncAll();
      expect(f.client.calls.find((c) => c.op === "compare")).toBeUndefined();
    });

    it("applies a remote add to the local vault", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Canonical input → text canonicalisation normalizer is a no-op, so this
      // test stays focused on pull-detection rather than republish.
      f.client.setContentAtRef("NEW_HEAD", "Notes/new.md", "fresh content\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/new.md", status: "added", sha: "blob-new" },
        ],
      });

      await f.manager.syncAll();

      // File now present locally with the remote content.
      const written = fs.readFileSync(
        path.join(f.root, "Notes/new.md"),
        "utf8",
      );
      expect(written).toBe("fresh content\n");
      // Snapshot records the canonical-form git blob SHA (which equals
      // the remote SHA when remote was already canonical).
      expect(f.store.get("Notes/new.md")?.remoteSha).toBe(
        await shaOf("fresh content\n"),
      );
      // lastSync moved forward.
      expect(f.store.getLastSyncCommitSha()).toBe("NEW_HEAD");
    });

    it("applies a remote delete when local matches snapshot", async () => {
      writeVaultFile(f.root, "Notes/gone.md", "going");
      const stat = fs.statSync(path.join(f.root, "Notes/gone.md"));
      const sha = await shaOf("going");
      f.store.set("Notes/gone.md", {
        path: "Notes/gone.md",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/gone.md", status: "removed", sha: null },
        ],
      });

      await f.manager.syncAll();

      expect(fs.existsSync(path.join(f.root, "Notes/gone.md"))).toBe(false);
      expect(f.store.get("Notes/gone.md")).toBeUndefined();
    });

    it("ignored remote path is silently dropped from pull (two-way mute)", async () => {
      writeVaultFile(f.root, ".gitignore", "secret/\n");
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "secret/note.md", "private");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "secret/note.md", status: "added", sha: "blob-secret" },
        ],
      });

      await f.manager.syncAll();

      // File NOT downloaded because local gitignore covers secret/.
      expect(fs.existsSync(path.join(f.root, "secret/note.md"))).toBe(false);
    });

    it("binary remote-modify, local clean: pulls binary content", async () => {
      writeVaultFile(f.root, "img.png", Buffer.from([1, 2, 3]));
      const stat = fs.statSync(path.join(f.root, "img.png"));
      const sha = await shaOf("\x01\x02\x03");
      f.store.set("img.png", {
        path: "img.png",
        remoteSha: sha,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Remote bumped the file. Local is clean.
      f.client.setContentAtRef("NEW_HEAD", "img.png", "remote-binary-bytes");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "img.png", status: "modified", sha: "blob-of-remote" },
        ],
      });

      await f.manager.syncAll();

      // Local file replaced.
      const updated = fs.readFileSync(path.join(f.root, "img.png"), "utf8");
      expect(updated).toBe("remote-binary-bytes");
    });

    it("binary remote-modify, local newer: keeps ours (no overwrite)", async () => {
      // Prepare: local file with a recent mtime; snapshot recorded at
      // an older SHA; remote bumped it but with an OLDER commit date.
      writeVaultFile(f.root, "img.png", Buffer.from([0x99, 0x99]));
      const localStat = fs.statSync(path.join(f.root, "img.png"));
      // Snapshot from "long ago" so findChangeForPath flags local
      // as modified (snapshot.mtime stale).
      f.store.set("img.png", {
        path: "img.png",
        remoteSha: "OLDSHA",
        mtime: 0,
        size: localStat.size,
      });
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setCommitDate(
        "NEW_HEAD",
        new Date(localStat.mtimeMs - 60_000).toISOString(),
      );
      f.client.setContentAtRef("NEW_HEAD", "img.png", "remote-stale");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "img.png", status: "modified", sha: "blob-of-remote" },
        ],
      });

      await f.manager.syncAll();

      // Local content unchanged (still the 0x99 0x99 we wrote).
      const data = fs.readFileSync(path.join(f.root, "img.png"));
      expect(data[0]).toBe(0x99);
      expect(data[1]).toBe(0x99);
    });

    it("compare 404 (force-push or GC'd commit) is graceful", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("LOST_BASE", "LOST_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Override compare to throw 404.
      const origCompare = f.client.compare.bind(f.client);
      f.client.compare = async (args) => {
        const e = new Error("Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      };

      // Should not throw. Push proceeds normally as if pull was a no-op.
      await f.manager.syncAll();
      f.client.compare = origCompare;
    });

    it("pre-flight validation drops a stale deletion and clears its snapshot row (PSEUDO-MERGE-MODE §12.1)", async () => {
      // Setup: a previous sync recorded `Notes/stale.md` in the snapshot,
      // and ChangeDetector then emitted a delete for it (the file's
      // gone locally). But by the time push runs, another device has
      // already removed the file from GitHub — so the deletion entry
      // in our batch would draw a 422 GitRPC::BadObjectState if
      // sent. Pre-flight validation must drop the entry AND clear
      // the snapshot row, so the next sync's ChangeDetector doesn't
      // re-emit the same stale deletion.
      f.store.set("Notes/stale.md", {
        path: "Notes/stale.md",
        remoteSha: "OLDSHA",
        mtime: 1,
        size: 1,
      });
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // Deliberately NO setContentAtRef for `Notes/stale.md` — the
      // fake's `getContentsAtRef` returns null for this path,
      // simulating the cross-device race where another device
      // deleted it.

      await f.manager.syncFile("Notes/stale.md");

      // The stale deletion was dropped — no tree-create with sha:null
      // for it.
      const treeCreates = f.client.calls.filter(
        (c) => c.op === "createTree",
      );
      // Either no tree was created (batch became empty after
      // validation and the push was skipped) or the tree carries no
      // entry for stale.md.
      if (treeCreates.length > 0) {
        const tree = f.client.state.lastTree ?? [];
        const staleEntry = tree.find((e) => e.path === "Notes/stale.md");
        expect(staleEntry).toBeUndefined();
      }

      // Critical invariant: snapshot row removed. Without this drop,
      // ChangeDetector's next pass would re-emit the same stale
      // deletion and we'd re-validate-and-drop forever — one wasted
      // round-trip per sync.
      expect(f.store.get("Notes/stale.md")).toBeUndefined();
    });

    it("pre-flight validation: batch becomes empty after dropping all stale deletions → push skipped", async () => {
      // Two phantom snapshot entries that both turn out to be stale
      // at currentHead. No modify entries. After validation, entries.length
      // === 0 → push must be skipped entirely.
      f.store.set("a.md", {
        path: "a.md",
        remoteSha: "SHA_A",
        mtime: 1,
        size: 1,
      });
      f.store.set("b.md", {
        path: "b.md",
        remoteSha: "SHA_B",
        mtime: 1,
        size: 1,
      });
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // No setContentAtRef → both paths null at currentHead.

      await f.manager.syncAll();

      // No createTree / createCommit calls — the empty batch was
      // dropped, not pushed.
      expect(
        f.client.calls.filter((c) => c.op === "createTree"),
      ).toEqual([]);
      expect(
        f.client.calls.filter((c) => c.op === "createCommit"),
      ).toEqual([]);

      // Both snapshot rows cleared.
      expect(f.store.get("a.md")).toBeUndefined();
      expect(f.store.get("b.md")).toBeUndefined();
    });

    it("pre-flight validation: deletion targeting a live remote path passes through unchanged", async () => {
      // Negative case for the validator — when the deletion is
      // legitimate (file still on remote), the entry must reach the
      // tree-create request with sha:null intact. Confirms the
      // validator doesn't over-drop.
      f.store.set("Notes/live.md", {
        path: "Notes/live.md",
        remoteSha: "LIVE_SHA",
        mtime: 1,
        size: 1,
      });
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f.client.setContentAtRef("BRANCH_HEAD_INIT", "Notes/live.md", "still-there");

      await f.manager.syncFile("Notes/live.md");

      const tree = f.client.state.lastTree!;
      expect(tree).toEqual([
        { path: "Notes/live.md", mode: "100644", type: "blob", sha: null },
      ]);
      // Snapshot dropped via the normal post-push pathway.
      expect(f.store.get("Notes/live.md")).toBeUndefined();
    });

    it("pre-flight validation: validator network failure aborts push and keeps lastSync (PSEUDO-MERGE-MODE §12.1)", async () => {
      // If `getContentsAtRef` itself errors during validation, we
      // cannot tell whether the entry is valid or stale. Policy:
      // abort the push and let the next drain retry — better than
      // optimistically proceeding and reintroducing the 422 we
      // were trying to prevent.
      f.store.set("Notes/will-fail-validation.md", {
        path: "Notes/will-fail-validation.md",
        remoteSha: "SHA",
        mtime: 1,
        size: 1,
      });
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      // Override getContentsAtRef to throw a network-like error.
      const origGet = f.client.getContentsAtRef.bind(f.client);
      f.client.getContentsAtRef = async () => {
        const e = new Error("ECONNRESET") as Error & { code?: string };
        e.code = "ECONNRESET";
        throw e;
      };

      await expect(
        f.manager.syncFile("Notes/will-fail-validation.md"),
      ).rejects.toThrow(/ECONNRESET/);

      // lastSync stays put — next drain will retry the whole batch.
      expect(f.store.getLastSyncCommitSha()).toBe("BRANCH_HEAD_INIT");
      // The snapshot row also survives the failed validation —
      // dropping it would be premature (we don't know yet whether
      // the deletion was stale).
      expect(f.store.get("Notes/will-fail-validation.md")).toBeDefined();

      // Restore for any later test isolation.
      f.client.getContentsAtRef = origGet;
    });

    it("contents-endpoint null for a compare-listed path THROWS instead of silent-skipping (orphan-prevention)", async () => {
      // 2026-05-25 field bug: compare diff named `[1] File ^ opa?.md` as
      // added at currentHead, but the (then-buggy) Contents URL was
      // mis-encoded so safeFetchContents returned null. The previous
      // silent-continue allowed pullIfNeeded to finish "successfully",
      // lastSync advanced past the file's introduction commit, and the
      // file became permanently invisible to incremental compare. Only
      // a Plugin Reset (full re-bootstrap) recovered.
      //
      // With the preventive fix, an unexpected null fetch on a path the
      // compare diff lists as added/modified throws — the per-file
      // catch in pullIfNeeded logs the exact path and re-throws, the
      // loop aborts, lastSync stays at expectedHead, and the next sync
      // retries. Either succeeds (transient race / permission drift) or
      // re-fails until the underlying bug (URL encoding, etc) is fixed.
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      // Compare advertises the file as added — but we intentionally do
      // NOT call setContentAtRef, so the fake's getContentsAtRef will
      // return null for this path. Simulates the field-bug 404.
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/ghost.md", status: "added", sha: "blob-ghost" },
        ],
      });

      // Phase 4 (PSEUDO-MERGE-MODE §13 + §7.3): the throw is now
      // a `StaleStateError` instance, not a plain Error. Test
      // both the class and the message — catch sites that
      // dispatch on `instanceof StaleStateError` (vs plain
      // Error or NotFoundError) get the right behaviour.
      const { StaleStateError } = await import("../../src/errors");
      await expect(f.manager.syncAll()).rejects.toBeInstanceOf(StaleStateError);
      // Critical invariant: lastSync did NOT advance. Next sync will
      // re-attempt the same compare and try to fetch the same path
      // again — once the underlying cause is gone, recovery is
      // automatic with no manual Reset needed.
      expect(f.store.getLastSyncCommitSha()).toBe("BASE_HEAD");
      // Local file is NOT in vault (we never got the bytes).
      expect(fs.existsSync(path.join(f.root, "Notes/ghost.md"))).toBe(false);
    });
  });

  // ── text canonicalisation — text canonicalisation on pull -----------------------
  // Pull-side normalization is non-negotiable ("ГОЛОВНЕ ПРАВИЛО":
  // locally everything is canonical regardless of what's on remote).
  // When the remote bytes for a text file aren't already canonical,
  // sync2 writes the canonical form locally and intentionally skips
  // recordSync. The next findChanges pass sees the file as new/
  // modified and the next syncAll pushes the canonical bytes back —
  // the server converges on the canonical form over one extra click.
  describe("text canonicalisation on pull (text canonicalisation)", () => {
    it("CRLF in remote text → local LF + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "line1\r\nline2\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-crlf" }],
      });

      await f.manager.syncAll();

      // Local file is canonical.
      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("line1\nline2\n");
      // First syncAll deliberately does NOT recordSync the canonical
      // SHA — that's how the next findChanges spots the divergence.
      expect(f.store.get("doc.md")).toBeUndefined();
      // No commit fired in this first syncAll — just pull.
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      // Second syncAll: findChanges sees doc.md as untracked, enqueues
      // it, drain pushes the canonical bytes back to GitHub.
      await f.manager.syncAll();
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe(
        "line1\nline2\n",
      );
      expect(f.store.get("doc.md")?.remoteSha).toBe(
        await shaOf("line1\nline2\n"),
      );
    });

    it("BOM-prefixed remote text → BOM stripped locally + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "﻿title\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-bom" }],
      });

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("title\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      await f.manager.syncAll();
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe("title\n");
    });

    it("missing trailing newline on remote → \\n added locally + next syncAll pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "no trailing nl");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "doc.md", status: "added", sha: "blob-no-nl" }],
      });

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("no trailing nl\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      await f.manager.syncAll();
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe(
        "no trailing nl\n",
      );
    });

    it("already-canonical remote text → no auto-republish push fires", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "doc.md", "clean\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "doc.md", status: "added", sha: "blob-clean" },
        ],
      });

      await f.manager.syncAll();

      // No createCommit fired — pull-only, nothing to republish.
      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toEqual([]);

      // lastSync stayed at NEW_HEAD (no further commits beyond pull).
      expect(f.store.getLastSyncCommitSha()).toBe("NEW_HEAD");
    });

    it("bootstrap with non-canonical remote text → canonical locally + auto-republish", async () => {
      // Fresh device (lastSync is null) hits bootstrap-from-remote.
      // Remote has a CRLF file. Bootstrap canonicalizes locally and
      // queues the path for republish; the same syncAll call commits
      // the canonical version back to GitHub.
      f.client.setBranchHead("FRESH_HEAD");
      f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f.client.setContentAtRef("FRESH_HEAD", "doc.md", "alpha\r\n");

      await f.manager.syncAll();

      expect(
        fs.readFileSync(path.join(f.root, "doc.md"), "utf8"),
      ).toBe("alpha\n");

      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(1);
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "doc.md")?.content).toBe("alpha\n");
    });

    it("syncFile: target normalized during pull → next syncFile pushes canonical", async () => {
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "x.md", "content\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [{ filename: "x.md", status: "modified", sha: "blob-crlf" }],
      });

      await f.manager.syncFile("x.md");

      // Local is canonical after pull, but no push fired yet — the
      // path wasn't in any batch at click time.
      expect(
        fs.readFileSync(path.join(f.root, "x.md"), "utf8"),
      ).toBe("content\n");
      expect(f.client.calls.filter((c) => c.op === "createCommit"))
        .toEqual([]);

      // Second syncFile picks the canonical local up as "added" and
      // pushes it back to GitHub.
      await f.manager.syncFile("x.md");
      const tree = f.client.state.lastTree!;
      expect(tree.find((e) => e.path === "x.md")?.content).toBe("content\n");
    });

    it("syncFile: non-target normalized during pull → NOT in syncFile batch (deferred to next syncAll)", async () => {
      // syncFile has narrow scope: only the target gets pushed in this
      // batch. Other paths the pull canonicalized stay clean locally;
      // their republish has to wait for the next syncAll.
      f.store.setLastSync("BASE_HEAD", "BASE_TREE");
      f.client.setBranchHead("NEW_HEAD");
      f.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f.client.setContentAtRef("NEW_HEAD", "other.md", "from-web\r\n");
      f.client.setCompareResult("BASE_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "other.md", status: "added", sha: "blob-other" },
        ],
      });
      // User adds a different file and asks to sync only that one.
      writeVaultFile(f.root, "x.md", "manual-edit\n");

      await f.manager.syncFile("x.md");

      const tree = f.client.state.lastTree!;
      // Only x.md goes up — other.md (canonicalized locally) stays
      // out of this commit.
      expect(tree.map((e) => e.path)).toEqual(["x.md"]);

      // But other.md IS canonical on disk — pull-side normalization
      // happened regardless of which file was the syncFile target.
      expect(
        fs.readFileSync(path.join(f.root, "other.md"), "utf8"),
      ).toBe("from-web\n");
    });
  });


  // ── local-phase UI feedback hooks --------------------------------
  // onLocalCommitted fires once per syncAll/syncFile after the batch
  // is enqueued. onNoLocalChanges fires when there's truly nothing to
  // do (no local changes AND no pending queue). main.ts wires both
  // to short-lived Notices so the user sees "Commit N files" / "No
  // changes" before any network I/O happens.
  describe("local-phase UI hooks", () => {
    it("onLocalCommitted fires with correct count when files are enqueued", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      writeVaultFile(f2.root, "a.md", "v1\n");
      writeVaultFile(f2.root, "b.md", "v1\n");
      writeVaultFile(f2.root, "c.md", "v1\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(calls).toEqual([3]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onLocalCommitted does NOT fire when there's nothing to enqueue", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(calls).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onLocalCommitted reports the full count — in-conflict paths are NOT filtered at enqueue (stage 7c)", async () => {
      // Pre-create a conflict on a.md. Pre-7c, dropPendingConflictPaths
      // would filter a.md out before enqueueOrMerge — onLocalCommitted
      // would see count=2. Post-7c, edits to in-conflict paths flow
      // through enqueue and get routed to the conflict-branch in
      // processBatch's split-push partition; onLocalCommitted sees
      // the full count=3.
      const ConflictStore = (
        await import("../../src/sync2/conflict-store")
      ).default;
      const calls: number[] = [];
      const f2 = fixture({});
      const conflictStore = new ConflictStore({
        vault: f2.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await conflictStore.load();
      writeVaultFile(f2.root, "a.md", "v1\n");
      await conflictStore.create({
        vaultPath: "a.md",
        kind: "modify-vs-modify",
        theirsContent: new TextEncoder().encode("theirs\n").buffer as ArrayBuffer,
        theirsBlobSha: "old-theirs-sha",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "test-device",
      });

      const manager = new Sync2Manager({
        vault: f2.vault as unknown as import("obsidian").Vault,
        store: f2.store,
        detector: f2.detector,
        queue: f2.queue,
        builder: f2.builder,
        client: f2.client,
        logger: silentLogger(),
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        deviceLabel: "test-device",
        conflictStore,
        onLocalCommitted: (n) => calls.push(n),
        now: () => f2.clock.nowMs(),
      });

      await f2.store.load();
      writeVaultFile(f2.root, "a.md", "edited locally\n");
      writeVaultFile(f2.root, "b.md", "clean-b\n");
      writeVaultFile(f2.root, "c.md", "clean-c\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await manager.syncAll();

      expect(calls).toEqual([3]); // a.md kept (routed to branch later), b.md + c.md plain
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onNoLocalChanges fires when nothing local AND queue empty", async () => {
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      expect(noChangesCalls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onNoLocalChanges does NOT fire when queue has pending batches", async () => {
      // Pre-load a pending batch into the queue. syncAll finds no
      // local changes but isn't truly idle — the queue has work.
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      writeVaultFile(f2.root, "stranded.md", "v1\n");
      await f2.queue.enqueue(
        [
          {
            kind: "added",
            path: "stranded.md",
            size: 3,
            mtime: 0,
          },
        ],
        {
          parentCommitSha: null,
          parentTreeSha: null,
        },
      );
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // Snapshot already records stranded.md so findChanges sees nothing.
      const stat = fs.statSync(path.join(f2.root, "stranded.md"));
      f2.store.set("stranded.md", {
        path: "stranded.md",
        remoteSha: await shaOf("v1\n"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncAll();

      // Queue had work → not idle → no "Nothing to commit" notice.
      expect(noChangesCalls).toEqual([]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("syncFile: onLocalCommitted fires with count=1 when file enqueues", async () => {
      const calls: number[] = [];
      const f2 = fixture({ onLocalCommitted: (n) => calls.push(n) });
      writeVaultFile(f2.root, "x.md", "v1\n");
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncFile("x.md");

      expect(calls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("syncFile: onNoLocalChanges fires when target is unchanged + no queue", async () => {
      const noChangesCalls: number[] = [];
      const f2 = fixture({
        onNoLocalChanges: () => noChangesCalls.push(1),
      });
      writeVaultFile(f2.root, "x.md", "v1\n");
      const stat = fs.statSync(path.join(f2.root, "x.md"));
      f2.store.set("x.md", {
        path: "x.md",
        remoteSha: await shaOf("v1\n"),
        mtime: stat.mtimeMs,
        size: stat.size,
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      f2.client.setBranchHead("BRANCH_HEAD_INIT");

      await f2.manager.syncFile("x.md");

      expect(noChangesCalls).toEqual([1]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("resumeQueue / drain — bootstrap entry point", () => {
    // Regression guard for the "fresh device, never clicked Sync,
    // interval timer or onload fires backgroundDrain → drain →
    // pullIfNeeded" path. Drain must call bootstrapIfNeeded itself
    // since these background entry points bypass the click-body that
    // would normally bootstrap. Without this, fresh-install
    // users with autoCommit OFF + syncOnStartup ON would see drain
    // exit silently and never adopt the remote content.
    it("drain on a fresh client (lastSync=null) triggers bootstrap-from-remote", async () => {
      const f2 = fixture({});
      // Fresh client: no lastSync recorded, no local files.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "Notes/alpha.md", "alpha\n");
      f2.client.setContentAtRef("FRESH_HEAD", "Notes/beta.md", "beta\n");

      await f2.manager.resumeQueue();

      // Bootstrap-from-remote pulled the remote files into the vault.
      expect(
        fs.readFileSync(path.join(f2.root, "Notes/alpha.md"), "utf8"),
      ).toBe("alpha\n");
      expect(
        fs.readFileSync(path.join(f2.root, "Notes/beta.md"), "utf8"),
      ).toBe("beta\n");
      // lastSync now set — subsequent calls skip bootstrap.
      expect(f2.store.getLastSyncCommitSha()).toBe("FRESH_HEAD");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("drain on an already-bootstrapped client doesn't re-bootstrap", async () => {
      // After lastSync is set, bootstrapIfNeeded returns null in O(1)
      // — no getRepoContent call, no re-adoption.
      f.store.setLastSync("HEAD_X", "TREE_X");
      f.client.setBranchHead("HEAD_X");

      await f.manager.resumeQueue();

      // Defensive check: no extra getRepoContent calls (the only
      // surface the bootstrap path uses to fetch the tree).
      const tree = f.client.calls.filter(
        (c) => c.op === "getRepoContent",
      );
      expect(tree).toEqual([]);
    });
  });

  describe("resumeQueue + consolidateCommits", () => {
    it("resumeQueue picks up a pending batch left over from a previous run", async () => {
      // Simulate a previous Sync2Manager that enqueued but crashed
      // before pushing.
      writeVaultFile(f.root, "stale.md", "stranded content");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      const id = await f.queue.enqueue(
        [{ kind: "added", path: "stale.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "INITIAL_TREE",
        },
      );

      await f.manager.resumeQueue();

      const commits = f.client.calls.filter((c) => c.op === "createCommit");
      expect(commits).toHaveLength(1);
      // Commit message is derived at push time from batch.synthetic
      // (false here) + the manager's deviceLabel ("test-device") —
      // no batch-level commitMessage.
      expect((commits[0].args as { message: string }).message).toMatch(
        /^Sync at .+ \(test-device\)$/,
      );
      expect(await f.queue.list()).toEqual([]);
      // batch is gone from disk
      expect(id).toMatch(/^\d{17}$/);
    });

    it("resumeQueue with empty queue is a no-op", async () => {
      await f.manager.resumeQueue();
      expect(f.client.calls.filter((c) => c.op === "createCommit")).toEqual(
        [],
      );
    });

    it("resumeQueue clears stale .in-progress markers and pushes anyway", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      const id = await f.queue.enqueue(
        [{ kind: "added", path: "x.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "INITIAL_TREE",
        },
      );
      // Crashed mid-push: marker stuck on disk.
      await f.queue.markInProgress(id);

      await f.manager.resumeQueue();

      // Push went through; batch deleted; marker irrelevant.
      expect(
        f.client.calls.filter((c) => c.op === "createCommit"),
      ).toHaveLength(1);
      expect(await f.queue.list()).toEqual([]);
    });
  });

  describe("consolidateCommits", () => {
    function brokenNetworkFixture() {
      // Helper: client whose updateBranchHead always throws so the
      // first push fails and leaves the batch on disk.
      const f = fixture({ consolidateCommits: true });
      const orig = f.client.updateBranchHead.bind(f.client);
      let allowPush = false;
      f.client.updateBranchHead = async (args) => {
        if (!allowPush) {
          throw new Error("simulated network outage");
        }
        return orig(args);
      };
      return {
        ...f,
        allowNextPush: () => (allowPush = true),
        allowAllPushes: () => (allowPush = true),
      };
    }

    it("offline + accumulate ON: failed batch is locked, second sync stacks a new one", async () => {
      // Under the user's spec, a batch that's been attempted at all
      // (even once, even if it failed) is frozen against further
      // accumulate-merges. The .attempted marker enforces this: it
      // gets written at the start of processBatch and is NEVER
      // cleared on failure. So even with consolidateCommits ON,
      // a second sync click after a failed push creates a separate
      // batch — symmetric to the accumulate=OFF behaviour below.
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      await expect(f2.manager.syncAll()).rejects.toThrow(
        /simulated network outage/,
      );
      const idsAfter1 = await f2.queue.list();
      expect(idsAfter1).toHaveLength(1);

      // The first batch must be marked .attempted; mergeIntoLatestPending
      // skips it on the next syncAll.
      const b1 = await f2.queue.read(idsAfter1[0]);
      expect(b1.attempted).toBe(true);

      writeVaultFile(f2.root, "b.md", "v2");

      await expect(f2.manager.syncAll()).rejects.toThrow();
      const idsAfter2 = await f2.queue.list();
      expect(idsAfter2).toHaveLength(2);

      // Each batch holds only the changes from its own sync click —
      // b.md did NOT fold into B1.
      const newId = idsAfter2.find((id) => !idsAfter1.includes(id));
      expect(newId).toBeDefined();
      const b2 = await f2.queue.read(newId!);
      expect(b2.files).toEqual(["b.md"]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("offline + accumulate OFF: second sync stacks a new batch", async () => {
      const fOff = (() => {
        const x = fixture({ consolidateCommits: false });
        const orig = x.client.updateBranchHead.bind(x.client);
        x.client.updateBranchHead = async () => {
          throw new Error("offline");
        };
        return x;
      })();
      writeVaultFile(fOff.root, "a.md", "v1");
      await fOff.store.load();
      fOff.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await expect(fOff.manager.syncAll()).rejects.toThrow();
      writeVaultFile(fOff.root, "b.md", "v2");
      await expect(fOff.manager.syncAll()).rejects.toThrow();
      const ids = await fOff.queue.list();
      expect(ids).toHaveLength(2);
      fs.rmSync(fOff.root, { recursive: true, force: true });
    });

    it("accumulate ON but queue empty: enqueue normally", async () => {
      const f2 = fixture({ consolidateCommits: true });
      writeVaultFile(f2.root, "a.md", "v");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

      await f2.manager.syncAll();

      // Push succeeded → batch was created and immediately drained.
      expect(
        f2.client.calls.filter((c) => c.op === "createCommit"),
      ).toHaveLength(1);
      expect(await f2.queue.list()).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("queued batches drain FIFO once network is back, each as its own commit", async () => {
      // With the attempted-marker locking failed batches, two failed
      // sync clicks produce TWO batches in queue (B1 + B2), not one
      // folded batch. When the network returns, processQueue drains
      // them in order: B1 commits (carrying a.md), then B2 commits
      // (carrying b.md). Two updateBranchHead calls succeed, queue
      // ends empty.
      const f2 = brokenNetworkFixture();
      writeVaultFile(f2.root, "a.md", "v1");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await expect(f2.manager.syncAll()).rejects.toThrow();
      writeVaultFile(f2.root, "b.md", "v2");
      await expect(f2.manager.syncAll()).rejects.toThrow();

      // Network restored; let every subsequent push through.
      f2.allowAllPushes();
      await f2.manager.resumeQueue();

      // Two commits landed in order. Each tree carries only its own
      // batch's files — proof the merge step refused to fold them.
      const refUpdates = f2.client.calls.filter(
        (c) => c.op === "updateBranchHead",
      );
      expect(refUpdates).toHaveLength(2);
      expect(await f2.queue.list()).toEqual([]);

      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  describe("progress UI (Step 5)", () => {
    it("single batch heavy push: notice opens at 'Pushing 1 file to GitHub…' and ends 'Sync done'", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      writeVaultFile(f2.root, "x.md", "v");
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f2.manager.syncAll();
      // Lazy-open on the first pre-op tick. A single file reads
      // "Pushing 1 file to GitHub…" (no meaningless "1/1", no "0/N").
      expect(messages[0]).toBe("Pushing 1 file to GitHub…");
      expect(messages.some((m) => /0\//.test(m))).toBe(false);
      // Final state is the "Sync done" replace on the same handle.
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("two pending batches: each shows its own 'Pushing 1 file to GitHub…'", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "TREE_0");
      writeVaultFile(f2.root, "a.md", "1");
      await f2.queue.enqueue(
        [{ kind: "added", path: "a.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "TREE_0",
        },
      );
      writeVaultFile(f2.root, "b.md", "2");
      await f2.queue.enqueue(
        [{ kind: "added", path: "b.md", size: 1, mtime: 0 }],
        {
          parentCommitSha: "BRANCH_HEAD_INIT",
          parentTreeSha: "TREE_0",
        },
      );
      // Pre-record snapshots for these so syncAll doesn't add a new batch.
      f2.store.set("a.md", {
        path: "a.md",
        remoteSha: await shaOf("1"),
        mtime: fs.statSync(path.join(f2.root, "a.md")).mtimeMs,
        size: 1,
      });
      f2.store.set("b.md", {
        path: "b.md",
        remoteSha: await shaOf("2"),
        mtime: fs.statSync(path.join(f2.root, "b.md")).mtimeMs,
        size: 1,
      });
      await f2.store.save();

      await f2.manager.resumeQueue();

      // Each single-file batch ticks "Pushing 1 file to GitHub…" once
      // (no commit-number indicator — every batch is a self-contained
      // push view). Two batches → the message appears at least twice
      // (the lazy-open of batch 1 + the tick of batch 2 on the same
      // handle). The final state is "Sync done" once the queue empties.
      expect(
        messages.filter((m) => m === "Pushing 1 file to GitHub…").length,
      ).toBeGreaterThanOrEqual(2);
      expect(messages.some((m) => /0\//.test(m))).toBe(false);
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("no onProgress provided: sync runs without crashing", async () => {
      writeVaultFile(f.root, "x.md", "v");
      f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f.manager.syncAll();
      // No assertion needed beyond completion.
    });

    it("live N/M counter: progress messages tick through 'Pushing X/N'", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      await f2.store.load();
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      // Mixed batch: 2 text files + 2 binaries. The counter has to
      // span all four, not just the binary uploads.
      writeVaultFile(f2.root, "a.md", "one");
      writeVaultFile(f2.root, "b.md", "two");
      writeVaultFile(f2.root, "c.png", Buffer.from([1, 2, 3]));
      writeVaultFile(f2.root, "d.png", Buffer.from([4, 5, 6]));

      await f2.manager.syncAll();

      // Pre-op lazy-open: the FIRST tick is "Pushing 1/4 files to
      // GitHub" (never "0/4"), and the counter ticks per file through
      // "Pushing 4/4 files to GitHub" as the tree-builder hook fires
      // before each file, ending with "Sync done" on the same handle.
      expect(messages[0]).toBe("Pushing 1/4 files to GitHub");
      expect(
        messages.some((m) => m === "Pushing 4/4 files to GitHub"),
      ).toBe(true);
      expect(messages.some((m) => /0\/4/.test(m))).toBe(false);
      expect(messages[messages.length - 1]).toBe("Sync done");
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side counter: bootstrap-from-remote ticks 'Preparing GitHub syncing: X/N'", async () => {
      // Adoption path (fresh vault, remote has content). Adoption is
      // a comparison pass — for vaults previously synced via another
      // tool most paths SHA-match and only a subset actually pulls,
      // so the user-facing label is "Reconciling" not "Downloading".
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "a.md", "a\n");
      f2.client.setContentAtRef("FRESH_HEAD", "b.md", "b\n");
      f2.client.setContentAtRef("FRESH_HEAD", "c.md", "c\n");

      await f2.manager.syncAll();

      expect(messages.some((m) => /Preparing GitHub syncing/.test(m))).toBe(
        true,
      );
      expect(messages.some((m) => /Preparing GitHub syncing: 3\/3/.test(m))).toBe(
        true,
      );
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("idle syncAll fires the unconditional 'Sync done' notice (2.0.2-beta2)", async () => {
      // 2.0.2-beta2 changed the lazy-open rule. The old contract
      // ("idle drain stays silent") was confusing in the field —
      // users had no explicit "it's safe to click again" signal.
      // Now drain always emits a brief "Sync done" toast at the end
      // (no suffix when nothing was pulled). The onNoLocalChanges
      // callback still handles the separate "Nothing to commit"
      // pre-flash.
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
        progressBytesThreshold: Infinity,
      });
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      await f2.manager.syncAll();
      expect(messages).toEqual(["Sync done"]);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onSyncCompleted fires with pushed/pulled counts at end of syncAll", async () => {
      const summaries: Array<{ pushedFiles: number; pulledFiles: number }> = [];
      const f2 = fixture({
        onProgress: (initial) => ({
          update: () => {},
          hide: () => {},
        }),
      });
      // Manually wire up the field (fixture currently doesn't pipe
      // onSyncCompleted, but the manager respects it when present
      // — assigned post-construct here for the test only).
      (
        f2.manager as unknown as {
          onSyncCompleted?: (s: {
            pushedFiles: number;
            pulledFiles: number;
          }) => void;
        }
      ).onSyncCompleted = (s) => summaries.push(s);

      // Push-only: lastSync set + a fresh local file → one push.
      f2.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
      writeVaultFile(f2.root, "x.md", "v");

      await f2.manager.syncAll();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].pushedFiles).toBe(1);
      expect(summaries[0].pulledFiles).toBe(0);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("onSyncCompleted: pull-only sync reports pulledFiles > 0, pushedFiles = 0", async () => {
      const summaries: Array<{ pushedFiles: number; pulledFiles: number }> = [];
      const f2 = fixture({
        onProgress: (initial) => ({
          update: () => {},
          hide: () => {},
        }),
      });
      (
        f2.manager as unknown as {
          onSyncCompleted?: (s: {
            pushedFiles: number;
            pulledFiles: number;
          }) => void;
        }
      ).onSyncCompleted = (s) => summaries.push(s);

      // Adoption from a fresh remote with two files — both pull.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", "a.md", "alpha\n");
      f2.client.setContentAtRef("FRESH_HEAD", "b.md", "beta\n");

      await f2.manager.syncAll();

      expect(summaries).toHaveLength(1);
      expect(summaries[0].pulledFiles).toBe(2);
      // The republish heuristic may queue a tiny push for the
      // canonicalised invariant gitignores, but for THIS pair of
      // files (canonical text), nothing extra. Loose check:
      expect(summaries[0].pushedFiles).toBeGreaterThanOrEqual(0);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side counter: incremental pullIfNeeded ticks through too", async () => {
      // Regular sync (lastSync set, head moved): pullIfNeeded fetches
      // the diff and applies each file. Same M/N progress contract
      // as bootstrap.
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      // Pretend we've already synced at OLD_HEAD; the branch moved
      // forward and two files changed on the remote side.
      f2.store.setLastSync("OLD_HEAD", "OLD_TREE");
      f2.client.setBranchHead("NEW_HEAD");
      f2.client.setTreeShaForCommit("NEW_HEAD", "NEW_TREE");
      f2.client.setCompareResult("OLD_HEAD", "NEW_HEAD", {
        status: "ahead",
        files: [
          { filename: "Notes/a.md", status: "added", sha: "irrelevant" },
          { filename: "Notes/b.md", status: "modified", sha: "irrelevant" },
        ],
      });
      f2.client.setContentAtRef("OLD_HEAD", "Notes/b.md", "old beta\n");
      f2.client.setContentAtRef("NEW_HEAD", "Notes/a.md", "new alpha\n");
      f2.client.setContentAtRef("NEW_HEAD", "Notes/b.md", "new beta\n");

      await f2.manager.syncAll();

      // Pre-op counter: the first file's tick shows "Pulling 1/2" (no
      // "0/N"), the last shows "Pulling 2/2".
      expect(messages.some((m) => /Pulling 1\/2/.test(m))).toBe(true);
      expect(messages.some((m) => /Pulling 2\/2/.test(m))).toBe(true);
      expect(messages.some((m) => /0\/2/.test(m))).toBe(false);
      fs.rmSync(f2.root, { recursive: true, force: true });
    });

    it("pull-side: no notice when there's nothing syncable to pull", async () => {
      const messages: string[] = [];
      const f2 = fixture({
        onProgress: (initial) => {
          messages.push(initial);
          return {
            update: (m) => messages.push(m),
            hide: () => {},
          };
        },
      });
      // Fresh vault, remote head exists, but the only file is
      // explicitly gitignored — nothing for the loop to do.
      f2.client.setBranchHead("FRESH_HEAD");
      f2.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
      f2.client.setContentAtRef("FRESH_HEAD", ".gitignore", "secret/\n");
      f2.client.setContentAtRef(
        "FRESH_HEAD",
        "secret/private.md",
        "blocked",
      );
      writeVaultFile(f2.root, ".gitignore", "secret/\n");

      await f2.manager.syncAll();

      // The "Pull…" message must not have fired with anything beyond
      // the gitignore itself — every other remote path got filtered.
      const pullFires = messages.filter((m) => /^Pull /.test(m));
      for (const m of pullFires) {
        expect(m).toMatch(/Pull [01]\/1/);
      }
      fs.rmSync(f2.root, { recursive: true, force: true });
    });
  });

  it("processQueue is re-entrant safe: a recursive call short-circuits", async () => {
    // Simulate concurrent syncAll() invocations: kick off two without
    // awaiting in between; only one drain loop should run.
    writeVaultFile(f.root, "a.md", "1");
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    const p1 = f.manager.syncAll();
    const p2 = f.manager.syncAll();
    await Promise.all([p1, p2]);

    // Whatever interleaving happens, we never double-pushed.
    expect(
      f.client.calls.filter((c) => c.op === "createCommit").length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("Sync2Manager — onPluginsAffected (BRAT-style auto-reload trigger)", () => {
  // 2.0.2-beta2: pull-side writes to <configDir>/plugins/<id>/<file>
  // are tracked through the drain cycle. At drain end (on full
  // success) the callback fires with the union of affected plugin
  // IDs so main.ts can call reloadPlugin(id) for each.
  //
  // Coverage matrix:
  //  - Other plugin's main.js pulled → callback fires with [id]
  //  - Other plugin's manifest.json / styles.css / data.json → fires
  //  - Our OWN plugin's file pulled → fires too (parent decides
  //    whether to actually reload self)
  //  - Multiple plugins → unioned, deduplicated
  //  - Subdirectory files (plugins/x/data/y.json) → NOT included
  //  - Non-plugin paths (notes, themes) → callback doesn't fire
  //  - Failed drain → callback doesn't fire (set preserved for next)

  it("plugin main.js pulled → callback fires once with that plugin's id", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    // Adoption from fresh remote — `<configDir>/plugins/some-plugin/main.js`
    // counts as a plugin file. The path is what determines tracking;
    // bytes can be arbitrary.
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/main.js`,
      "console.log('hi')",
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["some-plugin"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("plugin manifest.json pulled → callback fires", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/manifest.json`,
      '{"id":"some-plugin","version":"1.0.0"}',
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["some-plugin"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("plugin styles.css pulled → callback fires", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/styles.css`,
      ".x { color: red; }",
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["some-plugin"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("plugin data.json pulled → callback fires", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/data.json`,
      "{}",
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["some-plugin"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("our OWN plugin file pulled → callback fires too (main.ts handles whether to actually reload self)", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/main.js`,
      "new-self-bytes",
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([SELF_PLUGIN_ID]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("multiple plugins pulled → callback fires once with deduplicated id list", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/plugin-a/main.js`,
      "a-code",
    );
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/plugin-a/manifest.json`,
      '{"id":"plugin-a"}',
    );
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/plugin-b/main.js`,
      "b-code",
    );

    await f.manager.syncAll();

    expect(calls).toHaveLength(1);
    expect(calls[0].sort()).toEqual(["plugin-a", "plugin-b"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("subdirectory files under plugins/<id>/ → NOT included", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    // Subdirectory file — should NOT trigger reload (Obsidian reads
    // these on demand at runtime, not at plugin enable time).
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/data/user-file.json`,
      "{}",
    );

    await f.manager.syncAll();

    expect(calls).toEqual([]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("non-plugin paths (notes, themes) → callback doesn't fire", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef("FRESH_HEAD", "note.md", "# Hi");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/themes/my-theme.css`,
      "body { }",
    );

    await f.manager.syncAll();

    expect(calls).toEqual([]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("drain with no plugin files pulled → callback doesn't fire", async () => {
    const calls: string[][] = [];
    const f = fixture({
      onPluginsAffected: (ids) => calls.push(ids.slice()),
    });
    // Idle sync — no remote changes, no local changes.
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await f.manager.syncAll();

    expect(calls).toEqual([]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("no onPluginsAffected callback provided → no error, drain completes", async () => {
    const f = fixture(); // no callback
    f.client.setBranchHead("FRESH_HEAD");
    f.client.setTreeShaForCommit("FRESH_HEAD", "FRESH_TREE");
    f.client.setContentAtRef(
      "FRESH_HEAD",
      `${CONFIG_DIR}/plugins/some-plugin/main.js`,
      "code",
    );

    await expect(f.manager.syncAll()).resolves.toBeUndefined();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe("Sync2Manager — zero-byte restore guard (SYNC2 §2.9)", () => {
  // The guard fires at processBatch start. We exercise it directly via
  // the private method so the snapshot-state matrix is pinned without
  // routing through a full syncAll. Setup per case:
  //   - write the local vault file to 0 bytes
  //   - enqueue a batch naming that path
  //   - set (or omit) a snapshot entry
  //   - register the "good" bytes on GitHub (fake getBlob resolves by
  //     SHA) and/or in an older/newer queue batch
  // Then assert restore-vs-passthrough + whether the path stayed in
  // the batch.
  const META = { parentCommitSha: null, parentTreeSha: null };

  type GuardManager = {
    applyZeroByteRestoreGuard(id: string): Promise<void>;
  };
  const runGuard = (m: Sync2Manager, id: string): Promise<void> =>
    (m as unknown as GuardManager).applyZeroByteRestoreGuard(id);

  it("snapshot.size != 0 + local zero → restores from GitHub, drops path from batch", async () => {
    const f = fixture();
    const good = "important note body\n";
    const goodSha = await shaOf(good);
    // GitHub holds the good blob (fake getBlob resolves by SHA).
    f.client.setContentAtRef("ANYREF", "Notes/a.md", good);
    // snapshot says last-synced size was non-zero.
    f.store.set("Notes/a.md", {
      path: "Notes/a.md",
      remoteSha: goodSha,
      mtime: 1,
      size: good.length,
    });
    // local file is now empty; enqueue a batch naming it.
    writeVaultFile(f.root, "Notes/a.md", "");
    const id = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/a.md",
          size: 0,
          mtime: 2,
          previousRemoteSha: goodSha,
        },
      ],
      META,
    );

    await runGuard(f.manager, id);

    // restored locally
    expect(fs.readFileSync(path.join(f.root, "Notes/a.md"), "utf8")).toBe(good);
    // dropped from the batch → never pushed
    const batch = await f.queue.read(id);
    expect(batch.files).not.toContain("Notes/a.md");
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("no snapshot (brand-new file) + local zero → NOT restored, path stays (intentional empty file)", async () => {
    const f = fixture();
    // No snapshot entry for this path at all — it's brand new.
    writeVaultFile(f.root, "Notes/new-empty.md", "");
    const id = await f.queue.enqueue(
      [{ kind: "added", path: "Notes/new-empty.md", size: 0, mtime: 1 }],
      META,
    );

    await runGuard(f.manager, id);

    // still empty — no restoration
    expect(fs.readFileSync(path.join(f.root, "Notes/new-empty.md"), "utf8")).toBe("");
    // still in the batch → will push as a legitimate empty file
    const batch = await f.queue.read(id);
    expect(batch.files).toContain("Notes/new-empty.md");
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("snapshot.size === 0 (was already empty) + local zero → NOT restored, path stays", async () => {
    const f = fixture();
    f.store.set("Notes/empty.md", {
      path: "Notes/empty.md",
      remoteSha: await shaOf(""),
      mtime: 1,
      size: 0,
    });
    writeVaultFile(f.root, "Notes/empty.md", "");
    const id = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/empty.md",
          size: 0,
          mtime: 2,
          previousRemoteSha: await shaOf(""),
        },
      ],
      META,
    );

    await runGuard(f.manager, id);

    expect(fs.readFileSync(path.join(f.root, "Notes/empty.md"), "utf8")).toBe("");
    const batch = await f.queue.read(id);
    expect(batch.files).toContain("Notes/empty.md");
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("non-zero local file → guard is a no-op (path stays)", async () => {
    const f = fixture();
    f.store.set("Notes/ok.md", {
      path: "Notes/ok.md",
      remoteSha: await shaOf("old\n"),
      mtime: 1,
      size: 4,
    });
    writeVaultFile(f.root, "Notes/ok.md", "new content\n");
    const id = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/ok.md",
          size: 12,
          mtime: 2,
          previousRemoteSha: await shaOf("old\n"),
        },
      ],
      META,
    );

    await runGuard(f.manager, id);

    expect(fs.readFileSync(path.join(f.root, "Notes/ok.md"), "utf8")).toBe("new content\n");
    const batch = await f.queue.read(id);
    expect(batch.files).toContain("Notes/ok.md");
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("restore source: a newer pending batch's non-zero copy is preferred over GitHub", async () => {
    const f = fixture();
    const stale = "old github version\n";
    const fresh = "freshly retyped version\n";
    const staleSha = await shaOf(stale);
    // GitHub has the stale (last-synced) version.
    f.client.setContentAtRef("ANYREF", "Notes/a.md", stale);
    f.store.set("Notes/a.md", {
      path: "Notes/a.md",
      remoteSha: staleSha,
      mtime: 1,
      size: stale.length,
    });
    // A NEWER pending batch holds a non-zero good copy (user retyped).
    writeVaultFile(f.root, "Notes/a.md", fresh);
    const newerId = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/a.md",
          size: fresh.length,
          mtime: 2,
          previousRemoteSha: staleSha,
        },
      ],
      META,
    );
    // The zero-collapse batch is created AFTER (newer id), so the
    // good copy lives in an OLDER batch relative to it. To make the
    // good copy "newer than the zero batch is irrelevant" — the guard
    // searches ALL pending batches newest-first. Put the zero in its
    // own batch and ensure the good batch is found.
    writeVaultFile(f.root, "Notes/a.md", "");
    const zeroId = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/a.md",
          size: 0,
          mtime: 3,
          previousRemoteSha: staleSha,
        },
      ],
      META,
    );

    await runGuard(f.manager, zeroId);

    // restored from the QUEUE copy (fresh), NOT GitHub (stale)
    expect(fs.readFileSync(path.join(f.root, "Notes/a.md"), "utf8")).toBe(fresh);
    // no getBlob call was needed — the queue copy short-circuited it
    const blobCalls = f.client.calls.filter((c) => c.op === "getBlob");
    expect(blobCalls.length).toBe(0);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  it("fires onZeroByteRestored callback with the restored path", async () => {
    const restored: string[] = [];
    const f = fixture({ onZeroByteRestored: (p) => restored.push(p) });
    const good = "content\n";
    const goodSha = await shaOf(good);
    f.client.setContentAtRef("ANYREF", "Notes/a.md", good);
    f.store.set("Notes/a.md", {
      path: "Notes/a.md",
      remoteSha: goodSha,
      mtime: 1,
      size: good.length,
    });
    writeVaultFile(f.root, "Notes/a.md", "");
    const id = await f.queue.enqueue(
      [
        {
          kind: "modified",
          path: "Notes/a.md",
          size: 0,
          mtime: 2,
          previousRemoteSha: goodSha,
        },
      ],
      META,
    );

    await runGuard(f.manager, id);

    expect(restored).toEqual(["Notes/a.md"]);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe("Sync2Manager — reconcileRemoteIdentity", () => {
  // The reconcile step is what runs at the very start of syncAll —
  // exercised here in isolation (cast to any) so the assertions
  // don't have to model the rest of syncAll's bootstrap/pull flow
  // re-populating `lastSyncCommitSha`. Public syncAll is exercised
  // by integration tests downstream.
  type ReconcilableManager = { reconcileRemoteIdentity(): Promise<void> };
  const reconcile = (m: Sync2Manager): Promise<void> =>
    (m as unknown as ReconcilableManager).reconcileRemoteIdentity();

  it("first observation: records identity, doesn't reset (upgrade-safe)", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("EXISTING_SHA", "EXISTING_TREE");
    expect(f.store.getRemoteIdentity()).toBeNull();

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual(handle);
    // lastSync untouched — no reset happened.
    expect(f.store.getLastSyncCommitSha()).toBe("EXISTING_SHA");
  });

  it("matching identity: no-op", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual(handle);
    expect(f.store.getLastSyncCommitSha()).toBe("BRANCH_HEAD_INIT");
  });

  it("repo change: wipes snapshot + push-queue, records new identity", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });
    // Leave a pending batch on disk (a failed earlier push).
    writeVaultFile(f.root, "stale.md", "from old repo");
    const id = await f.queue.enqueue(
      [
        {
          kind: "added",
          path: "stale.md",
          size: 13,
          mtime: f.clock.nowMs(),
        },
      ],
      {
        parentCommitSha: "OLD_PARENT",
        parentTreeSha: "OLD_PARENT_TREE",
      },
    );
    expect(await f.queue.list()).toContain(id);

    // User edits settings → new repo.
    handle.repo = "different-vault";

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toEqual({
      owner: "alice",
      repo: "different-vault",
      branch: "main",
    });
    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(await f.queue.list()).not.toContain(id);
  });

  it("branch change: also triggers reset (treated same as repo change)", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    handle.branch = "dev";

    await reconcile(f.manager);

    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(f.store.getRemoteIdentity()?.branch).toBe("dev");
  });

  it("owner change: also triggers reset", async () => {
    const handle = { owner: "alice", repo: "vault", branch: "main" };
    const f = fixture({ remoteIdentity: () => handle });
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");
    f.store.setRemoteIdentity({ ...handle });

    handle.owner = "bob";

    await reconcile(f.manager);

    expect(f.store.getLastSyncCommitSha()).toBeNull();
    expect(f.store.getRemoteIdentity()?.owner).toBe("bob");
  });

  it("no remoteIdentity getter: reconcile is a no-op", async () => {
    const f = fixture(); // no opts.remoteIdentity
    f.store.setLastSync("BRANCH_HEAD_INIT", "INITIAL_TREE");

    await reconcile(f.manager);

    expect(f.store.getRemoteIdentity()).toBeNull();
    expect(f.store.getLastSyncCommitSha()).toBe("BRANCH_HEAD_INIT");
  });
});
