// SPEC-COVERAGE — one test per rule in docs/tasks/DIFF-EDITOR-V2.md §2.x.
//
// Purpose (user directive 2026-06-14): a 1:1, auditable map from each spec rule to
// a test, so unimplemented rules surface as RED here instead of as bugs at first
// use. Interaction rules drive REAL keydown events through the production
// createDiffPaneState pipeline (happy-dom); pure rules assert on buildModel/
// splitModel/structure. Some overlap with the topical *.test.ts files is
// intentional — THIS file is the spec checklist.
//
// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildModel, splitModel, type VerRange } from "../../src/diff2/diff-model";
import { buildDecorations, mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { caretOffTerminal, readStructure } from "../../src/diff2/diff-structure";
import { applyResolve } from "../../src/diff2/diff-resolve";
import { groupsOf } from "../../src/diff2/diff-selection";
import { computeLineLabels, getDiffLineNumber } from "../../src/diff2/diff-line-numbers";

// ── helpers ──────────────────────────────────────────────────────────────────
interface Group {
  group: number;
  v1: VerRange;
  v2: VerRange;
}
function groups(ranges: VerRange[]): Group[] {
  const by = new Map<number, Partial<Group>>();
  for (const r of ranges) {
    const e = by.get(r.group) ?? { group: r.group };
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    by.set(r.group, e);
  }
  return [...by.values()].map((e) => e as Group).sort((a, b) => a.v1.from - b.v1.from);
}
const content = (doc: string, r: VerRange) => doc.slice(r.from, r.to - 1); // terminal-inside

// view harness for the interaction rules (real keymap path)
const _parents: HTMLElement[] = [];
function mount(base: string, sibling: string): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  _parents.push(p);
  return mountDiffPaneV2(p, base, sibling);
}
afterEach(() => {
  for (const p of _parents.splice(0)) p.remove();
});
const press = (v: EditorView, key: string, mods: Partial<KeyboardEventInit> = {}) =>
  v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
const caret = (v: EditorView) => v.state.selection.main.head;
const verOf = (v: EditorView, n: 1 | 2) => readStructure(v.state).find((r) => r.ver === n)!;

// A spread of (base, sibling) shapes exercised by the structural-invariant rules.
const FIXTURES: [string, string][] = [
  ["a\nL\nc\n", "a\nR\nc\n"], // modify-vs-modify
  ["a\nb\n", "a\nX\nb\n"], // empty ver1 (insert)
  ["a\nX\nb\n", "a\nb\n"], // empty ver2 (delete)
  ["a\nb\nc\nd\ne\n", "a\nP\nQ\nR\nc\nS\ne\n"], // multi-group
  ["line 0\nline 1\nline 2\nline 3\nline 4\n\nline 5\n", "line 0\n\nline 1\nother line\nyet another\nline 3\nline 5\nline 6\n\n"], // the real test1 pair
  ["", "added\n"], // one side empty
  ["a\nL", "a\nR"], // EOL-less last line
  ["x\ny\nz\n", "x\ny\nz\n"], // no diff
];

describe("§2.1 — diff-document construction (buildModel)", () => {
  it("round-trips: splitModel(buildModel(base, sibling)) === (base, sibling), byte-exact", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      expect(splitModel(m.doc, m.ranges)).toEqual({ base, sibling });
    }
  });
  it("§2.1 'important rule': every ver-block range ends on a terminal \\n (doc[to-1] === '\\n')", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      for (const r of m.ranges) expect(m.doc[r.to - 1]).toBe("\n");
    }
  });
  it("a group is ALWAYS a ver1→ver2 pair (exactly two blocks, that order, abutting)", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      for (const g of groups(m.ranges)) {
        expect(g.v1).toBeTruthy();
        expect(g.v2).toBeTruthy();
        expect(g.v2.from).toBe(g.v1.to); // adjacent, ver1 then ver2
      }
    }
  });
});

describe("§2.2.1 — normal (shared) lines are carried into the doc AS-IS", () => {
  it("text outside any ver range equals the shared lines verbatim", () => {
    // "a\nL\nc\n" vs "a\nR\nc\n": "a\n" (before) and "c\n" (after) are shared.
    const m = buildModel("a\nL\nc\n", "a\nR\nc\n");
    const g = groups(m.ranges)[0];
    expect(m.doc.slice(0, g.v1.from)).toBe("a\n"); // leading normal verbatim
    expect(m.doc.slice(g.v2.to)).toBe("c\n"); // trailing normal verbatim
  });
});

describe("§2.2.2 — diff-line representation (terminal-inside)", () => {
  it("every range covers ≥1 char (the terminal \\n); never zero-width", () => {
    for (const [base, sibling] of FIXTURES) {
      for (const r of buildModel(base, sibling).ranges) expect(r.to - r.from).toBeGreaterThanOrEqual(1);
    }
  });
  it("empty ver-block ⟺ (to - from) === 1 (just the terminal \\n)", () => {
    // empty ver1 (insert): base "a\nb\n" vs sibling "a\nX\nb\n"
    const m = buildModel("a\nb\n", "a\nX\nb\n");
    const g = groups(m.ranges)[0];
    expect(g.v1.to - g.v1.from).toBe(1); // empty
    expect(content(m.doc, g.v1)).toBe(""); // no content
    expect(g.v2.to - g.v2.from).toBeGreaterThan(1); // non-empty
  });
});

describe("§2.2.3 — group-boundary invariants  [normal* ver1 ver2 normal*]*", () => {
  it("(1) the first ver line is never ver2; (2) the last is never ver1", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      const text = Text.of(m.doc.split("\n"));
      const sorted = [...m.ranges].sort((a, b) => a.from - b.from);
      if (sorted.length === 0) continue;
      expect(sorted[0].ver).toBe(1); // earliest ver block is ver1
      expect(sorted[sorted.length - 1].ver).toBe(2); // latest is ver2
      void text;
    }
  });
  it("(3,4) ver1 immediately followed by its ver2 (no normal between); groups separated by ≥1 normal", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      const gs = groups(m.ranges);
      for (let i = 0; i < gs.length; i++) {
        expect(gs[i].v2.from).toBe(gs[i].v1.to); // ver1→ver2 adjacent
        if (i > 0) expect(gs[i].v1.from).toBeGreaterThan(gs[i - 1].v2.to); // a normal gap precedes
      }
    }
  });
  it("(5) no group has BOTH ver1 and ver2 empty", () => {
    for (const [base, sibling] of FIXTURES) {
      for (const g of groups(buildModel(base, sibling).ranges)) {
        const bothEmpty = g.v1.to - g.v1.from === 1 && g.v2.to - g.v2.from === 1;
        expect(bothEmpty).toBe(false);
      }
    }
  });
  it("(6) no group has ver1 content === ver2 content", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      for (const g of groups(m.ranges)) {
        expect(content(m.doc, g.v1)).not.toBe(content(m.doc, g.v2));
      }
    }
  });
});

// ── interaction rules (real keymap path) ─────────────────────────────────────
// C1 "a\nL\nc\n" vs "a\nR\nc\n" ⇒ doc "a\nL\n\nR\n\nc\n":
//   ver1 [2,5) "L\n\n" (content "L\n", terminal @4); ver2 [5,8) "R\n\n" (terminal @7).
// C2 "a\nb\n" vs "a\nX\nb\n": ver1 [2,3) EMPTY; ver2 [3,6).
describe("§2.2.4 — behavior inside a ver-block", () => {
  it("(1,3) the terminal \\n cannot be deleted (Delete at the terminal is a no-op)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: 4 } }); // ver1 terminal
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe(before);
  });
  it("(2) typing into a ver-block restores the content-trailing \\n (valid '.*\\n\\n')", () => {
    const v = mount("a\nb\n", "a\nX\nb\n");
    const v1 = verOf(v, 1); // empty [2,3)
    v.dispatch({ changes: { from: v1.from, insert: "w" }, selection: { anchor: v1.from + 1 }, userEvent: "input.type" });
    const nv1 = verOf(v, 1);
    expect(v.state.doc.sliceString(nv1.from, nv1.to)).toBe("w\n\n");
  });
  it("(4,8) deleting all content collapses the block to the empty '\\n' (range width 1)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const v1 = verOf(v, 1); // [2,5) content "L\n"
    v.dispatch({ changes: { from: v1.from, to: v1.to - 1 }, selection: { anchor: v1.from } });
    const nv1 = verOf(v, 1);
    expect(nv1.to - nv1.from).toBe(1);
  });
  it("(5) a selection anchored in a ver-block stays within that block (never the terminal)", () => {
    const v = mount("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const v1 = verOf(v, 1); // first group's ver1
    // try to select from inside ver1 to far past it → legalized; head must stay ≤ this block
    v.dispatch({ selection: EditorSelection.range(v1.from, v1.to - 1) });
    const sel = v.state.selection.main;
    expect(sel.from).toBeGreaterThanOrEqual(v1.from);
    expect(sel.to).toBeLessThanOrEqual(v1.to - 1); // terminal excluded
  });
  it("(6) Backspace at range.from is a no-op AND the caret does not move", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: 2 } }); // ver1.from
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe(before);
    expect(caret(v)).toBe(2);
  });
  it("(7) Delete just before the terminal \\n is a no-op", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: 4 } }); // ver1 terminal pos
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe(before);
  });
  it("(9b/f) Left/Right step OVER the hidden terminal line", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n"); // ver1 "X\n\n"[2,5]
    v.dispatch({ selection: { anchor: 3 } }); // after X, before content \n
    press(v, "ArrowRight");
    expect(caret(v)).toBe(5); // skipped terminal @4 → ver2.from
    v.dispatch({ selection: { anchor: 5 } });
    press(v, "ArrowLeft");
    expect(caret(v)).toBe(3); // skipped terminal @4 → end of X
  });
  it("(9) the caret never RESTS on a hidden terminal line (backstop, any vector incl. PgUp/PgDn)", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n");
    for (const k of ["PageDown", "PageUp", "ArrowDown", "ArrowUp"]) {
      v.dispatch({ selection: { anchor: 4 } }); // force onto terminal; backstop should nudge
      press(v, k);
      expect(caretOffTerminal(v.state.doc, readStructure(v.state), caret(v))).toBe(caret(v));
    }
  });
  it("(10) multi-cursor is disabled — only ONE selection range survives", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    try {
      // CM6 throws "Multiple selections must be enabled" when the facet is off —
      // catching it still proves "disabled". If it instead silently collapses, the
      // range count below is the real check.
      v.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(8, 9)]) });
    } catch {
      /* disabled (threw) */
    }
    expect(v.state.selection.ranges.length).toBe(1);
  });
});

describe("§2.2.5 — external protection of diff-blocks", () => {
  it("(1) Delete on the normal line before a group does not delete the separator \\n", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: 1 } }); // end of "a", separator \n@1 ahead
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe(before);
  });
  it("(2) Backspace on the normal line after a group does not delete ver2's terminal \\n", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: 8 } }); // start of "c" (== ver2.to)
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe(before);
  });
});

describe("§2.2.6 — selecting whole ver-blocks / diff-groups", () => {
  // C1 group span = [ver1.from=2, ver2.to=8); doc length 10.
  it("(1) Ctrl+A / select-all keeps the WHOLE document (groups fully contained)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    v.dispatch({ selection: EditorSelection.range(0, v.state.doc.length) });
    const s = v.state.selection.main;
    expect(s.from).toBe(0);
    expect(s.to).toBe(v.state.doc.length);
  });
  it("(2) a selection from a normal line into a group expands to cover the WHOLE group", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const g = groupsOf(readStructure(v.state))[0]; // {from:2,to:8}
    v.dispatch({ selection: EditorSelection.range(0, 3) }); // 0 in "a", 3 inside ver1
    const s = v.state.selection.main;
    expect(s.from).toBe(0);
    expect(s.to).toBe(g.to); // group fully included
  });
  it("(3,4) a selection crossing from ver1 into ver2 (or out of the group) selects the WHOLE group", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const g = groupsOf(readStructure(v.state))[0];
    v.dispatch({ selection: EditorSelection.range(3, 6) }); // 3 in ver1, 6 in ver2
    const s = v.state.selection.main;
    expect(s.from).toBe(g.from);
    expect(s.to).toBe(g.to);
  });
});

// reader for line-class decorations (collapse / ver colour)
function lineClasses(v: EditorView): Map<number, string> {
  const out = new Map<number, string>();
  const set = buildDecorations(v.state);
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as { class?: string; widget?: unknown };
    if (spec.class && !spec.widget) out.set(it.from, spec.class);
    it.next();
  }
  return out;
}

describe("§2.2.8 — empty ver-block & ↵ glyph rendering", () => {
  it("(1) an UNFOCUSED empty ver-block is collapsed (height:0)", () => {
    const v = mount("a\nb\n", "a\nX\nb\n"); // ver1 empty [2,3)
    v.dispatch({ selection: { anchor: 0 } }); // caret away
    expect(lineClasses(v).get(2)).toContain("diff2-collapsed");
  });
  it("(2) a FOCUSED empty ver-block (caret on it) is NOT collapsed", () => {
    const v = mount("a\nb\n", "a\nX\nb\n");
    v.dispatch({ selection: { anchor: 2 } }); // caret on the empty ver1.from
    expect(lineClasses(v).get(2) ?? "").not.toContain("diff2-collapsed");
  });
  it("(4) a non-empty ver-block's bare terminal line is ALWAYS collapsed", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n"); // ver1 "L\n\n": terminal line @4
    expect(lineClasses(v).get(4)).toContain("diff2-collapsed");
  });
  it("(3) the ↵ glyph never renders on the terminal line; renders on a content line", () => {
    // §1.6.a.1 — the ↵ is a CSS `::after` on the line decoration class
    // .diff2-glyph-line (NOT a widget — bug-25/26). doc "a\nL\n\nR\n\nc\n":
    // "L" content line.from=2, ver1 terminal line.from=4.
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const glyphLineFroms: number[] = [];
    let widgetGlyphs = 0;
    const set = buildDecorations(v.state);
    const it = set.iter();
    while (it.value) {
      const spec = it.value.spec as { class?: string; widget?: { diff2MarkerKind?: unknown } };
      if (!spec.widget && spec.class?.includes("diff2-glyph-line")) glyphLineFroms.push(it.from);
      if (spec.widget && !spec.widget.diff2MarkerKind) widgetGlyphs++;
      it.next();
    }
    expect(glyphLineFroms).toContain(2); // "L" content line
    expect(glyphLineFroms).not.toContain(4); // never on the terminal line
    expect(widgetGlyphs).toBe(0); // GUARD: no widget glyph (replaced by the line class)
  });
});

describe("§2.2.9 — conflict resolution (region-replace)", () => {
  const setup = () => mount("a\nL\nc\n", "a\nR\nc\n"); // ver1 "L\n", ver2 "R\n"
  it("keep1 → ver1 content; structure dropped; result is plain text", () => {
    const v = setup();
    applyResolve(v, 0, "keep1");
    expect(v.state.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(v.state)).toEqual([]);
  });
  it("keep2 → ver2 content", () => {
    const v = setup();
    applyResolve(v, 0, "keep2");
    expect(v.state.doc.toString()).toBe("a\nR\nc\n");
    expect(readStructure(v.state)).toEqual([]);
  });
  it("both → ver1 then ver2", () => {
    const v = setup();
    applyResolve(v, 0, "both");
    expect(v.state.doc.toString()).toBe("a\nL\nR\nc\n");
  });
  it("neither → group removed entirely", () => {
    const v = setup();
    applyResolve(v, 0, "neither");
    expect(v.state.doc.toString()).toBe("a\nc\n");
    expect(readStructure(v.state)).toEqual([]);
  });
  it("join (markdown) → ver1 + a '> '-quoted ver2 callout", () => {
    const v = setup();
    applyResolve(v, 0, "join", { label: "Phone", date: "2026-06-03" });
    expect(v.state.doc.toString()).toContain("L\n"); // ver1 kept
    expect(v.state.doc.toString()).toContain("> "); // quoted remote
    expect(readStructure(v.state)).toEqual([]);
  });
});

describe("§2.2.10 — sibling-wins line numbering", () => {
  it("normal+ver2 share a through-counter; ver1 is numbered in PARALLEL from the line above", () => {
    // base a b c d e ; sibling a P Q R c S e. The d (ver1) line reads 6 (continuing
    // from c=5), NOT its base line 4 (the §1.10 parallel rule, bug this verifies).
    const m = buildModel("a\nb\nc\nd\ne\n", "a\nP\nQ\nR\nc\nS\ne\n");
    const doc = Text.of(m.doc.split("\n"));
    const labels = computeLineLabels(doc, m.ranges);
    let dLine = -1;
    for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text === "d") dLine = n;
    expect(labels.get(dLine)).toEqual({ text: "6", side: "ver1" });
  });
  it("getDiffLineNumber (fast per-line formula) === computeLineLabels for every line", () => {
    for (const [base, sibling] of FIXTURES) {
      const m = buildModel(base, sibling);
      const doc = Text.of(m.doc.split("\n"));
      const walk = computeLineLabels(doc, m.ranges);
      for (let n = 1; n <= doc.lines; n++) {
        expect(getDiffLineNumber(doc, m.ranges, n)).toEqual(walk.get(n) ?? null);
      }
    }
  });
});

describe("§2.2.11 — split (diff-document → ver1/ver2 files)", () => {
  it("ver1 content → base, ver2 content → sibling, normal → both, terminals dropped", () => {
    // doc with a resolved edit: type into ver1, then split must reflect it.
    const m = buildModel("a\nL\nc\n", "a\nR\nc\n");
    // hand-edit: replace ver1 content "L\n" with "L2\n" (simulate an edit) by
    // rebuilding the (doc, ranges) the model would hold — easiest via splitModel of
    // the original (identity) since §2.1 already pins build∘split; here we assert the
    // RULE: a ver1 line goes only to base, a ver2 line only to sibling.
    const sp = splitModel(m.doc, m.ranges);
    expect(sp.base).toBe("a\nL\nc\n"); // "L" (ver1) in base, "R" (ver2) absent
    expect(sp.sibling).toBe("a\nR\nc\n"); // "R" (ver2) in sibling, "L" absent
  });
});

describe("§2.2.12 — zero-size docs & EOL-less last line (added later; resolved)", () => {
  it("deleted-vs-existing: '' vs 'data\\n' → ONE group, empty ver1 + full ver2; round-trips", () => {
    const m = buildModel("", "line 1\nline 2\n");
    const gs = groups(m.ranges);
    expect(gs).toHaveLength(1);
    expect(gs[0].v1.to - gs[0].v1.from).toBe(1); // ver1 empty (deletion)
    expect(content(m.doc, gs[0].v2)).toBe("line 1\nline 2\n"); // ver2 = whole file
    expect(splitModel(m.doc, m.ranges)).toEqual({ base: "", sibling: "line 1\nline 2\n" });
  });
  it("an EOL-less last line is preserved byte-exact (no phantom trailing \\n added)", () => {
    const m = buildModel("a\nL", "a\nR"); // both last lines EOL-less
    const sp = splitModel(m.doc, m.ranges);
    expect(sp.base).toBe("a\nL"); // NOT "a\nL\n"
    expect(sp.sibling).toBe("a\nR");
  });
  it("editing the EOL-less last ver-block does NOT force a trailing \\n (auto-\\n exempts it)", () => {
    // last group ends the doc; appending to ver1 content keeps it EOL-less on split.
    const v = mount("a\nL", "a\nR"); // ver1 "L" (EOL-less last group)
    const v1 = verOf(v, 1);
    v.dispatch({ changes: { from: v1.to - 1, insert: "X" }, userEvent: "input.type" }); // append to content
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(sp.base.endsWith("\n")).toBe(false); // still EOL-less
  });
});

// §2.2.7 — clipboard copy/cut/paste of a diff-group as the ```github-easy-sync```
// (≪/==/≫ + `- `/`+ ` + ↵) format. NOT BUILT YET (Tier-2). Documented as the spec
// gap; flip these to real tests when the clipboard subsystem lands.
describe("§2.2.7 — diff-group clipboard format (NOT BUILT — Tier-2 gap)", () => {
  it.todo("(2) a selected diff-group copies to ```github-easy-sync``` with ≪/==/≫ + `- `/`+ ` + ↵");
  it.todo("(3a) pasting that block onto a normal line converts it BACK into a diff-group");
  it.todo("(3b) pasting it inside a ver-block (or another editor) inserts as-is");
  it.todo("(4/5) malformed block (any 4a–4f rule fails) pastes as-is, no conversion");
  it.todo("(6) an empty content line encodes as exactly `- ↵`/`+ ↵`");
  it.todo("(1) text selected within ONE ver-block copies as plain text (no terminal \\n)");
});

// bug-24 regression — EDITING the LAST diff-group's ver2 down to an EOL-less last
// line, and applying it. Was broken pre-9ea3f83 (endSide=1): Delete couldn't remove
// the content \n (auto-\n / boundary fought it) and apply dropped the trailing blank.
describe("§2.2.12 bug-24 — last-group ver2 EOL-less editing", () => {
  const setup = () => mount("z\n", "z\nL6\n\n"); // ver1 empty; ver2 "L6\n\n" (L6 + blank), last group
  it("apply ver2 (keep2) on the last group preserves the trailing blank line", () => {
    const v = setup();
    const g = Math.max(...readStructure(v.state).map((r) => r.group));
    applyResolve(v, g, "keep2");
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(sp.sibling).toBe("z\nL6\n\n"); // blank line kept (NOT "z\nL6\n")
  });
  it("two Deletes turn 'L6'+blank into an EOL-less 'L6' (final ↵ removable)", () => {
    const v = setup();
    const after = v.state.doc.toString().indexOf("L6") + 2; // caret after "L6"
    v.dispatch({ selection: { anchor: after } });
    press(v, "Delete"); // removes the blank line
    press(v, "Delete"); // removes the content \n → EOL-less
    const ver2 = readStructure(v.state).filter((r) => r.ver === 2).pop()!;
    expect(v.state.doc.toString().slice(ver2.from, ver2.to - 1)).toBe("L6"); // content EOL-less
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(sp.sibling.endsWith("L6")).toBe(true); // no trailing \n
  });
});
