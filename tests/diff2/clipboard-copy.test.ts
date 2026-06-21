// @vitest-environment happy-dom
//
// §2.2.7 COPY — diff-group → fenced clipboard text. Oracle = the spec's byte-exact
// Examples 6/7 (user-finalized), NOT a serialize→parse round-trip (which could
// pass with compensating bugs). The DOM copy-event wiring (clipboardData reaching
// the handler) is a device-gate, not asserted here — happy-dom can't deliver a
// real copy ClipboardEvent into CM6 (same limit as marker-button clicks).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { readStructure, structureField, toRangeSet } from "../../src/diff2/diff-structure";
import {
  contentLines,
  copyClipboardText,
  serializeGroup,
  parseClipboard,
  clipboardHasGroup,
} from "../../src/diff2/diff-clipboard";
import { selectionDeleteSpec } from "../../src/diff2/diff-auto-resolve";

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

  it("empty VER1 (delete-vs-modify / absent-base) → ≪ then == directly", () => {
    expect(serializeGroup("", "x\n")).toBe("```github-easy-sync\n≪\n==\n+ x↵\n≫\n```\n");
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

  it("MULTI-group select-all → leading + between + trailing normal verbatim, each group fenced", () => {
    // 2 groups (L/R, M/N) with normals pre, mid, post — exercises the
    // normal-gap-BEFORE-a-non-first-group branch (the multi-region path).
    const base = "pre\nL\nmid\nM\npost\n";
    const sib = "pre\nR\nmid\nN\npost\n";
    const m = buildModel(base, sib);
    const s = state(base, sib, { anchor: 0, head: m.doc.length });
    expect(copyClipboardText(s)).toBe(
      "pre\n" +
        "```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\n" +
        "mid\n" +
        "```github-easy-sync\n≪\n- M↵\n==\n+ N↵\n≫\n```\n" +
        "post\n",
    );
  });

  it("empty selection → null", () => {
    const s = state("a\nL\nc\n", "a\nR\nc\n", { anchor: 3, head: 3 });
    expect(copyClipboardText(s)).toBeNull();
  });

  // §2.2.7 п.1 + §2.2.6 п.7e.ii.a/e, п.7iii.a/d — a single-ver selection (now
  // reachable via the strict legalizer: head lands at the boundary, NOT expanded to
  // whole group) copies as PLAIN ver-content WITHOUT the terminal \n — NOT a fence.
  it("7e.ii.a: WHOLE ver1 incl terminal [v1.from, v2.from] → plain ver1 content, NO terminal", () => {
    const m = buildModel("a\nL1\nL2\nc\n", "a\nR1\nc\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL1\nL2\nc\n", "a\nR1\nc\n", { anchor: v1.from, head: v2.from }); // = [v1.from, v1.to]
    expect(copyClipboardText(s)).toBe("L1\nL2\n"); // verContent: protected terminal dropped, line \n kept
  });

  it("7e.ii.e: INSIDE ver1, head at v2.from → only the selected ver1 chars, no terminal", () => {
    const m = buildModel("a\nWORD\nc\n", "a\nR\nc\n");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nWORD\nc\n", "a\nR\nc\n", { anchor: v1.from + 2, head: v2.from }); // "RD"+terminal
    expect(copyClipboardText(s)).toBe("RD\n"); // selected chars + line \n; only protected terminal dropped
  });

  it("7e.iii.a: WHOLE ver2 [v2.from, v2.to] → plain ver2 content, NO terminal, NO fence", () => {
    const m = buildModel("a\nL1\nc\n", "a\nR1\nR2\nc\n");
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL1\nc\n", "a\nR1\nR2\nc\n", { anchor: v2.from, head: v2.to });
    expect(copyClipboardText(s)).toBe("R1\nR2\n");
  });

  // §2.2.12(a) LAST diff-group in the doc — EOL-less final line: the ver-block's
  // ONLY trailing \n is the protected terminal (it doubles as L2's line-end), so
  // verContent drops it → NO trailing newline. (Interior groups keep L2's own \n.)
  // This is the difference the user flagged: same selection, different bytes by
  // position. verContent handles both via slice-to-(to-1) — no special-casing.
  it("7e.ii.a LAST group (EOL-less): WHOLE ver1 → 'L1\\nL2' (no trailing \\n)", () => {
    const m = buildModel("a\nL1\nL2", "a\nR1\nR2"); // group is the LAST thing, EOL-less
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL1\nL2", "a\nR1\nR2", { anchor: v1.from, head: v2.from });
    expect(copyClipboardText(s)).toBe("L1\nL2"); // EOL-less → no trailing newline
  });

  it("7e.iii.a LAST group (EOL-less): WHOLE ver2 → 'R1\\nR2' (no trailing \\n)", () => {
    const m = buildModel("a\nL1\nL2", "a\nR1\nR2");
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL1\nL2", "a\nR1\nR2", { anchor: v2.from, head: v2.to });
    expect(copyClipboardText(s)).toBe("R1\nR2");
  });

  it("LAST group single-line EOL-less: WHOLE ver1 → 'L' (no newline at all)", () => {
    const m = buildModel("a\nL", "a\nR"); // single EOL-less line each side
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL", "a\nR", { anchor: v1.from, head: v2.from });
    expect(copyClipboardText(s)).toBe("L");
  });
});

// ── §2.2.7 п.4–6 — PARSE (clipboard → segments), step 6a ─────────────────────
describe("parseClipboard — fenced block → group; malformed → as-is (rule 5)", () => {
  const G6 =
    "```github-easy-sync\n≪\n- ver1-visible-line-1↵\n-   ver1-visible-line-2↵\n" +
    "- ver1-visible-line-3  ↵\n==\n≫\n```\n";
  const G7 =
    "```github-easy-sync\n≪\n- ver1-visible-line-1↵\n-   ver1-visible-line-2↵\n" +
    "- ver1-visible-line-3  ↵\n==\n+ ver2-visible-line-1↵\n+ ↵\n+ ver2-visible-line-2↵\n≫\n```\n";

  it("Example 6 → one group, empty ver2 (prefixes + ↵ stripped, whitespace kept)", () => {
    expect(parseClipboard(G6)).toEqual([
      {
        kind: "group",
        ver1: ["ver1-visible-line-1", "  ver1-visible-line-2", "ver1-visible-line-3  "],
        ver2: [],
      },
    ]);
  });

  it("Example 7 → one group, both sides (blank middle ver2 line preserved)", () => {
    expect(parseClipboard(G7)).toEqual([
      {
        kind: "group",
        ver1: ["ver1-visible-line-1", "  ver1-visible-line-2", "ver1-visible-line-3  "],
        ver2: ["ver2-visible-line-1", "", "ver2-visible-line-2"],
      },
    ]);
  });

  it("round-trips serializeGroup → parseClipboard for a both-sides group", () => {
    const s = serializeGroup("L1\nL2\n", "R1\n");
    expect(parseClipboard(s)).toEqual([{ kind: "group", ver1: ["L1", "L2"], ver2: ["R1"] }]);
  });

  it("each rule-4 failure → the whole text stays NORMAL (as-is, rule 5)", () => {
    const asIs = (t: string) => expect(parseClipboard(t)).toEqual([{ kind: "normal", text: t }]);
    asIs("```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n"); // 4f: no close fence
    asIs("```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n```\n"); // 4e: no ≫
    asIs("```github-easy-sync\n≪\n- L↵\n+ R↵\n≫\n```\n"); // 4d: no ==
    asIs("```github-easy-sync\n≪\nL↵\n==\n≫\n```\n"); // 4c: ver1 line missing "- "
    asIs("```github-easy-sync\nX\n- L↵\n==\n≫\n```\n"); // 4b: not ≪
    asIs("```other\n≪\n- L↵\n==\n≫\n```\n"); // 4a: wrong fence tag
  });

  it("scan: normal + valid block + normal → 3 segments in order", () => {
    const t = "before\n```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\nafter\n";
    expect(parseClipboard(t)).toEqual([
      { kind: "normal", text: "before\n" },
      { kind: "group", ver1: ["L"], ver2: ["R"] },
      { kind: "normal", text: "after\n" },
    ]);
  });

  it("scan: valid block + INVALID block → group then literal normal (mixed all-or-nothing)", () => {
    const valid = "```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\n";
    const invalid = "```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n"; // no close fence
    const segs = parseClipboard(valid + invalid);
    expect(segs[0]).toEqual({ kind: "group", ver1: ["L"], ver2: ["R"] });
    expect(segs[1].kind).toBe("normal");
    expect((segs[1] as { text: string }).text).toBe(invalid);
  });

  it("plain text with no fence → one normal segment", () => {
    expect(parseClipboard("just\nsome\ntext\n")).toEqual([{ kind: "normal", text: "just\nsome\ntext\n" }]);
  });

  it("clipboardHasGroup discriminates", () => {
    expect(clipboardHasGroup(G6)).toBe(true);
    expect(clipboardHasGroup("plain text")).toBe(false);
  });
});

// ── §2.2.7 CUT = serialize (copy) + selection-delete, step 7 ─────────────────
describe("CUT — group-spanning selection: copy text + delete via selectionDeleteSpec", () => {
  it("cutting a whole group serializes it AND removes it (both sides → 'neither')", () => {
    const base = "a\nL\nc\n";
    const sib = "a\nR\nc\n";
    const m = buildModel(base, sib);
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state(base, sib, { anchor: v1.from, head: v2.to });
    // COPY half: serialized fenced block.
    expect(copyClipboardText(s)).toBe("```github-easy-sync\n≪\n- L↵\n==\n+ R↵\n≫\n```\n");
    // DELETE half: the group-spanning selection rebuilds to group-gone.
    const spec = selectionDeleteSpec(s)!;
    expect(spec).not.toBeNull();
    const after = s.update(spec).state;
    expect(splitModel(after.doc.toString(), readStructure(after))).toEqual({
      base: "a\nc\n",
      sibling: "a\nc\n",
    });
  });

  it("LAST group (EOL-less) cut WHOLE ver1 → copies 'L1\\nL2', empties ver1", () => {
    const m = buildModel("a\nL1\nL2", "a\nR1\nR2");
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state("a\nL1\nL2", "a\nR1\nR2", { anchor: v1.from, head: v2.from });
    expect(copyClipboardText(s)).toBe("L1\nL2"); // EOL-less → no trailing \n
    const spec = selectionDeleteSpec(s)!;
    expect(spec).not.toBeNull();
    const after = s.update(spec).state;
    expect(splitModel(after.doc.toString(), readStructure(after))).toEqual({
      base: "a\n", // ver1 emptied
      sibling: "a\nR1\nR2", // ver2 (still EOL-less) untouched
    });
  });

  it("within-block selection → both halves null (cut falls through to plain default)", () => {
    const s = state("a\nWORD\nc\n", "a\nR\nc\n", { anchor: 2, head: 6 }); // inside ver1
    expect(copyClipboardText(s)).toBeNull(); // → default plain cut
    expect(selectionDeleteSpec(s)).toBeNull();
  });

  // §2.2.7 п.1 single-ver CUT: copy plain ver-content + delete ver-CONTENT-only
  // (terminal \n preserved → ver becomes empty), NOT the whole group. Consistent.
  it("cutting WHOLE ver1 [v1.from, v2.from] → copies 'L1\\nL2', deletes ver1 content only (empty ver1)", () => {
    const base = "a\nL1\nL2\nc\n";
    const sib = "a\nR1\nc\n";
    const m = buildModel(base, sib);
    const v1 = m.ranges.find((r) => r.ver === 1)!;
    const v2 = m.ranges.find((r) => r.ver === 2)!;
    const s = state(base, sib, { anchor: v1.from, head: v2.from });
    expect(copyClipboardText(s)).toBe("L1\nL2\n"); // verContent (protected terminal dropped) — == deleted bytes
    const spec = selectionDeleteSpec(s)!;
    expect(spec).not.toBeNull();
    const after = s.update(spec).state;
    // ver1 emptied, ver2 + normals intact → still a (delete-vs-modify) conflict.
    expect(splitModel(after.doc.toString(), readStructure(after))).toEqual({
      base: "a\nc\n", // ver1 content gone
      sibling: "a\nR1\nc\n", // ver2 untouched
    });
  });

  it("cut serialize + delete are CONSISTENT: whenever copy yields text, delete yields a spec", () => {
    const m = buildModel("p\nL\nq\nM\nr\n", "p\nR\nq\nN\nr\n"); // 2 groups
    const s = state("p\nL\nq\nM\nr\n", "p\nR\nq\nN\nr\n", { anchor: 0, head: m.doc.length });
    expect(copyClipboardText(s)).not.toBeNull();
    expect(selectionDeleteSpec(s)).not.toBeNull(); // both fire on the same group-spanning selection
  });

  it("INVARIANT over EVERY selection: copy-text ⟺ delete-spec (single shared predicate)", () => {
    // The whole CUT correctness rests on copy and delete agreeing on "group-spanning"
    // for ANY selection — they now share selectionSpansTerminal, so this can't drift.
    const base = "p\nL\nq\nMM\nr\n";
    const sib = "p\nR\nq\nNN\nr\n";
    const m = buildModel(base, sib);
    const n = m.doc.length;
    for (let from = 0; from <= n; from++) {
      for (let to = from; to <= n; to++) {
        const s = state(base, sib, { anchor: from, head: to });
        const hasText = copyClipboardText(s) !== null;
        const hasSpec = selectionDeleteSpec(s) !== null;
        expect(hasText, `copy⟺delete must agree at [${from},${to}]`).toBe(hasSpec);
      }
    }
  });
});
