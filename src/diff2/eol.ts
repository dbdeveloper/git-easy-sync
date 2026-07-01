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

export type EolStyle = "lf" | "crlf" | "cr";

// The dominant line ending of `s`. No `\r` at all → "lf". Otherwise whichever of
// crlf / lone-cr / lone-lf occurs most (ties break crlf > cr > lf — the safe order for
// a file that has any `\r`). Uses no lookbehind (mobile Capacitor WebView compat).
export function detectEol(s: string): EolStyle {
  // A 2-byte EOL in EITHER order (`\r\n` or the rare `\n\r`) counts as crlf.
  const crlf = (s.match(/\r\n|\n\r/g) || []).length;
  const totalCr = (s.match(/\r/g) || []).length;
  const totalLf = (s.match(/\n/g) || []).length;
  const crOnly = totalCr - crlf; // lone \r (old Mac)
  const lfOnly = totalLf - crlf; // lone \n (Unix)
  if (crlf === 0 && crOnly === 0) return "lf";
  if (crlf >= crOnly && crlf >= lfOnly) return "crlf";
  if (crOnly >= lfOnly) return "cr";
  return "lf";
}

// Any line ending → `\n` (the model's hardcoded separator). The 2-byte forms FIRST
// (`\r\n` or `\n\r`) so a CRLF/reverse doesn't leave a stray `\r` (or become `\n\n`),
// then lone `\r`.
export function toLf(s: string): string {
  return s.replace(/\r\n|\n\r/g, "\n").replace(/\r/g, "\n");
}

// `\n` → the file's EOL. Inverse of toLf up to the dominant-EOL contract. `lf` is a
// no-op; the input is assumed already-`\n` (model output), so a plain `\n`→EOL replace
// is exact.
export function restoreEol(s: string, eol: EolStyle): string {
  if (eol === "lf") return s;
  return s.replace(/\n/g, eol === "crlf" ? "\r\n" : "\r");
}

// The single session EOL from the two sides' dominant EOLs. User's full truth table
// (explicit bytes — priority LF > CR > CRLF, "shorter" wins and LF beats CR in the tie):
//   \r\n?\r\n→\r\n · \r\n?\r→\r · \r\n?\n→\n · \r?\r→\r · \r?\n→\n · \n?\n→\n
// So CRLF survives only when BOTH sides are CRLF; a LF side always forces LF; CR beats
// only CRLF. Symmetric.
export function commonEol(a: EolStyle, b: EolStyle): EolStyle {
  if (a === b) return a;
  if (a === "lf" || b === "lf") return "lf";
  if (a === "cr" || b === "cr") return "cr";
  return "crlf";
}
