import { describe, it, expect, beforeEach } from "vitest";
import GithubClient from "../../src/github/client";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { ValidationError } from "../../src/errors";

// Phase 5.5 step 2a — the two client methods the new drain's
// conflict-branch surface needs (DrainClient contract, drain.ts):
//   getBranchHeadShaByName — live read of an arbitrary branch, null on 404
//   pushCommitToBranch     — blob-list → tree → commit → ref composition
// Fake network worker, same harness as contents-metadata-head.test.ts.

type FakeResponse = {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
};
type SeenRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

describe("pushCommitToBranch + getBranchHeadShaByName (Phase 5.5 step 2a)", () => {
  let seen: SeenRequest[];
  let queue: FakeResponse[];

  const makeClient = (): GithubClient =>
    new GithubClient(
      {
        ...DEFAULT_SETTINGS,
        githubToken: "t",
        githubOwner: "o",
        githubRepo: "r",
        githubBranch: "main",
      },
      { info: () => {}, warn: () => {}, error: () => {} } as never,
      {
        httpRequest: async (req: SeenRequest) => {
          seen.push(req);
          const next = queue.shift();
          if (!next) throw new Error("fake worker: no response queued");
          return next;
        },
      } as never,
    );

  beforeEach(() => {
    seen = [];
    queue = [];
  });

  const ok = (json: unknown): FakeResponse => ({
    status: 200,
    text: "",
    json,
    headers: {},
  });
  const created = (json: unknown): FakeResponse => ({
    status: 201,
    text: "",
    json,
    headers: {},
  });
  const body = (i: number): Record<string, unknown> =>
    JSON.parse(seen[i].body ?? "{}") as Record<string, unknown>;

  // ── getBranchHeadShaByName ─────────────────────────────────────────

  it("by-name head read uses the SINGULAR /git/ref/ endpoint with a cache-buster and returns object.sha", async () => {
    queue.push(ok({ object: { sha: "headsha1" } }));
    const sha = await makeClient().getBranchHeadShaByName({
      branch: "git-easy-sync-conflicts-lbl-123",
    });
    expect(sha).toBe("headsha1");
    expect(seen).toHaveLength(1);
    // Singular form: the PLURAL /git/refs/heads/{name} does prefix
    // MATCHING and answers an ARRAY when {name} prefixes another
    // branch — .object would be undefined and the read silently
    // broken. Mutable ref → must carry the ts cache-buster.
    expect(seen[0].url).toMatch(
      /\/git\/ref\/heads\/git-easy-sync-conflicts-lbl-123\?ts=\d+$/,
    );
  });

  it("by-name head read: 404 (no branch) AND 409 (bare repo — no commits at all) both mean null, NOT an error", async () => {
    queue.push({ status: 404, text: "", json: {}, headers: {} });
    expect(
      await makeClient().getBranchHeadShaByName({ branch: "gone" }),
    ).toBeNull();
    queue.push({ status: 409, text: "", json: {}, headers: {} });
    expect(
      await makeClient().getBranchHeadShaByName({ branch: "any" }),
    ).toBeNull();
  });

  // ── pushCommitToBranch ─────────────────────────────────────────────

  it("parent=null: the fresh branch is ROOTED AT MAIN HEAD (unrelated histories 404 GitHub's compare — gate finding), then createReference", async () => {
    queue.push(ok({ object: { sha: "mainhead" } })); // getBranchHeadSha (main)
    queue.push(ok({ tree: { sha: "maintree" }, committer: { date: "" } })); // getCommit(mainhead)
    queue.push(created({ sha: "tree1" })); // createTree
    queue.push(created({ sha: "commit1" })); // createCommit
    queue.push(created({})); // createReference
    const r = await makeClient().pushCommitToBranch({
      branch: "cb",
      parent: null,
      entries: [{ path: "note.md", sha: "blob1" }],
      message: "Sync at test (dev)",
    });
    expect(r).toEqual({ sha: "commit1" });
    expect(seen[0].url).toMatch(/\/git\/refs\/heads\/main\?ts=\d+$/); // main head read
    expect(seen[1].url).toMatch(/\/git\/commits\/mainhead$/);
    expect(body(2)).toEqual({
      tree: [{ path: "note.md", mode: "100644", type: "blob", sha: "blob1" }],
      base_tree: "maintree", // ON TOP of main's tree
    });
    expect(body(3).parents).toEqual(["mainhead"]); // related history
    expect(seen[4].url).toMatch(/\/git\/refs$/);
    expect(body(4)).toEqual({ ref: "refs/heads/cb", sha: "commit1" });
  });

  it("parent set: getCommit for base_tree, commit chained on parent, non-force PATCH of the branch ref", async () => {
    queue.push(ok({ tree: { sha: "ptree" }, committer: { date: "" } })); // getCommit
    queue.push(created({ sha: "tree2" })); // createTree
    queue.push(created({ sha: "commit2" })); // createCommit
    queue.push(ok({})); // updateReference
    const r = await makeClient().pushCommitToBranch({
      branch: "cb",
      parent: "parent1",
      entries: [
        { path: "a.md", sha: "b1" },
        { path: "b.md", sha: "b2" },
      ],
      message: "m",
    });
    expect(r).toEqual({ sha: "commit2" });
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toMatch(/\/git\/commits\/parent1$/);
    expect(body(1).base_tree).toBe("ptree");
    expect(body(2).parents).toEqual(["parent1"]);
    expect(seen[3].method).toBe("PATCH");
    expect(seen[3].url).toMatch(/\/git\/refs\/heads\/cb$/);
    expect(body(3)).toEqual({ sha: "commit2", force: false }); // NON-force
  });

  it("stale parent → PATCH 422 surfaces as ValidationError (the drain's 3-attempt re-read loop catches it)", async () => {
    queue.push(ok({ tree: { sha: "ptree" }, committer: { date: "" } }));
    queue.push(created({ sha: "t" }));
    queue.push(created({ sha: "c" }));
    queue.push({ status: 422, text: "", json: {}, headers: {} });
    await expect(
      makeClient().pushCommitToBranch({
        branch: "cb",
        parent: "stale",
        entries: [{ path: "a.md", sha: "b" }],
        message: "m",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("parent=null raced by another creator → createReference 422 'already exists' is ALSO ValidationError", async () => {
    queue.push(ok({ object: { sha: "mainhead" } }));
    queue.push(ok({ tree: { sha: "maintree" }, committer: { date: "" } }));
    queue.push(created({ sha: "t" }));
    queue.push(created({ sha: "c" }));
    queue.push({ status: 422, text: "", json: {}, headers: {} });
    await expect(
      makeClient().pushCommitToBranch({
        branch: "cb",
        parent: null,
        entries: [{ path: "a.md", sha: "b" }],
        message: "m",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── author pass-through (step-4 wiring; mechanism pinned here) ────

  it("author pass-through: pushCommitFromTree sends author AND committer when given, NEITHER when omitted", async () => {
    const author = { name: "n", email: "e", date: "2026-08-31T00:00:00Z" };
    queue.push(created({ sha: "c1", committer: { date: "2026-08-31T01:00:00Z" } }));
    queue.push(ok({}));
    await makeClient().pushCommitFromTree({
      treeSha: "t",
      parent: "p",
      message: "m",
      author,
    });
    expect(body(0).author).toEqual(author);
    expect(body(0).committer).toEqual(author);

    seen = [];
    queue.push(created({ sha: "c2", committer: { date: "2026-08-31T01:00:00Z" } }));
    queue.push(ok({}));
    await makeClient().pushCommitFromTree({
      treeSha: "t",
      parent: "p",
      message: "m",
    });
    expect("author" in body(0)).toBe(false);
    expect("committer" in body(0)).toBe(false);
  });
});
