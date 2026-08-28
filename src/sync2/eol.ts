// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Line-ending (EOL) detection/restoration. Canonical home for the engine
// (src/sync2/, src/worker/cpu-worker.ts) — src/diff2/eol.ts re-exports
// this instead of duplicating it (src/sync2/ must never import from
// src/diff2/, per .claude/rules/diff2-ui.md; the reverse direction is
// fine). Originally written for the diff2 UI's write-back path (bug-59),
// moved here 2026-08-28 when three-way-merge.ts's automatic 3-way merge
// needed the same algorithm (SYNC2-FIX.md §8.2.1 / NEW-DRAIN.md §III
// _diff3 CRLF residual case): merging must restore LOCAL's own dominant
// EOL, not whichever input happens to contain CRLF first.

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

// Any line ending → `\n`. The 2-byte forms FIRST (`\r\n` or `\n\r`) so a CRLF/reverse
// doesn't leave a stray `\r` (or become `\n\n`), then lone `\r`.
export function toLf(s: string): string {
  return s.replace(/\r\n|\n\r/g, "\n").replace(/\r/g, "\n");
}

// `\n` → the target EOL. Inverse of toLf up to the dominant-EOL contract. `lf` is a
// no-op; the input is assumed already-`\n`, so a plain `\n`→EOL replace is exact.
export function restoreEol(s: string, eol: EolStyle): string {
  if (eol === "lf") return s;
  return s.replace(/\n/g, eol === "crlf" ? "\r\n" : "\r");
}

// The single session EOL from two sides' dominant EOLs (diff2 UI write-back, where
// "the two sides" are base-file and sibling-file, not local/base/remote). User's full
// truth table (explicit bytes — priority LF > CR > CRLF, "shorter" wins and LF beats CR
// in the tie): \r\n?\r\n→\r\n · \r\n?\r→\r · \r\n?\n→\n · \r?\r→\r · \r?\n→\n · \n?\n→\n
// So CRLF survives only when BOTH sides are CRLF; a LF side always forces LF; CR beats
// only CRLF. Symmetric. NOT used by three-way-merge.ts (that's a 3-input local/base/
// remote merge, and the decided rule there is "restore local's own EOL", not a blend of
// two sides — see NEW-DRAIN.md §III _diff3 CRLF residual case, 2026-08-28).
export function commonEol(a: EolStyle, b: EolStyle): EolStyle {
  if (a === b) return a;
  if (a === "lf" || b === "lf") return "lf";
  if (a === "cr" || b === "cr") return "cr";
  return "crlf";
}
