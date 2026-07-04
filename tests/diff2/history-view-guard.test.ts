// Phase 7 §4.7 7a.2 — the per-file diff2-history dup-guard (pure). Mirrors the
// openGuard/alignOpenDescs test style: main.ts maps getLeavesOfType → paths and
// resolves the returned index against the SAME array. A leaf mid-rebuild has a
// null path (transient empty getState on a split) → must never match.

import { describe, it, expect } from "vitest";
import { findExistingHistoryLeaf } from "../../src/diff2/editor-tabs";

describe("findExistingHistoryLeaf", () => {
  it("returns -1 when no leaf shows the path", () => {
    expect(findExistingHistoryLeaf(["a.md", "b.md"], "c.md")).toBe(-1);
  });

  it("returns the index of the leaf already showing the path", () => {
    expect(findExistingHistoryLeaf(["a.md", "b.md", "c.md"], "b.md")).toBe(1);
  });

  it("a null slot (leaf mid-rebuild / transient empty state) never matches", () => {
    expect(findExistingHistoryLeaf([null, null], "a.md")).toBe(-1);
    // even when a null sits before the real match, the index stays honest.
    expect(findExistingHistoryLeaf([null, "a.md"], "a.md")).toBe(1);
  });

  it("returns the FIRST match (index aligned with the leaf array)", () => {
    expect(findExistingHistoryLeaf(["a.md", "a.md"], "a.md")).toBe(0);
  });

  it("empty leaf list → -1", () => {
    expect(findExistingHistoryLeaf([], "a.md")).toBe(-1);
  });
});

// Keyboard-driven HistoryList nav (§ user request 2026-07-04): arrows / Home / End / PgUp /
// PgDn move the selection; Enter opens. Pure resolver — clamps at both ends, ignores other keys.
import { nextHistorySelection } from "../../src/diff2/diff-history-view";

describe("nextHistorySelection", () => {
  it("Arrow keys move by one, clamped at both ends", () => {
    expect(nextHistorySelection("ArrowDown", 0, 5)).toBe(1);
    expect(nextHistorySelection("ArrowDown", 4, 5)).toBe(4); // clamped
    expect(nextHistorySelection("ArrowUp", 2, 5)).toBe(1);
    expect(nextHistorySelection("ArrowUp", 0, 5)).toBe(0); // clamped
  });

  it("Home / End jump to the ends", () => {
    expect(nextHistorySelection("Home", 3, 5)).toBe(0);
    expect(nextHistorySelection("End", 1, 5)).toBe(4);
  });

  it("PageDown / PageUp jump by a page, clamped", () => {
    expect(nextHistorySelection("PageDown", 0, 25)).toBe(10);
    expect(nextHistorySelection("PageDown", 0, 5)).toBe(4); // clamped (0+10 > 4)
    expect(nextHistorySelection("PageUp", 15, 25)).toBe(5);
    expect(nextHistorySelection("PageUp", 3, 25)).toBe(0); // clamped
  });

  it("Enter → 'open'", () => {
    expect(nextHistorySelection("Enter", 2, 5)).toBe("open");
  });

  it("unhandled keys → null (pass through)", () => {
    expect(nextHistorySelection("a", 2, 5)).toBeNull();
    expect(nextHistorySelection("Tab", 2, 5)).toBeNull();
  });

  it("empty list → null for every key", () => {
    expect(nextHistorySelection("ArrowDown", 0, 0)).toBeNull();
    expect(nextHistorySelection("Enter", 0, 0)).toBeNull();
  });
});
