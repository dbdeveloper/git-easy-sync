// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { makeFilter, splitPieces } from "../../src/log-viewer/log-filter";
import type { LogEntry } from "../../src/log-viewer/log-parse";

// LOG-VIEWER step 4 (spec §2.9-2.10). Columns: date | time | level |
// message (the message column includes the data). Pieces between "|"
// match DIFFERENT columns, in the SAME order, columns may be skipped.
// Switches: case, whole word, regexp. Times in UTC for the tests.

const UTC = { timeZone: "utc" as const };
const e = (level: string, message: string, data?: unknown): LogEntry => ({
  kind: "entry",
  timestamp: "2026-10-07T11:42:03.120Z",
  level,
  message,
  data,
});
const DRAIN = e("INFO", "Sync2 drain done", { pushedCommits: 0, pulled: 453 });
const FAIL = e("ERROR", "BRAT-style reload FAILED", { id: "cmdr" });
const UKR = e("WARN", "Користувач скасував синхронізацію");
const plain = { caseSensitive: false, wholeWord: false, regexp: false };
const ok = (q: string, entry: LogEntry, o = plain) => {
  const f = makeFilter(q, o, UTC);
  if (!f.ok) throw new Error(`unexpected invalid: ${q}`);
  return f.test(entry);
};

describe("splitPieces", () => {
  it("splits on |, trims, drops empty pieces; \\| is a literal |", () => {
    expect(splitPieces(" info | drain done ")).toEqual(["info", "drain done"]);
    expect(splitPieces("| error")).toEqual(["error"]);
    expect(splitPieces("a\\|b | c")).toEqual(["a|b", "c"]);
    expect(splitPieces("")).toEqual([]);
  });
});

describe("makeFilter — columns", () => {
  it("an empty filter lets everything through", () => {
    expect(ok("", DRAIN)).toBe(true);
    expect(ok("   ", FAIL)).toBe(true);
  });

  it("without | a piece may match ANY column", () => {
    expect(ok("2026-10-07", DRAIN)).toBe(true); // date
    expect(ok("info", DRAIN)).toBe(true); // level
    expect(ok("drain", DRAIN)).toBe(true); // message
    expect(ok("pulled", DRAIN)).toBe(true); // data is in the message column
    expect(ok("nowhere", DRAIN)).toBe(false);
  });

  it("🔑 the owner's examples: 2026 | pulled → date … message(data); info | drain done → level | message", () => {
    expect(ok("2026 | pulled", DRAIN)).toBe(true);
    expect(ok("info | drain done", DRAIN)).toBe(true);
  });

  it("🔑 ORDER matters: drain done | info does not match", () => {
    expect(ok("drain done | info", DRAIN)).toBe(false);
  });

  it("🔑 pieces need DIFFERENT columns: drain | done (both only in the message) does not match", () => {
    expect(ok("drain | done", DRAIN)).toBe(false);
  });

  it("columns may be skipped", () => {
    expect(ok("2026 | drain", DRAIN)).toBe(true); // date … message
    expect(ok("11:42 | cmdr", FAIL)).toBe(true); // time … message(data)
  });
});

describe("makeFilter — switches", () => {
  it("case: off by default; on → exact case", () => {
    expect(ok("error", FAIL)).toBe(true);
    expect(ok("error", FAIL, { ...plain, caseSensitive: true })).toBe(false);
    expect(ok("ERROR", FAIL, { ...plain, caseSensitive: true })).toBe(true);
  });

  it("🔑 whole word — Cyrillic words too", () => {
    const ww = { ...plain, wholeWord: true };
    expect(ok("drain", DRAIN, ww)).toBe(true);
    expect(ok("drai", DRAIN, ww)).toBe(false);
    expect(ok("скасував", UKR, ww)).toBe(true);
    expect(ok("скасува", UKR, ww)).toBe(false);
  });

  it("regexp: each piece is its own expression; \\| is alternation inside one", () => {
    const re = { ...plain, regexp: true };
    expect(ok("^warn$ | ^синхрон", UKR, re)).toBe(false); // the message starts with «Користувач»
    expect(ok("^warn$ | синхрон", UKR, re)).toBe(true);
    expect(ok("reload (FAILED\\|done)", FAIL, re)).toBe(true);
    expect(ok("^info$ | drain", FAIL, re)).toBe(false);
  });

  it("regexp + whole word", () => {
    const o = { ...plain, regexp: true, wholeWord: true };
    expect(ok("dra.n", DRAIN, o)).toBe(true);
    expect(ok("dra", DRAIN, o)).toBe(false);
  });

  it("🔑 an invalid regexp does NOT throw: ok=false with a reason", () => {
    const f = makeFilter("drain | (unclosed", { ...plain, regexp: true }, UTC);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.error).toMatch(/invalid/i);
  });

  it("a regexp special character in PLAIN mode is just a character", () => {
    expect(ok("(", e("INFO", "a (b) c"))).toBe(true);
    expect(ok("a.c", e("INFO", "abc"))).toBe(false);
  });

  it("a raw line: its text is the message column, level RAW", () => {
    const raw: LogEntry = { kind: "raw", raw: "garbage here" };
    expect(ok("raw | garbage", raw)).toBe(true);
  });
});
