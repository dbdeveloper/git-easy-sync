// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, expect, it } from "vitest";
import { docEdgeForLine } from "../../src/diff2/diff-pane-v2";

// Owner, 2026-10-18: a diff group at the very start/end of a long document —
// its [keep][remove] marker sits ABOVE the first line, [apply][remove] BELOW
// the last; a keyboard move onto that line scrolled only the LINE into view,
// so the buttons stayed off-screen. A keyboard move that lands on the first
// (last) VISIBLE line scrolls to the very top (bottom). Hidden lines (height 0
// — e.g. a ver-block's terminal) do not count as visible.
describe("docEdgeForLine", () => {
  const visible = (hidden: number[]) => (n: number) => !hidden.includes(n);

  it("🔑 the first line → top", () => {
    expect(docEdgeForLine(1, 100, visible([]))).toBe("top");
  });

  it("🔑 the last line → bottom", () => {
    expect(docEdgeForLine(100, 100, visible([]))).toBe("bottom");
  });

  it("🔑 the last VISIBLE line, only hidden lines after it → bottom", () => {
    expect(docEdgeForLine(98, 100, visible([99, 100]))).toBe("bottom");
  });

  it("the first visible line after hidden ones → top", () => {
    expect(docEdgeForLine(3, 100, visible([1, 2]))).toBe("top");
  });

  it("anywhere else → nothing", () => {
    expect(docEdgeForLine(2, 100, visible([]))).toBeNull();
    expect(docEdgeForLine(99, 100, visible([]))).toBeNull();
  });

  it("a one-line document → top", () => {
    expect(docEdgeForLine(1, 1, visible([]))).toBe("top");
  });
});
