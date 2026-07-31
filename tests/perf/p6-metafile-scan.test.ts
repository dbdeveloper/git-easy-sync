import { describe, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { emit } from "./perf-helpers";

// P6 — metafile scan costs (docs/tasks/SYNC2-METAFILE-REFACTOR.md).
//
// Local, no network. Measures the dot-space walk/stat costs behind the
// "dot-scan depth" setting, the getFiles-vs-adapter.stat gap, and the
// dir-mtime premise — against the mock fs-backed vault.
//
// ⚠️ This runs on Node fs (the CI/desktop machine), NOT Capacitor. The
// AUTHORITATIVE cross-platform numbers (macOS ~2s / Android ~10-22s full
// walk; adapter.stat ~10000x slower than the index; vault.on blind to
// dot-space) were measured ON DEVICE and live in SYNC2-METAFILE-REFACTOR.md
// §1. This perf test is a repeatable DESKTOP baseline + regression guard for
// the walk/stat shape; it cannot reproduce the Obsidian in-memory index
// (mock getFiles() hits fs too) or Capacitor IPC latency.
//
// Output (grep ^PERF_BASELINE):
//   PERF_BASELINE {"name":"P6-list-walk", ...}
//   PERF_BASELINE {"name":"P6-stat-dots", ...} / P6-stat-regular / P6-getfiles
//   PERF_BASELINE {"name":"P6-depth-<D>", ...}
//   PERF_BASELINE {"name":"P6-dir-mtime-<op>", ...}
//
// Run with `pnpm test:perf`. Skipped by unit + integration suites.

const CONFIG_DIR = ".obsidian";
const N_DIRS = 2000;
const BRANCHING = 8; // 8-ary tree → depth ≈ log_8(2000) ≈ 4
const REGULAR_PER_DIR = 10;
const ROOT = "dir-test";

type Adapter = import("obsidian").Vault["adapter"];

function fixture(): { root: string; vault: Vault; a: Adapter; cleanup: () => void } {
  const root = path.join(os.tmpdir(), `p6-metafile-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  return {
    root,
    vault,
    a: vault.adapter as unknown as Adapter,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// Build an 8-ary tree of N_DIRS dirs under ROOT; each dir gets one `.file`
// + REGULAR_PER_DIR `fileK.md`. Parent created before child (index order).
async function buildTree(a: Adapter): Promise<{ dotFiles: number; regular: number }> {
  const paths: string[] = [ROOT];
  await a.mkdir(ROOT);
  let regular = 0;
  for (let i = 1; i <= N_DIRS; i++) {
    const dir = `${paths[Math.floor((i - 1) / BRANCHING)]}/d${i}`;
    paths.push(dir);
    await a.mkdir(dir);
    const writes: Promise<void>[] = [a.write(`${dir}/.file`, "dot\n")];
    for (let j = 1; j <= REGULAR_PER_DIR; j++) writes.push(a.write(`${dir}/file${j}.md`, `${i}.${j}\n`));
    await Promise.all(writes);
    regular += REGULAR_PER_DIR;
  }
  return { dotFiles: N_DIRS, regular };
}

// Recursive adapter.list walk limited to `maxDepth` (Infinity = whole tree).
async function walk(
  a: Adapter,
  maxDepth = Infinity,
): Promise<{ dirsListed: number; dotFiles: string[]; regularFiles: string[] }> {
  const stack: { dir: string; depth: number }[] = [{ dir: ROOT, depth: 0 }];
  let dirsListed = 0;
  const dotFiles: string[] = [];
  const regularFiles: string[] = [];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (!(await a.exists(dir))) continue;
    const { files, folders } = await a.list(dir);
    dirsListed++;
    for (const f of files) ((f.split("/").pop() ?? f).startsWith(".") ? dotFiles : regularFiles).push(f);
    if (depth < maxDepth) for (const folder of folders) stack.push({ dir: folder, depth: depth + 1 });
  }
  return { dirsListed, dotFiles, regularFiles };
}

describe("P6 — metafile scan costs (dot-space walk/stat, getFiles, dir-mtime)", () => {
  it(
    "full walk + stat (dots via adapter, regular via adapter vs getFiles index)",
    async () => {
      const f = fixture();
      try {
        await buildTree(f.a);

        const tWalk = Date.now();
        const w = await walk(f.a);
        emit({
          name: "P6-list-walk",
          ms: Date.now() - tWalk,
          dirs: w.dirsListed,
          dots: w.dotFiles.length,
          regular: w.regularFiles.length,
        });

        let t = Date.now();
        for (const p of w.dotFiles) await f.a.stat(p);
        emit({ name: "P6-stat-dots", ms: Date.now() - t, stats: w.dotFiles.length });

        t = Date.now();
        for (const p of w.regularFiles) await f.a.stat(p);
        emit({ name: "P6-stat-regular", ms: Date.now() - t, stats: w.regularFiles.length });

        // getFiles() index read for the same regulars (mock: fs-backed; NOT the
        // real Obsidian in-memory index — see header).
        t = Date.now();
        const idx = f.vault.getFiles().filter((tf) => tf.path.startsWith(`${ROOT}/`));
        const map = new Map(idx.map((tf) => [tf.path, tf.stat.mtime]));
        let hits = 0;
        for (const p of w.regularFiles) if (map.has(p)) hits++;
        emit({ name: "P6-getfiles", ms: Date.now() - t, indexed: idx.length, hits });
      } finally {
        f.cleanup();
      }
    },
    120_000,
  );

  it(
    "dot-scan cost vs depth (0 = root only … max)",
    async () => {
      const f = fixture();
      try {
        await buildTree(f.a);
        let prev = -1;
        for (let D = 0; D <= 20; D++) {
          const t0 = Date.now();
          const w = await walk(f.a, D);
          const ms = Date.now() - t0;
          if (D > 0 && w.dirsListed === prev) break; // plateaued at real max depth
          emit({ name: `P6-depth-${D}`, ms, dirs: w.dirsListed, dots: w.dotFiles.length });
          prev = w.dirsListed;
        }
      } finally {
        f.cleanup();
      }
    },
    120_000,
  );

  it(
    "dir-mtime bumps on create / delete / rename (not modify) — premise for pruning",
    async () => {
      const f = fixture();
      try {
        const dir = "mtime-probe";
        await f.a.mkdir(dir);
        await f.a.write(`${dir}/a.md`, "1\n");
        const m = async (): Promise<number> => (await f.a.stat(dir))?.mtime ?? 0;

        // Node fs mtime resolution is fine-grained; no artificial delay needed
        // here (unlike the on-device test which padded for FAT's 2s resolution).
        const m0 = await m();
        await f.a.write(`${dir}/b.md`, "2\n");
        const mCreate = await m();
        await f.a.remove(`${dir}/b.md`);
        const mDelete = await m();
        await f.a.rename(`${dir}/a.md`, `${dir}/a2.md`);
        const mRename = await m();
        await f.a.write(`${dir}/a2.md`, "mod\n");
        const mModify = await m();

        emit({ name: "P6-dir-mtime-create", ms: 0, bumped: mCreate > m0 });
        emit({ name: "P6-dir-mtime-delete", ms: 0, bumped: mDelete > mCreate });
        emit({ name: "P6-dir-mtime-rename", ms: 0, bumped: mRename > mDelete });
        emit({ name: "P6-dir-mtime-modify", ms: 0, bumped: mModify > mRename });
      } finally {
        f.cleanup();
      }
    },
    60_000,
  );
});
