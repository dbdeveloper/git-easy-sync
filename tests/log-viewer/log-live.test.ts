// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { LiveFeed, renderAppend, renderLog } from "../../src/log-viewer/log-model";
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
  line: JSON.stringify({ timestamp: "2026-10-07T10:00:00.000Z", level: "INFO", message: `m${seq}` }),
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

  it("🔑 an entry the filter rejects is not appended", () => {
    expect(renderAppend(entry("INFO", "x"), pass("error"), 10, UTC)).toBeNull();
  });
});
