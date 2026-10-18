// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-11: a conflict whose COPY is gone is resolved — however it
// went (deleted by the user, renamed onto the base, both files deleted, or
// removed by the conflict reconcile because it matched the base). Its open
// diff-editor tabs close silently and its autosave is wiped. A deleted BASE
// alone is not a resolution: the copy is still there, the conflict goes on.
// The check reads the disk, never a vault event — events miss dot-paths.

import { describe, expect, it } from "vitest";
import { closeEditorsOfVanishedCopies } from "../../src/diff2/close-vanished-copies";
import { autosaveDir, deriveAutosaveId } from "../../src/diff2/autosave-store";

const BASE = "notes/a.md";
const COPY = "notes/a.conflict-from-Mac-2026-10-11T20-25-53Z.md";
const OTHER_BASE = "notes/b.md";
const OTHER_COPY = "notes/b.conflict-from-Mac-2026-10-11T20-25-53Z.md";

type Tab = { origin: string; basePath: string; siblingPath: string; active?: boolean };

function setup(tabs: Tab[], files: string[], dirs: string[] = [], equalToBase: string[] = []) {
  const existing = new Set([...files, ...dirs]);
  const closed: number[] = [];
  const wiped: string[] = [];
  const order: string[] = [];
  const deps = {
    editorTabs: () =>
      tabs.map((t, i) => ({
        ...t,
        isActive: t.active === true,
        detach: () => {
          closed.push(i);
          order.push(`close:${i}`);
        },
      })),
    // Resolved = the copy is gone, or byte-equal to its base (the model's rule).
    isResolved: async (_base: string, copy: string) =>
      !existing.has(copy) || equalToBase.includes(copy),
    onFocusedClosed: () => order.push("panel"),
    adapter: {
      exists: async (p: string) => existing.has(p),
      rmdir: async (p: string) => {
        wiped.push(p);
        existing.delete(p);
      },
    },
  };
  return { deps, closed, wiped, order };
}

const conflictTab = (basePath = BASE, siblingPath = COPY): Tab => ({
  origin: "conflict",
  basePath,
  siblingPath,
});

describe("closeEditorsOfVanishedCopies", () => {
  it("🔑 the copy is gone → its tab closes and both possible autosave dirs are wiped", async () => {
    const tracked = autosaveDir(deriveAutosaveId("tracked", BASE, COPY));
    const synthetic = autosaveDir(deriveAutosaveId("synthetic", BASE, COPY));
    const s = setup([conflictTab()], [BASE], [tracked, synthetic]);

    const r = await closeEditorsOfVanishedCopies(s.deps);

    expect(s.closed).toEqual([0]);
    expect(s.wiped.sort()).toEqual([synthetic, tracked].sort());
    expect(r).toEqual({ closedTabs: 1, wipedDirs: 2 });
  });

  it("both files deleted → closes too", async () => {
    const s = setup([conflictTab()], []);
    await closeEditorsOfVanishedCopies(s.deps);
    expect(s.closed).toEqual([0]);
  });

  it("only the BASE deleted → the copy is there, the conflict goes on, the tab stays", async () => {
    const s = setup([conflictTab()], [COPY]);
    const r = await closeEditorsOfVanishedCopies(s.deps);
    expect(s.closed).toEqual([]);
    expect(r.closedTabs).toBe(0);
  });

  it("only the tab whose copy vanished closes; another conflict's tab stays", async () => {
    const s = setup(
      [conflictTab(), conflictTab(OTHER_BASE, OTHER_COPY)],
      [BASE, OTHER_BASE, OTHER_COPY],
    );
    await closeEditorsOfVanishedCopies(s.deps);
    expect(s.closed).toEqual([0]);
  });

  // Owner, 2026-10-12: the cleaner follows the conflict MODEL — a copy that
  // still exists but is byte-equal to its base is resolved too.
  it("🔑 a copy that still EXISTS but equals its base → its tab closes too", async () => {
    const s = setup([conflictTab()], [BASE, COPY], [], [COPY]);
    await closeEditorsOfVanishedCopies(s.deps);
    expect(s.closed).toEqual([0]);
  });

  // Owner, 2026-10-18: resolved outside the editor = too late for any window.
  // The tab in focus closes silently too — and the user lands in the Diff
  // Panel; a background tab closes and nothing moves.
  it("🔑 the tab in FOCUS closes without a window, then the Diff Panel; others close silently", async () => {
    const s = setup(
      [{ ...conflictTab(), active: true }, conflictTab(OTHER_BASE, OTHER_COPY)],
      [BASE, OTHER_BASE],
    );
    await closeEditorsOfVanishedCopies(s.deps);
    expect(s.order).toEqual(["close:0", "panel", "close:1"]);
  });

  it("History / Deleted / Compare tabs are never touched — they show no conflict copy", async () => {
    const s = setup(
      [
        { origin: "history", basePath: BASE, siblingPath: BASE },
        { origin: "deleted", basePath: BASE, siblingPath: BASE },
        { origin: "compare", basePath: BASE, siblingPath: COPY },
      ],
      [],
    );
    await closeEditorsOfVanishedCopies(s.deps);
    expect(s.closed).toEqual([]);
  });
  // Field, 2026-10-18: one tab's check failing (a copy vanishing between its
  // stat and its read) used to abort the whole pass — no other tab was looked
  // at. A failed check leaves THAT tab for the next pass; the rest go on.
  it("🔑 one tab's check throws → that tab stays, the other tabs are still checked", async () => {
    const s = setup([conflictTab(), conflictTab(OTHER_BASE, OTHER_COPY)], [BASE, COPY, OTHER_BASE]);
    const failed: string[] = [];
    const deps = {
      ...s.deps,
      isResolved: async (base: string, copy: string) => {
        if (copy === COPY) throw new Error("ENOENT: no such file or directory");
        return s.deps.isResolved(base, copy);
      },
      onCheckFailed: (copy: string) => failed.push(copy),
    };
    await closeEditorsOfVanishedCopies(deps);
    expect(s.closed).toEqual([1]);
    expect(failed).toEqual([COPY]);
  });
});
