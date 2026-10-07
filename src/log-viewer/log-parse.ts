// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 1 (spec §2.14): turn the JSONL log text into entries,
// and recover what the file does not hold yet from the logger's
// in-memory ring.
//
// The file is read WHOLE (the vault adapter has no partial read). The
// logger may be appending while we read, so the text can end in the
// middle of a line. That torn tail is not a line — but the entry is not
// lost: the logger keeps its last lines in a ring, EXACTLY as written to
// the file, and the merge below takes from the ring everything the file
// does not have yet.

export type LogEntry =
  | {
      kind: "entry";
      timestamp: string;
      level: string;
      message: string;
      data: unknown;
    }
  // A line that is not a log record (hand-edited, an old format,
  // corruption). Shown as is, marked — never silently dropped.
  | { kind: "raw"; raw: string };

// One ring slot: the exact line the logger wrote (no trailing newline)
// and its in-memory sequence number.
export interface RecentLine {
  seq: number;
  line: string;
}

export function parseLogLine(line: string): LogEntry {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (
      o !== null &&
      typeof o === "object" &&
      typeof o.timestamp === "string" &&
      typeof o.level === "string" &&
      typeof o.message === "string"
    ) {
      return {
        kind: "entry",
        timestamp: o.timestamp,
        level: o.level,
        message: o.message,
        data: o.additional_data,
      };
    }
  } catch {
    // fall through
  }
  return { kind: "raw", raw: line };
}

// Only COMPLETE lines (terminated by "\n") count. Blank lines are
// skipped; `lines` keeps the exact text for the merge.
export function parseLogText(text: string): { lines: string[]; entries: LogEntry[] } {
  const parts = text.split("\n");
  parts.pop(); // after the last "\n": "" for a complete file, else the torn tail
  const lines = parts.filter((l) => l.length > 0);
  return { lines, entries: lines.map(parseLogLine) };
}

// The ring is a contiguous window over the END of everything the logger
// ever wrote; the file holds its BEGINNING (complete lines). So the ring
// overlaps the file in a prefix-of-ring == suffix-of-file, and whatever
// follows that overlap in the ring is not on disk yet.
//
// The LONGEST such overlap is taken: aligning on the whole common run,
// not on the newest look-alike, is what keeps two byte-identical lines
// from being mistaken for each other.
//
// No overlap at all (the logger wrote more after the read than the ring
// holds, or the ring belongs to an older file) → nothing is added: the
// file is shown as it is, nothing invented, nothing duplicated.
//
// `lastSeq` is the ring's newest number: live entries numbered above it
// are new; at or below it they are already shown.
export function mergeWithRecent(
  fileLines: string[],
  recent: RecentLine[],
): { extra: RecentLine[]; lastSeq: number | null } {
  const lastSeq = recent.length > 0 ? recent[recent.length - 1].seq : null;
  if (recent.length === 0) return { extra: [], lastSeq };
  if (fileLines.length === 0) return { extra: [...recent], lastSeq };
  const maxOverlap = Math.min(recent.length, fileLines.length);
  for (let t = maxOverlap; t >= 1; t--) {
    const fileStart = fileLines.length - t;
    let ok = true;
    for (let k = 0; k < t; k++) {
      if (recent[k].line !== fileLines[fileStart + k]) {
        ok = false;
        break;
      }
    }
    if (ok) return { extra: recent.slice(t), lastSeq };
  }
  return { extra: [], lastSeq };
}
