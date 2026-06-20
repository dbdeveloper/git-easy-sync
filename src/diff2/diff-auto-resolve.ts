// V2 §2.2.13 — auto-resolve (VANISH): a free edit inside a ver-block that makes
// ver1content === ver2content collapses the diff-group into normal lines (the
// degenerate re-diff = a resolution-drop, NOT a buildModel re-tile). This is the
// cheapest slice of §2.2.13 and the user's stated end-goal.
//
// Mechanism (advisor 2026-06-20): a `transactionFilter` that AUGMENTS the user's
// edit in-flight into ONE transaction (proven a single undo unit by the gate
// spike `v2-restructure-replay-spike`). It reuses `resolveGroup`'s fuzz-tested
// region-replace + structure-drop body (so no re-diff, so the "distant-group
// re-tile" risk does not apply here) and overrides only the caret to the VANISH
// rule. Persistence is free: the tx carries setStructure + resolveCaret, so the
// existing historyFeedListener records a structural block (structure + caret) and
// replay applies it — exactly the resolution path.
//
// Caret (§6.1, user 2026-06-20): the caret stays on the SAME logical line+col the
// user was editing — now a normal line. Since ver1content === ver2content, that is
// a content-offset: after = groupStart + (beforeCaret − vX.from), where vX is
// whichever block the caret sat in. before = the pre-edit caret (undo lands at the
// edit site in the restored group).
//
// SCOPE: VANISH only. split / shrink (group survives but re-tiles) is step 3 — it
// will add a branch to THIS filter (a second filter would double-process). Until
// then a split-shaped edit just leaves the group un-re-tiled; splitModel at save
// still yields correct content, so it is a cosmetic deferral, not a data bug.

import {
  ChangeSet,
  EditorState,
  type ChangeDesc,
  type StateEffect,
  type Text,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { buildModel, type VerRange } from "./diff-model";
import { resolveGroup } from "./diff-resolve";
import {
  fromRangeSet,
  resolveCaret,
  setStructure,
  structureField,
  toRangeSet,
} from "./diff-structure";

// content of a ver range, terminal `\n` dropped (mirror of splitModel / resolveGroup).
const verContent = (doc: Text, r: VerRange): string => doc.sliceString(r.from, r.to - 1);

// The group the edit touched AND whose ver1content === ver2content after the edit
// (a VANISH), or null. `mapped` is the structure already mapped through `changes`
// (so its positions are in `newDoc` coordinates). Scoped: only groups whose span
// overlaps the changed region are considered — a distant group can't have vanished.
export function detectVanish(
  newDoc: Text,
  mapped: VerRange[],
  changes: ChangeDesc,
): number | null {
  let lo = Infinity;
  let hi = -1;
  changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    if (fromB < lo) lo = fromB;
    if (toB > hi) hi = toB;
  });
  if (hi < 0) return null; // no doc change

  const byGroup = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of mapped) {
    const g = byGroup.get(r.group) ?? {};
    if (r.ver === 1) g.v1 = r;
    else g.v2 = r;
    byGroup.set(r.group, g);
  }
  for (const [group, { v1, v2 }] of byGroup) {
    if (!v1 || !v2) continue;
    // overlap test: the change region [lo,hi] touches the group span [v1.from,v2.to)
    if (hi < v1.from || lo > v2.to) continue;
    // ver1content === ver2content (incl. BOTH empty) → VANISH. Both-sides-empty IS
    // a classic resolution (user 2026-06-20): a one-side-empty ver-block is a valid
    // §2.2.4 placeholder, but BOTH empty means the conflict resolved to nothing →
    // collapse. (If this empties the whole file, the commit-time empty-resolution /
    // SYNC2 §2.9 path handles deletion — unaffected here, which only drops the
    // group's lines.)
    if (verContent(newDoc, v1) === verContent(newDoc, v2)) return group;
  }
  return null;
}

// Build the augmented spec for a vanish, or null if the tx is not a vanish (the
// caller returns `tr` unchanged then). Returns ONE composed transaction:
// user-edit ∘ collapse, + setStructure(remaining) + resolveCaret(VANISH), isolated
// as its own undo step.
export function vanishSpec(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged) return null;
  // re-entrancy: our own output, a resolution, and replay all carry setStructure.
  if (tr.effects.some((e) => e.is(setStructure))) return null;

  const mapped = fromRangeSet(tr.startState.field(structureField).map(tr.changes));
  const group = detectVanish(tr.newDoc, mapped, tr.changes);
  if (group === null) return null;

  const v1 = mapped.find((r) => r.group === group && r.ver === 1)!;
  const v2 = mapped.find((r) => r.group === group && r.ver === 2)!;

  // Reuse resolveGroup's region-replace + structure-drop (in newDoc coords). Since
  // ver1content === ver2content, "keep1" inserts the converged content.
  const rg = resolveGroup(tr.newDoc, mapped, group, "keep1");
  if (!rg || !rg.changes) return null;
  const structEffect = (rg.effects as readonly StateEffect<unknown>[]).find((e) =>
    e.is(setStructure),
  );
  if (!structEffect) return null;

  // VANISH caret (content-offset). The resolved normal block starts at v1.from in
  // the final doc (collapse replaces [v1.from, v2.to) in place). vX = the block the
  // caret was in; offset within it maps 1:1 into the resolved content.
  const beforeCaret = tr.newSelection.main.head;
  const inV1 = beforeCaret >= v1.from && beforeCaret < v1.to;
  const vX = inV1 ? v1 : v2;
  const offset = Math.max(0, Math.min(beforeCaret - vX.from, vX.to - 1 - vX.from));
  const after = v1.from + offset;
  const before = tr.startState.selection.main.head;

  // Compose the collapse (newDoc coords) onto the user's edit (startState coords).
  const collapse = ChangeSet.of(rg.changes, tr.newDoc.length);
  return {
    changes: tr.changes.compose(collapse),
    effects: [structEffect, resolveCaret.of({ before, after })],
    selection: { anchor: after },
    annotations: isolateHistory.of("before"), // own undo step under history() default
  };
}

// ── step 3 — SPLIT / SHRINK (scoped re-diff) ─────────────────────────────────
//
// An in-ver edit that does NOT converge the whole group but makes some line(s)
// COMMON re-tiles the group: split into two (a middle line became common),
// shrink-front (first line common → a normal line BEFORE the group), or
// shrink-back (last line common → a normal line AFTER). The recompute is SCOPED
// to the edited group: re-diff ONLY its (c1, c2) via buildModel and splice the
// result over the group's span. Scoping (not whole-doc) means a distant group can
// never be re-tiled (the §6 risk) and keeps neighbours byte-stable.
//
// STRUCTURE-FIRST (this commit): emit setStructure for the new tiling; the caret
// is a placeholder (v1.from). The §6.1 split/shrink caret rule lands in a separate
// commit (resolveCaret) once the rule is user-confirmed.

// Renumber ranges into sequential group ids by document order. A group's ver1
// always immediately precedes its ver2 (no normal text between them, groups never
// overlap), so a ver1 starts a new id and the following ver2 inherits it.
function renumberGroups(ranges: VerRange[]): VerRange[] {
  let g = -1;
  return [...ranges]
    .sort((a, b) => a.from - b.from)
    .map((r) => {
      if (r.ver === 1) g += 1;
      return { ...r, group: g };
    });
}

// The diff-group whose span the edit landed in, with its post-edit contents.
function editedGroup(
  tr: Transaction,
): { group: number; v1: VerRange; v2: VerRange; c1: string; c2: string; mapped: VerRange[] } | null {
  if (!tr.docChanged) return null;
  if (tr.effects.some((e) => e.is(setStructure))) return null; // own output / replay

  const mapped = fromRangeSet(tr.startState.field(structureField).map(tr.changes));
  let lo = Infinity;
  let hi = -1;
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    if (fromB < lo) lo = fromB;
    if (toB > hi) hi = toB;
  });
  if (hi < 0) return null;

  const byGroup = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of mapped) {
    const e = byGroup.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    byGroup.set(r.group, e);
  }
  for (const [group, { v1, v2 }] of byGroup) {
    if (!v1 || !v2) continue;
    if (hi < v1.from || lo > v2.to) continue; // change didn't touch this group
    return { group, v1, v2, c1: verContent(tr.newDoc, v1), c2: verContent(tr.newDoc, v2), mapped };
  }
  return null;
}

// Build the split/shrink spec, or null when the edit neither converges (vanish,
// handled by vanishSpec) nor re-tiles (plain edit). Scoped re-diff: replace the
// edited group's span with buildModel(c1, c2).doc and set the spliced structure.
export function splitShrinkSpec(tr: Transaction): TransactionSpec | null {
  const eg = editedGroup(tr);
  if (!eg) return null;
  if (eg.c1 === eg.c2) return null; // convergence → vanishSpec owns it

  const originalSpan = tr.newDoc.sliceString(eg.v1.from, eg.v2.to);
  const sub = buildModel(eg.c1, eg.c2);
  // No common line ⇒ buildModel yields ONE group covering everything ⇒ sub.doc ===
  // the original span ⇒ no structural change (a plain in-ver edit, RangeSet maps).
  if (sub.doc === originalSpan) return null;

  const off = eg.v1.from;
  const spliced = sub.ranges.map((r) => ({ ...r, from: r.from + off, to: r.to + off }));
  const delta = sub.doc.length - originalSpan.length;
  const others = eg.mapped
    .filter((r) => r.group !== eg.group)
    .map((r) => (r.from >= eg.v2.to ? { ...r, from: r.from + delta, to: r.to + delta } : r));
  const merged = renumberGroups([...others, ...spliced]);

  return {
    changes: tr.changes.compose(
      ChangeSet.of({ from: eg.v1.from, to: eg.v2.to, insert: sub.doc }, tr.newDoc.length),
    ),
    effects: [setStructure.of(toRangeSet(merged))],
    selection: { anchor: eg.v1.from }, // STRUCTURE-FIRST placeholder; §6.1 caret = separate commit
    annotations: isolateHistory.of("before"),
  };
}

// The live filter. vanish (step 2) → split/shrink (step 3) → unchanged.
export const autoResolveFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] =>
    vanishSpec(tr) ?? splitShrinkSpec(tr) ?? tr,
);
