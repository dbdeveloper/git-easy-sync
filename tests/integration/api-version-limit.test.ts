import { describe, it, expect } from "vitest";
import { requireEnv, integrationEnabled } from "./helpers";

// PERMANENT regression suite backing docs/tasks/SPIKE-COMPARE-300.md §1/§7
// and SYNC2-NEW-DRAIN.md §VII.1's housekeeping note. Not a one-off
// "scratch" probe — do not delete. The plugin pins
// `X-GitHub-Api-Version: 2022-11-28` (src/github/client.ts:92).
// GitHub's own EOL table (docs.github.com, "API Versions", live-checked
// 2026-08-28) says that version is supported until 2028-03-10; after
// that, requests using it are documented to receive `410 Gone`. That
// exact response is UNOBSERVABLE today — no version has ever actually
// expired — so this suite pins the two things that ARE observable now:
//   - the currently-pinned version still works, and GitHub is not yet
//     sending any advance-deprecation signal for it (headers null);
//   - the LIVE error shape for a version string GitHub has never
//     recognised (a stand-in for "unsupported", not "expired" — see
//     the note on Probe B) — `400 Bad Request` with a body naming the
//     currently-supported versions, NOT `410 Gone`. The runtime
//     detector must match both this shape AND the documented `410`,
//     since only one of the two has ever actually been observed.
// CANARY (last test): the test itself must go red ~90 days before the
// real cutoff, well ahead of the API actually failing in production —
// that lead time is the entire point of pinning this here instead of
// only in prose.
describe.skipIf(!integrationEnabled())(
  "GitHub REST API version pin (2022-11-28) — end-of-support regression pins",
  () => {
    it("Probe A: pinned version 2022-11-28 still works, no deprecation signal yet", async () => {
      const env = requireEnv();
      const res = await fetch(
        `https://api.github.com/repos/${env.owner}/${env.repo}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${env.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      const deprecation = res.headers.get("deprecation");
      const sunset = res.headers.get("sunset");
      const warning = res.headers.get("warning");
      console.log(
        `[api-version] baseline status=${res.status} deprecation=${deprecation} ` +
          `sunset=${sunset} warning=${warning}`,
      );
      expect(res.status).toBe(200);
      // If GitHub ever starts sending Deprecation/Sunset/Warning
      // headers for 2022-11-28, that is the FIRST live signal of the
      // 2028-03-10 cutoff approaching — a real finding (the reactive
      // runtime detector should start surfacing it), not flakiness.
      // Do not loosen this assertion to silence a red run; update the
      // detector and the docs instead.
      expect(deprecation).toBeNull();
      expect(sunset).toBeNull();
      expect(warning).toBeNull();
    }, 30_000);

    it("Probe B: an unrecognised version string — live error shape the runtime detector must match", async () => {
      const env = requireEnv();
      const res = await fetch(
        `https://api.github.com/repos/${env.owner}/${env.repo}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${env.token}`,
            // Predates GitHub's REST API versioning scheme entirely
            // (introduced 2022-11-28) — this is "never valid", the
            // closest live stand-in for "no longer valid" (expired),
            // since no version has actually expired yet. The two are
            // NOT proven to produce the same response — see the file
            // banner and SPIKE-COMPARE-300.md §1.
            "X-GitHub-Api-Version": "2015-01-01",
          },
        },
      );
      const body = await res.text();
      console.log(`[api-version] unrecognised-version status=${res.status} body=${body.slice(0, 300)}`);
      expect(res.status).toBe(400);
      expect(body).toContain("is not a supported version");
      expect(body).toContain("2022-11-28");
    }, 30_000);

    // CANARY: fails loudly, well before the API itself would, once the
    // 2022-11-28 cutoff (2028-03-10, per GitHub's published EOL table)
    // is within MARGIN_DAYS. Give the current or a future maintainer
    // months of runway to plan the X-GitHub-Api-Version migration
    // instead of discovering it via a production 410.
    it("CANARY: still comfortably ahead of the 2022-11-28 end-of-support date", () => {
      const EOL_DATE = new Date("2028-03-10T00:00:00Z");
      const MARGIN_DAYS = 90;
      const marginMs = MARGIN_DAYS * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const daysRemaining = Math.round((EOL_DATE.getTime() - now) / (24 * 60 * 60 * 1000));
      console.log(`[api-version] days until 2022-11-28 end-of-support: ${daysRemaining}`);
      // Red here means: migrate X-GitHub-Api-Version off 2022-11-28
      // now (see SPIKE-COMPARE-300.md §1 TODO) — this is not a test
      // bug, it is the test doing its job.
      expect(now).toBeLessThan(EOL_DATE.getTime() - marginMs);
    });
  },
);
