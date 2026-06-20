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
import type { EditorState, Text } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure } from "./diff-structure";

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

// Does the selection include any ver-block terminal \n? (Mirror of
// diff-auto-resolve's check — a terminal-spanning selection is group-atomic, so
// every touched group is wholly inside it.) Within-one-ver-block selections never
// include a terminal (§2.2.4 p5a) → plain copy.
function spansTerminal(from: number, to: number, ranges: VerRange[]): boolean {
  if (from === to) return false;
  return ranges.some((r) => from <= r.to - 1 && r.to - 1 < to);
}

// The clipboard text for the current selection, or null to let the default copy
// run (empty / within-one-ver-block selection → plain text, §2.2.7 п.1). Walks the
// selection in document order: normal gaps verbatim, each wholly-contained group
// as a fenced block. (EOL-less last group falls out of contentLines — no isLast
// flag needed: the content itself is EOL-less.)
export function copyClipboardText(state: EditorState): string | null {
  const sel = state.selection.main;
  const ranges = readStructure(state);
  if (!spansTerminal(sel.from, sel.to, ranges)) return null;

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

  let out = "";
  let pos = sel.from;
  for (const g of groups) {
    if (g.v2.to <= sel.from || g.v1.from >= sel.to) continue; // group outside selection
    if (g.v1.from > pos) out += state.doc.sliceString(pos, g.v1.from); // normal gap verbatim
    out += serializeGroup(verContent(state.doc, g.v1), verContent(state.doc, g.v2));
    pos = g.v2.to;
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
    const text = copyClipboardText(view.state);
    if (text === null) return false; // default plain copy
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    return true;
  },
  cut(event, view) {
    const text = copyClipboardText(view.state);
    if (text === null) return false; // within-block → default cut
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault(); // serialize-correct; deletion deferred to the cut step
    return true;
  },
});
