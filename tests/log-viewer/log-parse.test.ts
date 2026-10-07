// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import {
  parseLogText,
  parseLogLine,
  mergeWithRecent,
  type RecentLine,
} from "../../src/log-viewer/log-parse";

// LOG-VIEWER §2.14, step 1: the file is read whole; a torn tail (the
// logger appending while we read) is not thrown away — it comes back
// from the logger's in-memory ring of exact lines.

const line = (ts: string, msg: string, data?: unknown): string =>
  JSON.stringify({ timestamp: ts, level: "INFO", message: msg, additional_data: data });
const L1 = line("2026-10-07T10:00:00.000Z", "one");
const L2 = line("2026-10-07T10:00:01.000Z", "two", { n: 2 });
const L3 = line("2026-10-07T10:00:02.000Z", "three");
const L4 = line("2026-10-07T10:00:03.000Z", "four");
const rec = (seq: number, l: string): RecentLine => ({ seq, line: l });

describe("parseLogText / parseLogLine", () => {
  it("complete lines become entries, in file order", () => {
    const r = parseLogText(`${L1}\n${L2}\n`);
    expect(r.lines).toEqual([L1, L2]);
    expect(r.entries.map((e) => e.kind === "entry" && e.message)).toEqual(["one", "two"]);
    expect(r.entries[1]).toMatchObject({ kind: "entry", level: "INFO", data: { n: 2 } });
  });

  it("a torn tail (no trailing newline) is NOT a line", () => {
    const r = parseLogText(`${L1}\n${L2}\n${L3.slice(0, 20)}`);
    expect(r.lines).toEqual([L1, L2]);
  });

  it("an empty file → nothing; blank lines are skipped", () => {
    expect(parseLogText("").lines).toEqual([]);
    expect(parseLogText(`${L1}\n\n${L2}\n`).entries).toHaveLength(2);
  });

  it("a corrupt line in the middle is kept as RAW, marked — never dropped", () => {
    const r = parseLogText(`${L1}\nnot json at all\n${L2}\n`);
    expect(r.entries.map((e) => e.kind)).toEqual(["entry", "raw", "entry"]);
    expect(r.entries[1]).toEqual({ kind: "raw", raw: "not json at all" });
  });

  it("JSON that is not a log record (no timestamp/level/message) is raw too", () => {
    expect(parseLogLine('{"a":1}')).toEqual({ kind: "raw", raw: '{"a":1}' });
  });

  it("a record without additional_data has data undefined", () => {
    const e = parseLogLine(line("2026-10-07T10:00:00.000Z", "bare"));
    expect(e).toMatchObject({ kind: "entry", message: "bare", data: undefined });
  });
});

describe("mergeWithRecent — the torn tail comes back from the logger's ring", () => {
  it("🔑 the torn last line is RECOVERED from the ring", () => {
    const file = parseLogText(`${L1}\n${L2}\n${L3.slice(0, 15)}`);
    const m = mergeWithRecent(file.lines, [rec(1, L1), rec(2, L2), rec(3, L3)]);
    expect(m.extra.map((r) => r.line)).toEqual([L3]);
    expect(m.lastSeq).toBe(3);
  });

  it("🔑 entries created WHILE we read appear exactly once", () => {
    const file = parseLogText(`${L1}\n${L2}\n`);
    const m = mergeWithRecent(file.lines, [rec(1, L1), rec(2, L2), rec(3, L3), rec(4, L4)]);
    expect(m.extra.map((r) => r.line)).toEqual([L3, L4]);
    expect(m.lastSeq).toBe(4);
  });

  it("the file already holds everything → nothing extra, lastSeq = the ring's newest", () => {
    const m = mergeWithRecent([L1, L2], [rec(7, L1), rec(8, L2)]);
    expect(m.extra).toEqual([]);
    expect(m.lastSeq).toBe(8);
  });

  it("an empty file + a ring → the whole ring", () => {
    const m = mergeWithRecent([], [rec(1, L1), rec(2, L2)]);
    expect(m.extra.map((r) => r.line)).toEqual([L1, L2]);
  });

  it("an empty ring (logger just started) → nothing extra, lastSeq null", () => {
    expect(mergeWithRecent([L1], [])).toEqual({ extra: [], lastSeq: null });
  });

  it("🔑 NO overlap with the ring (more written than it holds) → file only, no invented lines, no duplicates", () => {
    const m = mergeWithRecent([L1], [rec(5, L3), rec(6, L4)]);
    expect(m.extra).toEqual([]);
    expect(m.lastSeq).toBe(6); // later live entries start after the ring
  });

  it("🔑 IDENTICAL lines in the ring: the overlap is aligned on the whole tail, not the last look-alike", () => {
    // ring: [L1, L2, L1'] where L1' is a byte-identical repeat of L1 not yet
    // on disk. File ends with L1 (preceded by nothing the ring holds before
    // it). Matching only the newest "L1" would swallow L2 and the repeat.
    const m = mergeWithRecent([L1], [rec(1, L1), rec(2, L2), rec(3, L1)]);
    expect(m.extra.map((r) => r.seq)).toEqual([2, 3]);
  });

  it("…and with more context the newest consistent alignment wins", () => {
    // file: L1 L2 L1 — the repeat IS on disk; nothing extra.
    const m = mergeWithRecent([L1, L2, L1], [rec(1, L1), rec(2, L2), rec(3, L1)]);
    expect(m.extra).toEqual([]);
  });
});
