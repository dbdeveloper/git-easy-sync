// TODO §17 — the diff-editor's in-body ver-block verbs are mode-aware. Conflict resolves
// ours-vs-theirs (Keep/Apply/Join); History+Deleted restore a version against the ACTUAL file
// (Restore/Keep, no Join). The RESOLVE CHOICES are identical across modes — only labels change —
// so the whole resolve/undo/replay machinery is untouched; this pins that invariant.

import { describe, expect, it } from "vitest";
import { markerButtonsFor } from "../../src/diff2/diff-pane-v2";

type Mode = "conflict" | "history" | "deleted";
const labels = (mode: Mode) => {
  const m = markerButtonsFor(mode);
  return {
    open: m.open.map((b) => b.label),
    mid: m.mid.map((b) => b.label),
    close: m.close.map((b) => b.label),
  };
};
const choices = (mode: Mode) => {
  const m = markerButtonsFor(mode);
  return {
    open: m.open.map((b) => b.choice),
    // drop the conflict-only Join so the comparison is like-for-like
    mid: m.mid.filter((b) => b.choice !== "join").map((b) => b.choice),
    close: m.close.map((b) => b.choice),
  };
};

describe("TODO §17 — in-body marker verbs by mode", () => {
  it("conflict → Keep/Apply, and a Join in the separator", () => {
    const l = labels("conflict");
    expect(l.open).toEqual(["Keep ↓", "Remove ↓"]);
    expect(l.mid).toContain("> Join ↓");
    expect(l.close).toEqual(["Apply ↑", "Remove ↑"]);
  });

  it("history → Restore/Keep, NO Join in the separator", () => {
    const l = labels("history");
    expect(l.open).toEqual(["Restore ↓", "Remove ↓"]);
    expect(l.mid).not.toContain("> Join ↓");
    expect(l.close).toEqual(["Keep ↑", "Remove ↑"]);
  });

  it("deleted verbs are IDENTICAL to history", () => {
    expect(labels("deleted")).toEqual(labels("history"));
  });

  it("undefined mode falls back to conflict verbs", () => {
    expect(labels("conflict")).toEqual({
      open: markerButtonsFor(undefined).open.map((b) => b.label),
      mid: markerButtonsFor(undefined).mid.map((b) => b.label),
      close: markerButtonsFor(undefined).close.map((b) => b.label),
    });
  });

  it("resolve CHOICES are identical across modes — only labels differ", () => {
    expect(choices("history")).toEqual(choices("conflict"));
    expect(choices("deleted")).toEqual(choices("conflict"));
  });
});
