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

import type { LogEntry } from "./log-parse";

const DATE_W = 10; // 2026-10-07
const TIME_W = 12; // 11:42:03.120
const LEVEL_W = 5; // ERROR

export const SEPARATOR =
  `${"-".repeat(DATE_W + 1)}+${"-".repeat(TIME_W + 2)}+` +
  `${"-".repeat(LEVEL_W + 2)}+${"-".repeat(40)}`;

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

const BLANK_PREFIX =
  `${" ".repeat(DATE_W)} | ${" ".repeat(TIME_W)} | ${" ".repeat(LEVEL_W)} | `;

// One entry → its lines (no separator, no trailing newline) and the
// level mark, with offsets relative to this block. Exposed for the live
// tail, which appends one block at a time.
export function formatEntryBlock(
  e: LogEntry,
  opts: FormatOptions = {},
): { text: string; marks: LevelMark[] } {
  const utc = opts.timeZone === "utc";
  const { date, time, level, message, data } =
    e.kind === "entry"
      ? { ...dateTime(e.timestamp, utc), level: e.level, message: e.message, data: e.data }
      : { date: "", time: "", level: "RAW", message: e.raw, data: undefined };
  const head = `${date.padEnd(DATE_W)} | ${time.padEnd(TIME_W)} | `;
  const levelCell = level.slice(0, LEVEL_W).padEnd(LEVEL_W);
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

// The whole table: a separator before every entry; a GAP item is the
// "…" line. Marks are shifted to their place in the full text.
export function formatTable(
  items: Array<LogEntry | GapItem>,
  opts: FormatOptions = {},
): { text: string; marks: LevelMark[] } {
  const parts: string[] = [];
  const marks: LevelMark[] = [];
  let offset = 0;
  const push = (s: string) => {
    parts.push(s);
    offset += s.length + 1; // + the "\n" that joins it to the next
  };
  for (const item of items) {
    if (item.kind === "gap") {
      push("…");
      continue;
    }
    push(SEPARATOR);
    const b = formatEntryBlock(item, opts);
    for (const m of b.marks) marks.push({ ...m, from: m.from + offset, to: m.to + offset });
    push(b.text);
  }
  return { text: parts.join("\n"), marks };
}
