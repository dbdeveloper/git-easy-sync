// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { formatEntryBlock, formatTable, SEPARATOR, GAP, separatorsAsDashes } from "../../src/log-viewer/log-format";
import type { LogEntry } from "../../src/log-viewer/log-parse";

// LOG-VIEWER step 3 (spec §2.6-2.7): the log as a TEXT table —
// "date | time | level | message", additional_data pretty-printed under
// the message in the SAME column, continuation lines padded with empty
// columns, a separator between entries, and the level marked for colour.
// Times in UTC here so the tests do not depend on the machine's zone.

const UTC = { timeZone: "utc" as const };
const entry = (over: Partial<Extract<LogEntry, { kind: "entry" }>> = {}): LogEntry => ({
  kind: "entry",
  timestamp: "2026-10-07T11:42:03.120Z",
  level: "INFO",
  message: "Sync2 drain done",
  data: undefined,
  ...over,
});

describe("formatEntryBlock — one entry", () => {
  it("🔑 the owner's layout: date | time | level | message", () => {
    expect(formatEntryBlock(entry(), UTC).text).toBe(
      "2026-10-07 | 11:42:03.120 | INFO  | Sync2 drain done",
    );
  });

  it("🔑 data goes UNDER the message, pretty-printed, with empty columns on the left", () => {
    const b = formatEntryBlock(entry({ data: { pushedCommits: 0, pulled: 2 } }), UTC);
    expect(b.text.split("\n")).toEqual([
      "2026-10-07 | 11:42:03.120 | INFO  | Sync2 drain done",
      "           |              |       | {",
      '           |              |       |   "pushedCommits": 0,',
      '           |              |       |   "pulled": 2',
      "           |              |       | }",
    ]);
  });

  it("a scalar or empty data is one line; a multi-line message keeps its columns too", () => {
    expect(formatEntryBlock(entry({ data: null }), UTC).text.split("\n")[1]).toBe(
      "           |              |       | null",
    );
    expect(formatEntryBlock(entry({ message: "a\nb" }), UTC).text.split("\n")).toEqual([
      "2026-10-07 | 11:42:03.120 | INFO  | a",
      "           |              |       | b",
    ]);
  });

  it("🔑 the level is marked for colour — exactly the level word", () => {
    for (const level of ["INFO", "WARN", "ERROR"]) {
      const b = formatEntryBlock(entry({ level }), UTC);
      expect(b.marks).toHaveLength(1);
      const m = b.marks[0];
      expect(b.text.slice(m.from, m.to)).toBe(level);
      expect(m.level).toBe(level);
    }
  });

  it("a raw (corrupt) line: empty date/time, level RAW, the text as the message", () => {
    const b = formatEntryBlock({ kind: "raw", raw: "not json" }, UTC);
    expect(b.text).toBe("           |              | RAW   | not json");
    expect(b.marks[0].level).toBe("RAW");
  });

  it("an unreadable timestamp is shown as is, never as NaN", () => {
    const b = formatEntryBlock(entry({ timestamp: "garbage" }), UTC);
    expect(b.text).not.toMatch(/NaN/);
    expect(b.text).toContain("garbage");
  });

  it("local time is the default (the user's zone), UTC on request", () => {
    const local = formatEntryBlock(entry()).text;
    const d = new Date("2026-10-07T11:42:03.120Z");
    const hh = String(d.getHours()).padStart(2, "0");
    expect(local).toContain(`| ${hh}:42:03.120 |`);
  });
});

describe("formatTable — the whole log", () => {
  it("🔑 a separator before every entry; marks shifted to their place in the whole text", () => {
    const t = formatTable([entry({ message: "a" }), entry({ level: "ERROR", message: "b" })], UTC);
    const lines = t.text.split("\n");
    expect(lines[0]).toBe(SEPARATOR);
    expect(lines[1]).toContain("| INFO  | a");
    expect(lines[2]).toBe(SEPARATOR);
    expect(lines[3]).toContain("| ERROR | b");
    expect(t.marks.map((m) => t.text.slice(m.from, m.to))).toEqual(["INFO", "ERROR"]);
  });

  it("the separator lines up with the column bars", () => {
    const row = formatEntryBlock(entry(), UTC).text;
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "|") expect(SEPARATOR[i]).toBe("+");
    }
  });

  // Owner, 2026-10-08: a fixed run of dashes was too short in a wide
  // window and under long messages. The separator line now carries only
  // the "+" junctions; the view draws the rule across the full width with
  // CSS. Copying turns it back into dashes so the text reads elsewhere.
  it("🔑 the separator is only spaces and '+' — the rule itself is drawn by the view", () => {
    expect(SEPARATOR).toMatch(/^[ +]+$/);
    expect(SEPARATOR.endsWith("+")).toBe(true);
  });

  it("🔑 copying: separators become dashes as long as the longest copied line, '+' kept", () => {
    const t = formatTable([entry({ message: "a much longer message than the separator itself" })], UTC).text;
    const copied = separatorsAsDashes(t);
    const lines = copied.split("\n");
    const longest = Math.max(...lines.map((l) => l.length));
    expect(lines[0]).toMatch(/^[-+]+$/);
    expect(lines[0]).toHaveLength(longest);
    for (let i = 0; i < SEPARATOR.length; i++) {
      if (SEPARATOR[i] === "+") expect(lines[0][i]).toBe("+");
    }
    expect(lines[1]).toBe(t.split("\n")[1]); // other lines untouched
  });

  it("copying text without separators changes nothing", () => {
    expect(separatorsAsDashes("just | text")).toBe("just | text");
  });

  it("a GAP item draws the gap marker line", () => {
    const t = formatTable([entry({ message: "file" }), GAP, entry({ message: "ring" })], UTC);
    expect(t.text.split("\n")).toContain("…");
  });

  it("an empty log is empty text", () => {
    expect(formatTable([], UTC)).toEqual({ text: "", marks: [] });
  });
});
