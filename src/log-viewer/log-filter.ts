// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 4 (spec §2.9-2.10): the filter. It DROPS entries that
// do not match; search (CodeMirror's own) then works inside what is left.
//
// Syntax (owner, 2026-10-07): pieces separated by "|" must match
// DIFFERENT columns, in the SAME left-to-right order; columns may be
// skipped. Without "|" a piece may match any column. Columns: date |
// time | level | message — the message column holds the data too.
//   "2026 | pulled"      → date … message
//   "info | drain done"  → level | message
//   "drain done | info"  → no: order matters
// "\|" is a literal "|" inside a piece — in regexp mode that makes it
// alternation within one expression.
//
// Switches, as in the search: case, whole word, regexp. An invalid
// regexp never throws: the caller gets { ok: false } and shows "invalid
// expression", letting everything through.

import type { LogEntry } from "./log-parse";
import { entryColumns, type FormatOptions } from "./log-format";

export interface FilterOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export type Filter =
  | { ok: true; test: (e: LogEntry) => boolean }
  | { ok: false; error: string };

export function splitPieces(query: string): string[] {
  const pieces: string[] = [];
  let cur = "";
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === "\\" && query[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (c === "|") {
      pieces.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  pieces.push(cur);
  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

// A letter, digit or underscore in ANY script — `\b` knows only ASCII,
// and the plugin's users write Cyrillic.
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const isWordChar = (c: string | undefined) => c !== undefined && WORD_CHAR.test(c);

function plainMatcher(piece: string, o: FilterOptions): (text: string) => boolean {
  const needle = o.caseSensitive ? piece : piece.toLowerCase();
  return (text) => {
    const hay = o.caseSensitive ? text : text.toLowerCase();
    if (!o.wholeWord) return hay.includes(needle);
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
      if (!isWordChar(hay[at - 1]) && !isWordChar(hay[at + needle.length])) return true;
    }
    return false;
  };
}

function regexpMatcher(piece: string, o: FilterOptions): (text: string) => boolean {
  // "m": ^ and $ per line — the message column spans the data lines.
  // "u" only with whole word, where \p{…} needs it; without it a user's
  // expression keeps the lenient escapes they are used to.
  const flags = `m${o.caseSensitive ? "" : "i"}${o.wholeWord ? "u" : ""}`;
  const source = o.wholeWord
    ? `(?<![\\p{L}\\p{N}_])(?:${piece})(?![\\p{L}\\p{N}_])`
    : piece;
  const re = new RegExp(source, flags); // throws on an invalid piece
  return (text) => re.test(text);
}

export function makeFilter(
  query: string,
  o: FilterOptions,
  format: FormatOptions = {},
): Filter {
  const pieces = splitPieces(query);
  if (pieces.length === 0) return { ok: true, test: () => true };
  let matchers: Array<(text: string) => boolean>;
  try {
    matchers = pieces.map((p) => (o.regexp ? regexpMatcher(p, o) : plainMatcher(p, o)));
  } catch (err) {
    return { ok: false, error: `invalid expression: ${(err as Error).message}` };
  }
  return {
    ok: true,
    test: (e) => {
      const cols = entryColumns(e, format);
      // Greedy, left to right: each piece takes the FIRST column after
      // the previous piece's that it matches. Earliest-first is enough
      // to decide whether an in-order assignment exists.
      let col = 0;
      for (const m of matchers) {
        while (col < cols.length && !m(cols[col])) col += 1;
        if (col === cols.length) return false;
        col += 1;
      }
      return true;
    },
  };
}
