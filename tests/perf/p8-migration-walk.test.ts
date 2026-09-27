import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { emit } from "./perf-helpers";
import { findMigrationCandidates } from "../../src/sync2/gitignore-migrate";

// P8 — the §8.1 migration walk (DOT-FILES §8.1.1a).
//
// The owner's answer on scale was "plan for the worst case": every
// directory in the vault, hidden ones included. So this measures at the
// plugin's DECLARED ceiling (~20k files / 7 MB, README) and at ~10× a
// normal case, and reports GROWTH — because the number that matters is
// not the wall-clock, it is the shape. 10× the input costing 100× the
// time would be hidden quadratic behaviour, a defect rather than a
// performance nicety.
//
// It also measures what pruning buys, since §8.1.1a's cost claim rests on
// it: a `node_modules`-shaped subtree is the realistic worst case, and
// pruning is supposed to make it free rather than merely cheaper.
//
// ⚠️ Node fs on a desktop machine, NOT Capacitor. The authoritative
// mobile numbers live in SYNC2-METAFILE-REFACTOR.md §1 (a full Android
// walk measured ~10-22 s); this is a repeatable desktop baseline and a
// regression guard on the SHAPE.
//
// Output (grep ^PERF_BASELINE):
//   PERF_BASELINE {"name":"P8-walk-<N>", "ms":…, "dirs":…, "files":…}
//   PERF_BASELINE {"name":"P8-prune-<state>", …}
//
// Run with `pnpm test:perf`. Skipped by unit + integration suites.

const CONFIG_DIR = ".obsidian";

// A vault shaped like a real one: a fan of folders, each holding files,
// with a few `.gitignore` files scattered through it.
function buildVault(opts: {
  dirs: number;
  filesPerDir: number;
  gitignoreEvery: number;
}): { root: string; vault: Vault; files: number } {
  const root = path.join(
    os.tmpdir(),
    `p8-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".*\n.*/\n!/.gitignore\n");
  let files = 0;
  for (let d = 0; d < opts.dirs; d++) {
    // Three levels, so depth is realistic rather than a flat fan.
    const dir = path.join(root, `top${d % 8}`, `mid${d % 32}`, `leaf${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < opts.filesPerDir; f++) {
      fs.writeFileSync(path.join(dir, `n${f}.md`), "x");
      files++;
    }
    if (d % opts.gitignoreEvery === 0) {
      fs.writeFileSync(path.join(dir, ".gitignore"), "build\n/dist\n");
      files++;
    }
  }
  return { root, vault: new Vault(root), files };
}

const walk = (vault: Vault, dirIgnored: (d: string) => boolean = () => false) =>
  findMigrationCandidates({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    dirIgnored,
  });

describe("P8 — migration walk cost and its shape", () => {
  it("scales with the tree, at the declared ceiling and 10x a normal case", async () => {
    // 200 dirs x 10 files ~= 2k files (a normal vault), then 2000 x 10
    // ~= 20k — the declared ceiling. The RATIO is the assertion; the
    // absolute ms is only a baseline to watch.
    const points: Array<{ dirs: number; files: number; ms: number }> = [];
    const roots: string[] = [];
    try {
      for (const dirs of [200, 2000]) {
        const built = buildVault({ dirs, filesPerDir: 10, gitignoreEvery: 20 });
        roots.push(built.root);
        const t0 = performance.now();
        const r = await walk(built.vault);
        const ms = performance.now() - t0;
        points.push({ dirs, files: built.files, ms });
        emit({
          name: `P8-walk-${dirs}`,
          ms: Math.round(ms),
          dirs: r.dirsScanned,
          files: built.files,
          candidates: r.candidates.length,
        });
        expect(r.completed).toBe(true);
      }

      // 10x the input. Linear would be ~10x the time; anything near 100x
      // is quadratic and a defect. The bar is deliberately loose (25x) so
      // this fails on a shape change, not on a noisy machine.
      const ratio = points[1].ms / Math.max(points[0].ms, 1);
      emit({
        name: "P8-walk-growth",
        ms: Math.round(points[1].ms),
        inputRatio: points[1].files / points[0].files,
        timeRatio: Math.round(ratio * 10) / 10,
      });
      expect(ratio).toBeLessThan(25);
    } finally {
      for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    }
  }, 300_000);

  it("pruning makes a node_modules-shaped subtree free, not merely cheap", async () => {
    // §8.1.1a's cost claim, measured: the worst realistic case is one
    // enormous excluded directory, and pruning must stop the DESCENT so
    // none of it is listed at all.
    const built = buildVault({ dirs: 400, filesPerDir: 10, gitignoreEvery: 20 });
    try {
      const t0 = performance.now();
      const full = await walk(built.vault);
      const fullMs = performance.now() - t0;

      const t1 = performance.now();
      const pruned = await walk(built.vault, (d) => d.startsWith("top0"));
      const prunedMs = performance.now() - t1;

      emit({
        name: "P8-prune-off",
        ms: Math.round(fullMs),
        dirs: full.dirsScanned,
      });
      emit({
        name: "P8-prune-on",
        ms: Math.round(prunedMs),
        dirs: pruned.dirsScanned,
        pruned: pruned.dirsPruned,
      });

      // The saving must be in DIRECTORIES NOT LISTED, which is the only
      // form of saving that survives a slower filesystem.
      expect(pruned.dirsScanned).toBeLessThan(full.dirsScanned);
      expect(pruned.dirsPruned).toBeGreaterThan(0);
    } finally {
      fs.rmSync(built.root, { recursive: true, force: true });
    }
  }, 300_000);
});
