import { describe, it, expect } from "vitest";
import { mergeText } from "../../src/sync2/three-way-merge";

describe("mergeText", () => {
  it("returns clean unchanged content when nothing diverged", () => {
    const text = "line1\nline2\nline3";
    const r = mergeText(text, text, text);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") expect(r.content).toBe(text);
  });

  it("clean merge when both sides edit different parts", () => {
    const base = "line1\nline2\nline3\nline4";
    const ours = "line1-ours\nline2\nline3\nline4";
    const theirs = "line1\nline2\nline3\nline4-theirs";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content).toContain("line1-ours");
      expect(r.content).toContain("line4-theirs");
      expect(r.content).toContain("line2");
      expect(r.content).toContain("line3");
    }
  });

  it("clean merge when both sides made the identical change (false conflict)", () => {
    const base = "line1\nline2\nline3";
    const ours = "line1\nUPDATED\nline3";
    const theirs = "line1\nUPDATED\nline3";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") expect(r.content).toBe(ours);
  });

  it("conflict when both sides edit the same line differently", () => {
    const base = "line1\nshared\nline3";
    const ours = "line1\nours-version\nline3";
    const theirs = "line1\ntheirs-version\nline3";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("conflict");
    if (r.kind === "conflict") {
      expect(r.conflictMarkedContent).toContain("<<<<<<<");
      expect(r.conflictMarkedContent).toContain(">>>>>>>");
      expect(r.conflictMarkedContent).toContain("ours-version");
      expect(r.conflictMarkedContent).toContain("theirs-version");
      expect(r.conflictMarkedContent).toContain("line1");
      expect(r.conflictMarkedContent).toContain("line3");
    }
  });

  it("ours-only edit: theirs and base identical → keeps ours cleanly", () => {
    const base = "a\nb\nc";
    const ours = "a\nb-edited\nc";
    const theirs = base;
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") expect(r.content).toBe(ours);
  });

  it("theirs-only edit: ours and base identical → adopts theirs cleanly", () => {
    const base = "a\nb\nc";
    const ours = base;
    const theirs = "a\nb-from-remote\nc";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") expect(r.content).toBe(theirs);
  });

  it("preserves CRLF line endings when inputs use them", () => {
    const base = "line1\r\nline2\r\nline3";
    const ours = "line1-ours\r\nline2\r\nline3";
    const theirs = "line1\r\nline2\r\nline3-theirs";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content).toContain("\r\n");
      expect(r.content).toContain("line1-ours");
      expect(r.content).toContain("line3-theirs");
    }
  });

  it("plain LF when no input has CRLF", () => {
    const base = "a\nb\nc";
    const ours = "a-ours\nb\nc";
    const theirs = "a\nb\nc-theirs";
    const r = mergeText(ours, base, theirs);
    if (r.kind === "clean") {
      expect(r.content.includes("\r\n")).toBe(false);
      expect(r.content).toContain("\n");
    }
  });

  it("handles empty base (synchronous additions on both sides)", () => {
    const base = "";
    const ours = "ours-only";
    const theirs = "theirs-only";
    const r = mergeText(ours, base, theirs);
    // Both sides added something to an empty base — that's a conflict.
    expect(r.kind).toBe("conflict");
  });

  it("handles ours-deletes-theirs-keeps as a conflict", () => {
    const base = "line1\nline2\nline3";
    const ours = "line1\nline3"; // line2 deleted locally
    const theirs = "line1\nline2-edited\nline3"; // line2 edited remotely
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("conflict");
  });

  // NEW-DRAIN.md §III (_diff3, CRLF residual case, 2026-08-28) + §VIII category A,
  // scenarios 27-29: the separator must reflect LOCAL's (ours) own dominant EOL, not
  // "any input has CRLF" (SYNC2-FIX.md §8.2.1's measured bug — base/theirs could
  // impose CRLF on a local LF-file). These three only apply to the residual case
  // where short-circuit is impossible (both sides genuinely diverged from base).
  it("CRLF regression (A.27): base has CRLF, ours/theirs LF, real merge — stays LF (not imposed by base)", () => {
    const base = "line1\r\nline2\r\nline3\r\nline4";
    const ours = "line1-ours\nline2\nline3\nline4";
    const theirs = "line1\nline2\nline3\nline4-theirs";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content.includes("\r\n")).toBe(false);
      expect(r.content).toContain("line1-ours");
      expect(r.content).toContain("line4-theirs");
    }
  });

  it("CRLF regression (A.28): ours has CRLF, base/theirs LF, real merge — stays CRLF (local's own style)", () => {
    const base = "line1\nline2\nline3\nline4";
    const ours = "line1-ours\r\nline2\r\nline3\r\nline4";
    const theirs = "line1\nline2\nline3\nline4-theirs";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content).toContain("\r\n");
      expect(r.content).toContain("line1-ours");
      expect(r.content).toContain("line4-theirs");
    }
  });

  it("CRLF regression (A.29): ours has mixed line endings — normalizes to ours' dominant style (tie→crlf)", () => {
    const base = "a\nb\nc\nd";
    const ours = "a-edit\r\nb\r\nc\nd"; // 2 CRLF pairs + 1 lone LF → dominant = crlf (tie-break)
    const theirs = "a\nb\nc\nd-edit";
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content).toContain("a-edit");
      expect(r.content).toContain("d-edit");
      // No lone \n survives once every \r\n pair is stripped out.
      expect(r.content.replace(/\r\n/g, "")).not.toContain("\n");
    }
  });

  it("handles paragraph-scale non-overlapping changes cleanly", () => {
    const base = [
      "# Title",
      "",
      "First paragraph stays.",
      "",
      "Middle paragraph base.",
      "",
      "Last paragraph stays.",
    ].join("\n");
    const ours = base.replace(
      "First paragraph stays.",
      "First paragraph local edit.",
    );
    const theirs = base.replace(
      "Last paragraph stays.",
      "Last paragraph remote edit.",
    );
    const r = mergeText(ours, base, theirs);
    expect(r.kind).toBe("clean");
    if (r.kind === "clean") {
      expect(r.content).toContain("First paragraph local edit.");
      expect(r.content).toContain("Last paragraph remote edit.");
      expect(r.content).toContain("Middle paragraph base.");
    }
  });
});

