import { describe, it, beforeAll, expect } from "vitest";
import {
  integrationEnabled,
  requireEnv,
  ensureRepoNotBare,
} from "../../../helpers";
import {
  probeGitHubConnection,
  type ProbeHttpGet,
} from "../../../../../src/settings/connection-probe";

// bug-60 (existing repo): connecting to a repo that ALREADY has data must
// accept only a pre-existing branch — a named-but-missing branch is a
// typo and must error (the "created on first sync" tolerance is for empty
// repos ONLY). Runs against the persistent private int-test repo with the
// fine-grained test token.

const httpGet: ProbeHttpGet = async (url, headers) => {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const hdrs: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: r.status, json, text, headers: hdrs };
};

const ghHeaders = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

describe.skipIf(!integrationEnabled())(
  "connection probe — existing repo requires a pre-existing branch (bug-60)",
  () => {
    let env: ReturnType<typeof requireEnv>;
    let defaultBranch: string;

    beforeAll(async () => {
      env = requireEnv();
      await ensureRepoNotBare(); // guarantee the repo has commits + a default branch
      const repoInfo = await httpGet(
        `https://api.github.com/repos/${env.owner}/${env.repo}`,
        ghHeaders(env.token),
      );
      defaultBranch = String((repoInfo.json as { default_branch?: string })?.default_branch ?? "main");
    }, 120_000);

    it(
      "the existing default branch → OK, reports it exists",
      async () => {
        const outcome = await probeGitHubConnection({
          owner: env.owner,
          repo: env.repo,
          branch: defaultBranch,
          token: env.token,
          httpGet,
        });
        expect(outcome.level).toBe("ok");
        expect(outcome.message).toContain(`branch \`${defaultBranch}\` exists`);
      },
      120_000,
    );

    it(
      "a non-existent branch on a NON-empty repo → typo error (not silently allowed)",
      async () => {
        const outcome = await probeGitHubConnection({
          owner: env.owner,
          repo: env.repo,
          branch: "probe-nonexistent-branch-zzz",
          token: env.token,
          httpGet,
        });
        expect(outcome.level).toBe("err");
        expect(outcome.message).toContain("not found");
      },
      120_000,
    );
  },
);
