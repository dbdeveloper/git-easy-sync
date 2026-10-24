// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 3 (spec §2.6-2.7): the log as a TEXT table for a
// read-only CodeMirror document.
//
//   -----------+--------------+-------+--------------------------
//   2026-10-07 | 11:42:03.120 | INFO  | Sync2 drain done
//              |              |       | {
//              |              |       |   "pushedCommits": 0
//              |              |       | }
//
// The data is pretty-printed UNDER the message, in the same column
// (owner: "they are, in fact, the message"), and every continuation line
// carries the empty columns on its left — line wrapping is off in the
// viewer, so the columns can only stay aligned if we split lines here.
// The level word is reported as a mark so the view can colour it.
//
// A line that is not a log record is printed AS IS — no columns, no
// level, no separator before it (owner, 2026-10-24): a file in another
// format reads like plain text, and a corrupt line in our log is just a
// line between the entries.

import type { LogEntry } from "./log-parse";

const DATE_W = 10; // 2026-10-07
const TIME_W = 12; // 11:42:03.120
const LEVEL_W = 5; // ERROR

// The separator line carries only the column bars "|", exactly under the
// bars of the rows; the RULE itself is drawn by the view with CSS across
// the full width (owner, 2026-10-08: a fixed run of dashes was too short
// in a wide window and under long messages). "|" and not "+": a "+"
// crossbar sits wherever the font puts it and may miss the rule, while
// "|" spans the whole line height, so the rule always crosses it — and
// the columns run unbroken from top to bottom. Copying turns the line
// back into dashes with "+" at the bars (separatorsAsDashes).
export const SEPARATOR =
  `${" ".repeat(DATE_W + 1)}|${" ".repeat(TIME_W + 2)}|${" ".repeat(LEVEL_W + 2)}|`;

// For the clipboard: every separator line becomes dashes with "+" at the
// bars, as long as the longest copied line, so the table still reads in
// plain text outside Obsidian.
export function separatorsAsDashes(text: string): string {
  const lines = text.split("\n");
  if (!lines.includes(SEPARATOR)) return text;
  const width = Math.max(SEPARATOR.length, ...lines.map((l) => l.length));
  const dashed = SEPARATOR.replace(/ /g, "-").replace(/\|/g, "+").padEnd(width, "-");
  return lines.map((l) => (l === SEPARATOR ? dashed : l)).join("\n");
}

// "Entries may be missing here" — the ring was appended after a file
// it does not overlap (log-parse.ts mergeWithRecent, gap: true).
export const GAP = { kind: "gap" } as const;
export type GapItem = typeof GAP;

export interface LevelMark {
  from: number; // offsets into the text
  to: number;
  level: string;
}

export interface FormatOptions {
  // "local" (default) = the user's own clock; "utc" for tests.
  timeZone?: "local" | "utc";
  // COMPACT mode (owner, 2026-10-24): one entry, one line — the data as
  // one-line JSON after the message, a line break in the message as ⏎,
  // no separators between entries. The columns stay.
  compact?: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad3 = (n: number) => String(n).padStart(3, "0");

function dateTime(iso: string, utc: boolean): { date: string; time: string } {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    // Shown as is (cut to the columns) — never "NaN".
    return { date: iso.slice(0, DATE_W), time: iso.slice(DATE_W, DATE_W + TIME_W) };
  }
  const g = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  return {
    date: `${g[0]}-${pad2(g[1])}-${pad2(g[2])}`,
    time: `${pad2(g[3])}:${pad2(g[4])}:${pad2(g[5])}.${pad3(g[6])}`,
  };
}

// The data as ONE line (compact mode). JSON escapes line breaks inside
// strings, so the result never spans lines.
function dataInline(data: unknown): string {
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

function dataLines(data: unknown): string[] {
  if (data === undefined) return [];
  let json: string;
  try {
    json = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    json = String(data);
  }
  return json.split("\n");
}

// The four columns as TEXT — what the filter (step 4) matches against,
// exactly as drawn: the local date/time, the level, and the message
// column, which holds the data under the message. A line that is not a
// log record has ONE column: its whole text.
export function entryColumns(e: LogEntry, opts: FormatOptions = {}): string[] {
  if (e.kind === "raw") return [e.raw];
  const { date, time } = dateTime(e.timestamp, opts.timeZone === "utc");
  if (opts.compact) return [date, time, e.level, compactMessage(e)];
  const data = dataLines(e.data);
  return [date, time, e.level, [e.message, ...data].join("\n")];
}

// The message column of a compact line: the message with ⏎ for its line
// breaks, then the data as one-line JSON.
function compactMessage(e: Extract<LogEntry, { kind: "entry" }>): string {
  const message = e.message.replace(/\r?\n/g, "⏎");
  return e.data === undefined ? message : `${message} ${dataInline(e.data)}`;
}

const BLANK_PREFIX =
  `${" ".repeat(DATE_W)} | ${" ".repeat(TIME_W)} | ${" ".repeat(LEVEL_W)} | `;

// One entry → its lines (no separator, no trailing newline) and the
// level mark, with offsets relative to this block. Exposed for the live
// tail, which appends one block at a time.
export function formatEntryBlock(
  e: LogEntry,
  opts: FormatOptions = {},
): { text: string; marks: LevelMark[] } {
  if (e.kind === "raw") return { text: e.raw, marks: [] };
  const utc = opts.timeZone === "utc";
  const { date, time } = dateTime(e.timestamp, utc);
  const { level, message, data } = e;
  const head = `${date.padEnd(DATE_W)} | ${time.padEnd(TIME_W)} | `;
  const levelCell = level.slice(0, LEVEL_W).padEnd(LEVEL_W);
  const mark = { from: head.length, to: head.length + Math.min(level.length, LEVEL_W), level };
  if (opts.compact) return { text: `${head}${levelCell} | ${compactMessage(e)}`, marks: [mark] };
  const [first, ...more] = message.split("\n");
  const lines = [
    `${head}${levelCell} | ${first}`,
    ...more.map((l) => BLANK_PREFIX + l),
    ...dataLines(data).map((l) => BLANK_PREFIX + l),
  ];
  const from = head.length;
  return {
    text: lines.join("\n"),
    marks: [{ from, to: from + Math.min(level.length, LEVEL_W), level }],
  };
}

// The whole table: a separator before every log record (not before a
// line printed as is); a GAP item is the "…" line. Marks are shifted to their place in the full text.
export function formatTable(
  items: Array<LogEntry | GapItem>,
  opts: FormatOptions = {},
): { text: string; marks: LevelMark[]; starts: number[] } {
  const parts: string[] = [];
  const marks: LevelMark[] = [];
  // The line each item starts on (its separator, if it has one) — lets
  // the view keep the same entry at the top when the mode is switched.
  const starts: number[] = [];
  let offset = 0;
  let line = 0;
  const push = (s: string) => {
    parts.push(s);
    offset += s.length + 1; // + the "\n" that joins it to the next
    line += s.split("\n").length;
  };
  for (const item of items) {
    starts.push(line);
    if (item.kind === "gap") {
      push("…");
      continue;
    }
    if (item.kind === "entry" && !opts.compact) push(SEPARATOR);
    const b = formatEntryBlock(item, opts);
    for (const m of b.marks) marks.push({ ...m, from: m.from + offset, to: m.to + offset });
    push(b.text);
  }
  return { text: parts.join("\n"), marks, starts };
}
