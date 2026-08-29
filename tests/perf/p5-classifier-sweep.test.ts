import { describe, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import ConflictStore from "../../src/sync2/conflict-store";
import { evaluateConflictState } from "../../src/sync2/conflict-classifier";
import { timed } from "./perf-helpers";

// P5 — classifier sweep at scale. Drain-start sweep calls
// evaluateConflictState() once per drain, walking every
// ConflictRecord in the store. This benchmark confirms that the
// per-record (mtime, size) → cached siblingSha watermark stays
// fast enough at N=100…1000 records on mobile-class hardware
// without a different bucketing structure.
//
// This is a self-contained local benchmark — no GitHub network, no
// real client. It builds N records on a tmpfs vault, then times two
// sweeps:
//   - "cache-hit": every record's (mtime, size) matches its persisted
//     cache — sweep should never read+hash, only stat.
//   - "cache-miss": every sibling file's mtime is bumped, forcing a
//     full re-read + re-hash + meta.json rewrite for each record.
//
// Output:
//   PERF_BASELINE {"name":"P5-classifier-sweep-cache-hit-100","ms":...,"records":100}
//   PERF_BASELINE {"name":"P5-classifier-sweep-cache-miss-100","ms":...,"records":100}
//   ... 500, 1000.
//
// Run with `pnpm test:perf`. Skipped by the integration suite.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

async function buildFixture(count: number): Promise<{
  root: string;
  vault: Vault;
  store: ConflictStore;
  siblingPaths: string[];
  basePaths: string[];
  cleanup: () => void;
}> {
  const root = path.join(
    os.tmpdir(),
    `p5-classifier-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let counter = 0;
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    idFactory: () =>
      `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`,
  });
  await store.load();

  const siblingPaths: string[] = [];
  const basePaths: string[] = [];
  for (let i = 0; i < count; i++) {
    const basePath = `Notes/note-${i}.md`;
    const baseContent = `local content for note ${i}\n`;
    const fullBaseAbs = path.join(root, basePath);
    fs.mkdirSync(path.dirname(fullBaseAbs), { recursive: true });
    fs.writeFileSync(fullBaseAbs, baseContent);

    const theirsBytes = new TextEncoder().encode(
      `theirs content for note ${i}\n`,
    );
    const theirsBuf = theirsBytes.buffer.slice(
      theirsBytes.byteOffset,
      theirsBytes.byteOffset + theirsBytes.byteLength,
    ) as ArrayBuffer;
    const rec = await store.create({
      vaultPath: basePath,
      kind: "modify-vs-modify",
      theirsContent: theirsBuf,
      theirsBlobSha: `theirs-${i}`,
      oursBlobSha: `ours-${i}`,
      baseMtime: null,
      baseSize: null,
      baseSha: null,
      remoteDevice: "perf",
    });

    // Run one warm-up sweep so each record's base cache is populated
    // (so the "cache-hit" scenario actually hits). This isn't part of
    // the measured block.
    siblingPaths.push(rec.siblingPath);
    basePaths.push(basePath);
  }
  // One pre-sweep to populate base cache fields.
  await evaluateConflictState(
    store,
    vault as unknown as import("obsidian").Vault,
  );

  return {
    root,
    vault,
    store,
    siblingPaths,
    basePaths,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function runForCount(count: number): Promise<void> {
  const f = await buildFixture(count);
  try {
    // Cache-hit scenario: every record's mtime+size matches its
    // persisted values from the warm-up sweep. The classifier should
    // skip every read+hash.
    await timed(
      `P5-classifier-sweep-cache-hit-${count}`,
      { records: count, scenario: "cache-hit" },
      async () => {
        await evaluateConflictState(
          f.store,
          f.vault as unknown as import("obsidian").Vault,
        );
      },
    );

    // Cache-miss scenario: touch every sibling AND base file to
    // bump mtime → every record forces a fresh read+hash + meta.json
    // rewrite via updateCache.
    const futureSec = Date.now() / 1000 + 60;
    for (const p of f.siblingPaths) {
      fs.utimesSync(path.join(f.root, p), futureSec, futureSec);
    }
    for (const p of f.basePaths) {
      fs.utimesSync(path.join(f.root, p), futureSec, futureSec);
    }
    await timed(
      `P5-classifier-sweep-cache-miss-${count}`,
      { records: count, scenario: "cache-miss" },
      async () => {
        await evaluateConflictState(
          f.store,
          f.vault as unknown as import("obsidian").Vault,
        );
      },
    );
  } finally {
    f.cleanup();
  }
}

describe("P5 — classifier sweep baseline (cache hit vs miss × N)", () => {
  it.each([100, 500, 1000])(
    "N=%i: cache-hit + cache-miss sweeps",
    async (count) => {
      await runForCount(count);
    },
    120_000,
  );
});
