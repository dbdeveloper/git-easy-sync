import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import CommitStats, {
  costLine,
  forecastMs,
  parseCommitStats,
} from "../../src/sync2/commit-stats";

// COMMIT-PASS-PERF step 3a (spec §3.2): per action the largest and the
// smallest file it ever handled; a line through the two gives the
// per-call overhead and the per-byte cost.

const PLUGIN_ID = "git-easy-sync";
const MB = 1024 * 1024;

describe("costLine — the line through the largest and the smallest record", () => {
  it("two distinct points: per-byte slope and per-call overhead", () => {
    // 2 ms for a 1 KB file, 102 ms for 10 MB + 1 KB → 10 ms per MB, ~2 ms overhead.
    const l = costLine({
      smallest: { bytes: 1024, ms: 2 },
      largest: { bytes: 10 * MB + 1024, ms: 102 },
    })!;
    expect(l.msPerByte * MB).toBeCloseTo(10, 6);
    expect(l.overheadMs).toBeCloseTo(2 - 1024 * l.msPerByte, 6);
  });

  it("🔑 thousands of tiny files are NOT forecast as instant — the overhead counts per file", () => {
    const l = costLine({
      smallest: { bytes: 100, ms: 3 }, // a bridge round trip
      largest: { bytes: 50 * MB, ms: 1000 },
    })!;
    // 20 000 files of 2 KB: bytes alone would say ~0.8 s.
    const ms = forecastMs(l, 20_000, 20_000 * 2048);
    expect(ms).toBeGreaterThan(20_000 * 2.9);
  });

  it("only one record (or both the same size): all time is per byte, no overhead", () => {
    expect(costLine({ largest: { bytes: 1000, ms: 10 }, smallest: null })).toEqual({
      overheadMs: 0,
      msPerByte: 0.01,
    });
    expect(
      costLine({ largest: { bytes: 1000, ms: 10 }, smallest: { bytes: 1000, ms: 4 } }),
    ).toEqual({ overheadMs: 0, msPerByte: 0.01 });
  });

  it("a noisy pair (the bigger file was faster) never goes negative", () => {
    const l = costLine({
      smallest: { bytes: 10, ms: 5 },
      largest: { bytes: 1000, ms: 1 },
    })!;
    expect(l.msPerByte).toBe(0);
    expect(l.overheadMs).toBe(5);
  });

  it("no records → no line (the caller says \"Checking all files…\")", () => {
    expect(costLine({ largest: null, smallest: null })).toBeNull();
  });
});

describe("CommitStats", () => {
  let dir: string;
  let vault: Vault;
  const file = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID, ".runtime", "commit-stats.json");
  const make = (): CommitStats =>
    new CommitStats({ vault: vault as never, selfPluginId: PLUGIN_ID });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "commit-stats-"));
    fs.mkdirSync(path.join(dir, ".obsidian", "plugins", PLUGIN_ID), { recursive: true });
    vault = new Vault(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a record is replaced only by a LARGER (largest) or SMALLER (smallest) file", () => {
    const s = make();
    s.record("hash", 1000, 10);
    s.record("hash", 500, 3);
    s.record("hash", 700, 99); // neither larger nor smaller — ignored
    s.record("hash", 5000, 40);
    expect(s.snapshot().hash).toEqual({
      largest: { bytes: 5000, ms: 40 },
      smallest: { bytes: 500, ms: 3 },
    });
  });

  it("the three actions are kept apart", () => {
    const s = make();
    s.record("read", 10, 1);
    s.record("write", 20, 2);
    const snap = s.snapshot();
    expect(snap.read.largest).toEqual({ bytes: 10, ms: 1 });
    expect(snap.write.largest).toEqual({ bytes: 20, ms: 2 });
    expect(snap.hash.largest).toBeNull();
  });

  it("dot-space: rewritten only on > 20% drift of time or of entry count", () => {
    const s = make();
    s.recordDot(100, 1000);
    s.recordDot(110, 1150); // +10% / +15% — kept
    expect(s.snapshot().dot).toEqual({ entries: 100, ms: 1000 });
    s.recordDot(100, 1300); // +30% time
    expect(s.snapshot().dot).toEqual({ entries: 100, ms: 1300 });
    s.recordDot(200, 1300); // +100% entries
    expect(s.snapshot().dot).toEqual({ entries: 200, ms: 1300 });
  });

  it("flush writes only when something changed; load reads it back", async () => {
    const s = make();
    await s.flush();
    expect(fs.existsSync(file())).toBe(false); // nothing measured, nothing written
    s.record("write", 4096, 1.5);
    s.recordDot(76, 40);
    await s.flush();
    const mtime = fs.statSync(file()).mtimeMs;
    await s.flush(); // clean — no rewrite
    expect(fs.statSync(file()).mtimeMs).toBe(mtime);

    const t = make();
    await t.load();
    expect(t.snapshot()).toEqual(s.snapshot());
    expect(t.hasAny()).toBe(true);
  });

  it("a torn or foreign file reads as \"no statistics yet\" — never an error", async () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), "{\"v\":1,\"read\":{\"largest\":{\"bytes\":-1");
    const s = make();
    await s.load();
    expect(s.hasAny()).toBe(false);
    expect(parseCommitStats("{\"v\":2}").read.largest).toBeNull();
    expect(
      parseCommitStats(JSON.stringify({ v: 1, hash: { largest: { bytes: 5, ms: "x" } } })).hash
        .largest,
    ).toBeNull();
  });

  it("🔑 reset() forgets the in-memory numbers, so a flush after RESET cannot write them back", async () => {
    const s = make();
    s.record("hash", 1000, 10);
    await s.flush();
    rmSync(path.dirname(file()), { recursive: true, force: true }); // RESET wipes .runtime/
    s.reset();
    expect(s.hasAny()).toBe(false);
    s.record("read", 1, 1); // the next commit measures afresh
    await s.flush();
    const t = make();
    await t.load();
    expect(t.snapshot().hash.largest).toBeNull();
    expect(t.snapshot().read.largest).toEqual({ bytes: 1, ms: 1 });
  });

  it("forecast(): null without records, the line's value with them", () => {
    const s = make();
    expect(s.forecast("write", 10, 10 * MB)).toBeNull();
    s.record("write", MB, 10);
    expect(s.forecast("write", 10, 10 * MB)).toBeCloseTo(100, 6);
  });
});
