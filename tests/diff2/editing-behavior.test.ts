// @vitest-environment happy-dom
//
// EMPIRICAL editing-behavior probe (§2.2.4 boundary rules + §2.2.5 external guard
// + empty↔non-empty transitions). Drives the REAL keymap commands
// (deleteCharBackward = Backspace, deleteCharForward = Delete, typed inserts)
// through the REAL createDiffPaneState pipeline in happy-dom and asserts the
// resulting doc + structure — so the filters are tested as the user experiences
// them, not just their pure helpers. Observed behavior, not derivation.

import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { caretOffTerminal, readStructure } from "../../src/diff2/diff-structure";
import { verLineDecisions } from "../../src/diff2/diff-decorations";
import { splitModel } from "../../src/diff2/diff-model";

const parents: HTMLElement[] = [];
function mount(base: string, sibling: string): EditorView {
  const p = document.createElement("div");
  document.body.appendChild(p);
  parents.push(p);
  return mountDiffPaneV2(p, base, sibling);
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

const at = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });
const type = (v: EditorView, pos: number, s: string) =>
  v.dispatch({ changes: { from: pos, insert: s }, selection: { anchor: pos + s.length }, userEvent: "input.type" });
// Dispatch a REAL keydown so the keymap (incl. the §2.2.4(6,7) diffBackspace/Delete
// guards) runs — calling deleteCharBackward directly would bypass the keymap.
const press = (v: EditorView, key: string) =>
  v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
// REAL Ctrl(+Shift) keydown — exercises the §1.9 resolution keymap (diffResolveKeymap),
// which routes through the private caretVer/currentGroupAt (caret → ver-block side).
const pressCtrl = (v: EditorView, key: string, shift = false) =>
  v.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }),
  );

// conflict A: base "a\nL\nc\n" vs sibling "a\nR\nc\n"
//   doc "a\nL\n\nR\n\nc\n": a0 \n1 L2 \n3 \n4 R5 \n6 \n7 c8 \n9
//   ver1 [2,5) "L\n\n" (content "L\n", terminal idx4); ver2 [5,8) "R\n\n" (terminal idx7)
describe("§2.2.4/§2.2.5 boundary protection (real keymap commands)", () => {
  it("Backspace at the group's leading boundary does NOT delete the separator \\n NOR move the caret (§2.2.4.6)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 2); // ver1.from — caret at start of "L"
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe(before); // separator \n at idx1 survives
    expect(readStructure(v.state).length).toBe(2); // group intact
    // bug-17: the change is blocked but the caret must NOT slide onto the hidden line.
    expect(v.state.selection.main.head).toBe(2);
  });

  it("Delete on the normal line before the group does NOT delete the separator \\n (§2.2.5.1)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 1); // end of "a", before the separator \n
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe(before);
  });

  it("Backspace at ver2.from does NOT delete ver1's terminal \\n (§2.2.4.6)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 5); // ver2.from == ver1.to
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe(before);
    expect(readStructure(v.state).length).toBe(2);
    expect(v.state.selection.main.head).toBe(5); // caret unmoved
  });

  it("Delete at a ver-block terminal \\n is blocked (§2.2.4.7)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 4); // ver1 terminal idx
    press(v, "Delete");
    expect(v.state.doc.toString()).toBe(before);
  });

  it("Backspace on the normal line after the group does NOT delete ver2's terminal \\n (§2.2.5.2)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const before = v.state.doc.toString();
    at(v, 8); // start of "c" (== ver2.to)
    press(v, "Backspace");
    expect(v.state.doc.toString()).toBe(before);
  });

  // conflict C: "a\nX\nc\n" vs "a\nY\nc\n" ⇒ doc "a\nX\n\nY\n\nc\n":
  //   ver1 "X\n\n" [2,5) (X@2, content-\n@3, terminal-\n@4); ver2 "Y\n\n" [5,8).
  //   pos 4 = the HIDDEN terminal line of ver1.
  it("bug-21: [Right] from end-of-content steps OVER the hidden terminal to the next block (§2.2.4.9b)", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n");
    at(v, 3); // after "X", before the content \n (where the ↵ glyph renders)
    press(v, "ArrowRight");
    expect(v.state.selection.main.head).toBe(5); // skipped pos 4 (terminal) → ver2.from
  });

  it("bug-21 mirror: [Left] from the next block steps back to end-of-content, not the terminal", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n");
    at(v, 5); // ver2.from
    press(v, "ArrowLeft");
    expect(v.state.selection.main.head).toBe(3); // skipped pos 4 (terminal) → end of "X"
  });

  it("bug-20: a caret forced onto the hidden terminal line is nudged off (§2.2.4.9 invariant)", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n");
    v.dispatch({ selection: { anchor: 4 } }); // 4 = hidden terminal line of ver1
    expect(v.state.selection.main.head).toBe(3); // backstop nudged it to end of "X"
  });

  it("bug-20: Enter at end of ver content leaves the caret on a VISIBLE line", () => {
    const v = mount("a\nX\nc\n", "a\nY\nc\n");
    at(v, 3);
    press(v, "Enter");
    const head = v.state.selection.main.head;
    expect(caretOffTerminal(v.state.doc, readStructure(v.state), head)).toBe(head); // not on a terminal
  });
});

// conflict B: base "a\nb\n" vs sibling "a\nX\nb\n"
//   doc "a\n\nX\n\nb\n": ver1 [2,3) "\n" EMPTY; ver2 [3,6) "X\n\n"
describe("§2.2.4 empty ↔ non-empty ver-block transitions", () => {
  it("typing into an empty ver-block grows it to a valid '.*\\n\\n' (§2.2.4.1,2)", () => {
    const v = mount("a\nb\n", "a\nX\nb\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v1.to - v1.from).toBe(1); // empty
    at(v, v1.from);
    type(v, v1.from, "w");
    const nv1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(v.state.doc.sliceString(nv1.from, nv1.to)).toBe("w\n\n"); // content "w\n" + terminal
  });

  it("deleting ALL content (selection) collapses the block to the empty '\\n', NOT '\\n\\n' (§2.2.4.4/8)", () => {
    const v = mount("a\nL\nc\n", "a\nR\nc\n");
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!; // [2,5) content "L\n"
    v.dispatch({ changes: { from: v1.from, to: v1.to - 1 }, selection: { anchor: v1.from } });
    const nv1 = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(nv1.to - nv1.from).toBe(1); // collapsed to empty "\n"
    expect(v.state.doc.sliceString(nv1.from, nv1.to)).toBe("\n");
  });

  it("bug-18: typing at the empty-ver1 / ver2 boundary grows VER2, not ver1 (no overlap)", () => {
    const v = mount("a\nb\n", "a\nX\nb\n"); // ver1 [2,3) empty, ver2 [3,6)
    const v2from = readStructure(v.state).find((r) => r.ver === 2)!.from; // == ver1.to (boundary)
    v.dispatch({ changes: { from: v2from, insert: "Z" }, selection: { anchor: v2from + 1 }, userEvent: "input.type" });
    const ranges = readStructure(v.state);
    const nv1 = ranges.find((r) => r.ver === 1)!;
    const nv2 = ranges.find((r) => r.ver === 2)!;
    expect(nv1.to - nv1.from).toBe(1); // ver1 still EMPTY (did not absorb "Z")
    expect(nv1.to).toBeLessThanOrEqual(nv2.from); // no overlap
    expect(v.state.doc.sliceString(nv2.from, nv2.to)).toContain("Z"); // "Z" is in ver2
  });

  it("bug-19: delete blank ver2 → empty, then Enter grows VER2 (not ver1) — no ↵↵", () => {
    // ver1 non-empty "L", ver2 a blank line. Delete the blank → ver2 empty (ver1
    // stays non-empty, so this is a valid one-side-empty state — NOT an auto-resolve
    // vanish, which needs BOTH sides equal). Enter must grow ver2, not ver1.
    const v = mount("a\nL\nb\n", "a\n\nb\n"); // ver1 "L\n", ver2 blank "\n\n"
    const v2start = readStructure(v.state).find((x) => x.ver === 2)!.from;
    v.dispatch({ selection: { anchor: v2start } }); // start of the blank line
    press(v, "Delete"); // ver2 → empty
    let r = readStructure(v.state);
    expect(r.find((x) => x.ver === 2)!.to - r.find((x) => x.ver === 2)!.from).toBe(1); // ver2 empty
    expect(r.find((x) => x.ver === 1)!.to - r.find((x) => x.ver === 1)!.from).toBe(3); // ver1 "L\n" intact (no vanish)
    const caret = v.state.selection.main.head;
    v.dispatch({ changes: { from: caret, insert: "\n" }, selection: { anchor: caret + 1 }, userEvent: "input" });
    r = readStructure(v.state);
    const v1 = r.find((x) => x.ver === 1)!;
    const v2 = r.find((x) => x.ver === 2)!;
    expect(v1.to - v1.from).toBe(3); // ver1 unchanged — did NOT absorb the Enter
    expect(v2.to - v2.from).toBe(2); // ver2 grew to a blank line
    expect(v1.to).toBeLessThanOrEqual(v2.from); // no overlap
  });

  it("Backspacing the content down to empty lands on '\\n' (not stuck at '\\n\\n')", () => {
    const v = mount("a\nX\nb\n", "a\nY\nb\n"); // ver1 "X\n", ver2 "Y\n" (non-empty, so ver1→empty doesn't vanish)
    const v1 = readStructure(v.state).find((r) => r.ver === 1)!; // content "X\n"
    // caret after "X" (content char), backspace twice to clear content
    at(v, v1.from + 1);
    press(v, "Backspace"); // delete "X"
    let cur = readStructure(v.state).find((r) => r.ver === 1)!;
    // keep backspacing the remaining content \n until only the terminal remains
    at(v, cur.from);
    press(v, "Delete"); // delete the content \n (forward, not the terminal)
    cur = readStructure(v.state).find((r) => r.ver === 1)!;
    expect(cur.to - cur.from).toBe(1); // empty "\n"
    expect(v.state.doc.sliceString(cur.from, cur.to)).toBe("\n");
  });
});

// §2.2.12 — the LAST diff-group (the one ENDING the document) may have an EOL-less
// last line on EITHER side. The user's simple glyph rule: a ver-block stored as
// "X\n\n" (content "X\n") shows `↵` on "X"; stored as "X\n" (content "X", EOL-less)
// shows NO `↵`. Pressing [Delete] at the end of that last content line removes its
// trailing `\n` (the autoNewlineInserts exemption keeps it removed), the glyph
// disappears, and on resolve the file's last line has no trailing `\n`.
describe("§2.2.12 last-group EOL-less editing (Delete removes the trailing \\n)", () => {
  // The single content line of the last group's ver-block, by side.
  const lastLine = (v: EditorView, ver: 1 | 2) => {
    const ranges = readStructure(v.state);
    const lg = Math.max(...ranges.map((r) => r.group));
    const r = ranges.find((x) => x.group === lg && x.ver === ver)!;
    return { r, line: v.state.doc.lineAt(r.from) };
  };
  const glyphOf = (v: EditorView, ver: 1 | 2, lineNo: number) =>
    verLineDecisions(v.state.doc, readStructure(v.state), v.state.selection.main.head)
      .find((d) => d.ver === ver && d.line === lineNo)!.glyph;

  it("ver2 of the last group: stored 'test\\n\\n' shows ↵; after [Delete] → 'test\\n' (no ↵) → sibling EOL-less", () => {
    const v = mount("x\n", "x\ntest\n"); // last group ver2 content "test\n" ⇒ stored "test\n\n"
    const { r, line } = lastLine(v, 2);
    expect(glyphOf(v, 2, line.number)).toBe(true); // "X\n\n" → ↵
    expect(splitModel(v.state.doc.toString(), readStructure(v.state)).sibling).toBe("x\ntest\n");
    at(v, line.to); // caret at end of "test", before its content \n
    press(v, "Delete");
    const after = lastLine(v, 2);
    expect(v.state.doc.sliceString(after.r.from, after.r.to)).toBe("test\n"); // content "test" (EOL-less) + terminal
    expect(glyphOf(v, 2, after.line.number)).toBe(false); // "X\n" → no ↵
    expect(splitModel(v.state.doc.toString(), readStructure(v.state)).sibling).toBe("x\ntest"); // EOL-less
  });

  it("ver1 of the last group: [Delete] on its last line → EOL-less base, glyph gone (ver2 untouched)", () => {
    const v = mount("x\nline1\n", "x\nline2\n"); // last group ver1 "line1\n", ver2 "line2\n"
    const { line } = lastLine(v, 1);
    expect(glyphOf(v, 1, line.number)).toBe(true);
    at(v, line.to); // end of "line1"
    press(v, "Delete");
    const after = lastLine(v, 1);
    expect(v.state.doc.sliceString(after.r.from, after.r.to)).toBe("line1\n"); // content "line1" (EOL-less) + terminal
    expect(glyphOf(v, 1, after.line.number)).toBe(false); // EOL-less → no ↵
    const sp = splitModel(v.state.doc.toString(), readStructure(v.state));
    expect(sp.base).toBe("x\nline1"); // ours tail EOL-less
    expect(sp.sibling).toBe("x\nline2\n"); // theirs untouched (still \n-terminated)
  });

  it("[Delete] AGAIN (now at the terminal) is blocked — the ver-block keeps its bare terminal", () => {
    const v = mount("x\n", "x\ntest\n");
    const { line } = lastLine(v, 2);
    at(v, line.to);
    press(v, "Delete"); // → "test\n" EOL-less
    const before = v.state.doc.toString();
    press(v, "Delete"); // caret now before the terminal \n → §2.2.4.7 blocks it
    expect(v.state.doc.toString()).toBe(before); // unchanged
  });

  it("[Backspace] at the START of a blank single-line block '|\\n\\n' acts like Delete → empty '|\\n'", () => {
    // ver1 "y\n" (non-empty, so ver2→empty doesn't vanish); ver2 = a blank line "\n\n".
    const v = mount("x\ny\n", "x\n\n");
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v.state.doc.sliceString(v2.from, v2.to)).toBe("\n\n"); // blank content line + terminal
    at(v, v2.from); // "|\n\n"
    press(v, "Backspace");
    const after = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(after.to - after.from).toBe(1); // → "\n" (empty ver-block)
    expect(v.state.doc.sliceString(after.from, after.to)).toBe("\n");
    expect(v.state.selection.main.head).toBe(after.from); // caret stays on the (now empty) block
  });

  it("[Backspace] blank-line→empty also works for a NON-last group (mirrors Delete)", () => {
    const v = mount("a\nc\nb\n", "a\n\nb\n"); // ver1 "c\n" (non-empty); ver2 = blank line "\n\n", "b" follows
    const v2 = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(v.state.doc.sliceString(v2.from, v2.to)).toBe("\n\n");
    at(v, v2.from);
    press(v, "Backspace");
    const after = readStructure(v.state).find((r) => r.ver === 2)!;
    expect(after.to - after.from).toBe(1); // empty
  });
});

// §1.9 — resolution hotkeys must target the ver-block the caret is ACTUALLY in.
// Both bugs were the inclusive `head <= r.to` boundary check (ranges are half-open
// [from,to)); the fix is `head < r.to`. Driven through the REAL keymap so the
// private caretVer/currentGroupAt are exercised as the user hits them.
describe("§1.9 resolution hotkeys — caret→ver-block boundary (half-open)", () => {
  it("Ctrl+Enter on the NORMAL line right after a group does NOT resolve it (head === ver2.to)", () => {
    const v = mount("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const g0v2 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 2)!;
    at(v, g0v2.to); // start of the normal line directly after group 0
    pressCtrl(v, "Enter"); // §1.9 "apply this block" — but the caret is NOT in a block
    // THE BUG: this used to RESOLVE group 0 (head === ver2.to matched ver2). The fix
    // leaves every group intact. (resolveApplyCurrent returns false → the key falls
    // through to defaultKeymap, which may insert a plain newline — benign, undoable;
    // no conflict is destroyed, which is what mattered.)
    const ranges = readStructure(v.state);
    expect(ranges).toHaveLength(4); // both groups intact (2 ranges each)
    expect(ranges.filter((r) => r.group === 0)).toHaveLength(2); // group 0 NOT resolved
  });

  it("Ctrl+Backspace at ver2.from removes VER2 (keep1), not ver1 (shared boundary ver2.from === ver1.to)", () => {
    const v = mount("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const g1v1 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 1)!;
    const g1v2 = readStructure(v.state).find((r) => r.group === 1 && r.ver === 2)!;
    expect(g1v2.from).toBe(g1v1.to); // the ambiguous shared boundary
    at(v, g1v2.from); // caret exactly there — old code matched ver1 first
    pressCtrl(v, "Backspace"); // §1.9 "remove this block" → caret in ver2 ⇒ keep1
    expect(readStructure(v.state).find((r) => r.group === 1)).toBeUndefined(); // group 1 resolved
    expect(v.state.doc.toString()).toContain("L2"); // ver1 kept
    expect(v.state.doc.toString()).not.toContain("R2"); // ver2 removed
  });

  it("Ctrl+Enter INSIDE a ver-block still resolves it (caret < to, not a regression)", () => {
    const v = mount("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const g0v1 = readStructure(v.state).find((r) => r.group === 0 && r.ver === 1)!;
    at(v, g0v1.from); // inside ver1 of group 0
    pressCtrl(v, "Enter"); // apply this block → keep1
    expect(readStructure(v.state).find((r) => r.group === 0)).toBeUndefined();
    expect(v.state.doc.toString()).toContain("L1"); // ver1 kept
  });

  it("Ctrl+Backspace on a NORMAL line is a no-op (consumed; no deleteGroupBackward jump)", () => {
    const v = mount("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const bPos = v.state.doc.toString().indexOf("b") + 1; // end of the normal "b" line (between groups)
    at(v, bPos);
    const beforeDoc = v.state.doc.toString();
    pressCtrl(v, "Backspace"); // off-block → CONSUMED, not deleteGroupBackward
    expect(v.state.doc.toString()).toBe(beforeDoc); // "b" NOT word-deleted
    expect(v.state.selection.main.head).toBe(bPos); // caret did NOT jump
  });
});
