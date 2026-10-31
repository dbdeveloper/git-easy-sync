// DIFF-EDITOR-V2.md §2.1.1 (owner, 2026-10-30): the diff editor's line
// comparison runs ONCE per (base, sibling) pair, off the main thread, within
// a time limit and a limit on the number of diff groups. Field: a 2 MB note
// with ~12 500 changed lines froze Obsidian for minutes — `diffLines` ran
// with no limit, on the main thread, twice.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as jsdiff from "diff";

vi.mock("diff", async (orig) => {
  const real = await orig<typeof import("diff")>();
  return { ...real, diffLines: vi.fn(real.diffLines) };
});

import { buildModel } from "../../src/diff2/diff-model";
import {
  DiffTooLargeError,
  clearLineDiffCache,
  countDiffGroups,
  prepareLineDiff,
  type LineDiffRunner,
} from "../../src/diff2/line-diff";

const realDiff = vi.mocked(jsdiff.diffLines);
const runReal: LineDiffRunner = async (a, b) => jsdiff.diffLines(a, b);

// `n` groups: every other line differs.
function pairWithGroups(n: number): { base: string; sibling: string } {
  let base = "";
  let sibling = "";
  for (let i = 0; i < n; i++) {
    base += `same ${i}\nmine ${i}\n`;
    sibling += `same ${i}\ntheirs ${i}\n`;
  }
  return { base, sibling };
}

// The parts a comparison of an `n`-group pair returns — built directly, so a
// limit test does not spend minutes comparing (10 000 groups take ~80 s).
function partsWithGroups(n: number) {
  const parts: { value: string; added?: boolean; removed?: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    parts.push({ value: `same ${i}\n` }, { value: `mine ${i}\n`, removed: true }, { value: `theirs ${i}\n`, added: true });
  }
  return parts;
}

afterEach(() => {
  clearLineDiffCache();
  realDiff.mockClear();
});

describe("countDiffGroups", () => {
  it("counts runs of changed parts separated by common text — as buildModel groups them", () => {
    const { base, sibling } = pairWithGroups(7);
    const parts = jsdiff.diffLines(base, sibling);
    expect(countDiffGroups(parts)).toBe(7);
    expect(new Set(buildModel(base, sibling).ranges.map((r) => r.group)).size).toBe(7);
  });

  it("identical sides → 0; a change at the very start and end → 2", () => {
    expect(countDiffGroups(jsdiff.diffLines("a\nb\n", "a\nb\n"))).toBe(0);
    expect(countDiffGroups(jsdiff.diffLines("x\nb\ny\n", "X\nb\nY\n"))).toBe(2);
  });
});

describe("prepareLineDiff — limits", () => {
  it("🔑 the comparison gave up (time limit) → DiffTooLargeError", async () => {
    const giveUp: LineDiffRunner = async () => null;
    const err = await prepareLineDiff("a\n", "b\n", giveUp, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(DiffTooLargeError);
    expect((err as DiffTooLargeError).message).toContain("three minutes");
  });

  // Owner, 2026-10-31: with Obsidian 1.14.5 (its CM6 fixed) a 1.3 MB file with
  // ~5000 groups is fluent — the number of groups is no longer a limit.
  it("🔑 any number of diff groups opens — only the time limit stops a comparison", async () => {
    const many: LineDiffRunner = async () => partsWithGroups(20_000);
    const r = await prepareLineDiff("a\n", "b\n", many, new AbortController().signal);
    expect(r.groups).toBe(20_000);
  });
});

describe("prepareLineDiff — one comparison per pair", () => {
  it("🔑 buildModel of a prepared pair does NOT compare again (main thread stays free)", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const runner = vi.fn(runReal);
    await prepareLineDiff(base, sibling, runner, new AbortController().signal);
    realDiff.mockClear();
    const m = buildModel(base, sibling);
    expect(realDiff).not.toHaveBeenCalled();
    expect(m.ranges).toHaveLength(2);
    // Preparing the same pair again costs nothing either.
    await prepareLineDiff(base, sibling, runner, new AbortController().signal);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("the result equals the inline one", async () => {
    const { base, sibling } = pairWithGroups(5);
    const inline = buildModel(base, sibling);
    await prepareLineDiff(base, sibling, runReal, new AbortController().signal);
    expect(buildModel(base, sibling)).toEqual(inline);
  });

  it("an unprepared pair still works — compared inline", () => {
    realDiff.mockClear();
    const m = buildModel("x\n", "y\n");
    expect(realDiff).toHaveBeenCalledTimes(1);
    expect(m.ranges).toHaveLength(2);
  });

  it("keeps the last two pairs (the vault read and the session read of one pair may differ)", async () => {
    await prepareLineDiff("1\n", "2\n", runReal, new AbortController().signal);
    await prepareLineDiff("3\n", "4\n", runReal, new AbortController().signal);
    realDiff.mockClear();
    buildModel("1\n", "2\n");
    buildModel("3\n", "4\n");
    expect(realDiff).not.toHaveBeenCalled();
  });
});
