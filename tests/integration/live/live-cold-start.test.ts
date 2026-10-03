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
//   3. SCOPE-LADDER — the two scope toggles walked off/off → on/off →
//      on/on against the real vault, with a deliberate desync so each
//      rung has something to move. Added 2026-10-03 at the owner's
//      direction: mirroring the device's settings checks ONE state,
//      while every interesting failure lives in the TRANSITION.
//
// Env: LIVE_VAULT_PATH, LIVE_BRANCH, OBSIDIAN_TEST_{TOKEN,OWNER,REPO}.
// LIVE_SHAPE=adoption|gate|scope-ladder picks the shape (default:
// adoption). ⚠️ EVERY shape starts by deleting `.runtime/`, before any
// network call — so a run that dies on a bad token still leaves the
// vault cold. Never aim this at a vault you are not willing to re-adopt.

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

// The scope-deciding settings, read from the vault the driver is aimed
// at. Only these two: they are what the engine branches on when it
// decides whether a path is IN the sync at all, and getting either one
// wrong changes what the gate measures (see the call site). Everything
// else the harness may default — it affects how work is done, not which
// files exist.
//
// Missing or unreadable data.json → return nothing and let
// createSync2Client's own defaults stand, loudly: a vault with no
// settings is a first-run vault, and inventing `true` there would be
// the same mistake in the other direction.
function deviceSettings(vaultPath: string): {
  syncConfigDir?: boolean;
  pushPluginsDataJson?: boolean;
} {
  const file = path.join(vaultPath, CONFIG_DIR, "plugins", SELF, "data.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    line("settings: no readable data.json — harness defaults apply");
    return {};
  }
  const out: { syncConfigDir?: boolean; pushPluginsDataJson?: boolean } = {};
  if (typeof raw.syncConfigDir === "boolean") {
    out.syncConfigDir = raw.syncConfigDir;
  }
  if (typeof raw.pushPluginsDataJson === "boolean") {
    out.pushPluginsDataJson = raw.pushPluginsDataJson;
  }
  // Printed, not just applied — the report has to say which scope the
  // numbers below belong to, or the next reader repeats this bug.
  line(
    `settings from vault: syncConfigDir=${out.syncConfigDir ?? "(default)"} ` +
      `pushPluginsDataJson=${out.pushPluginsDataJson ?? "(default)"}`,
  );
  return out;
}

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
  it.skipIf(SHAPE === "scope-ladder")(
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
        // ⚠️ READ THE DEVICE'S OWN SETTINGS — do not assume them.
        //
        // This line used to say "Mirror the device's actual data.json
        // settings" and then hardcode ONE of them, leaving
        // `pushPluginsDataJson` to default to FALSE. Caught in the
        // field 2026-10-03 by the owner: a run against a vault whose
        // setting was TRUE silently took every plugin `data.json` out
        // of scope, so the gate measured the vault MINUS those files,
        // and the change detector's two-way mute dropped their
        // baselines as "newly ignored". Nothing was lost — the files
        // already matched the remote, so the next real sync
        // short-circuited them — but the gate's number was about a
        // different vault than the one on disk.
        //
        // A driver aimed at a REAL vault has no business inventing its
        // configuration. Anything the engine branches on comes from
        // the vault's data.json; only what is missing falls back.
        ...deviceSettings(LIVE_VAULT),
        autoCanonicalize: true,
        enableLogging: true,
      });
      client.settings.deviceLabel = "Macbook";

      // Orphan sibling files already on disk, reported with their age
      // so a human can see WHO made them.
      //
      // ⚠️ Do not turn this snapshot into the gate's pass condition. A
      // sibling "already on disk" at the start of run N may simply be
      // one that run N-1 created, and then the gate passes by tautology
      // — which is exactly the mistake this comment replaces (I read a
      // sibling named `...conflict-from-Macbook-2026-08-18T18-09-17Z`
      // as an old artefact, when the date in a sibling FILENAME is the
      // base file's mtime, not the moment the sibling was written; that
      // one was minutes old and mine). The gate condition is the
      // explicit allow-list below instead: the human states which
      // conflicts this vault is already known to carry, and anything
      // else is a conflict the sync manufactured.
      {
        const walk = (dir: string, rel = ""): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              walk(path.join(dir, e.name), r);
            } else if (r.includes(".conflict-from-")) {
              const ageMin = (
                (Date.now() - fs.statSync(path.join(dir, e.name)).mtimeMs) /
                60_000
              ).toFixed(0);
              line(`sibling on disk (${ageMin} min old): ${r}`);
            }
          }
        };
        walk(LIVE_VAULT);
      }

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
          // "Zero conflicts" in the gate means zero conflicts the sync
          // manufactured. A vault may legitimately arrive carrying an
          // orphan sibling from an earlier tool (~/Obsidian-test has one
          // in `.test/`, from a phone, dated June — and `.test/` being a
          // dot-directory is why nobody sees it in Obsidian), and
          // adopting that as a synthetic conflict is documented
          // behaviour. Those go in LIVE_EXPECTED_CONFLICTS, stated by
          // the human up front. Everything else is a defect.
          const expected = new Set(
            (process.env.LIVE_EXPECTED_CONFLICTS ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          );
          const conflicts = [
            ...client.conflictStore.getCachedState().entries.keys(),
          ];
          const unexplainedConflicts = conflicts.filter(
            (p) => !expected.has(p),
          );
          line(
            `conflicts(${conflicts.length}): ${conflicts.join(", ") || "—"}`,
          );
          line(
            `NOT in LIVE_EXPECTED_CONFLICTS: ${
              unexplainedConflicts.join(", ") || "—"
            }`,
          );
          expect(
            unexplainedConflicts,
            "gate: no conflict may be created by the sync itself",
          ).toEqual([]);
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

  // ── SHAPE: scope-ladder ─────────────────────────────────────────────
  //
  // Owner's design, 2026-10-03, replacing my "mirror the device's
  // settings" fix — which aimed at the wrong target. Mirroring checks
  // ONE state; the value is in the TRANSITIONS, because that is where
  // the change detector's two-way mute deletes baselines and where a
  // widening scope could drag secrets along with it.
  //
  // ⚠️ THE STATE SPACE IS THREE, NOT FOUR. `pluginsDataJsonToggleState`
  // subordinates the child to the parent: with `syncConfigDir` off,
  // `pushPluginsDataJson` is forced false and greyed. So the only legal
  // ladder is off/off → on/off → on/on, which is exactly the sequence
  // the owner asked for.
  //
  // Each rung asserts TWO things, and the second is the sharp one:
  //   1. what came INTO scope actually moves;
  //   2. what is still OUT of scope does NOT — and on rung 2 that is a
  //      SECRET BOUNDARY, not a tidiness check. The subordination exists
  //      because a stored `true` under a disabled parent would, on the
  //      first flip of the parent, "silently resume publishing
  //      credentials" (the words are from loadSettings' own comment).
  //
  // The NARROWING direction comes free: a device whose real settings are
  // on/on starts this ladder by turning both OFF, so rung 1 is a live
  // became-ignored transition. Its claim is that the remote keeps every
  // `.obsidian/**` blob it had — a mute is not a delete.
  //
  // DELIBERATE DESYNC (owner: "розсинхрон роби"). On an already-synced
  // vault nothing moves when scope widens, so membership alone would be
  // a pale answer. Two files are nudged out of sync first — one ordinary
  // configDir file, one plugin data.json — by appending a single
  // newline: valid JSON, one byte, a different blob sha, and reverted at
  // the end. ⚠️ This leaves a few extra commits in the repo; that is the
  // price of the question being answerable.
  it.skipIf(SHAPE !== "scope-ladder")(
    "scope ladder: off/off → on/off → on/on, each rung moving exactly what it should",
    { retry: 0, timeout: 1_800_000 },
    async () => {
      const env = liveEnv();
      line(`vault=${LIVE_VAULT}`);
      line(`repo=${env.owner}/${env.repo} branch=${LIVE_BRANCH}`);
      const real = deviceSettings(LIVE_VAULT);

      const runtime = path.join(LIVE_VAULT, CONFIG_DIR, "plugins", SELF, ".runtime");
      if (fs.existsSync(runtime)) {
        fs.rmSync(runtime, { recursive: true, force: true });
        line("reset: removed existing .runtime/");
      }

      // Pick the two victims from what the REMOTE actually has, so the
      // desync is guaranteed observable as a sha change rather than as
      // an addition.
      const head0 = await headOf(env, LIVE_BRANCH);
      const tree0 = await treeOf(env, head0);
      const isPluginData = (p: string): boolean =>
        /^\.obsidian\/plugins\/[^/]+\/data\.json$/.test(p);
      const pickLocal = (pred: (p: string) => boolean): string | null => {
        for (const p of tree0.keys()) {
          if (pred(p) && fs.existsSync(path.join(LIVE_VAULT, p))) return p;
        }
        return null;
      };
      const cfgVictim = pickLocal(
        (p) => p.startsWith(`${CONFIG_DIR}/`) && !isPluginData(p) && p.endsWith(".json"),
      );
      const dataVictim = pickLocal(isPluginData);
      if (!cfgVictim || !dataVictim) {
        throw new Error(
          `need one configDir file and one plugin data.json present BOTH locally and ` +
            `remotely; got cfg=${cfgVictim} data=${dataVictim}`,
        );
      }
      line(`desync victims: cfg=${cfgVictim}  data=${dataVictim}`);

      const originals = new Map<string, Buffer>();
      for (const v of [cfgVictim, dataVictim]) {
        const abs = path.join(LIVE_VAULT, v);
        originals.set(v, fs.readFileSync(abs));
        fs.appendFileSync(abs, "\n"); // one byte, still valid JSON
      }
      line("desync applied: one newline appended to each victim");

      const client = await createSync2Client({
        branch: LIVE_BRANCH,
        env,
        vaultPath: LIVE_VAULT,
        ownsVaultPath: false,
        // Rung 1 explicitly, NOT the device's values — the ladder sets
        // its own starting state and restores the device's at the end.
        syncConfigDir: false,
        pushPluginsDataJson: false,
        autoCanonicalize: true,
        enableLogging: true,
      });
      client.settings.deviceLabel = "Macbook";

      const inScope = async (pred: (p: string) => boolean): Promise<number> =>
        (await client.baselines.allPaths()).filter(pred).length;
      const underConfig = (p: string): boolean => p.startsWith(`${CONFIG_DIR}/`);

      try {
        // ── RUNG 1: off / off ────────────────────────────────────────
        line("── rung 1: syncConfigDir=false pushPluginsDataJson=false");
        await client.manager.syncAll();
        const r1 = await report(client, env, LIVE_BRANCH, "AFTER rung 1");
        expect(await inScope(underConfig), "rung 1: configDir is OUT of scope").toBe(0);
        // A mute is not a delete: every configDir blob the remote had is
        // still there. This is the narrowing half of the ladder.
        const cfgBefore = [...tree0.keys()].filter(underConfig);
        expect(
          cfgBefore.filter((p) => !r1.tree.has(p)),
          "rung 1: a disabled scope must not DELETE remote files",
        ).toEqual([]);
        expect(r1.tree.get(cfgVictim), "rung 1: the cfg desync stayed home").toBe(
          tree0.get(cfgVictim),
        );
        expect(r1.tree.get(dataVictim), "rung 1: the data desync stayed home").toBe(
          tree0.get(dataVictim),
        );

        // ── RUNG 2: on / off ─────────────────────────────────────────
        line("── rung 2: syncConfigDir=TRUE pushPluginsDataJson=false");
        client.settings.syncConfigDir = true;
        await client.manager.syncAll();
        const r2 = await report(client, env, LIVE_BRANCH, "AFTER rung 2");
        // What came into scope MOVED…
        expect(
          r2.tree.get(cfgVictim),
          "rung 2: the configDir file reached the remote",
        ).not.toBe(tree0.get(cfgVictim));
        // …and the SECRET BOUNDARY held: data.json neither travelled nor
        // even entered the scope.
        expect(
          r2.tree.get(dataVictim),
          "🔑 rung 2: a plugin data.json must NOT travel while its toggle is off",
        ).toBe(tree0.get(dataVictim));
        expect(
          await inScope(isPluginData),
          "🔑 rung 2: no plugin data.json may be IN scope",
        ).toBe(0);
        expect(
          await inScope(underConfig),
          "rung 2: configDir is in scope now",
        ).toBeGreaterThan(0);

        // ── RUNG 3: on / on ──────────────────────────────────────────
        line("── rung 3: syncConfigDir=TRUE pushPluginsDataJson=TRUE");
        client.settings.pushPluginsDataJson = true;
        await client.manager.syncAll();
        const r3 = await report(client, env, LIVE_BRANCH, "AFTER rung 3");
        expect(
          r3.tree.get(dataVictim),
          "rung 3: the data.json reached the remote once its toggle opened",
        ).not.toBe(tree0.get(dataVictim));
        expect(
          await inScope(isPluginData),
          "rung 3: plugin data.json is in scope",
        ).toBeGreaterThan(0);

        // Quiescence at the top of the ladder — the same claim the
        // adoption shape makes, now at full scope.
        await client.manager.syncAll();
        const r3b = await report(client, env, LIVE_BRANCH, "AFTER rung 3 (again)");
        expect(r3b.head, "rung 3: the second sync is quiet").toBe(r3.head);
        expect(await client.detector.findChanges()).toEqual([]);
      } finally {
        // ── RESTORE: the vault and the remote go back ────────────────
        // Not best-effort — a driver that leaves a real vault desynced
        // or with the device's toggles flipped is worse than no driver.
        for (const [v, bytes] of originals) {
          fs.writeFileSync(path.join(LIVE_VAULT, v), bytes);
        }
        client.settings.syncConfigDir = real.syncConfigDir ?? true;
        client.settings.pushPluginsDataJson = real.pushPluginsDataJson ?? false;
        line(
          `restore: settings back to syncConfigDir=${client.settings.syncConfigDir} ` +
            `pushPluginsDataJson=${client.settings.pushPluginsDataJson}; reverting content`,
        );
        try {
          await client.manager.syncAll();
          const rf = await report(client, env, LIVE_BRANCH, "AFTER restore");
          for (const v of originals.keys()) {
            line(
              `restore ${v}: ${rf.tree.get(v) === tree0.get(v) ? "back to original" : "⚠️ NOT back"}`,
            );
          }
        } catch (e) {
          line(`⚠️ restore sync failed: ${String(e)} — revert by hand`);
        }
        client.cleanup();
      }
    },
  );
});
