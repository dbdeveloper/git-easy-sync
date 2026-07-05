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
  // Cyrillic word-mode: jsdiff's default tokenizer only knows ASCII/Latin word
  // chars, so it USED to split Cyrillic character-by-character → word-mode marked
  // mid-word fragments just like char-mode (user report). With an Intl.Segmenter
  // wired in, whole changed words are marked and the shared word is left alone.
  it("wordLevel=true → marks whole Cyrillic WORDS, not fragments", () => {
    const ours = "кіт сидить тут";
    const theirs = "пес сидить там";
    const r = computeWordDiff(ours, theirs, true);
    expect(r.oursSpans.map((s) => ours.slice(s.start, s.end)).join("|")).toBe("кіт|тут");
    expect(r.theirsSpans.map((s) => theirs.slice(s.start, s.end)).join("|")).toBe("пес|там");
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

// Cyrillic + word-mode (user report). jsdiff's default word tokenizer only knows
// ASCII/extended-Latin word chars, so it USED to split Cyrillic character-by-
// character → word-mode highlighted mid-word fragments exactly like char-mode.
// An Intl.Segmenter (granularity:"word") wired into computeWordDiff makes it
// respect real Unicode word boundaries. Each case asserts WHOLE changed words are
// marked and shared words are left untouched.
describe("computeWordDiff — Cyrillic word-mode", () => {
  // wordLevel=true → the coarse WORD granularity the "Diff-mode: Word" setting selects.
  const markedWords = (a: string, b: string) => {
    const r = computeWordDiff(a, b, true);
    return {
      ours: r.oursSpans.map((s) => a.slice(s.start, s.end)).join("|"),
      theirs: r.theirsSpans.map((s) => b.slice(s.start, s.end)).join("|"),
    };
  };

  it("marks whole changed words, leaves the shared word alone", () => {
    // "сидить" is common → NOT marked; "кіт"/"пес" and "тут"/"там" are whole-word swaps.
    expect(markedWords("кіт сидить тут", "пес сидить там")).toEqual({
      ours: "кіт|тут",
      theirs: "пес|там",
    });
  });

  it("a one-letter Cyrillic difference still marks the WHOLE word (not the letter)", () => {
    // "розуміємо" vs "розробки": in char-mode the shared "розум"/"роз" would leak
    // through; in word-mode the whole word is the unit.
    expect(markedWords("ми розуміємо це", "ми розробки це")).toEqual({
      ours: "розуміємо",
      theirs: "розробки",
    });
  });

  it("does NOT fragment a common Cyrillic word between two changes", () => {
    // The real conflict text: "розуміємо" sits between changed spans and must survive intact.
    const ours = "всі чудово розуміємо що";
    const theirs = "повинні швидко розуміємо як";
    const r = markedWords(ours, theirs);
    expect(r.ours).not.toContain("розумі"); // no mid-word fragment leaked in
    expect(r.theirs).not.toContain("розумі");
    // The trailing single-word change is still caught whole.
    expect(r.ours.split("|")).toContain("що");
    expect(r.theirs.split("|")).toContain("як");
  });

  it("identical Cyrillic sides → no spans", () => {
    const r = computeWordDiff("ми всі розуміємо", "ми всі розуміємо", true);
    expect(r.oursSpans).toEqual([]);
    expect(r.theirsSpans).toEqual([]);
  });

  it("added Cyrillic word on one side only", () => {
    const r = computeWordDiff("ми розуміємо", "ми добре розуміємо", true);
    expect(r.oursSpans).toEqual([]); // ours is a subset → nothing removed
    const theirs = r.theirsSpans.map((s) => "ми добре розуміємо".slice(s.start, s.end)).join("");
    expect(theirs).toContain("добре");
  });
});
