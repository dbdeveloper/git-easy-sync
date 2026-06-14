// Phase 3 — V2 decoration DECISIONS (§2.2.8 collapse/glyph + §2.2.2 markers).
// Pins the pure spec-encoding; CM6 Decoration construction + geometry is the
// view layer (1a-validated in Chromium).

import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";
import { markerSpecs, verLineDecisions } from "../../src/diff2/diff-decorations";

function model(base: string, sibling: string) {
  const m = buildModel(base, sibling);
  return { ...m, text: Text.of(m.doc.split("\n")) };
}

describe("diff-decorations — verLineDecisions (§2.2.8)", () => {
  it("non-empty ver-block: content lines visible+glyph, terminal line collapsed+no glyph", () => {
    // group: ver1 "L1\nL2\n" (2 content lines), ver2 "R1\n"
    const m = model("a\nL1\nL2\nb\n", "a\nR1\nb\n");
    const d = verLineDecisions(m.text, m.ranges, 0);
    const v1 = d.filter((x) => x.ver === 1);
    expect(v1.map((x) => x.collapsed)).toEqual([false, false, true]); // 2 content + terminal
    expect(v1.map((x) => x.glyph)).toEqual([true, true, false]); // glyph on content, not terminal
    expect(v1.filter((x) => x.isTerminal)).toHaveLength(1);
    const v2 = d.filter((x) => x.ver === 2);
    expect(v2.map((x) => x.collapsed)).toEqual([false, true]); // "R1" + terminal
  });

  it("empty ver-block: terminal line HIDDEN when caret off it", () => {
    const m = model("a\nb\n", "a\nX\nb\n"); // ver1 empty
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const d = verLineDecisions(m.text, m.ranges, 0).filter((x) => x.ver === 1);
    expect(d).toHaveLength(1); // empty ver = just the terminal line
    expect(d[0].collapsed).toBe(true);
    expect(d[0].glyph).toBe(false);
  });

  it("empty ver-block: terminal line SHOWN when caret is on it (focused → expand)", () => {
    const m = model("a\nb\n", "a\nX\nb\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const d = verLineDecisions(m.text, m.ranges, v1.from).filter((x) => x.ver === 1);
    expect(d[0].collapsed).toBe(false); // caret on it → not collapsed
  });

  it("§2.2.12(a) EOL-less last group: the line is VISIBLE (no collapse) + NO ↵ glyph", () => {
    // base "a\nL" vs "a\nR" (both EOL-less) ⇒ doc "a\nL\nR\n"; each ver-block is a
    // single EOL-less content line (terminal \n doubles as the line terminator).
    const m = model("a\nL", "a\nR");
    const d = verLineDecisions(m.text, m.ranges, 0);
    const v1 = d.filter((x) => x.ver === 1);
    const v2 = d.filter((x) => x.ver === 2);
    expect(v1).toHaveLength(1);
    expect(v1[0].collapsed).toBe(false); // visible content, NOT a hidden terminal
    expect(v1[0].glyph).toBe(false); // EOL-less ⇒ no ↵
    expect(v2).toHaveLength(1);
    expect(v2[0].collapsed).toBe(false);
    expect(v2[0].glyph).toBe(false);
  });

  it("collapses ONLY the bare terminal \\n; a blank CONTENT line stays visible", () => {
    // ver1 block "a\n\n\n": content "a\n\n" (line "a" + a blank CONTENT line) + terminal "\n".
    const doc = Text.of("a\n\n\nZ\n".split("\n"));
    const ranges = [{ from: 0, to: 4, ver: 1 as const, group: 0 }];
    const d = verLineDecisions(doc, ranges, 999);
    expect(d).toHaveLength(3); // "a", blank content, bare terminal
    expect(d.map((x) => x.collapsed)).toEqual([false, false, true]); // only the terminal collapses
    expect(d[1].from).toBe(2); // the blank content line stays VISIBLE
    expect(d[2].isTerminal).toBe(true);
  });

  it("normal lines produce no decisions", () => {
    const m = model("a\nL\nb\n", "a\nR\nb\n");
    const d = verLineDecisions(m.text, m.ranges, 0);
    // only the 2 ver lines (ver1 "L\n" terminal? no: "L\n"+terminal = 2 lines, "R\n"+terminal = 2 lines)
    expect(d.every((x) => x.ver === 1 || x.ver === 2)).toBe(true);
    expect(new Set(d.map((x) => x.group))).toEqual(new Set([0]));
  });
});

describe("diff-decorations — markerSpecs (§2.2.2)", () => {
  it("emits open/mid/close per group; all side:-1 for an interior group (TODO #1-safe)", () => {
    const m = model("a\nL\nb\n", "a\nR\nb\n"); // one interior group (gamma... actually 'b\n' follows)
    const specs = markerSpecs(m.text, m.ranges);
    expect(specs.map((s) => s.kind)).toEqual(["open", "mid", "close"]);
    expect(specs.every((s) => s.side === -1)).toBe(true); // group is interior → close also side:-1
    // open anchors above ver1's first line, mid above ver2's first line
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    expect(specs.find((s) => s.kind === "open")!.pos).toBe(m.text.lineAt(v1.from).from);
    expect(specs.find((s) => s.kind === "mid")!.pos).toBe(m.text.lineAt(v2.from).from);
  });

  it("bug-22: close marker is side:-1 even when the group ends the doc (trailing final line stays below >>>>>)", () => {
    const m = model("a\nL\n", "a\nR\n"); // trailing diff: group is the last thing
    const specs = markerSpecs(m.text, m.ranges);
    const close = specs.find((s) => s.kind === "close")!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    expect(v2.to).toBe(m.text.length); // group really ends the doc (ver2.to === docLen)
    // there is STILL a trailing final line at v2.to; the marker anchors ABOVE it.
    expect(close.pos).toBe(m.text.lineAt(v2.to).from);
    expect(close.side).toBe(-1);
  });

  it("multi-group: one open/mid/close triple per group, in order", () => {
    const m = model("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const specs = markerSpecs(m.text, m.ranges);
    expect(specs.filter((s) => s.kind === "open").map((s) => s.group)).toEqual([0, 1]);
    expect(specs).toHaveLength(6);
  });
});
