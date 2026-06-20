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
  type EditorSelection,
  type StateEffect,
  type Text,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { buildModel, type VerRange } from "./diff-model";
import { resolveGroup } from "./diff-resolve";
import {
  fromRangeSet,
  readStructure,
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

// §6.1 caret — where does offset `sideOffset` of side `side` (1=base/2=sibling) of
// a re-diffed group land in sub.doc? The INVERSE of splitModel's walk: splitModel
// reconstructs (base, sibling) from (sub.doc, sub.ranges) by concatenating normal
// gaps (both sides) + ver-range contents (one side); we replay that walk and stop
// when the chosen side's reconstructed length reaches `sideOffset`, returning the
// sub.doc offset of that char. Boundary uses `<` so an offset at a segment's end
// maps to the START of the NEXT segment — i.e. the caret follows the EDITED LINE to
// its new home (normal line OR ver-sub-block), per §6.1. Deterministic, no
// content-search. (side-offset maps directly: splitModel(sub)===(c1,c2) byte-exact,
// so an offset into c1/c2 is an offset into the reconstructed base/sibling.)
export function caretInSubDoc(
  subDoc: string,
  subRanges: VerRange[],
  side: 1 | 2,
  sideOffset: number,
): number {
  const sorted = [...subRanges].sort((a, b) => a.from - b.from);
  let baseLen = 0;
  let sibLen = 0;
  let pos = 0;
  // a [segStart, segStart+len) slice of subDoc appended to base and/or sibling;
  // returns the subDoc offset if the target side crosses sideOffset within it.
  const consume = (segStart: number, len: number, toBase: boolean, toSib: boolean): number | null => {
    if (side === 1 && toBase && sideOffset >= baseLen && sideOffset < baseLen + len)
      return segStart + (sideOffset - baseLen);
    if (side === 2 && toSib && sideOffset >= sibLen && sideOffset < sibLen + len)
      return segStart + (sideOffset - sibLen);
    if (toBase) baseLen += len;
    if (toSib) sibLen += len;
    return null;
  };
  for (const r of sorted) {
    if (r.from > pos) {
      const hit = consume(pos, r.from - pos, true, true); // normal gap → both sides
      if (hit !== null) return hit;
    }
    const contentLen = r.to - 1 - r.from; // ver content (terminal \n dropped)
    const hit = consume(r.from, contentLen, r.ver === 1, r.ver === 2);
    if (hit !== null) return hit;
    pos = r.to;
  }
  if (pos < subDoc.length) {
    const hit = consume(pos, subDoc.length - pos, true, true);
    if (hit !== null) return hit;
  }
  return subDoc.length; // offset at the very end (rare; caret never rests on a terminal)
}

// Renumber ranges into sequential group ids by document order. A group's ver1
// always immediately precedes its ver2 (no normal text between them, groups never
// overlap), so a ver1 starts a new id and the following ver2 inherits it.
export function renumberGroups(ranges: VerRange[]): VerRange[] {
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

// Shared splice: re-diff (base, sibling) and splice the result over [spanFrom,
// spanTo), set the new structure (others shifted by delta + sub.ranges offset,
// renumbered), and place the caret via caretInSubDoc(side, sideOffset). Used by
// BOTH split/shrink (one group's span) and merge (an adjacent run's span). Returns
// null when re-diff is a no-op (sub.doc === the original span). `others` = mapped
// ranges OUTSIDE the span (newDoc coords).
function rediffSplice(
  tr: Transaction,
  spanFrom: number,
  spanTo: number,
  base: string,
  sibling: string,
  others: VerRange[],
  caretSide: 1 | 2,
  caretSideOffset: number,
): TransactionSpec | null {
  const originalSpan = tr.newDoc.sliceString(spanFrom, spanTo);
  const sub = buildModel(base, sibling);
  if (sub.doc === originalSpan) return null; // no structural change

  const spliced = sub.ranges.map((r) => ({ ...r, from: r.from + spanFrom, to: r.to + spanFrom }));
  const delta = sub.doc.length - originalSpan.length;
  const shifted = others.map((r) =>
    r.from >= spanTo ? { ...r, from: r.from + delta, to: r.to + delta } : r,
  );
  const merged = renumberGroups([...shifted, ...spliced]);
  const after = spanFrom + caretInSubDoc(sub.doc, sub.ranges, caretSide, caretSideOffset);

  return {
    changes: tr.changes.compose(
      ChangeSet.of({ from: spanFrom, to: spanTo, insert: sub.doc }, tr.newDoc.length),
    ),
    effects: [
      setStructure.of(toRangeSet(merged)),
      resolveCaret.of({ before: tr.startState.selection.main.head, after }),
    ],
    selection: { anchor: after },
    annotations: isolateHistory.of("before"),
  };
}

// Build the split/shrink spec, or null when the edit neither converges (vanish,
// handled by vanishSpec) nor re-tiles (plain edit). Scoped re-diff over the edited
// group's span; caret follows the edited line (§6.1).
export function splitShrinkSpec(tr: Transaction): TransactionSpec | null {
  const eg = editedGroup(tr);
  if (!eg) return null;
  if (eg.c1 === eg.c2) return null; // convergence → vanishSpec owns it

  // §6.1 caret: follow the EDITED line. P (post-edit caret) is in vX; map its
  // side-offset into sub.doc (caretInSubDoc handles normal OR ver-sub-block).
  const p = tr.newSelection.main.head;
  const side: 1 | 2 = p >= eg.v1.from && p < eg.v1.to ? 1 : 2;
  const vX = side === 1 ? eg.v1 : eg.v2;
  const sideOffset = Math.max(0, Math.min(p - vX.from, vX.to - 1 - vX.from));
  const others = eg.mapped.filter((r) => r.group !== eg.group);
  return rediffSplice(tr, eg.v1.from, eg.v2.to, eg.c1, eg.c2, others, side, sideOffset);
}

// ── step 4 — MERGE (§2.2.12 cases 1&2 + §2.2.5(3)) ───────────────────────────
//
// When an edit removes the normal gap between groups (single Delete/Backspace on a
// lone empty separator — keymap §2.2.5(3); or select-the-normal-lines + Delete),
// the groups become ADJACENT (prev.v2.to === next.v1.from). Per §2.2.12.2 + the
// 1210 clarification, concat the run's ver1s + ver2s and ALWAYS re-diff. This is
// the SAME scoped re-diff (rediffSplice) over the run's combined span. Caret =
// the join point: the first line of the LAST-appended group's ver1 in the
// concatenated base (§6.1 merge rule), mapped through the re-diff.

interface GroupEntry {
  group: number;
  v1: VerRange;
  v2: VerRange;
}

// The first maximal run (≥2) of consecutive groups that are now adjacent (no
// normal char between prev.v2.to and next.v1.from), or null.
function adjacentRun(mapped: VerRange[]): GroupEntry[] | null {
  const byGroup = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of mapped) {
    const e = byGroup.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    byGroup.set(r.group, e);
  }
  const entries = [...byGroup.values()]
    .filter((e): e is GroupEntry => !!e.v1 && !!e.v2)
    .map((e) => ({ group: e.v1.group, v1: e.v1, v2: e.v2 }))
    .sort((a, b) => a.v1.from - b.v1.from);
  for (let i = 0; i + 1 < entries.length; i++) {
    if (entries[i].v2.to !== entries[i + 1].v1.from) continue;
    const run = [entries[i]];
    let j = i + 1;
    while (j < entries.length && entries[j - 1].v2.to === entries[j].v1.from) run.push(entries[j++]);
    return run;
  }
  return null;
}

// ALL maximal runs (≥2) of adjacent groups, left-to-right (each run = the groups
// that must merge). Used by paste (step 6b), which can create several adjacencies
// in one transaction (§2.2.12.1 case 4) — adjacentRun (first-only) is the reactive
// single-keystroke case where at most one forms.
function allAdjacentRuns(mapped: VerRange[]): GroupEntry[][] {
  const byGroup = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of mapped) {
    const e = byGroup.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    byGroup.set(r.group, e);
  }
  const entries = [...byGroup.values()]
    .filter((e): e is GroupEntry => !!e.v1 && !!e.v2)
    .map((e) => ({ group: e.v1.group, v1: e.v1, v2: e.v2 }))
    .sort((a, b) => a.v1.from - b.v1.from);
  const runs: GroupEntry[][] = [];
  let i = 0;
  while (i + 1 < entries.length) {
    if (entries[i].v2.to !== entries[i + 1].v1.from) {
      i++;
      continue;
    }
    const run = [entries[i]];
    let j = i + 1;
    while (j < entries.length && entries[j - 1].v2.to === entries[j].v1.from) run.push(entries[j++]);
    runs.push(run);
    i = j;
  }
  return runs;
}

const contentStr = (doc: string, r: VerRange): string => doc.slice(r.from, r.to - 1);

// Pure cascade: merge EVERY adjacent run in (doc, ranges) — concat each run's
// ver1s/ver2s and re-diff via buildModel (§2.2.12.2 + 1210) — and return the
// change set (in `doc` coords) + the final structure (post-change coords). Used by
// the paste filter, which materializes literal groups that may abut existing ones
// in several places at once. Returns null when there's no adjacency (nothing to do).
export function resolveAllAdjacencies(
  doc: string,
  ranges: VerRange[],
): {
  changes: { from: number; to: number; insert: string }[];
  finalRanges: VerRange[];
  caret: number;
} | null {
  const runs = allAdjacentRuns(ranges);
  if (runs.length === 0) return null;

  const runInfo = runs.map((run) => {
    const spanFrom = run[0].v1.from;
    const spanTo = run[run.length - 1].v2.to;
    const base = run.map((g) => contentStr(doc, g.v1)).join("");
    const sib = run.map((g) => contentStr(doc, g.v2)).join("");
    return { spanFrom, spanTo, ids: new Set(run.map((g) => g.group)), sub: buildModel(base, sib) };
  });
  const changes = runInfo.map((ri) => ({ from: ri.spanFrom, to: ri.spanTo, insert: ri.sub.doc }));
  const cs = ChangeSet.of(changes, doc.length);

  const runGroupIds = new Set(runInfo.flatMap((ri) => [...ri.ids]));
  const finalRanges: VerRange[] = [];
  for (const r of ranges) {
    if (runGroupIds.has(r.group)) continue; // replaced by a run's re-diff
    finalRanges.push({ ...r, from: cs.mapPos(r.from, 1), to: cs.mapPos(r.to, -1) });
  }
  for (const ri of runInfo) {
    const base = cs.mapPos(ri.spanFrom, 1); // start of this run's re-diffed region
    for (const sr of ri.sub.ranges) {
      finalRanges.push({ ...sr, from: sr.from + base, to: sr.to + base });
    }
  }

  // §6.1 merge caret for the cascade: each merge repositions the caret; the LAST
  // run (highest position) is processed last, so its join-point wins (user
  // 2026-06-20 — paste→merge→diff2 is one command; only the final caret is kept).
  // Join-point = first line of the last-appended group's ver1, or its ver2 first
  // line when that ver1 is empty (same rule as mergeSpec).
  const lastRun = runs[runs.length - 1];
  const lastInfo = runInfo[runInfo.length - 1];
  const lastGroup = lastRun[lastRun.length - 1];
  const lastVer1Empty = contentStr(doc, lastGroup.v1) === "";
  const caretSide: 1 | 2 = lastVer1Empty ? 2 : 1;
  const caretOffset = lastRun
    .slice(0, -1)
    .reduce((s, g) => s + contentStr(doc, caretSide === 1 ? g.v1 : g.v2).length, 0);
  const caret =
    cs.mapPos(lastInfo.spanFrom, 1) +
    caretInSubDoc(lastInfo.sub.doc, lastInfo.sub.ranges, caretSide, caretOffset);

  return { changes, finalRanges: renumberGroups(finalRanges), caret };
}

export function mergeSpec(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged) return null;
  if (tr.effects.some((e) => e.is(setStructure))) return null; // own output / replay

  const mapped = fromRangeSet(tr.startState.field(structureField).map(tr.changes));
  const run = adjacentRun(mapped);
  if (!run) return null;

  const spanFrom = run[0].v1.from;
  const spanTo = run[run.length - 1].v2.to;
  // concat the run's contents (adjacent ⇒ this == splitModel of the span).
  const base = run.map((g) => verContent(tr.newDoc, g.v1)).join("");
  const sibling = run.map((g) => verContent(tr.newDoc, g.v2)).join("");
  const runIds = new Set(run.map((g) => g.group));
  const others = mapped.filter((r) => !runIds.has(r.group));
  // §6.1 merge caret: join point = start of the LAST appended group's ver1. But if
  // that group's ver1 is EMPTY (nowhere to put the caret on the ver1 side), drop to
  // its ver2 first line instead (user 2026-06-20). side=1 with the ver1-prefix sum,
  // or side=2 with the ver2-prefix sum.
  const last = run[run.length - 1];
  const lastVer1Empty = verContent(tr.newDoc, last.v1) === "";
  const caretSide: 1 | 2 = lastVer1Empty ? 2 : 1;
  const caretOffset = run
    .slice(0, -1)
    .reduce((s, g) => s + verContent(tr.newDoc, caretSide === 1 ? g.v1 : g.v2).length, 0);
  return rediffSplice(tr, spanFrom, spanTo, base, sibling, others, caretSide, caretOffset);
}

// ── §2.2.4 p5c / p8a + §2.2.6 + §2.2.9 "neither" — selection-DELETE ───────────
//
// A selection that includes a ver-block's terminal \n can't be deleted by the
// default keymap: terminalProtectionFilter blocks it wholesale → the "Ctrl+A,
// Delete does nothing" bug. The fix is a keymap COMMAND that, for a
// terminal-spanning selection, CONSUMES the keystroke and dispatches its own
// rebuild routed through setStructure (so terminalProtectionFilter stays exactly
// as strict for stray single-keystroke terminal deletes — this passes by being
// structural). NOT the §2.2.5(3) return-false shape.
//
// Semantics: deleting a group-spanning selection removes the group from BOTH sides
// (= §2.2.9 "neither"). We project the deletion onto the logical files (base,
// sibling) — keeping ver terminals (internal, never selected, §2.2.4 p5a) — then
// whole-doc rebuild via buildModel. Group-atomic legalization (§2.2.6) guarantees
// any touched group is wholly inside the selection, so this is well-defined for N
// groups in ONE transaction. Ctrl+A is the maximal case: the whole doc → ("","")
// → empty. A within-block selection (no terminal inside) is NOT handled here
// (returns null) — the default delete already yields a valid one-empty block.

// New (base, sibling) after removing the chars in [F, T) from the doc, keeping ver
// terminals. Inverse-of-buildModel walk: each segment's kept part = its chars
// OUTSIDE [F, T); normal gaps go to both sides, ver content to its side, terminals
// are skipped (internal).
function projectDeletion(
  doc: Text,
  ranges: VerRange[],
  F: number,
  T: number,
): { base: string; sibling: string } {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let base = "";
  let sibling = "";
  let pos = 0;
  const kept = (segFrom: number, segTo: number): string => {
    const text = doc.sliceString(segFrom, segTo);
    if (F >= segTo || T <= segFrom) return text; // no overlap with the deletion
    const left = Math.max(0, F - segFrom);
    const right = Math.max(0, segTo - T);
    return text.slice(0, left) + (right > 0 ? text.slice(text.length - right) : "");
  };
  for (const r of sorted) {
    if (r.from > pos) {
      const g = kept(pos, r.from); // normal gap → both sides
      base += g;
      sibling += g;
    }
    const c = kept(r.from, r.to - 1); // ver content (terminal r.to-1 excluded)
    if (r.ver === 1) base += c;
    else sibling += c;
    pos = r.to;
  }
  if (pos < doc.length) {
    const g = kept(pos, doc.length);
    base += g;
    sibling += g;
  }
  return { base, sibling };
}

// Does the selection include any ver-block terminal \n? Only then does the default
// delete fail (terminalProtectionFilter) and we must rebuild.
function selectionSpansTerminal(sel: EditorSelection, ranges: VerRange[]): boolean {
  const { from, to } = sel.main;
  if (from === to) return false;
  return ranges.some((r) => from <= r.to - 1 && r.to - 1 < to);
}

// The rebuild spec for a terminal-spanning selection delete, or null if the
// selection is empty / within-block (let the default delete run).
export function selectionDeleteSpec(state: EditorState): TransactionSpec | null {
  const ranges = readStructure(state);
  if (!selectionSpansTerminal(state.selection, ranges)) return null;
  const { from } = state.selection.main;
  const { base, sibling } = projectDeletion(state.doc, ranges, from, state.selection.main.to);
  const rebuilt = buildModel(base, sibling);
  // caret → the deletion point. Everything before `from` is unchanged by the
  // delete (selection is [from,to)); clamp to the rebuilt length (Ctrl+A → 0).
  const after = Math.min(from, rebuilt.doc.length);
  return {
    changes: { from: 0, to: state.doc.length, insert: rebuilt.doc },
    effects: [
      setStructure.of(toRangeSet(rebuilt.ranges)),
      resolveCaret.of({ before: from, after }),
    ],
    selection: { anchor: after },
    annotations: isolateHistory.of("before"),
  };
}

// Keymap command (Backspace/Delete). Consumes (true) + dispatches the rebuild for
// a terminal-spanning selection; returns false otherwise so the default
// delete/diffBackspace/diffDelete chain runs (empty or within-block selection).
export function diffSelectionDelete(view: EditorView): boolean {
  const spec = selectionDeleteSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

// The live filter. vanish (step 2) → split/shrink (step 3) → merge (step 4) →
// unchanged. A gap-delete makes editedGroup no-op splitShrink, so it reaches merge.
export const autoResolveFilter = EditorState.transactionFilter.of(
  (tr: Transaction): TransactionSpec | readonly TransactionSpec[] =>
    vanishSpec(tr) ?? splitShrinkSpec(tr) ?? mergeSpec(tr) ?? tr,
);
