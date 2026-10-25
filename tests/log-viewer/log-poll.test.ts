// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER §2.23-2.24 (owner, 2026-10-25): every open log file is
// polled once a second — a changed file is re-read (new lines appended
// when the text only grew), a file missing at TWO polls in a row closes
// its tab; Esc closes the viewer only when it is the one tab of its own
// pop-out window.

import { describe, it, expect } from "vitest";
import { appendedLines, onlyTabInItsPopout, pollStep } from "../../src/log-viewer/log-poll";

describe("pollStep", () => {
  const st = (size: number, mtime: number) => ({ size, mtime });

  it("unchanged → nothing", () => {
    const r = pollStep({ last: st(10, 1), misses: 0 }, st(10, 1));
    expect(r.action).toBe("none");
  });

  it("🔑 size or mtime changed → re-read, and the new stat is remembered", () => {
    expect(pollStep({ last: st(10, 1), misses: 0 }, st(12, 1))).toEqual({ action: "changed", state: { last: st(12, 1), misses: 0 } });
    expect(pollStep({ last: st(10, 1), misses: 0 }, st(10, 2)).action).toBe("changed");
  });

  it("🔑 missing ONCE → nothing yet (a mobile replace is remove + rename)", () => {
    const r = pollStep({ last: st(10, 1), misses: 0 }, null);
    expect(r).toEqual({ action: "none", state: { last: st(10, 1), misses: 1 } });
  });

  it("🔑 missing at two polls in a row → close", () => {
    const one = pollStep({ last: st(10, 1), misses: 0 }, null);
    expect(pollStep(one.state, null).action).toBe("close");
  });

  it("back after one miss → the miss is forgotten (and a change is a change)", () => {
    const one = pollStep({ last: st(10, 1), misses: 0 }, null);
    expect(pollStep(one.state, st(10, 1))).toEqual({ action: "none", state: { last: st(10, 1), misses: 0 } });
    expect(pollStep(one.state, st(20, 3)).action).toBe("changed");
  });
});

describe("appendedLines", () => {
  it("🔑 the text only grew → the new COMPLETE lines", () => {
    expect(appendedLines("a\nb\n", "a\nb\nc\nd\n")).toEqual(["c", "d"]);
  });

  it("a torn tail is not a line yet — it comes with the next read", () => {
    expect(appendedLines("a\n", "a\nb\nc")).toEqual(["b"]);
    expect(appendedLines("a\nb\nc", "a\nb\ncd\n")).toEqual(["cd"]);
  });

  it("blank lines are skipped, as when the file is opened", () => {
    expect(appendedLines("a\n", "a\n\nb\n")).toEqual(["b"]);
  });

  it("🔑 rewritten or truncated → null (show it anew)", () => {
    expect(appendedLines("a\nb\n", "x\nb\nc\n")).toBeNull();
    expect(appendedLines("a\nb\n", "a\n")).toBeNull();
    expect(appendedLines("a\nb\n", "")).toBeNull();
  });
});

describe("onlyTabInItsPopout", () => {
  const main = { name: "rootSplit" };
  const left = { name: "left" };
  const right = { name: "right" };
  const popA = { name: "popoutA" };
  const leaf = (root: object) => ({ getRoot: () => root });
  const ws = (leaves: Array<{ getRoot: () => object }>) => ({
    rootSplit: main,
    leftSplit: left,
    rightSplit: right,
    iterateAllLeaves: (cb: (l: { getRoot: () => object }) => void) => leaves.forEach(cb),
  });

  it("🔑 the one tab of a pop-out window → true", () => {
    const me = leaf(popA);
    expect(onlyTabInItsPopout(me, ws([me, leaf(main), leaf(main)]))).toBe(true);
  });

  it("🔑 dragged next to other tabs in the pop-out → false", () => {
    const me = leaf(popA);
    expect(onlyTabInItsPopout(me, ws([me, leaf(popA)]))).toBe(false);
  });

  it("🔑 in the main window — even alone — never", () => {
    const me = leaf(main);
    expect(onlyTabInItsPopout(me, ws([me]))).toBe(false);
  });

  it("in a sidebar → never", () => {
    expect(onlyTabInItsPopout(leaf(left), ws([leaf(left)]))).toBe(false);
    expect(onlyTabInItsPopout(leaf(right), ws([leaf(right)]))).toBe(false);
  });
});
