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
import type { VerRange } from "./diff-model";
import { resolveGroup } from "./diff-resolve";
import { fromRangeSet, resolveCaret, setStructure, structureField } from "./diff-structure";

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

// The live filter. Vanish only (step 2); split/shrink add a branch here (step 3).
export const autoResolveFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] => vanishSpec(tr) ?? tr,
);
