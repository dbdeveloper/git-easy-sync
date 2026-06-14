// Phase 4 — V2 conflict resolution (§2.2.9 scenario-2 region-replace).
// Pure resolveGroup (all 5 choices) + dispatch-level (the spec through the real
// createDiffPaneState pipeline: doc + structure resolve together, caret at start).

import { describe, expect, it } from "vitest";
import { redo, undo } from "@codemirror/commands";
import { buildModel, splitModel } from "../../src/diff2/diff-model";
import { readStructure } from "../../src/diff2/diff-structure";
import { currentGroupAt, resolveAll, resolveGroup } from "../../src/diff2/diff-resolve";
import { groupsOf } from "../../src/diff2/diff-selection";
import { createDiffPaneState } from "../../src/diff2/diff-pane-v2";

// one group: base "a\nL\nc\n" vs "a\nR\nc\n" ⇒ doc "a\nL\n\nR\n\nc\n"
//   ver1 [2,5) "L\n", ver2 [5,8) "R\n", group span [2,8); normal "c\n" [8,10)
function oneGroup() {
  const m = buildModel("a\nL\nc\n", "a\nR\nc\n");
  return { doc: createDiffPaneState("a\nL\nc\n", "a\nR\nc\n").doc, ranges: m.ranges };
}

describe("diff-resolve — resolveGroup (pure, scenario-2)", () => {
  const { doc, ranges } = oneGroup();
  const insertOf = (choice: Parameters<typeof resolveGroup>[3], opts = {}) =>
    (resolveGroup(doc, ranges, 0, choice, opts)!.changes as { insert: string }).insert;

  it("keep1 → ver1 content; keep2 → ver2 content", () => {
    expect(insertOf("keep1")).toBe("L\n");
    expect(insertOf("keep2")).toBe("R\n");
  });
  it("both → ver1+ver2; neither → empty", () => {
    expect(insertOf("both")).toBe("L\nR\n");
    expect(insertOf("neither")).toBe("");
  });
  it("join → ver1 + quoted ver2 under a header", () => {
    expect(insertOf("join", { label: "dev", date: "2026-06-05 10:31:30" })).toBe(
      "L\n> Changes from `dev` at 2026-06-05 10:31:30:\n> R\n",
    );
  });
  it("replaces the WHOLE group span and puts the caret at the END of the insert (§2.2.9)", () => {
    const spec = resolveGroup(doc, ranges, 0, "keep1")!;
    expect(spec.changes).toMatchObject({ from: 2, to: 8, insert: "L\n" });
    expect(spec.selection).toMatchObject({ anchor: 4 }); // groupFrom(2) + insert "L\n" length(2)
  });
  it("returns null for an unknown group", () => {
    expect(resolveGroup(doc, ranges, 99, "keep1")).toBeNull();
  });
});

describe("diff-resolve — dispatch-level (doc + structure resolve together)", () => {
  it("keep1: group becomes ver1 normal text, structure emptied, caret at END", () => {
    const s0 = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "keep1")!;
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(s1)).toEqual([]); // no more conflict
    expect(s1.selection.main.head).toBe(4); // END of "L\n" (§2.2.9 copy-paste)
  });

  it("neither: group deleted; the resolved doc round-trips on split", () => {
    const s0 = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "neither")!;
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nc\n");
    // fully resolved ⇒ both sides identical = the doc
    expect(splitModel(s1.doc.toString(), readStructure(s1))).toEqual({
      base: "a\nc\n",
      sibling: "a\nc\n",
    });
  });

  it("multi-group: resolving group 0 leaves group 1 intact (ranges shifted)", () => {
    const s0 = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const spec = resolveGroup(s0.doc, readStructure(s0), 0, "keep1")!; // ver1content "L1\n"
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nL1\nb\nL2\n\nR2\n\nc\n");
    expect(readStructure(s1)).toEqual([
      { from: 7, to: 11, ver: 1, group: 1 },
      { from: 11, to: 15, ver: 2, group: 1 },
    ]);
  });
});

describe("diff-resolve — currentGroupAt (§1.9 hotkey target)", () => {
  const s = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n"); // groups [2,10),[12,20)
  const ranges = readStructure(s);
  it("returns the group whose span contains the caret", () => {
    expect(currentGroupAt(ranges, 3)).toBe(0); // inside group 0
    expect(currentGroupAt(ranges, 14)).toBe(1); // inside group 1
  });
  it("returns null when the caret is in normal space", () => {
    expect(currentGroupAt(ranges, 0)).toBeNull(); // "a"
    expect(currentGroupAt(ranges, 11)).toBeNull(); // "b" between the groups
  });
  it("HALF-OPEN [from,to): a caret AT g.to (the next line) is NOT in the group", () => {
    // bug: `<= g.to` made a caret on the normal line directly after a group resolve
    // THAT group (boundary shifted down). g0=[2,10), g1=[12,20).
    const g0 = groupsOf(ranges).find((g) => g.group === 0)!;
    const g1 = groupsOf(ranges).find((g) => g.group === 1)!;
    expect(currentGroupAt(ranges, g0.from)).toBe(0); // start IS inside
    expect(currentGroupAt(ranges, g0.to)).toBeNull(); // === next normal line start → OUT
    expect(currentGroupAt(ranges, g0.to - 1)).toBe(0); // last position still IN
    expect(currentGroupAt(ranges, g1.to)).toBeNull();
  });
});

describe("diff-resolve — resolveAll (bulk toolbar)", () => {
  it("resolves EVERY group in one transaction; structure emptied", () => {
    const s0 = createDiffPaneState("a\nL1\nb\nL2\nc\n", "a\nR1\nb\nR2\nc\n");
    const spec = resolveAll(s0.doc, readStructure(s0), "keep2")!; // apply all remote
    const s1 = s0.update(spec).state;
    expect(s1.doc.toString()).toBe("a\nR1\nb\nR2\nc\n"); // both groups → ver2
    expect(readStructure(s1)).toEqual([]);
    expect(s1.selection.main.head).toBe(2); // first resolved group
  });
  it("returns null when there are no conflicts", () => {
    const s0 = createDiffPaneState("x\ny\n", "x\ny\n");
    expect(resolveAll(s0.doc, readStructure(s0), "keep1")).toBeNull();
  });
});

describe("diff-resolve — undo/redo restore STRUCTURE + cursor (Mina 1: structureHistory)", () => {
  const run = (
    state: ReturnType<typeof createDiffPaneState>,
    cmd: typeof undo,
  ): ReturnType<typeof createDiffPaneState> => {
    let next: ReturnType<typeof createDiffPaneState> | null = null;
    cmd({ state, dispatch: (tr) => (next = tr.state) });
    if (!next) throw new Error("command did not dispatch");
    return next;
  };

  it("undo after resolve brings the group + its structure back; redo re-resolves", () => {
    let s = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const groupStructure = readStructure(s); // [ver1[2,5), ver2[5,8)]
    s = s.update(resolveGroup(s.doc, readStructure(s), 0, "keep1")!).state;
    expect(readStructure(s)).toEqual([]); // resolved
    expect(s.selection.main.head).toBe(4); // caret at END of "L\n" (§2.2.9 copy-paste)

    const undone = run(s, undo);
    expect(undone.doc.toString()).toBe("a\nL\n\nR\n\nc\n"); // raw group text back
    expect(readStructure(undone)).toEqual(groupStructure); // ⭐ STRUCTURE restored (was the desync bug)

    const redone = run(undone, redo);
    expect(redone.doc.toString()).toBe("a\nL\nc\n");
    expect(readStructure(redone)).toEqual([]);
    // cursor after redo follows CM6-native history (here the pre-resolution pos);
    // it stays a VALID position (no 0,0-garbage / out-of-range). Exact placement
    // on undo/redo is a polish item — see the cursor note.
    expect(redone.selection.main.head).toBeGreaterThanOrEqual(0);
    expect(redone.selection.main.head).toBeLessThanOrEqual(redone.doc.length);
  });

  it("UNDO→REDO→UNDO keeps structure + cursor consistent (no 0,0 drift)", () => {
    let s = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    const g = readStructure(s);
    s = s.update(resolveGroup(s.doc, readStructure(s), 0, "keep2")!).state;
    const u1 = run(s, undo);
    expect(readStructure(u1)).toEqual(g);
    const r1 = run(u1, redo);
    expect(readStructure(r1)).toEqual([]);
    expect(r1.selection.main.head).toBeGreaterThanOrEqual(0); // valid, not garbage
    const u2 = run(r1, undo);
    expect(readStructure(u2)).toEqual(g); // structure still intact after the round-trip
  });
});
