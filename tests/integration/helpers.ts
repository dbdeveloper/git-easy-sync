import {
  installRequestFaultInjector,
  type FakeResponse,
  type RequestFaultInjector,
} from "../../mock-obsidian";

// ----------------------------------------------------------------------------
// Env access — two distinct setups by design:
//   - "main" env: fine-grained PAT against a private test repo. Used by
//     every test except bootstrap. Token cannot create or delete repos,
//     so its leak surface is just the one selected repo's contents.
//   - "bootstrap" env: classic PAT with public_repo scope against an
//     ephemeral PUBLIC test repo. Used only by bootstrap tests, which
//     need delete+recreate to regain the bare-repo state. Public means
//     the token can't reach private data; ephemeral means the repo
//     is recreated per test, so leak blast radius is "delete a public
//     test repo we'd recreate anyway".
// ----------------------------------------------------------------------------

export function integrationEnabled(): boolean {
  return Boolean(
    process.env.GITHUB_TOKEN &&
      process.env.INT_TEST_OWNER &&
      process.env.INT_TEST_REPO,
  );
}

export function bootstrapEnabled(): boolean {
  return Boolean(
    process.env.GITHUB_BOOTSTRAP_TOKEN &&
      process.env.INT_TEST_OWNER &&
      process.env.INT_BOOTSTRAP_TEST_REPO,
  );
}

export interface RepoEnv {
  token: string;
  owner: string;
  repo: string;
  branchPrefix: string;
  /** True if the repo is meant to be created public via recreateRepo. */
  isPublic: boolean;
}

export function requireEnv(): RepoEnv {
  if (!integrationEnabled()) {
    throw new Error(
      "Integration env missing. Set GITHUB_TOKEN, INT_TEST_OWNER, INT_TEST_REPO.",
    );
  }
  return {
    token: process.env.GITHUB_TOKEN as string,
    owner: process.env.INT_TEST_OWNER as string,
    repo: process.env.INT_TEST_REPO as string,
    branchPrefix: process.env.INT_TEST_BRANCH_PREFIX || "int-test",
    isPublic: false,
  };
}

export function requireBootstrapEnv(): RepoEnv {
  if (!bootstrapEnabled()) {
    throw new Error(
      "Bootstrap env missing. Set GITHUB_BOOTSTRAP_TOKEN, INT_TEST_OWNER, INT_BOOTSTRAP_TEST_REPO.",
    );
  }
  return {
    token: process.env.GITHUB_BOOTSTRAP_TOKEN as string,
    owner: process.env.INT_TEST_OWNER as string,
    repo: process.env.INT_BOOTSTRAP_TEST_REPO as string,
    branchPrefix: process.env.INT_TEST_BRANCH_PREFIX || "int-test",
    isPublic: true,
  };
}

// ----------------------------------------------------------------------------
// Per-test branch naming + raw GitHub API helpers
// ----------------------------------------------------------------------------

let counter = 0;

/** Globally-unique branch name for one test. Caller deletes via deleteBranchIfExists. */
export function uniqueBranchName(scenario: string): string {
  const { branchPrefix } = requireEnv();
  counter += 1;
  const stamp = `${Date.now()}-${counter}`;
  // GitHub branch names allow most ASCII; sanitise anyway.
  const safe = scenario.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${branchPrefix}-${safe}-${stamp}`;
}

const GH = "https://api.github.com";

function ghHeaders(token?: string): Record<string, string> {
  // Default to the main (fine-grained) token; bootstrap helpers pass
  // their own classic token in for repo create/delete calls.
  const useToken = token ?? requireEnv().token;
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${useToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * URL-encode each `/`-separated segment, leaving the slashes alone.
 * GitHub's Contents API expects this shape: each path component is
 * percent-encoded, but the path structure is preserved. Without it,
 * paths with spaces / Cyrillic / `()` etc. produce malformed URLs
 * and 404 responses.
 */
function encodePathForUrl(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

async function ghFetch(
  url: string,
  init?: { method?: string; body?: unknown; token?: string },
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: init?.method || "GET",
    headers: {
      ...ghHeaders(init?.token),
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  return { status: res.status, json, text };
}

/**
 * Delete a branch if it exists. Treats 404 as a no-op (branch already
 * gone) and 409 as a no-op (repo is bare → there are no refs to
 * delete in the first place). Useful in afterEach as well as
 * before-create.
 *
 * Defaults to the main env (private repo + fine-grained PAT). Pass
 * env explicitly when targeting the bootstrap repo.
 */
export async function deleteBranchIfExists(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<void> {
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "DELETE", token },
  );
  if (
    res.status !== 204 &&
    res.status !== 422 &&
    res.status !== 404 &&
    res.status !== 409
  ) {
    throw new Error(
      `deleteBranchIfExists ${branch} → ${res.status}: ${res.text}`,
    );
  }
}

/**
 * List existing test branches with our prefix. Lets cleanup pick up
 * branches left behind by crashed previous runs. Returns [] on a
 * bare repo (no branches exist yet).
 */
export async function listTestBranches(
  env: RepoEnv = requireEnv(),
): Promise<string[]> {
  const { token, owner, repo, branchPrefix } = env;
  const out: string[] = [];
  let page = 1;
  for (;;) {
    const res = await ghFetch(
      `${GH}/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      { token },
    );
    if (res.status === 404 || res.status === 409) {
      return [];
    }
    if (res.status !== 200) {
      throw new Error(`listTestBranches → ${res.status}: ${res.text}`);
    }
    const names = (res.json as Array<{ name: string }>).map((b) => b.name);
    if (names.length === 0) break;
    out.push(...names.filter((n) => n.startsWith(`${branchPrefix}-`)));
    if (names.length < 100) break;
    page += 1;
  }
  return out;
}

/**
 * Sweep leftover test branches. Safe to run before suite or in
 * afterAll — only touches branches whose name starts with the
 * configured prefix. Note: GitHub auto-promotes the first branch in
 * a previously-bare repo to "default", and default branches can't be
 * deleted via DELETE /git/refs. If you need to truly reset, use
 * recreateRepo() instead.
 */
export async function cleanupAllTestBranches(
  env: RepoEnv = requireEnv(),
): Promise<number> {
  const branches = await listTestBranches(env);
  for (const b of branches) {
    await deleteBranchIfExists(b, env);
  }
  return branches.length;
}

/**
 * Delete the given repo if it exists. Treats 404 as a no-op (repo
 * already gone). Used by globalTeardown to wipe the ephemeral
 * bootstrap repo after all integration tests finish, so the public
 * repo + classic-PAT exposure window is as small as possible.
 */
export async function deleteRepoIfExists(env: RepoEnv): Promise<void> {
  const { token, owner, repo } = env;
  const res = await ghFetch(`${GH}/repos/${owner}/${repo}`, {
    method: "DELETE",
    token,
  });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`deleteRepoIfExists → ${res.status}: ${res.text}`);
  }
}

/**
 * Delete the given repo and create it fresh as a bare repo (no
 * commits, no default branch, no auto-init README). The only way to
 * get the "bare repo" state that bootstrap tests need: GitHub auto-
 * promotes the first commit's branch to default, and default
 * branches can't be deleted, so once a test creates any commit the
 * repo is no longer bare.
 *
 * Pass the bootstrap env (classic PAT + public repo) — the
 * fine-grained PAT used by other tests can't create or delete repos.
 *
 * GitHub's repo deletion is slow and eventually-consistent — it can
 * take 30+ seconds before POST /user/repos accepts the same name
 * again. We poll GET /repos/{owner}/{repo} until it returns 404
 * before attempting the create, then retry the POST a few times in
 * case the namespace lock lingers a beat longer than the GET says.
 */
export async function recreateRepo(env: RepoEnv): Promise<void> {
  const { token, owner, repo, isPublic } = env;
  const del = await ghFetch(`${GH}/repos/${owner}/${repo}`, {
    method: "DELETE",
    token,
  });
  if (del.status !== 204 && del.status !== 404) {
    throw new Error(`recreateRepo DELETE → ${del.status}: ${del.text}`);
  }

  // Wait until the repo is truly gone from GitHub's perspective. Poll
  // up to 90 s with a 2 s interval — typical case completes in 5-15 s,
  // but tail latency can stretch.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const probe = await ghFetch(`${GH}/repos/${owner}/${repo}`, { token });
    if (probe.status === 404) break;
    if (probe.status !== 200) {
      throw new Error(
        `recreateRepo poll-after-delete → ${probe.status}: ${probe.text}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Even after GET 404s, the namespace lock can linger briefly, so
  // retry the POST a few times. Carry the last error message forward
  // for the give-up exception so it's clear what GitHub actually said.
  let lastBody = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const create = await ghFetch(`${GH}/user/repos`, {
      method: "POST",
      token,
      body: { name: repo, private: !isPublic, auto_init: false },
    });
    if (create.status === 201) return;
    if (create.status !== 422) {
      throw new Error(`recreateRepo POST → ${create.status}: ${create.text}`);
    }
    lastBody = create.text;
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  throw new Error(
    `recreateRepo POST kept hitting 422 after retries. Last body: ${lastBody}`,
  );
}

/**
 * Read a file's blob SHA on a given branch (resolves the path through
 * the branch's tree). Returns null if the path isn't in the tree.
 */
export async function getRemoteFileSha(
  branch: string,
  path: string,
  env: RepoEnv = requireEnv(),
): Promise<string | null> {
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { token },
  );
  if (res.status === 404 || res.status === 409) return null;
  if (res.status !== 200) {
    throw new Error(`getRemoteFileSha → ${res.status}: ${res.text}`);
  }
  const tree = res.json.tree as Array<{
    path: string;
    type: string;
    sha: string;
  }>;
  const entry = tree.find((t) => t.path === path && t.type === "blob");
  return entry ? entry.sha : null;
}

/**
 * Write or replace a file directly on remote via the Contents API.
 * Used by tests to simulate web-UI edits without touching the
 * SyncManager. If the path already exists on the branch, you must
 * pass a non-null sha to the underlying call — we look it up here.
 *
 * Accepts a UTF-8 string for text or a Buffer for binary content.
 */
export async function writeRemoteFile(
  branch: string,
  path: string,
  content: string | Buffer,
  message: string,
  env: RepoEnv = requireEnv(),
): Promise<void> {
  const { token, owner, repo } = env;
  const existingSha = await getRemoteFileSha(branch, path, env);
  const buf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, "utf-8");
  const body: Record<string, unknown> = {
    message,
    content: buf.toString("base64"),
    branch,
  };
  if (existingSha) body.sha = existingSha;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/contents/${encodePathForUrl(path)}`,
    { method: "PUT", token, body },
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`writeRemoteFile → ${res.status}: ${res.text}`);
  }
}

/**
 * Delete a file directly on remote via the Contents API. Simulates
 * a web-UI deletion. Throws if the file isn't there.
 */
export async function removeRemoteFile(
  branch: string,
  path: string,
  message: string,
  env: RepoEnv = requireEnv(),
): Promise<void> {
  const { token, owner, repo } = env;
  const sha = await getRemoteFileSha(branch, path, env);
  if (!sha) {
    throw new Error(`removeRemoteFile: ${path} not in branch ${branch}`);
  }
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/contents/${encodePathForUrl(path)}`,
    { method: "DELETE", token, body: { message, sha, branch } },
  );
  if (res.status !== 200) {
    throw new Error(`removeRemoteFile → ${res.status}: ${res.text}`);
  }
}

/**
 * Returns all blob paths in a branch's tree. Useful for assertions
 * like "remote should contain exactly these N files".
 */
export async function listRemoteFiles(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<string[]> {
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { token },
  );
  if (res.status === 404 || res.status === 409) return [];
  if (res.status !== 200) {
    throw new Error(`listRemoteFiles → ${res.status}: ${res.text}`);
  }
  const tree = res.json.tree as Array<{ path: string; type: string }>;
  return tree.filter((t) => t.type === "blob").map((t) => t.path);
}

/**
 * Read a remote file's content as UTF-8 string (decoded from base64).
 * Throws if the file isn't there.
 */
export async function readRemoteFile(
  branch: string,
  path: string,
  env: RepoEnv = requireEnv(),
): Promise<string> {
  const sha = await getRemoteFileSha(branch, path, env);
  if (sha === null) {
    throw new Error(`readRemoteFile: ${path} not in branch ${branch}`);
  }
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/git/blobs/${sha}`,
    { token },
  );
  if (res.status !== 200) {
    throw new Error(`readRemoteFile blob → ${res.status}: ${res.text}`);
  }
  return Buffer.from(res.json.content as string, "base64").toString("utf-8");
}

/**
 * Latest commit SHA for a branch (used to assert "exactly one commit"
 * after bootstrap, etc.).
 */
export async function getBranchHead(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<string | null> {
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    { token },
  );
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`getBranchHead → ${res.status}: ${res.text}`);
  }
  return res.json.object.sha as string;
}

/**
 * How many commits a branch has in its history (since the root). Used
 * to assert bootstrap collapses to a single commit. Walks the commit
 * chain via the Git Data API (`/git/commits/<sha>`) rather than the
 * higher-level `/commits` endpoint, because the latter requires the
 * repo to have a default branch set — and a bare test repo doesn't.
 */
/**
 * Walk the branch's commit history (first-parent) and return each
 * commit's message, newest first. Capped at 100 commits to avoid
 * runaway walks. Used by tests that care about commit-message
 * content (e.g. asserting that a custom-message commit appears
 * verbatim somewhere in history).
 */
export async function getBranchCommitMessages(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<string[]> {
  const { token, owner, repo } = env;
  const head = await getBranchHead(branch, env);
  if (head === null) return [];
  const out: string[] = [];
  let sha: string | null = head;
  let count = 0;
  while (sha !== null && count < 100) {
    count += 1;
    const res = await ghFetch(
      `${GH}/repos/${owner}/${repo}/git/commits/${sha}`,
      { token },
    );
    if (res.status !== 200) {
      throw new Error(
        `getBranchCommitMessages walk → ${res.status}: ${res.text}`,
      );
    }
    out.push(res.json.message as string);
    const parents = res.json.parents as Array<{ sha: string }>;
    sha = parents.length > 0 ? parents[0].sha : null;
  }
  return out;
}

/**
 * Walk the branch's commit history (first-parent) and return each
 * commit's SHA, newest first. Same walk as getBranchCommitMessages,
 * capped at 100. Tests that need per-commit file content slice this
 * list down to "commits after <baseline>" and pass each SHA where a
 * tree-ish is accepted (getRemoteFileSha / readRemoteFile take any
 * tree-ish, not just a branch name).
 */
export async function getBranchCommitShas(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<string[]> {
  const { token, owner, repo } = env;
  const head = await getBranchHead(branch, env);
  if (head === null) return [];
  const out: string[] = [];
  let sha: string | null = head;
  let count = 0;
  while (sha !== null && count < 100) {
    count += 1;
    const res = await ghFetch(
      `${GH}/repos/${owner}/${repo}/git/commits/${sha}`,
      { token },
    );
    if (res.status !== 200) {
      throw new Error(`getBranchCommitShas walk → ${res.status}: ${res.text}`);
    }
    out.push(sha);
    const parents = res.json.parents as Array<{ sha: string }>;
    sha = parents.length > 0 ? parents[0].sha : null;
  }
  return out;
}

export async function countBranchCommits(
  branch: string,
  env: RepoEnv = requireEnv(),
): Promise<number> {
  const { token, owner, repo } = env;
  const head = await getBranchHead(branch, env);
  if (head === null) return 0;
  let sha: string | null = head;
  let count = 0;
  while (sha !== null && count < 100) {
    count += 1;
    const res = await ghFetch(
      `${GH}/repos/${owner}/${repo}/git/commits/${sha}`,
      { token },
    );
    if (res.status !== 200) {
      throw new Error(`countBranchCommits walk → ${res.status}: ${res.text}`);
    }
    const parents = res.json.parents as Array<{ sha: string }>;
    sha = parents.length > 0 ? parents[0].sha : null;
  }
  if (count === 100) {
    throw new Error("countBranchCommits hit the 100-commit safety cap");
  }
  return count;
}

// ----------------------------------------------------------------------------
// Baseline helpers — non-bootstrap suites (B/C/D/E + A3) work on the
// private int-test repo. Each test runs on its own branch off the
// default branch, so the int-test repo needs at least one commit
// somewhere first. ensureRepoNotBare() lazily provides that baseline
// by bootstrapping main on the first call; subsequent calls are
// cheap (one branches GET).
// ----------------------------------------------------------------------------

/**
 * Returns the SHA the default branch points at, or null if the repo
 * is bare. The repo's `default_branch` field exists even when bare
 * (it's just the configured default name like "main"); we have to
 * resolve the ref separately.
 */
export async function getDefaultBranchHead(
  env: RepoEnv = requireEnv(),
): Promise<string | null> {
  const { token, owner, repo } = env;
  const repoInfo = await ghFetch(`${GH}/repos/${owner}/${repo}`, { token });
  if (repoInfo.status !== 200) {
    throw new Error(`getDefaultBranchHead repo → ${repoInfo.status}: ${repoInfo.text}`);
  }
  const defaultBranch = repoInfo.json.default_branch as string;
  return getBranchHead(defaultBranch, env);
}

/**
 * Create a branch ref pointing at a given commit. Used to derive
 * per-test branches off the int-test repo's main without going
 * through full bootstrap each time.
 */
export async function createBranchFromHead(
  branch: string,
  fromSha: string,
  env: RepoEnv = requireEnv(),
): Promise<void> {
  const { token, owner, repo } = env;
  const res = await ghFetch(`${GH}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    token,
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
  if (res.status !== 201) {
    throw new Error(`createBranchFromHead → ${res.status}: ${res.text}`);
  }
}

/**
 * Make sure the int-test repo has at least one commit on default
 * branch. If it doesn't, drop a `.gitkeep` via the GitHub Contents
 * API — same effect as the legacy SyncManager bootstrap, without
 * dragging the legacy engine into the test fixture. Subsequent
 * tests use createBranchFromHead off this baseline.
 *
 * Cheap when already non-bare: a single /branches probe.
 */
export async function ensureRepoNotBare(
  env: RepoEnv = requireEnv(),
): Promise<void> {
  const branches = await listAllBranches(env);
  if (branches.length > 0) return;
  const defaultBranch = await getDefaultBranchName(env);
  await writeRemoteFile(
    defaultBranch,
    ".gitkeep",
    "",
    "Initial commit (int-test baseline)",
    env,
  );
}

/** Returns ALL branches on the repo (not filtered by prefix). */
async function listAllBranches(env: RepoEnv): Promise<string[]> {
  const { token, owner, repo } = env;
  const res = await ghFetch(
    `${GH}/repos/${owner}/${repo}/branches?per_page=100`,
    { token },
  );
  if (res.status === 404 || res.status === 409) return [];
  if (res.status !== 200) {
    throw new Error(`listAllBranches → ${res.status}: ${res.text}`);
  }
  return (res.json as Array<{ name: string }>).map((b) => b.name);
}

async function getDefaultBranchName(env: RepoEnv): Promise<string> {
  const { token, owner, repo } = env;
  const res = await ghFetch(`${GH}/repos/${owner}/${repo}`, { token });
  if (res.status !== 200) {
    throw new Error(`getDefaultBranchName → ${res.status}: ${res.text}`);
  }
  return res.json.default_branch as string;
}

// Legacy SyncManager-based TestClient + createClient + sync wrappers
// were here before the pseudo-merge cutover. Sync2 tests instead use
// `tests/integration/scenarios/sync2/helpers.ts` → createSync2Client
// and sync2AllAndAssertNoErrors. Vault content helpers (writeVault…)
// are unused by sync2 tests — they hit fs directly to keep the test
// fixture independent of Obsidian's adapter quirks.

// ----------------------------------------------------------------------------
// Fault injection — re-exports the mock-obsidian primitive so tests
// don't need to reach into mock-obsidian directly. Pair every
// installFaultInjector(injector) with installFaultInjector(null) in
// afterEach to stop the injector leaking into the next test.
// ----------------------------------------------------------------------------

export type { FakeResponse, RequestFaultInjector };
export { installRequestFaultInjector };

/**
 * Builds an injector that throws on the Nth match of a per-call
 * filter. Useful for "fail on the 3rd createBlob" style tests:
 *
 *   installRequestFaultInjector(failOnNthMatch(
 *     (url, method) => method === "POST" && url.endsWith("/git/blobs"),
 *     3,
 *     "Simulated crash mid-upload",
 *   ));
 *
 * The N count is per-injector lifetime — if you uninstall and
 * reinstall, the count resets.
 */
export function failOnNthMatch(
  matcher: (url: string, method: string) => boolean,
  n: number,
  message = "Simulated mid-sync crash",
): RequestFaultInjector {
  let matches = 0;
  return {
    intercept(url, method) {
      if (matcher(url, method)) {
        matches += 1;
        if (matches === n) return new Error(message);
      }
      return null;
    },
  };
}

/**
 * Builds an injector that returns a fake HTTP response for the FIRST
 * `n` calls matching `matcher`, then passes everything else through.
 * Lets J-series tests feed retryUntil deterministic 429/5xx responses
 * to verify the retry-then-recover loop without rate-limiting our PAT.
 *
 *   installRequestFaultInjector(respondForFirstN(
 *     (u, m) => m === "GET" && /\/git\/trees\//.test(u),
 *     2,
 *     { status: 429, headers: { "Retry-After": "1" }, body: "{}" },
 *   ));
 *
 * After the 2 fakes are exhausted the next matching call goes to
 * the real GitHub. Reset the injector with installRequestFaultInjector(null)
 * in afterEach.
 */
export function respondForFirstN(
  matcher: (url: string, method: string) => boolean,
  n: number,
  fake: FakeResponse,
): RequestFaultInjector {
  let matches = 0;
  return {
    intercept(url, method) {
      if (matcher(url, method)) {
        matches += 1;
        if (matches <= n) return fake;
      }
      return null;
    },
  };
}

