import { describe, it, expect } from "vitest";
import {
  isEphemeralAutosaveId,
  historyDeletedOrphans,
  isLayoutRestoreFresh,
  layoutForRestore,
} from "../../src/diff2/history-deleted-lifecycle";

describe("isEphemeralAutosaveId", () => {
  it("true for history-/deleted- ids", () => {
    expect(isEphemeralAutosaveId("history-abc")).toBe(true);
    expect(isEphemeralAutosaveId("deleted-abc")).toBe(true);
  });
  it("false for conflict/compare ids", () => {
    expect(isEphemeralAutosaveId("tracked-abc")).toBe(false);
    expect(isEphemeralAutosaveId("synthetic-abc")).toBe(false);
    expect(isEphemeralAutosaveId("compare-abc")).toBe(false);
  });
});

describe("historyDeletedOrphans (B1 sweep)", () => {
  it("wipes ephemeral dirs with no live tab; keeps live ones", () => {
    const dirs = ["history-a", "history-b", "deleted-c", "tracked-x"];
    const live = new Set(["history-b"]);
    expect(historyDeletedOrphans(dirs, live)).toEqual(["history-a", "deleted-c"]);
  });
  it("NEVER returns a conflict/compare dir, even if not live", () => {
    const dirs = ["tracked-x", "synthetic-y", "compare-z"];
    expect(historyDeletedOrphans(dirs, new Set())).toEqual([]);
  });
  it("empty inputs → []", () => {
    expect(historyDeletedOrphans([], new Set())).toEqual([]);
  });
  it("order-preserving", () => {
    const dirs = ["deleted-2", "history-1", "deleted-0"];
    expect(historyDeletedOrphans(dirs, new Set())).toEqual([
      "deleted-2",
      "history-1",
      "deleted-0",
    ]);
  });
});

describe("isLayoutRestoreFresh (TTL)", () => {
  const TTL = 30_000;
  it("fresh: gap under TTL → true", () => {
    expect(isLayoutRestoreFresh(1000, 1000 + 5_000, TTL)).toBe(true);
    expect(isLayoutRestoreFresh(1000, 1000, TTL)).toBe(true); // instant
  });
  it("stale: gap >= TTL → false (deliberate long disable)", () => {
    expect(isLayoutRestoreFresh(1000, 1000 + 30_000, TTL)).toBe(false);
    expect(isLayoutRestoreFresh(1000, 1000 + 10 * 60_000, TTL)).toBe(false);
  });
  it("future savedAt (clock skew) → false", () => {
    expect(isLayoutRestoreFresh(5000, 1000, TTL)).toBe(false);
  });
});

// Owner, 2026-10-31 (B): after a plugin disable+enable the [Commit] ribbon
// icon jumped to the top and a drag-reorder was lost. The fast-reload
// snapshot (getLayout) carries "left-ribbon"; changeLayout re-applied that
// STALE icon order (Obsidian sorts an id missing from it to the top). The
// restore is for our WINDOWS only — the ribbon order stays as it is now.
describe("layoutForRestore — windows only, never the ribbon order", () => {
  it("🔑 drops left-ribbon, keeps every window part", () => {
    const snap = {
      main: { id: "m" },
      left: { id: "l" },
      right: { id: "r" },
      "left-ribbon": { hiddenItems: { "git-easy-sync:Commit local changes": false } },
      active: "x",
    };
    const out = layoutForRestore(snap) as Record<string, unknown>;
    expect(out["left-ribbon"]).toBeUndefined();
    expect(out).toEqual({ main: { id: "m" }, left: { id: "l" }, right: { id: "r" }, active: "x" });
    expect(snap["left-ribbon"]).toBeDefined(); // the saved snapshot itself is untouched
  });
});
