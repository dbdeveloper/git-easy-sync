// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { openLog, renderLog } from "../../src/log-viewer/log-model";
import { GAP } from "../../src/log-viewer/log-format";
import type { LogEntry } from "../../src/log-viewer/log-parse";

// LOG-VIEWER step 6, the testable half of the window: open (stat-limited
// read + merge with the logger's ring + gap) and render (filter → table
// text + marks + "N of M").

const UTC = { timeZone: "utc" as const };
const line = (ts: string, msg: string, level = "INFO") =>
  JSON.stringify({ timestamp: ts, level, message: msg });
const A = line("2026-10-07T10:00:00.000Z", "alpha");
const B = line("2026-10-07T10:00:01.000Z", "beta", "ERROR");
const C = line("2026-10-07T10:00:02.000Z", "gamma");
const fs = (text: string | null, size?: number) => ({
  stat: async () => (text === null ? null : { size: size ?? text.length }),
  read: async () => text ?? "",
});
const ring = (...lines: string[]) => ({
  recentLines: () => lines.map((l, i) => ({ seq: i + 1, line: l })),
});

describe("openLog", () => {
  it("🔑 a torn read is completed from the ring", async () => {
    const r = await openLog(fs(`${A}\n${B}\n${C.slice(0, 12)}`), "x.log", ring(A, B, C));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.items.map((i) => i.kind === "entry" && i.message)).toEqual(["alpha", "beta", "gamma"]);
    expect(r.gap).toBe(false);
    expect(r.lastSeq).toBe(3);
  });

  it("a newer ring with no overlap → a GAP item between file and ring", async () => {
    const r = await openLog(fs(`${A}\n`), "x.log", ring(C));
    if (r.kind !== "ok") throw new Error("not ok");
    expect(r.gap).toBe(true);
    expect(r.items[1]).toBe(GAP);
  });

  it("too big → too-big, nothing parsed", async () => {
    const r = await openLog(fs("x", 11 * 1024 * 1024), "x.log", ring());
    expect(r).toEqual({ kind: "too-big", size: 11 * 1024 * 1024 });
  });

  it("no file and an empty ring → an empty log", async () => {
    const r = await openLog(fs(null), "x.log", ring());
    expect(r).toMatchObject({ kind: "ok", items: [], gap: false, lastSeq: null });
  });
});

describe("renderLog", () => {
  const items: Array<LogEntry | typeof GAP> = [
    { kind: "entry", timestamp: "2026-10-07T10:00:00.000Z", level: "INFO", message: "alpha", data: undefined },
    { kind: "entry", timestamp: "2026-10-07T10:00:01.000Z", level: "ERROR", message: "beta", data: { x: 1 } },
    GAP,
    { kind: "entry", timestamp: "2026-10-07T10:00:02.000Z", level: "INFO", message: "gamma", data: undefined },
  ];
  const none = { caseSensitive: false, wholeWord: false, regexp: false };

  it("no filter: everything, 'N of M' counts entries only (not the gap)", () => {
    const v = renderLog(items, "", none, UTC);
    expect(v.shown).toBe(3);
    expect(v.total).toBe(3);
    expect(v.error).toBeNull();
    expect(v.text).toContain("alpha");
    expect(v.text).toContain("…");
  });

  it("🔑 the filter DROPS entries; marks belong to what is shown", () => {
    const v = renderLog(items, "error", none, UTC);
    expect(v.shown).toBe(1);
    expect(v.text).toContain("beta");
    expect(v.text).not.toContain("alpha");
    expect(v.marks.map((m) => v.text.slice(m.from, m.to))).toEqual(["ERROR"]);
  });

  it("a gap with nothing shown on one side is dropped (no dangling '…')", () => {
    const v = renderLog(items, "gamma", none, UTC);
    expect(v.text).not.toContain("…");
  });

  it("🔑 an invalid regexp shows EVERYTHING and reports the error", () => {
    const v = renderLog(items, "(", { ...none, regexp: true }, UTC);
    expect(v.shown).toBe(3);
    expect(v.error).toMatch(/invalid/i);
  });
});
