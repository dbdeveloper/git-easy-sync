// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 6 — the testable half of the window. The view
// (log-viewer-view.ts) only draws what these return.
//
// openLog: stat-limited read (log-load) → parse (log-parse) → merge with
// the logger's ring, with a GAP item where the ring does not overlap.
// renderLog: filter (log-filter) → table text + level marks (log-format)
// + "N of M".

import { loadLogText, type LogFileAdapter } from "./log-load";
import {
  mergeWithRecent,
  parseLogLine,
  parseLogText,
  type LogEntry,
  type RecentLine,
} from "./log-parse";
import {
  formatEntryBlock,
  formatTable,
  GAP,
  SEPARATOR,
  type FormatOptions,
  type GapItem,
  type LevelMark,
} from "./log-format";
import { makeFilter, type FilterOptions } from "./log-filter";

export type LogItem = LogEntry | GapItem;

export type OpenResult =
  | { kind: "ok"; items: LogItem[]; gap: boolean; lastSeq: number | null }
  | { kind: "too-big"; size: number }
  | { kind: "error"; reason: string };

export async function openLog(
  adapter: LogFileAdapter,
  path: string,
  logger: { recentLines(): RecentLine[] },
): Promise<OpenResult> {
  const loaded = await loadLogText(adapter, path);
  if (loaded.kind !== "ok") return loaded;
  const file = parseLogText(loaded.text);
  const m = mergeWithRecent(file.lines, logger.recentLines());
  const items: LogItem[] = [...file.entries];
  if (m.gap) items.push(GAP);
  for (const r of m.extra) items.push(parseLogLine(r.line));
  return { kind: "ok", items, gap: m.gap, lastSeq: m.lastSeq };
}

export interface RenderResult {
  text: string;
  marks: LevelMark[];
  shown: number; // entries after the filter (gap markers not counted)
  total: number;
  error: string | null; // "invalid expression: …" — everything is shown then
}

export function renderLog(
  items: LogItem[],
  query: string,
  switches: FilterOptions,
  format: FormatOptions = {},
): RenderResult {
  const f = makeFilter(query, switches, format);
  const keep = f.ok ? f.test : () => true;
  const total = items.filter((i) => i.kind !== "gap").length;
  const filtered: LogItem[] = [];
  for (const item of items) {
    if (item.kind === "gap") {
      filtered.push(item);
    } else if (keep(item)) {
      filtered.push(item);
    }
  }
  // A gap marker means "something may be missing BETWEEN these" — with
  // nothing shown on one side it would only dangle.
  const tidy = filtered.filter(
    (it, i) =>
      it.kind !== "gap" ||
      (filtered.slice(0, i).some((x) => x.kind !== "gap") &&
        filtered.slice(i + 1).some((x) => x.kind !== "gap")),
  );
  const table = formatTable(tidy, format);
  return {
    text: table.text,
    marks: table.marks,
    shown: tidy.filter((i) => i.kind !== "gap").length,
    total,
    error: f.ok ? null : f.error,
  };
}

// ── step 7: live tail (spec §2.13-2.14) ────────────────────────────────

// The viewer's subscription to the logger. It is created BEFORE the file
// is read: lines that arrive during the read wait in `pending`. start()
// is called after the merge with the ring's newest number (`lastSeq`)
// and lets through only lines above it — so a line that the merge
// already took from the ring never shows twice. close() unsubscribes.
export class LiveFeed {
  private pending: RecentLine[] = [];
  private lastSeq: number | null = null;
  private sink: ((l: RecentLine) => void) | null = null;
  private started = false;
  private readonly off: () => void;

  constructor(subscribe: (fn: (l: RecentLine) => void) => () => void) {
    this.off = subscribe((l) => this.onLine(l));
  }

  start(lastSeq: number | null, sink: (l: RecentLine) => void): void {
    this.lastSeq = lastSeq;
    this.sink = sink;
    this.started = true;
    const waiting = this.pending;
    this.pending = [];
    for (const l of waiting) this.onLine(l);
  }

  // A re-read (after a gap) replaced the content with a merge that
  // reaches `seq`: skip lines at or below it from now on.
  advanceTo(seq: number | null): void {
    if (seq !== null && (this.lastSeq === null || seq > this.lastSeq)) this.lastSeq = seq;
  }

  close(): void {
    this.off();
    this.sink = null;
    this.pending = [];
  }

  private onLine(l: RecentLine): void {
    if (!this.started) {
      this.pending.push(l);
      return;
    }
    if (this.lastSeq !== null && l.seq <= this.lastSeq) return;
    this.lastSeq = l.seq;
    this.sink?.(l);
  }
}

// One new entry for the end of the document — the same text renderLog
// would give for the whole list (separator, block), or null when the
// current filter rejects it. Marks are absolute in the document after
// the insert.
export function renderAppend(
  entry: LogEntry,
  passes: (e: LogEntry) => boolean,
  docLength: number,
  format: FormatOptions = {},
): { insert: string; marks: LevelMark[] } | null {
  if (!passes(entry)) return null;
  const lead = docLength === 0 ? "" : "\n";
  const block = formatEntryBlock(entry, format);
  const head = `${lead}${SEPARATOR}\n`;
  const start = docLength + head.length;
  return {
    insert: head + block.text,
    marks: block.marks.map((m) => ({ ...m, from: m.from + start, to: m.to + start })),
  };
}
