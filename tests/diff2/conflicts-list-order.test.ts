// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The Diff Panel's conflict list (owner, 2026-10-09):
//   - files with a TRACKED conflict first — they are kept from the server
//     until resolved, and they are drawn in RED, so the red rows add up to
//     the diff badge's number;
//   - then files with only synthetic copies, in the normal colour;
//   - under a file: its tracked copies first, then the synthetic ones,
//     each kind newest first.

import { describe, expect, it } from "vitest";
import { orderConflictGroups } from "../../src/diff2/conflicts-list";
import type { ConflictEntry } from "../../src/diff2/synthetic-detector";

const e = (basePath: string, iso: string, kind: "tracked" | "synthetic"): ConflictEntry => ({
  basePath,
  siblingPath: `${basePath}.conflict-from-X-${iso}`,
  deviceLabel: "X",
  isoTimestamp: iso,
  kind,
});

describe("orderConflictGroups", () => {
  it("🔑 files with a tracked conflict first (marked), synthetic-only files after", () => {
    const groups = orderConflictGroups([
      e("s.md", "2026-10-09T22-00-00Z", "synthetic"), // newest, but synthetic-only
      e("a.md", "2026-10-09T21-00-00Z", "tracked"),
      e("b.md", "2026-10-09T20-00-00Z", "tracked"),
    ]);
    expect(groups.map((g) => [g.basePath, g.tracked])).toEqual([
      ["a.md", true],
      ["b.md", true],
      ["s.md", false],
    ]);
  });

  it("🔑 under one file: tracked copies first, then synthetic; each newest first", () => {
    const [g] = orderConflictGroups([
      e("a.md", "2026-10-09T23-00-00Z", "synthetic"),
      e("a.md", "2026-10-09T21-16-48Z", "tracked"),
      e("a.md", "2026-10-09T22-00-00Z", "synthetic"),
      e("a.md", "2026-10-09T21-17-58Z", "tracked"),
    ]);
    expect(g.tracked).toBe(true); // one tracked copy makes the file red
    expect(g.entries.map((x) => `${x.kind} ${x.isoTimestamp}`)).toEqual([
      "tracked 2026-10-09T21-17-58Z",
      "tracked 2026-10-09T21-16-48Z",
      "synthetic 2026-10-09T23-00-00Z",
      "synthetic 2026-10-09T22-00-00Z",
    ]);
  });

  it("within each class the files keep the list's newest-first order", () => {
    const groups = orderConflictGroups([
      e("new.md", "2026-10-09T23-00-00Z", "tracked"),
      e("old.md", "2026-10-09T01-00-00Z", "tracked"),
    ]);
    expect(groups.map((g) => g.basePath)).toEqual(["new.md", "old.md"]);
  });
});
