import { describe, it, expect } from "vitest";
import { requireEnv, integrationEnabled } from "./helpers";

// PERMANENT probe/regression for MASTER-PLAN Фаза 3 п.0: does
// POST /git/trees cap the number of entries per call? The cold start
// (§Фаза 4.0 + NEW-DRAIN §II.15) makes ONE batch of the whole vault,
// so one tree with ~20k entries is a real production shape — if
// GitHub rejects it, batch splitting becomes MANDATORY in the tree
// accumulator (count-based flushing next to the existing
// MAX_INLINE_BYTES size-based one), not a nicety. The plan forbids
// inventing this number: until this probe runs, the limit is
// UNKNOWN — not "probably fine" and not "probably capped".
//
// Method (mirrors compare-api-300-limit.test.ts): entries reference
// ONE pre-created blob by sha at distinct paths, so the request body
// stays small relative to the entry count and the probe measures the
// COUNT axis, not the payload axis. Trees are left dangling on
// purpose — no commit, no branch, nothing to clean up (unreachable
// objects are GitHub's garbage collector's job).
//
// The same run also pins the READ side at the same scale:
// GET /git/trees/{sha}?recursive=1 on the 20k tree must return every
// entry with truncated=false — fullTreeDiffAgainstColdBaseline
// (Фаза 3 item 1, the compare-300/force-push fallback) depends on
// exactly that call at exactly that scale.

const API = "https://api.github.com";

describe.skipIf(!integrationEnabled())(
  "POST /git/trees entry-count limit (MASTER-PLAN Фаза 3 п.0 probe)",
  () => {
    it("accepts trees of 1k / 5k / 20k sha-referenced entries; recursive GET at 20k is complete and untruncated", async () => {
      const env = requireEnv();
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };

      // One shared blob — every entry points at it.
      const blobResp = await fetch(
        `${API}/repos/${env.owner}/${env.repo}/git/blobs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            content: `trees-limit probe blob ${Date.now()}`,
            encoding: "utf-8",
          }),
        },
      );
      expect(blobResp.status).toBe(201);
      const blobSha = ((await blobResp.json()) as { sha: string }).sha;

      const prefix = `spike-trees-limit-${Date.now()}`;
      const results: Array<{
        count: number;
        status: number;
        ms: number;
        bodyBytes: number;
        treeSha: string | null;
        errorBody: string | null;
      }> = [];

      let sha20k: string | null = null;
      for (const count of [1_000, 5_000, 20_000]) {
        const body = JSON.stringify({
          tree: Array.from({ length: count }, (_, i) => ({
            path: `${prefix}/n${count}/f-${i}.md`,
            mode: "100644",
            type: "blob",
            sha: blobSha,
          })),
        });
        const started = Date.now();
        const resp = await fetch(
          `${API}/repos/${env.owner}/${env.repo}/git/trees`,
          { method: "POST", headers, body },
        );
        const ms = Date.now() - started;
        const text = await resp.text();
        const treeSha = resp.ok
          ? (JSON.parse(text) as { sha: string }).sha
          : null;
        if (count === 20_000) sha20k = treeSha;
        results.push({
          count,
          status: resp.status,
          ms,
          bodyBytes: body.length,
          treeSha,
          errorBody: resp.ok ? null : text.slice(0, 500),
        });
        console.log(
          `[spike-trees-limit] count=${count} status=${resp.status} ms=${ms} ` +
            `bodyBytes=${body.length} treeSha=${treeSha} ` +
            (resp.ok ? "" : `ERROR=${text.slice(0, 500)}`),
        );
      }

      // The probe's core finding, pinned: all three sizes must be
      // ACCEPTED. If any of these ever fails, the cold-start design
      // needs a count-based flush in the tree accumulator — re-derive
      // in docs/tasks/SPIKE-TREES-LIMIT.md, do not loosen blindly.
      for (const r of results) {
        expect(r.status, `createTree with ${r.count} entries`).toBe(201);
      }

      // READ side at the same scale: the 20k tree comes back complete
      // and untruncated via ?recursive=1 — the exact call
      // fullTreeDiffAgainstColdBaseline makes on a 20k vault.
      expect(sha20k).not.toBeNull();
      const started = Date.now();
      const getResp = await fetch(
        `${API}/repos/${env.owner}/${env.repo}/git/trees/${sha20k}?recursive=1`,
        { headers },
      );
      const getMs = Date.now() - started;
      const getText = await getResp.text();
      const getJson = JSON.parse(getText) as {
        tree?: unknown[];
        truncated?: boolean;
      };
      console.log(
        `[spike-trees-limit] GET recursive status=${getResp.status} ms=${getMs} ` +
          `tree.length=${getJson.tree?.length} truncated=${getJson.truncated} ` +
          `responseBytes=${getText.length} bytesPerEntry=${(
            getText.length / (getJson.tree?.length ?? 1)
          ).toFixed(1)}`,
      );
      expect(getResp.status).toBe(200);
      expect(getJson.truncated).toBe(false);
      // 20k files + the per-level subtree entries (prefix dir etc.).
      expect((getJson.tree ?? []).length).toBeGreaterThanOrEqual(20_000);
    }, 300_000);
  },
);
