import { describe, it, expect } from "vitest";
import { requireEnv, integrationEnabled } from "./helpers";
import { utf8RoundTrip } from "../../src/sync2/text-normalize";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII Q.5 — CANARY for the §II.15 inline-content path, EQUALITY not
// shape: for an inline tree entry GitHub assigns the blob sha
// server-side and the drain never re-reads it — it records the
// LOCALLY computed sha as the baseline. If the two ever diverge
// (server-side normalisation, encoding surprises), every inline push
// would record a baseline the repo doesn't have — silent eternal
// churn. Red here = disable the inline path in favour of createBlob,
// don't "fix the test" (same contract as the ETag canary, P.19).

const API = "https://api.github.com";

describe.skipIf(!integrationEnabled())(
  "inline-content sha canary (§VIII Q.5)",
  () => {
    it("createTree's per-entry sha for an inline entry literally equals the locally computed git blob sha", async () => {
      const env = requireEnv();
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };

      // Deliberately non-ASCII (multibyte UTF-8) + LF structure — the
      // exact shape the round-trip gate admits to the inline path.
      const content = `канарка Q.5 — ${Date.now()}\nдругий рядок\n`;
      const bytes = new TextEncoder().encode(content);
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      // Sanity: this content passes the same gate production uses.
      expect(utf8RoundTrip(buf)).toBe(content);
      const localSha = await calculateGitBlobSHA(buf);

      // FLAT path on purpose: the createTree response lists only the
      // created tree's DIRECT entries — a nested path would show up
      // as a subtree row, hiding the blob's sha.
      const path = `q5-canary-${Date.now()}.md`;
      const resp = await fetch(
        `${API}/repos/${env.owner}/${env.repo}/git/trees`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            tree: [{ path, mode: "100644", type: "blob", content }],
          }),
        },
      );
      expect(resp.status).toBe(201);
      const json = (await resp.json()) as {
        tree: Array<{ path: string; sha: string }>;
      };
      const entry = json.tree.find((e) => e.path === path);
      console.log(
        `[Q.5 canary] path=${path} serverSha=${entry?.sha} localSha=${localSha}`,
      );
      expect(entry).toBeDefined();
      expect(entry!.sha).toBe(localSha);
      // Dangling tree — nothing to clean up (GitHub GC).
    }, 60_000);
  },
);
