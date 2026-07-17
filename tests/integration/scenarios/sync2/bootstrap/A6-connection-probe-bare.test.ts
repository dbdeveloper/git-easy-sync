import { describe, it, beforeAll, expect } from "vitest";
import {
  bootstrapEnabled,
  requireBootstrapEnv,
  recreateRepo,
} from "../../../helpers";
import {
  probeGitHubConnection,
  type ProbeHttpGet,
} from "../../../../../src/settings/connection-probe";

// bug-60 (A-series): the Settings "Test connection" probe must NOT error
// on a freshly-created EMPTY repo when a branch is named — that branch is
// created on the first sync. Runs against a real bare repo recreated via
// the classic bootstrap token.

// Real-network adapter, same shape the production requestUrl adapter
// produces (settings/tab.ts).
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

describe.skipIf(!bootstrapEnabled())(
  "connection probe — bare (empty) repo allows an arbitrary branch (bug-60)",
  () => {
    let env: ReturnType<typeof requireBootstrapEnv>;

    beforeAll(async () => {
      env = requireBootstrapEnv();
      await recreateRepo(env); // delete + recreate → a bare, zero-commit repo
    }, 120_000);

    it(
      "a NAMED (arbitrary, non-default) branch on an empty repo → OK, created on first sync",
      async () => {
        const outcome = await probeGitHubConnection({
          owner: env.owner,
          repo: env.repo,
          branch: "some-arbitrary-branch",
          token: env.token,
          httpGet,
        });
        expect(outcome.level).toBe("ok");
        expect(outcome.message).toContain("EMPTY");
        expect(outcome.message).toContain("some-arbitrary-branch");
        expect(outcome.message).toContain("will be created");
      },
      120_000,
    );

    it(
      "an EMPTY branch field on an empty repo → OK, assumes `main`",
      async () => {
        const outcome = await probeGitHubConnection({
          owner: env.owner,
          repo: env.repo,
          branch: "",
          token: env.token,
          httpGet,
        });
        expect(outcome.level).toBe("ok");
        expect(outcome.message).toContain("assuming `main`");
        expect(outcome.message).toContain("will be created");
      },
      120_000,
    );
  },
);
