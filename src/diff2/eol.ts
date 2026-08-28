// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Line-ending (EOL) handling for the diff2 model (bug-59 / DIFF-EDITOR-V2 §…).
//
// The whole diff2 model HARDCODES `\n` as the line separator (incl. the protected
// terminal `\n` per ver-block). CM6 `EditorState.create` ALSO normalizes `\r\n`→`\n`,
// so a CRLF (Windows) or lone-CR (old Mac) file makes the model's ranges (computed on
// the raw `\r\n` string) overflow the shorter CM6 doc → "RangeError: Invalid position N
// in document of length M" (bug-59).
//
// Fix (Option B — bytes stay RAW, model strings are `\n`):
//   - normalize base/sibling to `\n` (toLf) BEFORE they enter the model (so a base
//     with CRLF and a sibling with LF but identical text produce NO spurious diff);
//   - record ONE session EOL — `commonEol(baseEol, siblingEol)` — and restore it on
//     write-back (conflict/history/deleted all have a single write target). The rule
//     picks the SHORTER ending (priority CR > LF > CRLF): CRLF only survives when BOTH
//     sides were CRLF; any CR side forces CR; LF-vs-CRLF forces LF (see commonEol).
//   - snapshots + every git-blob SHA stay byte-exact/raw — no SHA changes.
//
// Contract: one dominant EOL per side → one common session EOL, applied uniformly on
// write-back. A mixed-EOL file is normalized to its dominant style (a deliberate,
// documented change — not byte-for-byte preserved). Compare mode (TWO write targets)
// is deferred (§8, unbuilt) — "which EOL per side" is genuinely ambiguous there.
//
// 2026-08-28: the actual algorithm moved to src/sync2/eol.ts — three-way-merge.ts
// (engine, automatic 3-way merge) needed the identical detection/restoration logic,
// and src/sync2/ may not import from src/diff2/ (.claude/rules/diff2-ui.md). This file
// re-exports the canonical implementation so existing diff2/ imports keep working
// unchanged.
export { type EolStyle, detectEol, toLf, restoreEol, commonEol } from "../sync2/eol";
