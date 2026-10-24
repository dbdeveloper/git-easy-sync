// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { LiveFeed, cursorItemLines, renderAppend, renderLog, sameItemLine } from "../../src/log-viewer/log-model";
import { makeFilter } from "../../src/log-viewer/log-filter";
import type { RecentLine } from "../../src/log-viewer/log-parse";
import type { LogEntry } from "../../src/log-viewer/log-parse";

// LOG-VIEWER step 7 (spec §2.13-2.14): new entries appear live. The
// subscription starts BEFORE the file is read; what arrives during the
// read waits, and after the merge only numbers above the last shown one
// pass — no duplicates. Closing the window unsubscribes.

const UTC = { timeZone: "utc" as const };
const r = (seq: number): RecentLine => ({
  seq,
  line: JSON.stringify({ t: "2026-10-07T10:00:00.000Z", l: "INFO", m: `m${seq}` }),
});
const fakeLogger = () => {
  const subs = new Set<(l: RecentLine) => void>();
  return {
    subs,
    subscribe: (fn: (l: RecentLine) => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    emit: (l: RecentLine) => subs.forEach((fn) => fn(l)),
  };
};

describe("LiveFeed", () => {
  it("🔑 lines arriving DURING the read wait; after start only those above lastSeq pass, once", () => {
    const lg = fakeLogger();
    const feed = new LiveFeed(lg.subscribe);
    lg.emit(r(5)); // already in the merge (≤ lastSeq)
    lg.emit(r(6)); // logged after the ring snapshot
    const got: number[] = [];
    feed.start(5, (l) => got.push(l.seq));
    lg.emit(r(6)); // a repeat must not show twice
    lg.emit(r(7));
    expect(got).toEqual([6, 7]);
  });

  it("an empty ring (lastSeq null) lets every line through", () => {
    const lg = fakeLogger();
    const feed = new LiveFeed(lg.subscribe);
    lg.emit(r(1));
    const got: number[] = [];
    feed.start(null, (l) => got.push(l.seq));
    lg.emit(r(2));
    expect(got).toEqual([1, 2]);
  });

  it("🔑 close() unsubscribes — nothing more is delivered", () => {
    const lg = fakeLogger();
    const feed = new LiveFeed(lg.subscribe);
    const got: number[] = [];
    feed.start(null, (l) => got.push(l.seq));
    feed.close();
    lg.emit(r(1));
    expect(got).toEqual([]);
    expect(lg.subs.size).toBe(0);
  });

  it("advanceTo (after a gap re-read replaced the content) skips what the new content holds", () => {
    const lg = fakeLogger();
    const feed = new LiveFeed(lg.subscribe);
    const got: number[] = [];
    feed.start(3, (l) => got.push(l.seq));
    feed.advanceTo(9);
    lg.emit(r(8));
    lg.emit(r(10));
    expect(got).toEqual([10]);
  });
});

describe("renderAppend", () => {
  const none = { caseSensitive: false, wholeWord: false, regexp: false };
  const entry = (level: string, message: string): LogEntry => ({
    kind: "entry",
    timestamp: "2026-10-07T10:00:00.000Z",
    level,
    message,
    data: undefined,
  });
  const pass = (q: string) => {
    const f = makeFilter(q, none, UTC);
    if (!f.ok) throw new Error("bad filter");
    return f.test;
  };

  it("🔑 appending gives the SAME text as rendering everything at once", () => {
    const a = entry("INFO", "first");
    const b = entry("ERROR", "second");
    const base = renderLog([a], "", none, UTC);
    const add = renderAppend(b, pass(""), base.text.length, UTC)!;
    const full = renderLog([a, b], "", none, UTC);
    expect(base.text + add.insert).toBe(full.text);
    const doc = base.text + add.insert;
    expect(add.marks.map((m) => doc.slice(m.from, m.to))).toEqual(["ERROR"]);
  });

  it("into an EMPTY document: no leading newline", () => {
    const add = renderAppend(entry("INFO", "x"), pass(""), 0, UTC)!;
    expect(add.insert.startsWith("\n")).toBe(false);
    expect(add.insert).toBe(renderLog([entry("INFO", "x")], "", none, UTC).text);
  });

  it("🔑 a line that is not a log record is appended as is, without a separator", () => {
    const a = entry("INFO", "first");
    const raw: LogEntry = { kind: "raw", raw: "plain text" };
    const base = renderLog([a], "", none, UTC);
    const add = renderAppend(raw, pass(""), base.text.length, UTC)!;
    expect(add.insert).toBe("\nplain text");
    expect(add.marks).toEqual([]);
    expect(base.text + add.insert).toBe(renderLog([a, raw], "", none, UTC).text);
  });

  it("🔑 compact mode: appending gives the same text as rendering everything, no separator", () => {
    const C = { ...UTC, compact: true };
    const a = entry("INFO", "first");
    const b = entry("ERROR", "second");
    const base = renderLog([a], "", none, C);
    const add = renderAppend(b, pass(""), base.text.length, C)!;
    expect(add.insert).toBe("\n" + renderLog([b], "", none, C).text);
    expect(base.text + add.insert).toBe(renderLog([a, b], "", none, C).text);
  });

  it("🔑 an entry the filter rejects is not appended", () => {
    expect(renderAppend(entry("INFO", "x"), pass("error"), 10, UTC)).toBeNull();
  });
});

// Owner, 2026-10-24: switching compact/expanded keeps the entry that was
// at the top of the screen at the top.
describe("sameItemLine — the entry at the top stays at the top", () => {
  it("🔑 the line of the item that contained the old top line", () => {
    // expanded: items start on lines 0, 5, 6; compact: 0, 1, 2
    expect(sameItemLine([0, 5, 6], [0, 1, 2], 3)).toBe(0); // inside item 0
    expect(sameItemLine([0, 5, 6], [0, 1, 2], 5)).toBe(1);
    expect(sameItemLine([0, 5, 6], [0, 1, 2], 7)).toBe(2);
    expect(sameItemLine([0, 1, 2], [0, 5, 6], 2)).toBe(6); // and back
  });

  it("an empty table → line 0", () => {
    expect(sameItemLine([], [], 4)).toBe(0);
  });
});

// Owner, 2026-10-24: the entry with the cursor (or the start of the
// selection) is the anchor of a mode switch — its FIRST line stays at the
// same height on screen and the cursor lands on that line, so an expanded
// entry "opens downwards" and a compacted one "pulls the rest up".
describe("cursorItemLines — where the cursor's entry is before and after", () => {
  const e = { kind: "entry" } as const;
  const raw = { kind: "raw" } as const;
  const gap = { kind: "gap" } as const;
  // items: entry(3 data lines), raw, gap, entry
  const items = [e, raw, gap, e];
  const compact = { starts: [0, 1, 2, 3], compact: true };
  // expanded: sep0 head1 d2 d3 d4 | raw5 | …6 | sep7 head8
  const expanded = { starts: [0, 5, 6, 7], compact: false };

  it("🔑 compact → expanded: the anchor is the entry's head line, below its separator", () => {
    expect(cursorItemLines(compact, expanded, items, 0)).toEqual({ oldLine: 0, newLine: 1 });
    expect(cursorItemLines(compact, expanded, items, 3)).toEqual({ oldLine: 3, newLine: 8 });
  });

  it("🔑 expanded → compact from ANY line of the entry: the old anchor is its head line", () => {
    for (const l of [0, 1, 2, 3, 4]) {
      expect(cursorItemLines(expanded, compact, items, l)).toEqual({ oldLine: 1, newLine: 0 });
    }
  });

  it("a line that is not a record has no separator in either mode", () => {
    expect(cursorItemLines(compact, expanded, items, 1)).toEqual({ oldLine: 1, newLine: 5 });
    expect(cursorItemLines(expanded, compact, items, 5)).toEqual({ oldLine: 5, newLine: 1 });
  });

  it("an empty view → null", () => {
    expect(cursorItemLines({ starts: [], compact: true }, { starts: [], compact: false }, [], 0)).toBeNull();
  });
});
