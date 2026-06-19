// GATE SPIKE (V2 interaction features §2.2.7/§2.2.12/§2.2.13) — the advisor's #1
// make-or-break: can a REAL user-edit transaction be AUGMENTED in-flight (the
// filter adds changes BEYOND the user's edit span + a setStructure effect) so the
// edit AND the structural recompute land as ONE undo unit — and does replay then
// reproduce it by APPLYING the recorded (changes, structure), without re-running
// diff2?
//
// This is the front half the existing v2-mixed-recovery-spike simulated away:
// that one hand-assembled the composed-spec and proved the BACK half (round-trip
// of a (changes+setStructure) tx). Here we drive a real edit and let a throwaway
// transactionFilter compute the cascade — proving the augmentation mechanic and
// the one-undo-unit granularity that §2/§2.1 of DIFF-EDITOR-V2-ANALYSIS.md assume.
//
// Decision this spike makes: augment-in-filter (one tx) vs follow-up-dispatch +
// coalesce (two txs). If a transactionFilter can return {changes: bigger-than-
// user, effects:[setStructure]} as ONE undo step, augment-in-filter wins.
//
// Scope: SPLIT (1 group → 2) + VANISH/auto-resolve (1 group → 0) via the universal
// splitModel→buildModel recompute on an in-ver edit; MERGE (2 groups → 1) via a
// separator-delete, which needs a line-content concat branch (splitModel alone
// loses the line boundary — a real finding for step-4 merge). Paste-cascade is
// NOT added: the augmentation mechanic is identical, proven here for edit/delete.

import { describe, expect, it } from "vitest";
import {
  ChangeSet,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { history, isolateHistory, redo, undo, undoDepth } from "@codemirror/commands";
import { buildModel, splitModel, type VerRange } from "../../../src/diff2/diff-model";
import {
  fromRangeSet,
  readStructure,
  setStructure,
  structureField,
  structureHistory,
  toRangeSet,
} from "../../../src/diff2/diff-structure";

// ── the throwaway cascade filter (the thing under test) ──────────────────────
//
// On a real doc-changing user edit (no setStructure of its own → not replay/own
// output), recompute the structure with ONE universal pass and, IF it changed,
// REWRITE the transaction into one composed-spec: whole-doc replace (from
// startState.doc) + setStructure.
//
// FINDING: the universal recompute `splitModel(newDoc, mappedStructure) →
// buildModel` covers ALL of split / shrink / vanish (edit-in-ver) AND merge
// (separator delete) uniformly — no merge-specific branch needed. (Each ver
// block's content already carries its own trailing `\n` in the terminal-inside
// model, so when the normal gap between two groups is deleted, splitModel
// concatenates them WITH line boundaries intact: "a\n"+"c\n" = "a\nc\n", not the
// fused "ac" I'd feared. buildModel then re-diffs the concatenation.) This is the
// §2.2.13 re-diff engine; merge (§2.2.12) falls out of it for free.
function sameModel(doc: string, ranges: VerRange[], m: { doc: string; ranges: VerRange[] }): boolean {
  return (
    doc === m.doc &&
    JSON.stringify([...ranges].sort((a, b) => a.from - b.from)) ===
      JSON.stringify([...m.ranges].sort((a, b) => a.from - b.from))
  );
}

const cascadeFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    if (tr.effects.some((e) => e.is(setStructure))) return tr; // own output / replay

    const startDoc = tr.startState.doc.toString();
    const newDoc = tr.newDoc.toString();
    // map the structure through the user's edit, read the post-edit logical
    // content, then re-diff the whole thing.
    const mapped = fromRangeSet(tr.startState.field(structureField).map(tr.changes));
    const { base, sibling } = splitModel(newDoc, mapped);
    const final = buildModel(base, sibling);
    if (sameModel(newDoc, mapped, final)) return tr; // plain in-line edit, no restructure

    return {
      changes: { from: 0, to: startDoc.length, insert: final.doc },
      effects: [setStructure.of(toRangeSet(final.ranges))],
      selection: { anchor: Math.min(tr.newSelection.main.head, final.doc.length) },
    };
  },
);

// ── harness (mirrors v2-mixed-recovery-spike / v2-resolution-paste-spike) ─────
function freshState(base: string, sibling: string): EditorState {
  const m = buildModel(base, sibling);
  return EditorState.create({
    doc: m.doc,
    extensions: [
      history({ newGroupDelay: 0 }), // each tx = its own undo group
      structureField,
      structureField.init(() => toRangeSet(m.ranges)),
      structureHistory,
      cascadeFilter,
    ],
  });
}

type LogEntry = { change: unknown; structure?: VerRange[] };

// dispatch a REAL user edit; capture the POST-FILTER transaction for the log.
function applyAndCapture(
  state: EditorState,
  spec: TransactionSpec,
): { state: EditorState; entry: LogEntry } {
  const tr = state.update({ ...spec, annotations: isolateHistory.of("before") });
  const entry: LogEntry = { change: tr.changes.toJSON() };
  for (const e of tr.effects) if (e.is(setStructure)) entry.structure = fromRangeSet(e.value);
  return { state: tr.state, entry };
}

// replay the captured log into a fresh editor (recovery): apply the recorded
// change + (if present) setStructure — NO cascade re-run, NO diff2.
function replay(base: string, sibling: string, log: LogEntry[]): EditorState {
  let s = freshState(base, sibling);
  for (const e of log) {
    const effects = e.structure ? [setStructure.of(toRangeSet(e.structure))] : [];
    s = s.update({
      changes: ChangeSet.fromJSON(e.change as never),
      effects,
      annotations: isolateHistory.of("before"),
    }).state;
  }
  return s;
}

const groupCount = (s: EditorState): number =>
  new Set(readStructure(s).map((r) => r.group)).size;
const docStruct = (s: EditorState) => ({
  doc: s.doc.toString(),
  struct: readStructure(s),
});
const undoTo = (s: EditorState): EditorState => {
  let out = s;
  undo({ state: s, dispatch: (tr) => (out = tr.state) });
  return out;
};
const redoTo = (s: EditorState): EditorState => {
  let out = s;
  redo({ state: s, dispatch: (tr) => (out = tr.state) });
  return out;
};

describe("GATE — real edit augmented in-filter is ONE undo unit + replay applies recorded structure", () => {
  it("SPLIT: in-ver edit makes a middle line equal → 1 group becomes 2 (count UP)", () => {
    const BASE = "a\nb\nc\n";
    const SIB = "x\ny\nz\n"; // all differ → 1 group
    const s0 = freshState(BASE, SIB);
    expect(groupCount(s0)).toBe(1);

    // real edit: change ver1's middle line "b" → "y" (= ver2's middle). pos 2.
    const { state: s1, entry } = applyAndCapture(s0, { changes: { from: 2, to: 3, insert: "y" } });

    // restructure happened, AND it is exactly ONE undo step despite the filter
    // adding changes far beyond the 1-char user edit.
    expect(groupCount(s1)).toBe(2);
    expect(entry.structure, "captured structure for the log").toBeDefined();
    expect(undoDepth(s1)).toBe(1);

    // undo reverts BOTH the doc and the structure (invertedEffects) in one step.
    const back = undoTo(s1);
    expect(docStruct(back)).toEqual(docStruct(s0));
    expect(undoDepth(back)).toBe(0);
    // redo re-applies both.
    expect(docStruct(redoTo(back))).toEqual(docStruct(s1));

    // replay (recovery) applies the recorded (change, structure) → identical.
    expect(docStruct(replay(BASE, SIB, [entry]))).toEqual(docStruct(s1));
  });

  it("VANISH (auto-resolve): in-ver edit makes ver1 == ver2 → group disappears (count → 0)", () => {
    const BASE = "L\n";
    const SIB = "R\n"; // 1 group
    const s0 = freshState(BASE, SIB);
    expect(groupCount(s0)).toBe(1);

    // change ver1 "L" → "R" (now equals ver2). pos 0.
    const { state: s1, entry } = applyAndCapture(s0, { changes: { from: 0, to: 1, insert: "R" } });

    expect(groupCount(s1)).toBe(0); // group gone → all normal
    expect(s1.doc.toString()).toBe("R\n");
    expect(undoDepth(s1)).toBe(1);

    const back = undoTo(s1);
    expect(docStruct(back)).toEqual(docStruct(s0)); // group restored
    expect(docStruct(redoTo(back))).toEqual(docStruct(s1));
    expect(docStruct(replay(BASE, SIB, [entry]))).toEqual(docStruct(s1));
  });

  it("MERGE: deleting the separator between two groups merges them via universal recompute (count DOWN)", () => {
    const BASE = "a\nS\nc\n";
    const SIB = "x\nS\nz\n"; // group(a/x), normal "S\n", group(c/z) → 2 groups
    const s0 = freshState(BASE, SIB);
    expect(groupCount(s0)).toBe(2);

    // find the separator "S\n" (the normal gap between the two groups) and delete it.
    const before = readStructure(s0);
    const g0v2 = before.find((r) => r.group === 0 && r.ver === 2)!;
    const g1v1 = before.find((r) => r.group === 1 && r.ver === 1)!;
    const { state: s1, entry } = applyAndCapture(s0, {
      changes: { from: g0v2.to, to: g1v1.from }, // delete the whole gap
    });

    expect(groupCount(s1)).toBe(1); // merged
    // merge preserved line boundaries (a,c) / (x,z) — NOT fused "ac"/"xz".
    expect(splitModel(s1.doc.toString(), readStructure(s1))).toEqual({
      base: "a\nc\n",
      sibling: "x\nz\n",
    });
    expect(undoDepth(s1)).toBe(1);

    const back = undoTo(s1);
    expect(docStruct(back)).toEqual(docStruct(s0)); // two groups + separator restored
    expect(docStruct(redoTo(back))).toEqual(docStruct(s1));
    expect(docStruct(replay(BASE, SIB, [entry]))).toEqual(docStruct(s1));
  });

  it("interleave + multi-step replay: split then vanish, undo/redo walk, replay all", () => {
    const BASE = "a\nb\nc\n";
    const SIB = "x\ny\nz\n";
    const s0 = freshState(BASE, SIB);
    const log: LogEntry[] = [];

    // op1: SPLIT (b→y)
    const r1 = applyAndCapture(s0, { changes: { from: 2, to: 3, insert: "y" } });
    log.push(r1.entry);
    expect(groupCount(r1.state)).toBe(2);

    // op2: VANISH group 0 — make its ver1 line equal ver2 ("a"→"x"). pos 0.
    const r2 = applyAndCapture(r1.state, { changes: { from: 0, to: 1, insert: "x" } });
    log.push(r2.entry);
    expect(groupCount(r2.state)).toBe(1); // one group resolved away, one remains

    expect(undoDepth(r2.state)).toBe(2); // two undo units total

    // undo/redo walk (live)
    const afterUndo1 = undoTo(r2.state);
    expect(docStruct(afterUndo1)).toEqual(docStruct(r1.state));
    const afterUndo2 = undoTo(afterUndo1);
    expect(docStruct(afterUndo2)).toEqual(docStruct(s0));

    // full replay reproduces the final state
    expect(docStruct(replay(BASE, SIB, log))).toEqual(docStruct(r2.state));
  });
});
