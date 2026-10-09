// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-09: when the drain REPLACES a conflict copy with a newer
// server version, the OLD copy is forgotten at once: (1) its editor tabs
// close, (2) its diff2-autosave dir is wiped — whether a tab was open or not.
// Nothing else, and no other case.

import { describe, expect, it } from "vitest";
import { forgetReplacedConflictCopy } from "../../src/diff2/forget-replaced-copy";
import { autosaveDir, deriveAutosaveId } from "../../src/diff2/autosave-store";

const BASE = "notes/a.md";
const OLD = "notes/a.conflict-from-Mac-2026-10-09T18-26-16Z.md";
const NEW = "notes/a.conflict-from-Mac-2026-10-09T18-26-52Z.md";

function setup(openTabs: (string | null)[], dirs: string[]) {
  const existing = new Set(dirs);
  const order: string[] = [];
  const tabs = openTabs.map((siblingPath, i) => ({
    siblingPath,
    detach: () => order.push(`close:${i}`),
  }));
  const adapter = {
    exists: async (p: string) => existing.has(p),
    rmdir: async (p: string) => {
      order.push(`rmdir:${p}`);
      existing.delete(p);
    },
  };
  return { order, existing, deps: { editorTabs: () => tabs, adapter } };
}

describe("forgetReplacedConflictCopy", () => {
  const trackedDir = autosaveDir(deriveAutosaveId("tracked", BASE, OLD));
  const newDir = autosaveDir(deriveAutosaveId("tracked", BASE, NEW));

  it("🔑 closes the OLD copy's tabs FIRST, then wipes its autosave dir; the new copy is untouched", async () => {
    const s = setup([OLD, NEW, null], [trackedDir, newDir]);
    const r = await forgetReplacedConflictCopy(s.deps, BASE, OLD);
    expect(s.order).toEqual(["close:0", `rmdir:${trackedDir}`]);
    expect(s.existing.has(newDir)).toBe(true);
    expect(r).toEqual({ closedTabs: 1, wipedDirs: 1 });
  });

  it("🔑 no tab open → the dir is wiped anyway", async () => {
    const s = setup([], [trackedDir]);
    const r = await forgetReplacedConflictCopy(s.deps, BASE, OLD);
    expect(s.existing.has(trackedDir)).toBe(false);
    expect(r).toEqual({ closedTabs: 0, wipedDirs: 1 });
  });

  it("nothing there → nothing done", async () => {
    const s = setup([NEW], [newDir]);
    expect(await forgetReplacedConflictCopy(s.deps, BASE, OLD)).toEqual({ closedTabs: 0, wipedDirs: 0 });
    expect(s.order).toEqual([]);
  });
});
