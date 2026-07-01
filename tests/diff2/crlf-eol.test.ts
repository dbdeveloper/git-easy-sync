import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";

// bug-59: opening a CRLF (or old-Mac CR) conflict throws
//   "RangeError: Invalid position N in document of length M".
// Root cause pinned below: buildModel keeps \r in BOTH doc and ranges, but CM6
// EditorState.create NORMALIZES \r\n → \n → the CM6 doc is shorter than the string
// the ranges were computed on → range positions overflow the doc → RangeError.
//
// These tests LOCK IN the mechanism (repro). The fix normalizes \r\n/\r → \n at the
// snapshot-bytes → model-string boundary (bytes stay raw; model strings are \n), so
// buildModel's ranges and the CM6 doc always agree.

describe("bug-59 repro — CRLF breaks the diff2 model (CM6 strips \\r, ranges don't)", () => {
  it("CM6 EditorState.create STRIPS \\r — where the position mismatch is born", () => {
    const raw = "a\r\nb\r\nc\n"; // 3 line-ends, two of them CRLF
    const doc = EditorState.create({ doc: raw }).doc;
    expect(doc.length).toBeLessThan(raw.length); // the \r's are gone
    expect(doc.toString()).toBe(raw.replace(/\r/g, ""));
  });

  it("buildModel keeps \\r in doc+ranges → CM6 strips them → ranges overflow the doc", () => {
    const base = "alpha\r\nbeta\r\n";
    const sibling = "alpha\r\nGAMMA\r\n";
    const m = buildModel(base, sibling);
    expect(m.doc).toContain("\r"); // model doc carries the CRLF
    const cmLen = EditorState.create({ doc: m.doc }).doc.length;
    expect(cmLen).toBeLessThan(m.doc.length); // CM6 dropped the \r's
    // A range.to computed on the \r-full doc now points PAST the CM6 doc's end.
    expect(Math.max(...m.ranges.map((r) => r.to))).toBeGreaterThan(cmLen);
  });

  it("normalizing \\r\\n → \\n BEFORE buildModel makes ranges and the CM6 doc agree (the fix)", () => {
    const toLf = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const m = buildModel(toLf("alpha\r\nbeta\r\n"), toLf("alpha\r\nGAMMA\r\n"));
    expect(m.doc).not.toContain("\r");
    const cmLen = EditorState.create({ doc: m.doc }).doc.length;
    expect(cmLen).toBe(m.doc.length); // no \r stripped → same length
    expect(Math.max(...m.ranges.map((r) => r.to))).toBeLessThanOrEqual(cmLen);
  });
});
