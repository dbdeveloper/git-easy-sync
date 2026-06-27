// V2 §2.2.7 — diff-group ↔ clipboard serialization (COPY half; PASTE = step 6).
//
// A selection that wholly contains diff-group(s) (group-atomic, §2.2.6) copies as
// a fenced ```github-easy-sync block per group; normal text in the selection is
// copied verbatim; a selection within ONE ver-block copies as plain text (§2.2.7
// п.1) — handled by returning null so the default copy runs.
//
// COPY is READ-ONLY: no doc mutation, no history, no resolveCaret. The pure
// copyClipboardText(state) is the oracle-testable core (asserted byte-exact
// against the spec's Examples 6/7); the EditorView.domEventHandlers wrapper that
// puts it on the OS clipboard is a thin device-gate edge (happy-dom can't deliver
// a real copy ClipboardEvent into CM6 — same limitation as marker-button clicks).

import { EditorView } from "@codemirror/view";
import { ChangeSet, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { VerRange } from "./diff-model";
import {
  isTouchOnly,
  readStructure,
  resolveCaret,
  setStructure,
  toRangeSet,
} from "./diff-structure";
import {
  renumberGroups,
  resolveAllAdjacencies,
  selectionDeleteSpec,
  selectionSpansTerminal,
  singleVerSpan,
} from "./diff-auto-resolve";

// §2.2.7 markers/prefixes (byte-exact, user-finalized 2026-06-20). Unicode here is
// cosmetic for ≪/≫; uniqueness is carried by the fence tag + all-or-nothing parse.
export const FENCE_OPEN = "```github-easy-sync";
export const FENCE_CLOSE = "```";
export const VER1_OPEN = "≪"; // U+226A MUCH LESS-THAN
export const SEP = "=="; // ASCII
export const VER2_CLOSE = "≫"; // U+226B MUCH GREATER-THAN
export const VER1_PREFIX = "- ";
export const VER2_PREFIX = "+ ";
export const NL_GLYPH = "↵"; // U+21B5 — trailing-whitespace guard before \n

// Split a ver-block's content into lines, tracking whether each ended with \n.
// "" → [] (empty ver-block, no lines). "L1\nL2\n" → both \n-terminated. "L1\nL2"
// (EOL-less last group, §2.2.12 a) → L2 NOT terminated → no ↵. "\n" → one empty
// line (a blank content line) → "- ↵\n".
export function contentLines(content: string): { text: string; nl: boolean }[] {
  if (content === "") return [];
  const trailingNL = content.endsWith("\n");
  const parts = content.split("\n");
  const lines = trailingNL ? parts.slice(0, -1) : parts;
  return lines.map((text, i) => ({ text, nl: trailingNL || i < lines.length - 1 }));
}

// One diff-group → the fenced block (Examples 6/7). c1/c2 are the ver-block
// contents (terminal \n already dropped). EOL-less last lines (nl=false) omit the
// ↵ but keep their \n line-separator.
export function serializeGroup(c1: string, c2: string): string {
  const emit = (content: string, prefix: string): string =>
    contentLines(content)
      .map((l) => `${prefix}${l.text}${l.nl ? NL_GLYPH : ""}\n`)
      .join("");
  return (
    `${FENCE_OPEN}\n` +
    `${VER1_OPEN}\n` +
    emit(c1, VER1_PREFIX) +
    `${SEP}\n` +
    emit(c2, VER2_PREFIX) +
    `${VER2_CLOSE}\n` +
    `${FENCE_CLOSE}\n`
  );
}

// ── §2.2.7 п.4–6 — PARSE (clipboard text → segments), the inverse of serialize ──
//
// A clipboard string is a sequence of normal text and fenced ```github-easy-sync
// blocks. parseClipboard scans for blocks; a block that matches rules 4(a–f)
// EXACTLY becomes a group segment, anything else (incl. a malformed fence, rule 5)
// stays literal normal text. All-or-nothing PER BLOCK. Pure — the paste filter
// (step 6b) materializes these segments into the doc + structure.

export type ClipSegment =
  | { kind: "normal"; text: string }
  | { kind: "group"; ver1: string[]; ver2: string[] };

// strip the trailing ↵ (rule 4c/4e: "↵ перед \n") — once.
const stripGlyph = (s: string): string => (s.endsWith(NL_GLYPH) ? s.slice(0, -1) : s);

// Try to parse a fenced block starting at line `start`. Returns the group's
// ver1/ver2 line contents + the index AFTER the close fence, or null if ANY rule
// 4(a–f) fails (→ caller treats the opening line as ordinary normal text, rule 5).
function tryParseBlock(
  lines: string[],
  start: number,
): { ver1: string[]; ver2: string[]; next: number } | null {
  if (lines[start] !== FENCE_OPEN) return null; // 4a
  if (lines[start + 1] !== VER1_OPEN) return null; // 4b
  let i = start + 2;
  const ver1: string[] = [];
  while (i < lines.length && lines[i] !== SEP) {
    if (!lines[i].startsWith(VER1_PREFIX)) return null; // 4c — must be "- "
    ver1.push(stripGlyph(lines[i].slice(VER1_PREFIX.length)));
    i++;
  }
  if (i >= lines.length) return null; // 4d — no "=="
  i++; // skip "=="
  const ver2: string[] = [];
  while (i < lines.length && lines[i] !== VER2_CLOSE) {
    if (!lines[i].startsWith(VER2_PREFIX)) return null; // 4e — must be "+ "
    ver2.push(stripGlyph(lines[i].slice(VER2_PREFIX.length)));
    i++;
  }
  if (i >= lines.length) return null; // 4e — no "≫"
  i++; // skip "≫"
  if (lines[i] !== FENCE_CLOSE) return null; // 4f — close fence
  return { ver1, ver2, next: i + 1 };
}

export function parseClipboard(text: string): ClipSegment[] {
  const lines = text.split("\n");
  // line i contributed "text\n" in the original unless it's the last split part.
  const lineWithNL = (i: number): string => lines[i] + (i < lines.length - 1 ? "\n" : "");
  const segments: ClipSegment[] = [];
  let normal = "";
  const flush = (): void => {
    if (normal !== "") segments.push({ kind: "normal", text: normal });
    normal = "";
  };
  let i = 0;
  while (i < lines.length) {
    const block = tryParseBlock(lines, i);
    if (block) {
      flush();
      segments.push({ kind: "group", ver1: block.ver1, ver2: block.ver2 });
      i = block.next;
    } else {
      normal += lineWithNL(i);
      i++;
    }
  }
  flush();
  return segments;
}

// True iff the clipboard contains at least one convertible diff-group (so the
// paste filter knows to rewrite rather than insert verbatim).
export function clipboardHasGroup(text: string): boolean {
  return parseClipboard(text).some((s) => s.kind === "group");
}

const verContent = (doc: Text, r: VerRange): string => doc.sliceString(r.from, r.to - 1);

// The clipboard text for the current selection, or null to let the default copy
// run (empty / within-one-ver-block selection → plain text, §2.2.7 п.1). Walks the
// selection in document order: normal gaps verbatim, each wholly-contained group
// as a fenced block. (EOL-less last group falls out of contentLines — no isLast
// flag needed: the content itself is EOL-less.)
//
// Uses selectionSpansTerminal — THE SAME predicate selectionDeleteSpec uses — so
// CUT's copy and delete halves can never disagree (advisor: a divergence would
// silently make Ctrl+X copy-without-delete).
export function copyClipboardText(state: EditorState): string | null {
  const sel = state.selection.main;
  const ranges = readStructure(state);
  if (!selectionSpansTerminal(sel.from, sel.to, ranges)) return null;

  // §2.2.7 п.1 — a single-ver selection (within ONE ver-block, e.g. all of ver1 with
  // head at v2.from) copies as PLAIN content WITHOUT the terminal \n — not a fence.
  // Mirrors selectionDeleteSpec's single-ver branch (shared singleVerSpan) so CUT's
  // copy & delete halves agree.
  const v = singleVerSpan(sel.from, sel.to, ranges);
  if (v) {
    // §2.2.7 п.1 — plain ver-content WITHOUT the (protected) terminal \n = the LAST
    // \n of the block; the content's own line-newlines stay (verContent = slice to
    // v.to-1). This equals exactly what selectionDeleteSpec removes → CUT is symmetric
    // (copy === deleted bytes). raw empty ⇒ null so copy agrees with delete (only the
    // terminal selected → nothing to cut).
    const raw = state.doc.sliceString(sel.from, Math.min(sel.to, v.to - 1));
    return raw.length === 0 ? null : raw;
  }

  const byGroup = new Map<number, { v1?: VerRange; v2?: VerRange }>();
  for (const r of ranges) {
    const e = byGroup.get(r.group) ?? {};
    if (r.ver === 1) e.v1 = r;
    else e.v2 = r;
    byGroup.set(r.group, e);
  }
  const groups = [...byGroup.values()]
    .filter((e): e is { v1: VerRange; v2: VerRange } => !!e.v1 && !!e.v2)
    .sort((a, b) => a.v1.from - b.v1.from);

  // §2.2.7 п.2 — fence ONLY groups WHOLLY inside the selection; everything else
  // (normal gaps) verbatim. A partially-overlapped group can't reach here post-
  // legalize (it would be the single-ver case above), but gating on full containment
  // is the correct, defensive rule.
  let out = "";
  let pos = sel.from;
  for (const g of groups) {
    if (sel.from <= g.v1.from && g.v2.to <= sel.to) {
      if (g.v1.from > pos) out += state.doc.sliceString(pos, g.v1.from); // normal gap verbatim
      out += serializeGroup(verContent(state.doc, g.v1), verContent(state.doc, g.v2));
      pos = g.v2.to;
    }
  }
  if (pos < sel.to) out += state.doc.sliceString(pos, sel.to); // trailing normal
  return out;
}

// Thin edge: intercept copy when the selection spans a group; otherwise let CM6
// copy plain text. Device-gate: a real copy ClipboardEvent reaching this handler
// with a working clipboardData is browser-validated, not unit-testable in happy-dom.
//
// CUT (full feature = copy-serialize + the selection-delete) is a SEPARATE step.
// Until then, intercept `cut` on a group-spanning selection to PREVENT the default:
// CM6's default cut would put the RAW doc slice (with inter-ver structure) on the
// clipboard AND its terminal-spanning delete is blocked by terminalProtectionFilter
// — i.e. garbage clipboard + no delete. We at least serialize correctly (so the
// clipboard is valid) and preventDefault (no broken delete); the actual removal
// lands with the cut step. A within-block cut falls through to the default.
export const diffClipboardCopy = EditorView.domEventHandlers({
  copy(event, view) {
    // §2.2.7 — an EMPTY selection must NOT copy/cut the whole current line (CM6's
    // default line-copy). A collapsed caret means "nothing selected" (e.g. bug-1b — a
    // Shift+Up that lands the caret on a group edge), so the clipboard gets "" (user:
    // empty string; keep-old is the free fallback when clipboardData is null).
    if (view.state.selection.main.empty) {
      event.clipboardData?.setData("text/plain", "");
      event.preventDefault();
      return true;
    }
    const text = copyClipboardText(view.state);
    if (text === null) return false; // default plain copy
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    return true;
  },
  cut(event, view) {
    // §2.2.7 — empty selection → "" clipboard + NO delete (CM6's default cut would
    // DELETE the whole current line — a worse latent bug than the copy one).
    if (view.state.selection.main.empty) {
      event.clipboardData?.setData("text/plain", "");
      event.preventDefault();
      return true;
    }
    // CUT = COPY (serialize the group-spanning selection) + the terminal-safe
    // selection-delete (§2.2.4 p5c / §2.2.9 "neither", group-atomic). One undo unit
    // (the delete is a single setStructure transaction; the copy mutates nothing).
    const text = copyClipboardText(view.state);
    if (text === null) return false; // within-block → default cut (plain text)
    event.clipboardData?.setData("text/plain", text);
    // §2.2.14 — read-only: cut COPIES (proper format) but does NOT delete. The delete is a
    // setStructure transaction with no "delete" userEvent, so the changeFilter can't catch
    // it — skip the dispatch here. preventDefault still blocks the native raw-slice cut.
    if (!isTouchOnly(view.state)) {
      const spec = selectionDeleteSpec(view.state);
      if (spec) view.dispatch(spec); // group-spanning → rebuild-delete (never a raw slice)
    }
    event.preventDefault();
    return true;
  },
});

// ── §2.2.7 п.3a — PASTE into normal text: materialize fenced groups + cascade ──
//
// Materialize parsed segments into the model's doc form: normal text verbatim,
// each group → ver1 content + terminal \n, ver2 content + terminal \n (the
// buildModel convention). Literal groups (NOT re-diffed — paste is faithful to the
// copy); adjacency with existing groups is resolved by the cascade below.
function materialize(segments: ClipSegment[]): { text: string; ranges: VerRange[] } {
  let text = "";
  const ranges: VerRange[] = [];
  let group = -1;
  const block = (lines: string[]): string => lines.map((l) => `${l}\n`).join(""); // "L1\nL2\n" | ""
  for (const seg of segments) {
    if (seg.kind === "normal") {
      text += seg.text;
      continue;
    }
    group += 1;
    const f1 = text.length;
    text += `${block(seg.ver1)}\n`; // content + terminal \n
    ranges.push({ from: f1, to: text.length, ver: 1, group });
    const f2 = text.length;
    text += `${block(seg.ver2)}\n`;
    ranges.push({ from: f2, to: text.length, ver: 2, group });
  }
  return { text, ranges };
}

// pos is inside a ver-block (content or terminal) → §2.2.7 п.3b paste-as-is.
function insideVerBlock(ranges: VerRange[], pos: number): boolean {
  return ranges.some((r) => pos >= r.from && pos < r.to);
}

// Build the paste transaction for pasting `text` at the current selection, or null
// to let the default paste run (no group in clipboard / paste into a ver-block §3b
// / paste over a group-spanning selection — DEFERRED). On success: materialize the
// segments at the insertion point, then run the FULL multi-run adjacency cascade
// (the paste tx carries setStructure, so autoResolveFilter skips it — paste must
// resolve its own adjacencies, incl. §2.2.12.1 case 4 two-run). Caret = paste-end.
export function pasteSpec(state: EditorState, text: string): TransactionSpec | null {
  const segments = parseClipboard(text);
  if (!segments.some((s) => s.kind === "group")) return null; // plain → default paste

  const ranges = readStructure(state);
  const sel = state.selection.main;
  const insFrom = sel.from;
  const insTo = sel.to;
  if (insideVerBlock(ranges, insFrom)) return null; // §3b — paste as-is into a ver-block
  // paste-over-a-group-spanning selection is deferred (= selection-delete + paste).
  if (insFrom !== insTo && ranges.some((r) => insFrom <= r.to - 1 && r.to - 1 < insTo)) return null;

  const startDoc = state.doc.toString();
  const mat = materialize(segments);

  // changeA: replace the selection with the materialized model text.
  const csA = ChangeSet.of({ from: insFrom, to: insTo, insert: mat.text }, startDoc.length);
  const newDoc = startDoc.slice(0, insFrom) + mat.text + startDoc.slice(insTo);
  const delta = mat.text.length - (insTo - insFrom);
  // Renumber by from-order: materialize's group ids (0,1,…) collide with the
  // existing groups' ids, which would make allAdjacentRuns conflate them.
  const newRanges = renumberGroups([
    ...ranges
      .filter((r) => r.to <= insFrom || r.from >= insTo) // paste into normal → none span the point
      .map((r) => (r.from >= insTo ? { ...r, from: r.from + delta, to: r.to + delta } : r)),
    ...mat.ranges.map((r) => ({ ...r, from: r.from + insFrom, to: r.to + insFrom })),
  ]);

  const caretNew = insFrom + mat.text.length; // paste-end (in newDoc)
  const cascade = resolveAllAdjacencies(newDoc, newRanges);
  if (!cascade) {
    return {
      changes: csA,
      effects: [
        setStructure.of(toRangeSet(newRanges)),
        resolveCaret.of({ before: insFrom, after: caretNew }),
      ],
      selection: { anchor: caretNew },
      annotations: isolateHistory.of("before"),
      userEvent: "input.paste",
    };
  }
  const csB = ChangeSet.of(cascade.changes, newDoc.length);
  // §5/§6.1 (user 2026-06-20): a paste that TRIGGERS a merge lands the caret on the
  // merge's join-point (the cascade's final caret), NOT paste-end — paste sets
  // paste-end, then the merge replay repositions it. before=insFrom (UNDO → the
  // paste point); only before/after are kept (intermediate paste-end is not).
  const after = cascade.caret;
  void caretNew;
  return {
    changes: csA.compose(csB),
    effects: [
      setStructure.of(toRangeSet(cascade.finalRanges)),
      resolveCaret.of({ before: insFrom, after }),
    ],
    selection: { anchor: after },
    annotations: isolateHistory.of("before"),
    userEvent: "input.paste",
  };
}

// Thin edge: intercept paste of a clipboard that carries a fenced group. Pure
// pasteSpec is the testable core; the DOM paste event (clipboardData.getData) is a
// device-gate (happy-dom can't deliver a real paste into CM6).
export const diffClipboardPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (isTouchOnly(view.state)) return false; // §2.2.14 — read-only: paste disabled (native paste → input.paste → changeFilter blocks)
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return false;
    const spec = pasteSpec(view.state, text);
    if (!spec) return false; // plain paste / into-ver-block / over-selection → default
    view.dispatch(spec);
    event.preventDefault();
    return true;
  },
});
