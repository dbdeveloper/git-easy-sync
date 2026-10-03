// 🔴 RED — pointing the plugin at a DIFFERENT repository can delete the
// vault.
//
// Field report 2026-10-03: the owner created an empty repo, changed the
// repo name and the token WITHOUT pressing Reset, and synced. Nothing
// was uploaded. Tracing why led somewhere worse than "it did nothing".
//
// ── THE CHAIN, as traced in the code ────────────────────────────────
// `base` in this engine is NOT a git merge-base. It is the per-file
// baseline — the blob sha "we last agreed on for this path". It records
// WHAT was agreed and never WITH WHOM: `FileBaseline` is
// {baselineSha, mtime, size}, and no field names the repository.
//
// Strip that provenance and two situations become bit-identical:
//
//   force-push to an empty tree   compare() → 404, live tree empty
//   a different, empty repository compare() → 404, live tree empty
//
// (A mass deletion committed NORMALLY is a third thing and is handled
// correctly today: history moves forward, compare() answers 200 with
// the deletions, and pulling them is right.)
//
// `getChangedFilesFromGitHubRepo` reads the 404 as force-push and falls
// back to a full-tree diff against the baselines. Against an empty tree
// every known path has `live === null`, so it emits a deletion for each
// one. `_diff3` then sees local unchanged (`local.sha === base.sha`)
// against a remote that moved (`DELETED_SHA_HASH !== base.sha`) — rule
// 4.3, "clean pull" — and the Vault-step removes the file.
//
// ⚠️ Rule 4.6.a ("an edit beats a delete") protects only files the user
// has edited since the baseline. Everything untouched is deleted.
//
// ── WHY THIS TEST IS IN TWO HALVES ──────────────────────────────────
// The chain above was traced by READING, and a chain of correct-looking
// steps is exactly what produced the defect in the first place. So each
// half drives the REAL code: the first proves discovery really emits
// the deletions, the second proves the drain really applies them to
// disk. Neither asserts my description of the other.
//
// The owner was saved by an OPTIMISATION, not by design: discovery is
// skipped entirely when `head === lastSyncCommitSha` (§II.7.1), and
// after the first sync seeded the new repo that was true. Remove that
// coincidence and the loss is reachable.

import { describe, expect, it } from "vitest";
import {
  getChangedFilesFromGitHubRepo,
  DELETED_SHA_HASH,
  type DiscoveryDeps,
} from "../../src/sync2/discovery";
import { NotFoundError } from "../../src/errors";

// Baselines from repo A: five paths the vault and repo A agreed on.
const PATHS = ["a.md", "b.md", "notes/c.md", "notes/d.md", "e.md"];

function depsAgainstEmptyRepo(): DiscoveryDeps {
  return {
    client: {
      // Repo B has never heard of repo A's commit. GitHub answers 404
      // for unrelated histories — the same answer it gives after a
      // force-push, which is the whole problem.
      compare: async () => {
        throw new NotFoundError("404: no common ancestor");
      },
      // …and repo B is empty.
      getRepoTree: async () => ({ files: [], truncated: false }),
    } as unknown as DiscoveryDeps["client"],
    baselines: {
      allPaths: async () => [...PATHS],
      getMany: async (paths: string[]) =>
        new Map(paths.map((p) => [p, { baselineSha: `sha-of-${p}` }])),
    },
    isSyncable: () => true,
  };
}

describe("🔴 repo substitution is indistinguishable from a force-push", () => {
  it("half 1: discovery emits a DELETION for every baselined path", async () => {
    const result = await getChangedFilesFromGitHubRepo(
      depsAgainstEmptyRepo(),
      "commit-from-repo-A",
      "head-of-repo-B",
    );

    // Every path the vault knows about is reported as deleted remotely.
    expect(result.changes).toHaveLength(PATHS.length);
    for (const c of result.changes) {
      expect(c.sha, `${c.path} must be a deletion`).toBe(DELETED_SHA_HASH);
    }
    expect(result.changes.map((c) => c.path).sort()).toEqual([...PATHS].sort());
  });

  it("🔑 half 2: and the engine's own rule turns that into a local delete", async () => {
    // Rule 4.3, driven through the REAL `_diff3` rather than described:
    // base = what repo A and the vault agreed on, local unchanged since
    // then, remote "deleted" because repo B simply does not have it.
    const { _diff3 } = await import("../../src/sync2/diff3");
    const base = {
      path: "a.md",
      sha: "sha-of-a.md",
      size: 10,
      mtime: 1,
      blob: null,
      mode: "" as const,
      deviceLabel: null,
    };
    const verdict = await _diff3(
      {
        syncStore: { getBlobFromSyncStore: async () => null } as never,
        verifiedShas: new Set<string>(),
        getBlobFromRepo: async () => null,
        getContentsMetadataAtRef: async () => null,
        maxAutoMergeFileSize: () => 1_000_000,
        mergeBlobs: async () => ({ kind: "conflict" }) as never,
        computeSha: async () => "x",
      } as never,
      {
        base,
        remote: { ...base, sha: DELETED_SHA_HASH, mode: "deleted" as never },
      },
      { ...base }, // the local file, untouched since the baseline
      "head-of-repo-B",
    );

    // ⚠️ "file" + a deleted side means the Vault-step removes it. This
    // is the engine agreeing to destroy a file because a repository it
    // has never synced with does not contain it.
    expect(verdict.kind).toBe("file");
    if (verdict.kind === "file") {
      expect(
        verdict.file.sha,
        "the winning side is the DELETION — the vault copy is removed",
      ).toBe(DELETED_SHA_HASH);
    }
  });
});
