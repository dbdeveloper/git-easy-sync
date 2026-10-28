// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import FolderJournal from "../../src/sync2/folder-journal";

// GITKEEP I11-I14, I21 (docs/tasks/GITKEEP.md): the folder journal is an
// in-memory SET of folders worth a look at the next commit — never an
// event log. A folder whose ancestor is already marked is not added; a
// folder that is added drops its marked descendants.
describe("FolderJournal — marks, ancestor collapse", () => {
  const sorted = (j: FolderJournal) => [...j.paths()].sort();

  it("marks folders; marking twice is one mark", () => {
    const j = new FolderJournal();
    j.mark("notes");
    j.mark("notes");
    j.mark("a/b");
    expect(sorted(j)).toEqual(["a/b", "notes"]);
    expect(j.size).toBe(2);
  });

  it("🔑 a folder under a marked ancestor (at ANY depth) is not added", () => {
    const j = new FolderJournal();
    j.mark("notes");
    j.mark("notes/sub");
    j.mark("notes/sub/deeper/still");
    expect(sorted(j)).toEqual(["notes"]);
  });

  it("🔑 a marked ancestor drops every marked descendant", () => {
    const j = new FolderJournal();
    j.mark("notes/a");
    j.mark("notes/b/c");
    j.mark("other");
    j.mark("notes");
    expect(sorted(j)).toEqual(["notes", "other"]);
  });

  it("a sibling that merely shares a name prefix is not a descendant", () => {
    const j = new FolderJournal();
    j.mark("notes");
    j.mark("notes2");
    j.mark("notes-old/x");
    expect(sorted(j)).toEqual(["notes", "notes-old/x", "notes2"]);
  });

  it("the root is never a folder of the journal", () => {
    const j = new FolderJournal();
    j.mark("");
    j.mark("/");
    expect(j.size).toBe(0);
  });

  it("paths are normalized: no leading or trailing slash", () => {
    const j = new FolderJournal();
    j.mark("/notes/");
    j.mark("notes/sub/");
    expect(sorted(j)).toEqual(["notes"]);
  });
});

describe("FolderJournal — the commit's snapshot (I21)", () => {
  it("🔑 take() hands the marks over and leaves an EMPTY journal behind", () => {
    const j = new FolderJournal();
    j.mark("a");
    j.mark("b/c");
    const snap = j.take();
    expect([...snap].sort()).toEqual(["a", "b/c"]);
    expect(j.size).toBe(0);
  });

  it("🔑 marks made during the commit survive — they go to the new set", () => {
    const j = new FolderJournal();
    j.mark("a");
    const snap = j.take();
    j.mark("a/inner"); // an event while the commit runs
    expect([...snap]).toEqual(["a"]);
    expect([...j.paths()]).toEqual(["a/inner"]);
  });

  it("🔑 a failed commit puts the snapshot back, through the same collapse", () => {
    const j = new FolderJournal();
    j.mark("a");
    j.mark("x/y");
    const snap = j.take();
    j.mark("a/inner"); // arrived during the failed commit
    j.mark("x"); // ...and an ancestor of a snapshot folder
    j.restore(snap);
    expect([...j.paths()].sort()).toEqual(["a", "x"]);
  });
});

describe("FolderJournal — cost grows with the input, not its square (I14)", () => {
  // Realistic maximum 2000 folders (owner, 2026-10-28); 20 000 is the
  // 10x check. Every shape must stay linear-ish: marking N folders may
  // not scan the whole set per mark.
  const time = (fn: () => void): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };
  const topLevel = (n: number) => () => {
    const j = new FolderJournal();
    for (let i = 0; i < n; i++) j.mark(`f${i}`);
  };
  const deep = (n: number) => () => {
    const j = new FolderJournal();
    // A copied tree: every folder fires an event, deepest last.
    let p = "root";
    const all: string[] = [];
    for (let i = 0; i < n; i++) {
      all.push(p);
      p = `${p}/d${i % 50}`;
      if (i % 50 === 49) p = `root/b${i}`;
    }
    for (const x of all.reverse()) j.mark(x);
  };

  // Compared on EQUAL work: ten journals of 2000 against one of 20 000 —
  // the same number of marks. Linear cost makes them about equal; a
  // quadratic makes the big one ~10x. Timing tiny runs against a big one
  // drowns in JIT and GC noise when the suite runs files in parallel.
  for (const [name, shape] of [["top-level", topLevel], ["copied tree", deep]] as const) {
    it(`${name}: one journal of 20 000 costs about what ten of 2000 do`, () => {
      const best = (fn: () => void, n: number) =>
        Math.min(...Array.from({ length: n }, () => time(fn)));
      const tenSmall = () => {
        for (let k = 0; k < 10; k++) shape(2000)();
      };
      tenSmall(); // warm-up
      const small = best(tenSmall, 5);
      const large = best(shape(20000), 5);
      // Linear ≈ 1, quadratic ≈ 10; 5 leaves room for a GC pause.
      expect(large / small).toBeLessThan(5);
    });
  }
});
