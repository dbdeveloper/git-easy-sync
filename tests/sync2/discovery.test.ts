import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import {
  COMPARE_FILES_CAP,
  DELETED_SHA_HASH,
  DiscoveryClient,
  DiscoveryDeps,
  RemoteFileChange,
  fullTreeDiffAgainstColdBaseline,
  getChangedFilesFromGitHubRepo,
  getCommitInfoForPath,
} from "../../src/sync2/discovery";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { NotFoundError, TreeTruncatedError } from "../../src/errors";

// §VIII category O (hybrid discovery, Layer 1) + P.23/24/26
// (getCommitInfoForPath) — unit, fake GitHub client, REAL
// FileBaselinesStore (Phase 1 cold buckets) as `metadata.files`.

const PLUGIN_ID = "git-easy-sync";

type CompareFile = {
  filename: string;
  status: string;
  sha: string | null;
  previous_filename?: string;
};
type TreeFile = { path: string; sha: string; size: number | null };

describe("discovery Layer 1 (§VIII O)", () => {
  let dir: string;
  let vault: Vault;
  let baselines: FileBaselinesStore;
  let warnings: string[];
  let compareCalls: number;
  let treeCalls: number;

  // Fake client state each test crafts:
  let compareResult: CompareFile[] | "404" | Error;
  let treeResult: { files: TreeFile[]; truncated: boolean };

  const client: DiscoveryClient = {
    compare: async () => {
      compareCalls += 1;
      if (compareResult === "404") {
        throw new NotFoundError("compare 404");
      }
      if (compareResult instanceof Error) throw compareResult;
      return { files: compareResult };
    },
    getRepoTree: async () => {
      treeCalls += 1;
      return treeResult;
    },
  };

  const deps = (): DiscoveryDeps => ({
    client,
    baselines,
    isSyncable: (p) => !p.startsWith(".obsidian/plugins/"),
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  });

  const paths = (r: RemoteFileChange[]): string[] =>
    r.map((c) => c.path).sort();

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "discovery-test-"));
    vault = new Vault(dir);
    baselines = new FileBaselinesStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    warnings = [];
    compareCalls = 0;
    treeCalls = 0;
    compareResult = [];
    treeResult = { files: [], truncated: false };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("O.1: compare() under the cap → its list verbatim, ZERO tree calls", async () => {
    compareResult = [
      { filename: "a.md", status: "modified", sha: "sha-a" },
      { filename: "b.md", status: "added", sha: "sha-b" },
    ];
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    expect(paths(result)).toEqual(["a.md", "b.md"]);
    expect(result.find((c) => c.path === "a.md")).toEqual({
      path: "a.md",
      sha: "sha-a",
      size: null, // compare() has no sizes — Layer 2 / rule 7 fills later
      mtime: null,
      deleted: false,
    });
    expect(treeCalls).toBe(0);
  });

  it("O.1a: removed / renamed statuses → set-difference semantics (deletion candidates)", async () => {
    compareResult = [
      { filename: "gone.md", status: "removed", sha: "old-sha" },
      {
        filename: "new-name.md",
        status: "renamed",
        sha: "sha-r",
        previous_filename: "old-name.md",
      },
    ];
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    expect(paths(result)).toEqual(["gone.md", "new-name.md", "old-name.md"]);
    const gone = result.find((c) => c.path === "gone.md")!;
    expect(gone.deleted).toBe(true);
    expect(gone.sha).toBe(DELETED_SHA_HASH);
    expect(result.find((c) => c.path === "old-name.md")!.deleted).toBe(true);
    expect(result.find((c) => c.path === "new-name.md")).toMatchObject({
      sha: "sha-r",
      deleted: false,
    });
  });

  it("O.2: compare() at exactly 300 → tree fallback REPLACES (not supplements) the partial list", async () => {
    compareResult = Array.from({ length: COMPARE_FILES_CAP }, (_, i) => ({
      filename: `partial-${i}.md`,
      status: "modified",
      sha: `sha-${i}`,
    }));
    treeResult = {
      files: [{ path: "from-tree.md", sha: "tree-sha", size: 7 }],
      truncated: false,
    };
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    // Nothing from the partial compare list survives; the tree diff
    // is the whole answer.
    expect(paths(result)).toEqual(["from-tree.md"]);
    expect(treeCalls).toBe(1);
    expect(warnings.some((w) => w.includes("truncated at 300"))).toBe(true);
  });

  it("O.3: compare() 404 (force-push) → the SAME tree fallback; the error never escapes", async () => {
    compareResult = "404";
    treeResult = {
      files: [{ path: "x.md", sha: "sha-x", size: 3 }],
      truncated: false,
    };
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    expect(paths(result)).toEqual(["x.md"]);
    expect(warnings.some((w) => w.includes("force-push"))).toBe(true);
  });

  it("non-404 compare errors DO escape (the §III call site owns retry/token-latch)", async () => {
    compareResult = new Error("network layer down");
    await expect(
      getChangedFilesFromGitHubRepo(deps(), "base", "head"),
    ).rejects.toThrow("network layer down");
  });

  it("step 0 — cold start: base=null goes straight to the tree; empty baselines → the WHOLE repo", async () => {
    treeResult = {
      files: [
        { path: "a.md", sha: "s1", size: 1 },
        { path: "sub/b.md", sha: "s2", size: 2 },
      ],
      truncated: false,
    };
    const result = (await getChangedFilesFromGitHubRepo(deps(), null, "head")).changes;
    expect(paths(result)).toEqual(["a.md", "sub/b.md"]);
    expect(compareCalls).toBe(0);
  });

  it("O.4: path in tree with sha equal to our baseline → NOT a candidate", async () => {
    await baselines.set("same.md", {
      baselineSha: "sha-same",
      mtime: 1,
      size: 1,
    });
    treeResult = {
      files: [
        { path: "same.md", sha: "sha-same", size: 1 },
        { path: "differs.md", sha: "sha-new", size: 2 },
      ],
      truncated: false,
    };
    const result = (await fullTreeDiffAgainstColdBaseline(deps(), "head")).changes;
    expect(paths(result)).toEqual(["differs.md"]);
  });

  it("O.5: path in baselines, absent from tree → DELETED candidate", async () => {
    await baselines.set("vanished.md", {
      baselineSha: "sha-v",
      mtime: 1,
      size: 1,
    });
    treeResult = { files: [], truncated: false };
    const result = (await fullTreeDiffAgainstColdBaseline(deps(), "head")).changes;
    expect(result).toEqual([
      {
        path: "vanished.md",
        sha: DELETED_SHA_HASH,
        size: null,
        mtime: null,
        deleted: true,
      },
    ]);
  });

  it("O.6: path in tree, never seen in baselines → added candidate, size rides for free", async () => {
    treeResult = {
      files: [{ path: "brand-new.md", sha: "sha-n", size: 42 }],
      truncated: false,
    };
    const result = (await fullTreeDiffAgainstColdBaseline(deps(), "head")).changes;
    expect(result).toEqual([
      {
        path: "brand-new.md",
        sha: "sha-n",
        size: 42,
        mtime: null,
        deleted: false,
      },
    ]);
  });

  it("O.7: tree.truncated → TreeTruncatedError, a hard error, never a silent partial return", async () => {
    treeResult = {
      files: [{ path: "partial.md", sha: "s", size: 1 }],
      truncated: true,
    };
    await expect(
      fullTreeDiffAgainstColdBaseline(deps(), "head"),
    ).rejects.toThrow(TreeTruncatedError);
  });

  it("O.8: force-push that did NOT touch a file (tree sha == baseline) → not in result, no false conflict", async () => {
    await baselines.set("untouched.md", {
      baselineSha: "sha-u",
      mtime: 1,
      size: 1,
    });
    compareResult = "404";
    treeResult = {
      files: [
        { path: "untouched.md", sha: "sha-u", size: 1 },
        { path: "rewritten.md", sha: "sha-r2", size: 5 },
      ],
      truncated: false,
    };
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    expect(paths(result)).toEqual(["rewritten.md"]);
  });

  it("O.9: force-push + local edit → the candidate carries the REAL per-file baseline shape (sha differs from baseline, not from null)", async () => {
    // The point of feeding _diff3 a real base: the fallback reports
    // "changed vs OUR baseline", so downstream diff3 gets base =
    // baselineSha (from the same buckets), never null. Here we pin
    // the discovery half: the candidate appears exactly because
    // baselineSha differs, and the baseline row survives untouched.
    await baselines.set("edited.md", {
      baselineSha: "sha-old-base",
      mtime: 1,
      size: 1,
    });
    compareResult = "404";
    treeResult = {
      files: [{ path: "edited.md", sha: "sha-forced", size: 9 }],
      truncated: false,
    };
    const result = (await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes;
    expect(result).toEqual([
      {
        path: "edited.md",
        sha: "sha-forced",
        size: 9,
        mtime: null,
        deleted: false,
      },
    ]);
    expect((await baselines.get("edited.md"))!.baselineSha).toBe(
      "sha-old-base",
    );
  });

  it("isSyncable filters BOTH paths — compare list and tree diff", async () => {
    compareResult = [
      { filename: ".obsidian/plugins/x/data.json", status: "modified", sha: "s" },
      { filename: "kept.md", status: "modified", sha: "k" },
    ];
    expect(
      paths((await getChangedFilesFromGitHubRepo(deps(), "base", "head")).changes),
    ).toEqual(["kept.md"]);

    treeResult = {
      files: [
        { path: ".obsidian/plugins/x/data.json", sha: "s", size: 1 },
        { path: "kept.md", sha: "k2", size: 1 },
      ],
      truncated: false,
    };
    expect(paths((await fullTreeDiffAgainstColdBaseline(deps(), "head")).changes)).toEqual(
      ["kept.md"],
    );
  });
});

describe("getCommitInfoForPath (§VIII P.23-26)", () => {
  it("P.23: ONE request yields BOTH fields — device label from the message suffix, mtime from committer.date", async () => {
    let calls = 0;
    const info = await getCommitInfoForPath(
      {
        listCommitsForPath: async () => {
          calls += 1;
          return [
            {
              sha: "c1",
              date: "2026-08-30T12:00:00Z",
              message: "Sync at 2026-08-30 12:00 +0000 (laptop)",
            },
          ];
        },
      },
      "note.md",
      "headsha",
    );
    expect(calls).toBe(1);
    expect(info).toEqual({
      deviceLabel: "laptop",
      committedAtMs: Date.parse("2026-08-30T12:00:00Z"),
    });
  });

  it("P.24: foreign commit (no suffix) → UNKNOWN label but a REAL date → sibling name has a timestamp", async () => {
    const info = await getCommitInfoForPath(
      {
        listCommitsForPath: async () => [
          {
            sha: "c1",
            date: "2026-08-30T12:34:56Z",
            message: "edited on github.com web UI",
          },
        ],
      },
      "idea.md",
      "headsha",
    );
    expect(info!.deviceLabel).toBe("unknown");
    const sibling = buildSiblingFilePath(
      "idea.md",
      info!.committedAtMs,
      info!.deviceLabel,
    );
    expect(sibling).toBe(
      "idea.conflict-from-unknown-2026-08-30T12-34-56Z.md",
    );
  });

  it("P.26 (regression 2026-08-29): discovery's mtime is null by design — the conflict site fills it via getCommitInfoForPath, so the sibling name NEVER loses its date", async () => {
    // Discovery half: no source carries dates.
    const discovered: RemoteFileChange = {
      path: "note.md",
      sha: "sha-x",
      size: null,
      mtime: null,
      deleted: false,
    };
    expect(discovered.mtime).toBeNull();
    // Conflict-site half: one lazy call fills the date.
    const info = await getCommitInfoForPath(
      {
        listCommitsForPath: async () => [
          {
            sha: "c9",
            date: "2026-01-02T03:04:05Z",
            message: "Sync at 2026-01-02 03:04 +0000 (phone)",
          },
        ],
      },
      discovered.path,
      "headsha",
    );
    const sibling = buildSiblingFilePath(
      discovered.path,
      info!.committedAtMs,
      info!.deviceLabel,
    );
    expect(sibling).toContain("conflict-from-phone-2026-01-02T03-04-05Z");
  });

  it("path with no commits at the ref → null (caller decides the degraded name)", async () => {
    expect(
      await getCommitInfoForPath(
        { listCommitsForPath: async () => [] },
        "ghost.md",
        "headsha",
      ),
    ).toBeNull();
  });
});
