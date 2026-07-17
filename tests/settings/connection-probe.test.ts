import { describe, it, expect } from "vitest";
import {
  probeGitHubConnection,
  type ProbeHttpGet,
  type ProbeHttpResult,
} from "../../src/settings/connection-probe";

// Pure probe decision logic (bug-60 + §35 auth parity). No network — a
// configurable fake httpGet returns per-endpoint responses.

type Resp = Partial<ProbeHttpResult> & { status: number };

function fakeHttpGet(cfg: { repo: Resp; branch?: Resp; list?: Resp }): ProbeHttpGet {
  const fill = (r: Resp): ProbeHttpResult => ({
    json: undefined,
    text: "",
    headers: {},
    ...r,
  });
  return async (url) => {
    if (url.includes("/branches?")) return fill(cfg.list ?? { status: 200, json: [] });
    if (url.includes("/branches/")) return fill(cfg.branch ?? { status: 404 });
    return fill(cfg.repo); // GET /repos/{owner}/{repo}
  };
}

const okRepo: Resp = {
  status: 200,
  json: { private: true, default_branch: "main", full_name: "acme/vault" },
};

const base = { owner: "acme", repo: "vault", token: "ghp_x" };

describe("probeGitHubConnection — bug-60 empty/bare repo", () => {
  it("EMPTY repo + a NAMED (arbitrary) branch → OK, will be created on first sync", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "my-cool-branch",
      httpGet: fakeHttpGet({
        repo: okRepo,
        branch: { status: 404 }, // branch doesn't exist yet
        list: { status: 200, json: [] }, // repo is bare — NO branches
      }),
    });
    expect(outcome.level).toBe("ok");
    expect(outcome.message).toContain("EMPTY");
    expect(outcome.message).toContain("my-cool-branch");
    expect(outcome.message).toContain("will be created");
  });

  it("EMPTY repo + EMPTY branch field → OK, assumes `main`", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "",
      httpGet: fakeHttpGet({ repo: okRepo, branch: { status: 404 }, list: { status: 200, json: [] } }),
    });
    expect(outcome.level).toBe("ok");
    expect(outcome.message).toContain("assuming `main`");
  });

  it("NON-empty repo + missing branch → typo error (only a pre-existing branch is allowed)", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "nope",
      httpGet: fakeHttpGet({
        repo: okRepo,
        branch: { status: 404 },
        list: { status: 200, json: [{ name: "main" }] }, // repo HAS branches
      }),
    });
    expect(outcome.level).toBe("err");
    expect(outcome.message).toContain("not found");
  });

  it("existing branch → OK, reports HEAD", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "main",
      httpGet: fakeHttpGet({
        repo: okRepo,
        branch: { status: 200, json: { commit: { sha: "abcdef1234567" } } },
      }),
    });
    expect(outcome.level).toBe("ok");
    expect(outcome.message).toContain("branch `main` exists");
    expect(outcome.message).toContain("abcdef1");
  });

  it("STRICT emptiness: branch 404 + branch-list 500 → keeps the typo error (no false green)", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "x",
      httpGet: fakeHttpGet({ repo: okRepo, branch: { status: 404 }, list: { status: 500 } }),
    });
    expect(outcome.level).toBe("err");
    expect(outcome.message).toContain("not found");
  });

  it("STRICT emptiness: branch 404 + branch-list 200 but non-array → keeps the typo error", async () => {
    const outcome = await probeGitHubConnection({
      ...base,
      branch: "x",
      httpGet: fakeHttpGet({ repo: okRepo, branch: { status: 404 }, list: { status: 200, json: {} } }),
    });
    expect(outcome.level).toBe("err");
  });
});

describe("probeGitHubConnection — §35 auth parity + repo errors", () => {
  const withRepoStatus = (r: Resp) =>
    probeGitHubConnection({ ...base, branch: "main", httpGet: fakeHttpGet({ repo: r }) });

  it("401 → err + authKind 'invalid'", async () => {
    const o = await withRepoStatus({ status: 401 });
    expect(o).toMatchObject({ level: "err", authKind: "invalid" });
  });
  it("403 → err + authKind 'scope'", async () => {
    const o = await withRepoStatus({ status: 403 });
    expect(o).toMatchObject({ level: "err", authKind: "scope" });
  });
  it("404 repo → err, NO authKind", async () => {
    const o = await withRepoStatus({ status: 404 });
    expect(o.level).toBe("err");
    expect(o.authKind).toBeUndefined();
  });
  it("500 repo → err, NO authKind", async () => {
    const o = await withRepoStatus({ status: 500 });
    expect(o.level).toBe("err");
    expect(o.authKind).toBeUndefined();
  });
  it("missing token/owner/repo → err 'fill in'", async () => {
    const o = await probeGitHubConnection({
      owner: "",
      repo: "vault",
      token: "t",
      branch: "main",
      httpGet: fakeHttpGet({ repo: okRepo }),
    });
    expect(o.level).toBe("err");
    expect(o.message).toContain("Fill in");
  });
  it("a successful probe carries no authKind (caller clears the latch)", async () => {
    const o = await probeGitHubConnection({
      ...base,
      branch: "main",
      httpGet: fakeHttpGet({ repo: okRepo, branch: { status: 200, json: { commit: { sha: "deadbeef" } } } }),
    });
    expect(o.level).toBe("ok");
    expect(o.authKind).toBeUndefined();
  });
});
