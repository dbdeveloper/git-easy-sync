// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Pure, UI-free decision logic for the Settings "Test connection" probe.
// Extracted from settings/tab.ts so it can be unit- AND integration-
// tested (the inline version was UI-bound and unreachable from tests).
//
// The probe reads only — it never writes or mutates plugin state. It
// makes at most three GETs: the repo, the branch, and (only on a branch
// 404) the branch list to tell a BARE repo apart from a typo.
//
// TODO §35 auth semantics are preserved via `authKind`: the caller maps
// it back to the token-expired flag (401→invalid, 403→scope; a level:"ok"
// outcome clears the latch).
//
// TODO bug-60: a freshly-created EMPTY repo has no branches yet, so a
// named branch legitimately doesn't exist — it will be created on the
// first sync. The probe must NOT error in that case. An empty branch
// field is treated as `main`.

export type ProbeAuthKind = "invalid" | "scope";

export interface ProbeOutcome {
  level: "ok" | "err";
  message: string;
  // Present only on 401/403 — the caller sets the token-expired latch.
  authKind?: ProbeAuthKind;
}

// Minimal HTTP response shape both the production (`requestUrl`) and the
// integration (`fetch`) adapters normalise to. Pin it here and use it on
// both sides so an extracted-probe test can never pass while production
// misreads a response.
export interface ProbeHttpResult {
  status: number;
  json: unknown;
  text: string;
  headers: Record<string, string>;
}

export type ProbeHttpGet = (
  url: string,
  headers: Record<string, string>,
) => Promise<ProbeHttpResult>;

export interface ProbeArgs {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  httpGet: ProbeHttpGet;
}

const API = "https://api.github.com";

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function networkError(err: unknown): ProbeOutcome {
  return {
    level: "err",
    message: "✗ Network error: " + String((err as Error)?.message ?? err).slice(0, 200),
  };
}

export async function probeGitHubConnection(args: ProbeArgs): Promise<ProbeOutcome> {
  const { owner, repo, branch, token, httpGet } = args;
  if (!token || !owner || !repo) {
    return { level: "err", message: "✗ Fill in token, owner, and repo first." };
  }
  const headers = githubHeaders(token);

  let repoRes: ProbeHttpResult;
  try {
    repoRes = await httpGet(`${API}/repos/${owner}/${repo}`, headers);
  } catch (err) {
    return networkError(err);
  }

  if (repoRes.status === 401) {
    return {
      level: "err",
      authKind: "invalid",
      message:
        "✗ 401 Unauthorized — token invalid or expired.\n" +
        "Generate a new token on GitHub → Settings → Developer settings.",
    };
  }
  if (repoRes.status === 403) {
    return {
      level: "err",
      authKind: "scope",
      message:
        "✗ 403 Forbidden — token lacks the required scope.\n" +
        "Fine-grained PAT needs: Contents (R/W), Metadata (R).\n" +
        "Classic PAT needs: repo.",
    };
  }
  if (repoRes.status === 404) {
    return {
      level: "err",
      message:
        `✗ 404 Not Found — \`${owner}/${repo}\` is unreachable for this token.\n` +
        "Likely causes:\n" +
        "  • Typo in owner or repo (case-sensitive on REST API).\n" +
        "  • Fine-grained PAT doesn't include this repo in its Repository access list.\n" +
        "  • Repo is private and token belongs to a different user.",
    };
  }
  if (repoRes.status >= 500) {
    const reqId =
      repoRes.headers?.["x-github-request-id"] ??
      repoRes.headers?.["X-GitHub-Request-Id"] ??
      "";
    return {
      level: "err",
      message:
        `✗ ${repoRes.status} GitHub server error. Retry later.\n` +
        (reqId ? `Request ID: ${reqId}` : ""),
    };
  }
  if (repoRes.status < 200 || repoRes.status >= 400) {
    return {
      level: "err",
      message: `✗ Unexpected status ${repoRes.status}.\n` + String(repoRes.text ?? "").slice(0, 200),
    };
  }

  const repoJson = (repoRes.json ?? {}) as Record<string, unknown>;
  const visibility = repoJson.private ? "private" : "public";
  const defaultBranch = (repoJson.default_branch as string) ?? "?";
  const fullName = (repoJson.full_name as string) ?? `${owner}/${repo}`;

  const trimmed = (branch ?? "").trim();
  const branchWasEmpty = trimmed === "";
  // bug-60: an empty branch field defaults to `main` (which is also what
  // the engine uses). We probe `main` rather than skip the check.
  const effectiveBranch = trimmed || "main";
  const emptyNote = branchWasEmpty ? "Branch field is empty — assuming `main`.\n" : "";

  let branchRes: ProbeHttpResult;
  try {
    branchRes = await httpGet(
      `${API}/repos/${owner}/${repo}/branches/${encodeURIComponent(effectiveBranch)}`,
      headers,
    );
  } catch (err) {
    return networkError(err);
  }

  if (branchRes.status === 404) {
    // bug-60: a BARE (freshly-created, zero-commit) repo has NO branches
    // at all → the named branch legitimately doesn't exist yet and will be
    // created on the first sync. Only a repo that HAS branches (just not
    // this one) is a real typo. STRICT emptiness check: anything other
    // than a 200-with-empty-array keeps the "not found" error, so a
    // transient failure never flips a typo into a false green.
    const bare = await isBareRepo(owner, repo, headers, httpGet);
    if (bare === true) {
      return {
        level: "ok",
        message:
          `✓ Repo \`${fullName}\` accessible (${visibility}), but EMPTY (no commits yet).\n` +
          emptyNote +
          `Branch \`${effectiveBranch}\` will be created on the first sync.`,
      };
    }
    return {
      level: "err",
      message:
        `✗ Repo OK, but branch \`${effectiveBranch}\` not found.\n` +
        emptyNote +
        `Default branch on this repo: ${defaultBranch}.\n` +
        "Check for typos or create the branch on GitHub first.",
    };
  }
  if (branchRes.status < 200 || branchRes.status >= 400) {
    return { level: "err", message: `✗ Branch check failed: status ${branchRes.status}.` };
  }

  const branchSha =
    String((branchRes.json as { commit?: { sha?: string } })?.commit?.sha ?? "").slice(0, 7) || "?";
  return {
    level: "ok",
    message:
      `✓ All good. Repo \`${fullName}\` (${visibility}), ` +
      emptyNote +
      `branch \`${effectiveBranch}\` exists, HEAD ${branchSha}.\n` +
      "Plugin is ready to sync.",
  };
}

// Returns true only when the repo provably has NO branches (a 200 with an
// empty array). Any ambiguity (non-200, non-array, network fail) → null,
// so the caller treats the branch as a genuine "not found" rather than
// inferring "empty" from a failed call.
async function isBareRepo(
  owner: string,
  repo: string,
  headers: Record<string, string>,
  httpGet: ProbeHttpGet,
): Promise<boolean | null> {
  try {
    const res = await httpGet(`${API}/repos/${owner}/${repo}/branches?per_page=1`, headers);
    if (res.status === 200 && Array.isArray(res.json)) return res.json.length === 0;
    return null;
  } catch {
    return null;
  }
}
