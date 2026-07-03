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
