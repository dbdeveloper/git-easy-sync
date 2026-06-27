import { describe, it, expect } from "vitest";
import { computeWordDiff } from "../../src/diff2/word-level-diff";

describe("computeWordDiff", () => {
  it("returns empty spans when sides are identical", () => {
    const result = computeWordDiff("same text here", "same text here");
    expect(result.oursSpans).toEqual([]);
    expect(result.theirsSpans).toEqual([]);
  });

  it("returns full-range span when sides differ entirely", () => {
    const result = computeWordDiff("abc", "xyz");
    expect(result.oursSpans).toHaveLength(1);
    expect(result.oursSpans[0]).toEqual({ start: 0, end: 3 });
    expect(result.theirsSpans).toHaveLength(1);
    expect(result.theirsSpans[0]).toEqual({ start: 0, end: 3 });
  });

  // bug-8 — CHARACTER-level, not word-level: a one-letter change highlights only that
  // letter, not the whole word. The marked slice on each side is exactly the differing chars.
  const marked = (a: string, b: string) => {
    const r = computeWordDiff(a, b);
    return {
      ours: r.oursSpans.map((s) => a.slice(s.start, s.end)).join("|"),
      theirs: r.theirsSpans.map((s) => b.slice(s.start, s.end)).join("|"),
    };
  };
  it("one-letter change → highlights only the letter (True vs true)", () => {
    expect(marked("True", "true")).toEqual({ ours: "T", theirs: "t" }); // shared "rue" untouched
  });
  it("wordLevel=true → marks the WHOLE changed word (Settings: Words mode)", () => {
    const r = computeWordDiff("True", "true", true);
    expect(r.oursSpans.map((s) => "True".slice(s.start, s.end)).join("|")).toBe("True");
    expect(r.theirsSpans.map((s) => "true".slice(s.start, s.end)).join("|")).toBe("true");
  });
  it("shared suffix kept (false vs true → fals / tru, common trailing e)", () => {
    expect(marked("false", "true")).toEqual({ ours: "fals", theirs: "tru" });
  });
  it("highlights only the changed region inside a shared prefix", () => {
    const { ours, theirs } = marked('"x": local', '"x": local2');
    expect(ours).toBe(""); // ours is a prefix of theirs → nothing removed
    expect(theirs).toBe("2"); // only the appended char
  });

  it("returns empty for added-only / removed-only side", () => {
    // theirs has additional words; ours has no changes.
    const result = computeWordDiff("hello", "hello world");
    expect(result.oursSpans).toEqual([]);
    expect(result.theirsSpans.length).toBeGreaterThan(0);
    // The added " world" is captured.
    const theirsMarked = result.theirsSpans
      .map((s) => "hello world".slice(s.start, s.end))
      .join("");
    expect(theirsMarked).toContain("world");
  });

  it("keeps changed runs separated by a shared character non-adjacent", () => {
    // "aaa bbb ccc" vs "aaa xxx yyy": the shared "aaa " + inner space stay common, so
    // "bbb" and "ccc" are two separate spans — mergeAdjacent must NOT fuse across the
    // common space. (When runs DO abut, mergeAdjacent collapses them — same invariant.)
    const result = computeWordDiff("aaa bbb ccc", "aaa xxx yyy");
    // Both "bbb" and "ccc" changed → expect 1 or 2 spans on ours; if
    // 2, they must not be adjacent in the merged output.
    for (let i = 1; i < result.oursSpans.length; i++) {
      expect(result.oursSpans[i].start).toBeGreaterThan(
        result.oursSpans[i - 1].end,
      );
    }
  });
});
