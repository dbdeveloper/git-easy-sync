// @vitest-environment happy-dom
//
// The `[←]` return from the diff editor must not repaint a conflict the
// user just resolved.
//
// Harness: the panel is an ItemView whose render() needs a live workspace,
// so the constructor is skipped (`Object.create(prototype)` — the pattern
// main-pre-sync-gate.test.ts established) and `render`/`scrollToBase` are
// shadowed by own-property spies. What is under test is the ORDER inside
// applyBackNav, not the painting, so stubbing the paint is the point
// rather than a shortcut.

import { describe, it, expect, vi } from "vitest";
import { DiffPanelView } from "../../src/diff2/diff-panel-view";
import type { ConflictEntry } from "../../src/diff2/synthetic-detector";

interface PanelHandle {
  deps: unknown;
  viewState: unknown;
  conflictEntries: ConflictEntry[];
  render: () => void;
  scrollToBase: (p: string) => void;
  applyBackNav(nav: {
    kind: "panel";
    tab: "conflicts";
    scrollToBase: string | null;
  }): Promise<void>;
}

const entry = (siblingPath: string, basePath: string): ConflictEntry => ({
  basePath,
  siblingPath,
  deviceLabel: "Old gitignore files",
  isoTimestamp: "2026-09-28T10-00-00Z",
  kind: "synthetic",
});

function makePanel(onDisk: string[]) {
  const panel = Object.create(DiffPanelView.prototype) as PanelHandle;
  const render = vi.fn();
  panel.deps = {
    vault: { adapter: { exists: async (p: string) => onDisk.includes(p) } },
  };
  panel.viewState = { tab: "conflicts" };
  panel.render = render;
  panel.scrollToBase = vi.fn();
  return { panel, render };
}

const PROPOSAL =
  ".gitignore.conflict-from-Old gitignore files-2026-09-28T10-00-00Z";

describe("panel [←] back-nav", () => {
  it("🔑 drops a row whose sibling is gone before repainting", async () => {
    // Field report 2026-09-28: after resolving the .gitignore proposal and
    // pressing [←], the row was still there and clicking it did nothing —
    // the file behind it no longer existed.
    //
    // It did not bite for ordinary files because ConflictWatcher hears
    // `vault.on('delete')`. It bites for DOT-paths, which Obsidian's
    // indexer hides, so that event never fires.
    const { panel, render } = makePanel([]); // nothing left on disk
    panel.conflictEntries = [entry(PROPOSAL, ".gitignore")];

    await panel.applyBackNav({
      kind: "panel",
      tab: "conflicts",
      scrollToBase: null,
    });

    expect(panel.conflictEntries).toEqual([]);
    expect(render).toHaveBeenCalled();
  });

  it("keeps rows that are still real", async () => {
    // Without this, "always clear the list" would pass the test above.
    const { panel } = makePanel([PROPOSAL]);
    panel.conflictEntries = [entry(PROPOSAL, ".gitignore")];

    await panel.applyBackNav({
      kind: "panel",
      tab: "conflicts",
      scrollToBase: null,
    });

    expect(panel.conflictEntries).toHaveLength(1);
  });

  it("drops only what vanished, out of a mixed list", async () => {
    const other = "note.conflict-from-Phone-2026-09-28T10-00-00Z.md";
    const { panel } = makePanel([other]);
    panel.conflictEntries = [
      entry(PROPOSAL, ".gitignore"),
      entry(other, "note.md"),
    ];

    await panel.applyBackNav({
      kind: "panel",
      tab: "conflicts",
      scrollToBase: null,
    });

    expect(panel.conflictEntries.map((e) => e.siblingPath)).toEqual([other]);
  });

  it("repaints even when nothing vanished — the tab may have changed", async () => {
    // applyBackNav's other job. A prune that returned early must not take
    // the repaint with it.
    const { panel, render } = makePanel([PROPOSAL]);
    panel.conflictEntries = [entry(PROPOSAL, ".gitignore")];

    await panel.applyBackNav({
      kind: "panel",
      tab: "conflicts",
      scrollToBase: null,
    });

    expect(render).toHaveBeenCalledTimes(1);
  });
});
