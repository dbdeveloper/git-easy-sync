// V2 editing-behaviour filters — keep the ver-block representation valid while
// the user edits (DIFF-EDITOR-V2.md §2.2.4(2), §2.2.5). The structural guard
// (the terminal \n itself) lives in diff-structure.ts; this module adds:
//   - auto-\n (§2.2.4(2)): a non-empty ver-block's content must end with \n
//     (valid forms: "\n" empty | ".*\n\n" non-empty). After an edit drops the
//     content's trailing \n (".*\n" → invalid), restore it before the terminal.
//   - external guard (§2.2.5(1)): the \n separating a NORMAL line from a
//     following diff-group must not be deleted by a single Delete keystroke when
//     that normal line is non-empty (else the line silently merges into the
//     group). §2.2.5(2) (Backspace deleting ver2's terminal) is already covered
//     by terminalProtectionFilter — ver2.to-1 is a protected terminal.
//
// Pure decision functions (unit-tested) + thin CM6 filter wrappers.

import { ChangeSet, EditorState, type ChangeDesc, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { deleteCharForward } from "@codemirror/commands";
import type { VerRange } from "./diff-model";
import { fromRangeSet, readStructure, setStructure, structureField } from "./diff-structure";
import { replayDispatch } from "./history-log-v2";

// §2.2.4(2): inserts needed to restore a missing content-trailing \n, one per
// affected ver-block. Positions are in the post-edit doc (insert before the
// terminal \n at index to-1).
//
// §2.2.12 variant (a) — the LAST diff-group (the one that ENDS the document, no
// trailing normal text) is EXEMPT: both its ver-blocks represent the respective
// files' tails, whose last line may be EOL-less (".*\n" content). Forcing a \n
// there would add a byte the file never had → a phantom conflict on the next
// sync. The group is identified by its ver2 reaching doc end (`ver2.to ===
// doc.length`); both its ver1 and ver2 are skipped.
export function autoNewlineInserts(
  doc: Text,
  ranges: VerRange[],
): { from: number; insert: string }[] {
  const docLen = doc.length;
  let exemptGroup: number | null = null;
  for (const r of ranges) {
    if (r.ver === 2 && r.to === docLen) exemptGroup = r.group;
  }
  const out: { from: number; insert: string }[] = [];
  for (const r of ranges) {
    if (r.group === exemptGroup) continue; // §2.2.12 (a) — last group, EOL-less allowed
    if (r.to - r.from <= 1) continue; // empty ver — valid as the bare terminal "\n"
    // content = [from, to-1); its last char is at to-2.
    if (doc.sliceString(r.to - 2, r.to - 1) !== "\n") {
      out.push({ from: r.to - 1, insert: "\n" });
    }
  }
  return out;
}

// transactionFilter: append the §2.2.4(2) normalization into the SAME
// transaction (one Ctrl+Z reverts the edit + the auto-\n together). Skips
// structure-replacing transactions (resolution / replay set structure wholesale).
export const autoNewlineFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  // bug-16: REPLAY re-dispatches the recorded change, which ALREADY includes this
  // filter's auto-\n (composed at record time). Re-running the filter on replay
  // re-maps the structure + composes a fresh ChangeSet against the replay doc — a
  // second normalization that can desync the running length and throw
  // "Applying change set to a document with the wrong length" on a later block.
  // Replay must apply recorded ops VERBATIM → skip.
  if (tr.annotation(replayDispatch)) return tr;
  if (tr.effects.some((e) => e.is(setStructure))) return tr;
  const mapped = fromRangeSet(tr.startState.field(structureField).map(tr.changes));
  const inserts = autoNewlineInserts(tr.newDoc, mapped);
  if (inserts.length === 0) return tr;
  const norm = ChangeSet.of(inserts, tr.newDoc.length);
  return {
    changes: tr.changes.compose(norm),
    // caret stays just before the inserted \n (assoc -1) — i.e. right after the typed text.
    selection: tr.selection ? tr.selection.map(norm, -1) : undefined,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
  };
});

// §2.2.5(1): true (allow) unless the change is a single-char Delete of a
// group-preceding separator \n while that normal line is non-empty.
export function externalGuardOk(doc: Text, ranges: VerRange[], changes: ChangeDesc): boolean {
  const protectedSep = new Set<number>();
  for (const r of ranges) {
    if (r.ver !== 1) continue;
    const sep = r.from - 1; // the normal line's \n directly before the group
    if (sep < 1) continue; // group at doc start → no preceding normal to protect
    if (doc.sliceString(sep, sep + 1) !== "\n") continue;
    if (doc.sliceString(sep - 1, sep) !== "\n") protectedSep.add(sep); // normal line non-empty
  }
  if (protectedSep.size === 0) return true;
  let ok = true;
  changes.iterChangedRanges((fromA: number, toA: number, fromB: number, toB: number) => {
    // exactly a single-char deletion (no insertion) of a protected separator
    if (toA - fromA === 1 && toB === fromB && protectedSep.has(fromA)) ok = false;
  });
  return ok;
}

export const externalGuardFilter = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true;
  if (tr.annotation(replayDispatch)) return true; // replay applies recorded ops verbatim (bug-16)
  if (tr.effects.some((e) => e.is(setStructure))) return true; // resolution / replay
  return externalGuardOk(
    tr.startState.doc,
    fromRangeSet(tr.startState.field(structureField)),
    tr.changes,
  );
});

// ── §2.2.4(6,7) + §2.2.5 boundary Backspace/Delete (keymap commands) ─────────
//
// The changeFilters above DROP a boundary deletion's changes, but the default
// deleteCharBackward/Forward still applies its SELECTION move — so the caret
// slides onto the hidden (height:0) terminal line (bug-17). The spec wants the
// keystroke IGNORED "as if at the document boundary" — i.e. fully consumed, caret
// unmoved. So these commands sit ABOVE defaultKeymap (Prec.high) and return true
// (consume, NO transaction) when the keystroke is at a protected boundary; else
// false → the default delete runs. Empty-selection only — a real selection delete
// falls through to defaultKeymap (legalize + the changeFilters guard it).

const terminalsOf = (ranges: VerRange[]): Set<number> => new Set(ranges.map((r) => r.to - 1));
const fromsOf = (ranges: VerRange[]): Set<number> => new Set(ranges.map((r) => r.from));
// The `\n` directly before a diff-group (ver1.from-1) — separates a normal line
// from the group; deleting it merges them (§2.2.5.1).
function separatorsOf(doc: Text, ranges: VerRange[]): Set<number> {
  const out = new Set<number>();
  for (const r of ranges) {
    if (r.ver !== 1) continue;
    const sep = r.from - 1;
    if (sep >= 0 && doc.sliceString(sep, sep + 1) === "\n") out.add(sep);
  }
  return out;
}

// Backspace deletes [pos-1, pos). No-op when pos is a group/ver-block start
// (§2.2.4.6 — pos-1 is then a separator or the previous block's terminal) OR
// pos-1 is a terminal `\n` (§2.2.5.2 — Backspace just after a ver-block).
//
// EXCEPTION: at the START of a single-blank-line ver-block ("|\n\n"), Backspace
// acts like Delete — it removes the content `\n` so the block collapses to the
// EMPTY form "\n" ("|\n"). Without this, Backspace there is a plain no-op (the
// char before is a protected separator/terminal), so the user could clear a
// blank line with Delete but not Backspace. deleteCharForward removes [pos,pos+1)
// = the content \n (NOT the terminal at pos+1), and the auto-\n filter leaves the
// now-empty block alone (to-from <= 1).
export function diffBackspace(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const ranges = readStructure(view.state);
  const pos = sel.head;
  const blankBlock = ranges.find(
    (r) => r.from === pos && r.to - r.from === 2 && view.state.doc.sliceString(r.from, r.from + 1) === "\n",
  );
  if (blankBlock) {
    deleteCharForward(view); // "|\n\n" → "|\n" (empty ver-block)
    return true;
  }
  return fromsOf(ranges).has(pos) || terminalsOf(ranges).has(pos - 1);
}

// Delete deletes [pos, pos+1). No-op when pos is a terminal `\n` (§2.2.4.7) or a
// group-leading separator (§2.2.5.1).
export function diffDelete(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const ranges = readStructure(view.state);
  const pos = sel.head;
  return terminalsOf(ranges).has(pos) || separatorsOf(view.state.doc, ranges).has(pos);
}
