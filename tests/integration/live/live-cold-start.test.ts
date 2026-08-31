// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// LIVE cold-start driver — MASTER-PLAN §5.5.0's last gate row:
// "живий гейт холодного старту: reset → syncAll на відповідному vault →
//  нуль конфліктів/пушів, метадані заповнені, findChanges порожній".
//
// Not part of any suite run: the whole file is skipped unless
// LIVE_VAULT_PATH is set, which never happens from .env.test. It points
// the real engine at a real 63 MB vault and a real repo, so it is run by
// hand, one shape at a time, and it reports rather than merely asserts.
//
// Two shapes, in order:
//   1. ADOPTION — a vault with genuine drift (files only here, files
//      only there, one differing). This is the interesting one, and it
//      is NOT the gate: drift legitimately produces pushes, pulls and
//      possibly a manual conflict (§6.4 decision A).
//   2. THE GATE — same vault after shape 1 converged it, with our
//      runtime state deleted (that IS "reset"). A cold start against a
//      corresponding remote must do NOTHING: no commit, no conflict,
//      empty findChanges.
//
// Env: LIVE_VAULT_PATH, LIVE_BRANCH, OBSIDIAN_TEST_{TOKEN,OWNER,REPO}.
// LIVE_SHAPE=adoption|gate picks the shape (default: adoption).

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createSync2Client,
  Sync2TestClient,
} from "../scenarios/sync2/helpers";
import { recordedNotices, clearRecordedNotices } from "../../../mock-obsidian";
import type { RepoEnv } from "../helpers";

const LIVE_VAULT = process.env.LIVE_VAULT_PATH ?? "";
const LIVE_BRANCH = process.env.LIVE_BRANCH ?? "";
const SHAPE = process.env.LIVE_SHAPE ?? "adoption";
const SELF = "git-easy-sync";
const CONFIG_DIR = ".obsidian";

function liveEnv(): RepoEnv {
  const token = process.env.OBSIDIAN_TEST_TOKEN ?? "";
  const owner = process.env.OBSIDIAN_TEST_OWNER ?? "";
  const repo = process.env.OBSIDIAN_TEST_REPO ?? "";
  if (!token || !owner || !repo) {
    throw new Error("live run needs OBSIDIAN_TEST_{TOKEN,OWNER,REPO}");
  }
  return { token, owner, repo, branchPrefix: "live", isPublic: false };
}

const enabled = LIVE_VAULT !== "" && LIVE_BRANCH !== "";

// Talk to GitHub directly for the before/after picture — deliberately
// NOT through the engine, so the report is independent of it.
async function gh(
  env: RepoEnv,
  urlPath: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    headers: {
      Authorization: `Bearer ${env.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`${urlPath} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function headOf(env: RepoEnv, branch: string): Promise<string> {
  const r = await gh(
    env,
    `/repos/${env.owner}/${env.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return (r.object as { sha: string }).sha;
}

async function treeOf(
  env: RepoEnv,
  sha: string,
): Promise<Map<string, string>> {
  const r = await gh(
    env,
    `/repos/${env.owner}/${env.repo}/git/trees/${sha}?recursive=1`,
  );
  if (r.truncated === true) throw new Error("tree truncated");
  const out = new Map<string, string>();
  for (const e of r.tree as { path: string; type: string; sha: string }[]) {
    if (e.type === "blob") out.set(e.path, e.sha);
  }
  return out;
}

function line(s: string): void {
  // eslint-disable-next-line no-console
  console.log(`LIVE  ${s}`);
}

async function report(
  c: Sync2TestClient,
  env: RepoEnv,
  branch: string,
  label: string,
): Promise<{ head: string; tree: Map<string, string> }> {
  const head = await headOf(env, branch);
  const tree = await treeOf(env, head);
  const changes = await c.detector.findChanges();
  const conflicts = c.conflictStore.getCachedState();
  const batches = await c.queue.list();
  line(
    `${label}: head=${head.slice(0, 8)} remoteBlobs=${tree.size} ` +
      `localChanges=${changes.length} conflictBases=${conflicts.entries.size} ` +
      `pendingBatches=${batches.length}`,
  );
  return { head, tree };
}

describe.skipIf(!enabled)(`live cold-start [${SHAPE}]`, () => {
  it(
    "runs the real engine against the real vault and reports what moved",
    { retry: 0, timeout: 1_800_000 },
    async () => {
      const env = liveEnv();
      line(`vault=${LIVE_VAULT}`);
      line(`repo=${env.owner}/${env.repo} branch=${LIVE_BRANCH}`);

      // "reset": our runtime state is what makes a start cold. Deleting
      // it is exactly what the Reset command does.
      const runtime = path.join(
        LIVE_VAULT,
        CONFIG_DIR,
        "plugins",
        SELF,
        ".runtime",
      );
      if (fs.existsSync(runtime)) {
        fs.rmSync(runtime, { recursive: true, force: true });
        line("reset: removed existing .runtime/");
      } else {
        line("reset: no .runtime/ present (genuinely first run)");
      }

      const client = await createSync2Client({
        branch: LIVE_BRANCH,
        env,
        vaultPath: LIVE_VAULT,
        ownsVaultPath: false, // never rm -rf a real vault
        // Mirror the device's actual data.json settings.
        syncConfigDir: true,
        autoCanonicalize: true,
        enableLogging: true,
      });
      client.settings.deviceLabel = "Macbook";

      try {
        const localFiles = (await client.vault.adapter.list("")).files.length;
        line(`local root entries=${localFiles}`);
        const before = await report(client, env, LIVE_BRANCH, "BEFORE");

        clearRecordedNotices();
        const t0 = Date.now();
        await client.manager.syncAll();
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        line(`syncAll finished in ${secs}s`);
        for (const n of recordedNotices) line(`notice: ${n.message}`);

        const after = await report(client, env, LIVE_BRANCH, "AFTER-1");

        // What the sync actually did to the remote, path by path.
        const added = [...after.tree.keys()].filter((p) => !before.tree.has(p));
        const changed = [...after.tree.entries()]
          .filter(([p, sha]) => before.tree.has(p) && before.tree.get(p) !== sha)
          .map(([p]) => p);
        const removed = [...before.tree.keys()].filter(
          (p) => !after.tree.has(p),
        );
        line(`remote added(${added.length}): ${added.join(", ") || "—"}`);
        line(`remote changed(${changed.length}): ${changed.join(", ") || "—"}`);
        line(`remote removed(${removed.length}): ${removed.join(", ") || "—"}`);

        // Convergence, not "one pass and done". A first-ever adoption
        // legitimately needs more than one commit: enforce() rewrites
        // the two managed .gitignore files at the START of a sync, so
        // those writes are only DISCOVERED by the following scan. On a
        // vault carrying pre-rename gitignores that is a real, one-time
        // second commit. What must be true is that the sequence STOPS.
        let head = after.head;
        let passes = 1;
        for (let i = 0; i < 3; i++) {
          clearRecordedNotices();
          await client.manager.syncAll();
          passes += 1;
          const st = await report(client, env, LIVE_BRANCH, `AFTER-${passes}`);
          for (const n of recordedNotices) line(`notice(${passes}): ${n.message}`);
          const errs = recordedNotices
            .map((n) => n.message)
            .filter((m) => m.toLowerCase().includes("error"));
          expect(errs, `pass ${passes} must be error-free`).toEqual([]);
          if (st.head === head) {
            line(`converged after ${passes - 1} commit-producing pass(es)`);
            break;
          }
          head = st.head;
        }
        const settled = await headOf(env, LIVE_BRANCH);
        expect(settled, "engine must stop committing").toBe(head);

        const residual = await client.detector.findChanges();
        line(
          `residual local changes: ${residual.map((c2) => c2.path).join(", ") || "—"}`,
        );
        // A path held in an unresolved conflict legitimately keeps
        // reporting as changed (§26) — so residuals are reported, and
        // only the gate shape demands zero.
        const conflicted = new Set(
          client.conflictStore.getCachedState().entries.keys(),
        );
        const unexplained = residual.filter((c2) => !conflicted.has(c2.path));
        line(
          `residual NOT explained by an open conflict: ${
            unexplained.map((c2) => c2.path).join(", ") || "—"
          }`,
        );
        expect(unexplained, "every residual must be a conflict base").toEqual(
          [],
        );

        if (SHAPE === "gate") {
          // THE GATE: a cold start against a corresponding remote does
          // nothing at all.
          expect(added, "gate: no remote additions").toEqual([]);
          expect(changed, "gate: no remote changes").toEqual([]);
          expect(removed, "gate: no remote removals").toEqual([]);
          expect(after.head, "gate: no commit").toBe(before.head);
          const conflicts = client.conflictStore.getCachedState();
          expect(conflicts.entries.size, "gate: zero conflicts").toBe(0);
          // Metadata must be populated, not empty.
          const baselinePaths = await client.baselines.allPaths();
          line(`baseline rows=${baselinePaths.length}`);
          expect(baselinePaths.length).toBeGreaterThan(100);
        }
      } finally {
        client.cleanup();
      }
    },
  );
});
