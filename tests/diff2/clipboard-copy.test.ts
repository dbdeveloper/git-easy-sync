// @vitest-environment happy-dom
//
// §2.2.7 COPY — diff-group → fenced clipboard text. Oracle = the spec's byte-exact
// Examples 6/7 (user-finalized), NOT a serialize→parse round-trip (which could
// pass with compensating bugs). The DOM copy-event wiring (clipboardData reaching
// the handler) is a device-gate, not asserted here — happy-dom can't deliver a
// real copy ClipboardEvent into CM6 (same limit as marker-button clicks).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";
import { structureField, toRangeSet } from "../../src/diff2/diff-structure";
import {
  contentLines,
  copyClipboardText,
  serializeGroup,
} from "../../src/diff2/diff-clipboard";

// Build a real EditorState (with structure) the way createDiffPaneState seeds it,
// so copyClipboardText reads the same structure the editor would.
function state(base: string, sibling: string, sel: { anchor: number; head: number }) {
  const m = buildModel(base, sibling);
  return EditorState.create({
    doc: m.doc,
    selection: sel,
    extensions: [structureField, structureField.init(() => toRangeSet(m.ranges))],
  });
}

describe("contentLines (pure)", () => {
  it("empty ver-block → no lines", () => {
    expect(contentLines("")).toEqual([]);
  });
  it("terminated lines all carry \\n", () => {
    expect(contentLines("L1\nL2\n")).toEqual([
      { text: "L1", nl: true },
      { text: "L2", nl: true },
    ]);
  });
  it("EOL-less last line → nl false (§2.2.12 a)", () => {
    expect(contentLines("L1\nL2")).toEqual([
      { text: "L1", nl: true },
      { text: "L2", nl: false },
    ]);
  });
  it("a single blank content line → one empty nl-line", () => {
    expect(contentLines("\n")).toEqual([{ text: "", nl: true }]);
  });
});

describe("serializeGroup — byte-exact against the spec Examples", () => {
  it("Example 6: 3-line ver1, empty ver2", () => {
    const c1 = "ver1-visible-line-1\n  ver1-visible-line-2\nver1-visible-line-3  \n";
    const expected =
      "```github-easy-sync\n" +
      "≪\n" +
      "- ver1-visible-line-1↵\n" +
      "-   ver1-visible-line-2↵\n" +
      "- ver1-visible-line-3  ↵\n" +
      "==\n" +
      "≫\n" +
      "```\n";
    expect(serializeGroup(c1, "")).toBe(expected);
  });

  it("Example 7: 3-line ver1, 3-line ver2 (incl. a blank middle line)", () => {
    const c1 = "ver1-visible-line-1\n  ver1-visible-line-2\nver1-visible-line-3  \n";
    const c2 = "ver2-visible-line-1\n\nver2-visible-line-2\n";
    const expected =
      "```github-easy-sync\n" +
      "≪\n" +
      "- ver1-visible-line-1↵\n" +
      "-   ver1-visible-line-2↵\n" +
      "- ver1-visible-line-3  ↵\n" +
      "==\n" +
      "+ ver2-visible-line-1↵\n" +
      "+ ↵\n" +
      "+ ver2-visible-line-2↵\n" +
      "≫\n" +
      "```\n";
    expect(serializeGroup(c1, c2)).toBe(expected);
  });

  it("EOL-less last line omits ↵ but keeps its \\n separator (§2.2.7 п.6)", () => {
    // ver1 "a\nb" EOL-less (b → no ↵); ver2 "x\n" terminated (x → ↵).
    expect(serializeGroup("a\nb", "x\n")).toBe(
      "```github-easy-sync\n≪\n- a↵\n- b\n==\n+ x↵\n≫\n```\n",
    );
  });
});

describe("copyClipboardText — selection modes", () => {
  it("within ONE ver-block (no terminal) → null (plain copy)", () => {
    const s = state("a\nWORD\nc\n", "a\nR\nc\n", { anchor: 2, head: 6 }); // inside ver1 "WORD"
    expect(copyClipboardText(s)).toBeNull();
  });

  it("whole single group → just the fenced block", () => {
    const m = buildModel("a\nL\nc\n", "a\nR\nc\n");
    const v1from = m.ranges.find((r) => r.ver === 1)!.from;
    const v2to = m.ranges.find((r) => r.ver === 2)!.to;
    const s = state("a\nL\nc\n", "a\nR\nc\n", { anchor: v1from, head: v2to });
    expect(copyClipboardText(s)).toBe("```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\n");
  });

  it("mixed selection (normal + whole group) → normal verbatim + fenced, doc order", () => {
    // select from the trailing normal "c" backward across the group is awkward; use
    // a doc with a normal line AFTER the group inside the selection.
    const base = "L\nc\n"; // group L/R then normal "c"
    const sib = "R\nc\n";
    const m = buildModel(base, sib);
    const v2to = m.ranges.find((r) => r.ver === 2)!.to;
    const s = state(base, sib, { anchor: 0, head: m.doc.length });
    // whole doc selected: group fenced + trailing normal "c\n" verbatim.
    expect(copyClipboardText(s)).toBe("```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\n" + "c\n");
    expect(v2to).toBeLessThan(m.doc.length); // there IS trailing normal
  });

  it("empty selection → null", () => {
    const s = state("a\nL\nc\n", "a\nR\nc\n", { anchor: 3, head: 3 });
    expect(copyClipboardText(s)).toBeNull();
  });
});
