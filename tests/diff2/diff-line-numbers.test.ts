// V2 per-side gutter numbering (§1.10 / §2.2.10 "sibling-wins").
//
// ONE through-counter advanced by normal+ver2; ver1 numbered in PARALLEL from the
// line above (through + offset), NOT the base file's own line number (that was the
// bug — see the §1.10 example case below). The label text carries NO sign; the
// −/+ side glyph is a separate gutter element. `getDiffLineNumber` is the §2.2.10
// fast per-line formula; the property test pins it EQUAL to the full walk.

import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { buildModel } from "../../src/diff2/diff-model";
import { computeLineLabels, getDiffLineNumber, gutterCell, gutterCellAt, lineNumberIndex } from "../../src/diff2/diff-line-numbers";
import type { VerRange } from "../../src/diff2/diff-model";

function model(base: string, sibling: string): { doc: Text; ranges: VerRange[] } {
  const m = buildModel(base, sibling);
  return { doc: Text.of(m.doc.split("\n")), ranges: m.ranges };
}
function labels(base: string, sibling: string) {
  const { doc, ranges } = model(base, sibling);
  return computeLineLabels(doc, ranges);
}

describe("diff-line-numbers — §1.10/§2.2.10 sibling-wins", () => {
  it("ver1 numbered in parallel (text, side); bare terminals get NO number", () => {
    // base "a\nL\nc\n" vs sibling "a\nR1\nR2\nc\n"
    //   1 a normal | 2 L ver1 | 3 "" ver1-term(bare) | 4 R1 ver2 | 5 R2 ver2 |
    //   6 "" ver2-term(bare) | 7 c normal
    const l = labels("a\nL\nc\n", "a\nR1\nR2\nc\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.get(2)).toEqual({ text: "2", side: "ver1" }); // L: through(1)+1
    expect(l.has(3)).toBe(false); // bare terminal
    expect(l.get(4)).toEqual({ text: "2", side: "ver2" }); // R1: through→2 (dup w/ L by design, ± glyph distinguishes)
    expect(l.get(5)).toEqual({ text: "3", side: "ver2" });
    expect(l.has(6)).toBe(false);
    expect(l.get(7)).toEqual({ text: "4", side: "normal" });
  });

  it("§1.10 example — a LATER ver1 block numbers PARALLEL (6), not its base line (4)", () => {
    // base = a b c d e ; sibling = a P Q R c S e. The d (ver1) line must read 6
    // (continuing from c=5), NOT 4 (its base-file line) — the bug this fixes.
    const { doc, ranges } = model("a\nb\nc\nd\ne\n", "a\nP\nQ\nR\nc\nS\ne\n");
    const l = computeLineLabels(doc, ranges);
    // find the line whose content is "d"
    let dLine = -1;
    for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text === "d") dLine = n;
    expect(l.get(dLine)).toEqual({ text: "6", side: "ver1" });
  });

  it("identical inputs (no diff): plain 1..n normal numbering", () => {
    const l = labels("x\ny\nz\n", "x\ny\nz\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.get(2)).toEqual({ text: "2", side: "normal" });
    expect(l.get(3)).toEqual({ text: "3", side: "normal" });
  });

  it("delete-vs-modify (empty ver1): the empty ver-block line gets no number", () => {
    const l = labels("a\nb\n", "a\nX\nb\n");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.has(2)).toBe(false); // empty ver1 → bare → no number
    expect(l.get(3)).toEqual({ text: "2", side: "ver2" });
  });

  it("EOL-less last group: the EOL-less content line IS numbered (no bare terminal)", () => {
    const l = labels("a\nL", "a\nR");
    expect(l.get(1)).toEqual({ text: "1", side: "normal" });
    expect(l.get(2)).toEqual({ text: "2", side: "ver1" });
    expect(l.get(3)).toEqual({ text: "2", side: "ver2" });
  });

  // The §2.2.10 fast per-line formula MUST equal the §1.10 full walk for EVERY line
  // across a range of shapes (the "verify the formula" requirement). A divergence
  // (e.g. the spec's buggy "−1 per block" or a missed bare terminal) fails here.
  it("getDiffLineNumber === computeLineLabels for every line (property)", () => {
    const cases: [string, string][] = [
      ["a\nL\nc\n", "a\nR1\nR2\nc\n"],
      ["a\nb\nc\nd\ne\n", "a\nP\nQ\nR\nc\nS\ne\n"],
      ["a\nb\n", "a\nX\nb\n"], // empty ver1
      ["a\nX\nb\n", "a\nb\n"], // empty ver2
      ["a\nL", "a\nR"], // EOL-less last group
      ["x\ny\nz\n", "x\ny\nz\n"], // no diff
      ["1\n2\n3\n4\n5\n6\n7\n8\n", "1\nA\n3\nB\nC\n6\n7\nD\n"], // multiple groups
      ["only\n", "only\n"],
      ["", "added\n"], // one side empty
      ["L1\nL2\nL3\n", "R1\n"], // big delete + small add
    ];
    for (const [base, sibling] of cases) {
      const { doc, ranges } = model(base, sibling);
      const walk = computeLineLabels(doc, ranges);
      for (let n = 1; n <= doc.lines; n++) {
        expect(getDiffLineNumber(doc, ranges, n)).toEqual(walk.get(n) ?? null);
      }
    }
  });
});

describe("diff-line-numbers — gutterCell (bare-terminal ver-blocks carry the side tint)", () => {
  it("EMPTY ver-block: no number but the block's side, so a focused/expanded block is tinted (not white)", () => {
    // base "a\nb\n" vs "a\nX\nb\n" ⇒ doc "a\n\nX\n\nb\n": line2 = the EMPTY ver1 bare
    // terminal, line4 = ver2's hidden terminal.
    const { doc, ranges } = model("a\nb\n", "a\nX\nb\n");
    expect(getDiffLineNumber(doc, ranges, 2)).toBeNull(); // walk: bare terminal → no number
    expect(gutterCell(doc, ranges, 2)).toEqual({ text: "", side: "ver1" }); // …but tinted ours
    expect(gutterCell(doc, ranges, 4)).toEqual({ text: "", side: "ver2" });
  });

  it("numbered + normal lines unchanged (gutterCell === getDiffLineNumber there)", () => {
    const { doc, ranges } = model("a\nL\nc\n", "a\nR\nc\n");
    expect(gutterCell(doc, ranges, 1)).toEqual({ text: "1", side: "normal" });
    expect(gutterCell(doc, ranges, 2)).toEqual({ text: "2", side: "ver1" }); // "L"
    // doc "a\nL\n\nR\n\nc\n": line3 = ver1 terminal, line5 = ver2 terminal (line6 = "c")
    expect(gutterCell(doc, ranges, 3)).toEqual({ text: "", side: "ver1" });
    expect(gutterCell(doc, ranges, 5)).toEqual({ text: "", side: "ver2" });
    expect(gutterCell(doc, ranges, 6)).toEqual({ text: "3", side: "normal" }); // "c"
  });
});

// Field 2026-10-30 (owner): a History diff with 1648 groups scrolled at ~0.5 s a
// step — the gutter scanned EVERY block (~3300) several times for EACH visible
// line. The §2.2.10 formula stays; "which blocks are above" now comes from an
// index built once per structure (binary search + prefix sums).
describe("diff-line-numbers — the index: same cells, without scanning every block", () => {
  // The previous per-line lookup (a linear scan over all blocks), kept here as the
  // oracle: the index must give exactly its answers.
  function referenceCell(doc: Text, ranges: VerRange[], cm6: number) {
    const blocks = ranges.map((r) => {
      const firstLine = doc.lineAt(r.from).number;
      const termLine = doc.lineAt(r.to - 1).number;
      const bare = doc.line(termLine).length === 0;
      return { ver: r.ver, firstLine, termLine, bare, numbered: termLine - firstLine + 1 - (bare ? 1 : 0) };
    });
    const own = blocks.find((b) => cm6 >= b.firstLine && cm6 <= b.termLine);
    let label: { text: string; side: string } | null;
    if (own && own.bare && cm6 === own.termLine) label = null;
    else {
      const bareAbove = blocks.filter((b) => b.bare && b.termLine < cm6).length;
      if (own && own.ver === 1) {
        const prior = blocks.filter((b) => b.ver === 1 && b.termLine < own.firstLine).reduce((s, b) => s + b.numbered, 0);
        label = { text: String(cm6 - prior - bareAbove), side: "ver1" };
      } else {
        const above = blocks.filter((b) => b.ver === 1 && b.termLine < cm6).reduce((s, b) => s + b.numbered, 0);
        label = { text: String(cm6 - above - bareAbove), side: own ? "ver2" : "normal" };
      }
    }
    if (label) return label;
    const bare = blocks.find((b) => b.bare && b.termLine === cm6);
    return bare ? { text: "", side: bare.ver === 1 ? "ver1" : "ver2" } : null;
  }

  // A pseudo-random pair with every group shape: changed, added, removed, multi-line,
  // blank content lines, and an EOL-less last line.
  function randomPair(seed: number, n: number): [string, string] {
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    let base = "";
    let sib = "";
    for (let i = 0; i < n; i++) {
      base += `same ${i}\n`;
      sib += `same ${i}\n`;
      const k = Math.floor(rnd() * 6);
      if (k === 1) { base += `mine ${i}\n`; sib += `theirs ${i}\n`; }
      if (k === 2) sib += `added ${i}\nadded2 ${i}\n`;
      if (k === 3) base += `removed ${i}\n\n`;
      if (k === 4) { base += `\n`; sib += `x ${i}\n\n\n`; }
    }
    return rnd() < 0.5 ? [base + "tail", sib + "TAIL"] : [base, sib];
  }

  it("🔑 gutterCell === the previous linear lookup on every line of many random docs", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { doc, ranges } = model(...randomPair(seed, 60));
      for (let n = 1; n <= doc.lines; n++) {
        expect(gutterCell(doc, ranges, n)).toEqual(referenceCell(doc, ranges, n));
      }
    }
  });

  it("getDiffLineNumber === the full walk on a doc with thousands of groups", () => {
    const { doc, ranges } = model(...randomPair(7, 1500));
    const walk = computeLineLabels(doc, ranges);
    const ix = lineNumberIndex(doc, ranges);
    for (let n = 1; n <= doc.lines; n++) {
      const cell = gutterCellAt(ix, n);
      const want = walk.get(n);
      if (want) expect(cell).toEqual(want);
      else expect(cell === null || cell.text === "").toBe(true);
    }
  }, 30_000);

  it("🔑 one line costs a binary search: every line of a 2500-group doc in well under a second", () => {
    const { doc, ranges } = model(...randomPair(3, 3000));
    expect(new Set(ranges.map((r) => r.group)).size).toBeGreaterThan(1500);
    const ix = lineNumberIndex(doc, ranges);
    const t0 = performance.now();
    for (let n = 1; n <= doc.lines; n++) gutterCellAt(ix, n);
    // The old scan: ~doc.lines × 4 × #blocks ≈ 10^8 steps (seconds). The index: ms.
    expect(performance.now() - t0).toBeLessThan(500);
  }, 30_000);
});
