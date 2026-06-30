import { describe, it, expect } from "vitest";
import {
  writeSetFor,
  openGuard,
  openDescFor,
  alignOpenDescs,
  type OpenEditorDesc,
} from "../../src/diff2/editor-tabs";

// S1 of the panel/editor split (SPLIT-PANEL-EDITOR-FEASIBILITY.md §12). Pure
// core: write-set derivation + open-guard. The Obsidian leaf adapter (S4) is not
// tested here — it has no logic, only the `which`→leaf mapping these results feed.

describe("writeSetFor", () => {
  it("conflict → both base and sibling (pair-atomic commit7Step writes both)", () => {
    expect(writeSetFor("conflict", "Notes/a.md", "Notes/a.conflict-from-X.md")).toEqual([
      "Notes/a.md",
      "Notes/a.conflict-from-X.md",
    ]);
  });

  it("history → only the sibling (current file); base is read-only history", () => {
    expect(writeSetFor("history", "hist-version", "Notes/a.md")).toEqual(["Notes/a.md"]);
  });

  it("deleted → only the base (originalPath); sibling is read-only trash", () => {
    expect(writeSetFor("deleted", "Notes/a.md", "trash-id")).toEqual(["Notes/a.md"]);
  });

  it("compare → both (PROVISIONAL — Compare phase revisits to lock the edit-target only)", () => {
    expect(writeSetFor("compare", "a.md", "b.md")).toEqual(["a.md", "b.md"]);
  });

  it("routes paths through normalizePath so the guard's compare can't miss on a separator mismatch", () => {
    // normalizePath canonicalises separators (here: backslash → forward slash, the
    // one transform observable under both the obsidian mock and the real API). The
    // point is that writeSetFor's output is canonical, so openGuard's string
    // overlap test never misses a real same-file collision (advisor flag #1).
    expect(writeSetFor("conflict", "Notes\\a.md", "Notes\\b.md")).toEqual([
      "Notes/a.md",
      "Notes/b.md",
    ]);
  });
});

describe("openGuard", () => {
  const desc = (autosaveId: string, ...writeSet: string[]): OpenEditorDesc => ({
    autosaveId,
    writeSet,
  });

  it("no open editors → open", () => {
    expect(openGuard([], { autosaveId: "p1", writeSet: ["a.md", "b.md"] })).toEqual({
      action: "open",
    });
  });

  it("same autosaveId already open → focus that leaf (no new tab, no dialog)", () => {
    const open = [desc("p0", "x.md"), desc("p1", "a.md", "b.md")];
    expect(openGuard(open, { autosaveId: "p1", writeSet: ["a.md", "b.md"] })).toEqual({
      action: "focus",
      which: 1,
    });
  });

  it("partial write-set overlap with a DIFFERENT pair → busy dialog naming the shared file", () => {
    const open = [desc("p0", "a.md", "b.md")];
    expect(openGuard(open, { autosaveId: "p1", writeSet: ["b.md", "c.md"] })).toEqual({
      action: "dialog",
      busyFile: "b.md",
      which: 0,
    });
  });

  it("different pair, no overlap → open", () => {
    const open = [desc("p0", "a.md", "b.md")];
    expect(openGuard(open, { autosaveId: "p1", writeSet: ["c.md", "d.md"] })).toEqual({
      action: "open",
    });
  });

  it("same-pair PRECEDENCE — same id wins even when another open editor overlaps", () => {
    // index 0 overlaps on a.md, index 1 is the SAME pair → step (1) wins → focus(1).
    const open = [desc("overlaps", "a.md"), desc("p1", "a.md", "b.md")];
    expect(openGuard(open, { autosaveId: "p1", writeSet: ["a.md", "b.md"] })).toEqual({
      action: "focus",
      which: 1,
    });
  });

  it("multi-overlap → reports the FIRST offending editor (deterministic)", () => {
    const open = [desc("p0", "z.md", "a.md"), desc("p2", "a.md")];
    expect(openGuard(open, { autosaveId: "pX", writeSet: ["a.md"] })).toEqual({
      action: "dialog",
      busyFile: "a.md",
      which: 0,
    });
  });
});

describe("openDescFor (the S4 write-set chokepoint)", () => {
  it("builds the write-set via writeSetFor (normalized) and threads autosaveId", () => {
    // Backslash input → normalized output (proves it goes through writeSetFor, not
    // raw paths — the carry-flag the open-guard depends on).
    expect(openDescFor("conflict", "Notes\\a.md", "Notes\\a.conflict-from-X.md", "id-7")).toEqual({
      autosaveId: "id-7",
      writeSet: ["Notes/a.md", "Notes/a.conflict-from-X.md"],
    });
  });

  it("matches the bare writeSetFor for every origin (single source of truth)", () => {
    for (const origin of ["conflict", "history", "deleted", "compare"] as const) {
      expect(openDescFor(origin, "a.md", "b.md", "x").writeSet).toEqual(
        writeSetFor(origin, "a.md", "b.md"),
      );
    }
  });
});

describe("alignOpenDescs (index-alignment invariant)", () => {
  it("keeps array length + indices (null → inert slot), NEVER drops", () => {
    const a = openDescFor("conflict", "a.md", "a.conflict-from-X.md", "pA");
    const b = openDescFor("conflict", "b.md", "b.conflict-from-Y.md", "pB");
    const aligned = alignOpenDescs([a, null, b]);
    expect(aligned).toHaveLength(3); // NOT 2 — the .filter(Boolean) trap
    expect(aligned[0]).toBe(a);
    expect(aligned[2]).toBe(b);
    // The inert middle slot never matches anything.
    expect(aligned[1]).toEqual({ autosaveId: "", writeSet: [] });
  });

  it("a request matching the LAST real desc resolves which against the aligned (un-filtered) array", () => {
    const a = openDescFor("conflict", "a.md", "a.conflict-from-X.md", "pA");
    const b = openDescFor("conflict", "b.md", "b.conflict-from-Y.md", "pB");
    // Leaf 1 is mid-open (null). The guard's `which` must still point at leaf index 2,
    // which is only true because alignOpenDescs preserved the slot.
    const open = alignOpenDescs([a, null, b]);
    expect(openGuard(open, { autosaveId: "pB", writeSet: b.writeSet })).toEqual({
      action: "focus",
      which: 2,
    });
  });
});
