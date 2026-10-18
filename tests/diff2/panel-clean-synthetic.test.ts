// @vitest-environment happy-dom
//
// The Diff Panel's slow pass is the synthetic-copy cleanup when the panel
// OPENS and on Ctrl/Cmd+R (owner, 2026-10-12) — and only then: a refresh the
// conflict model triggers just lists. Harness as in panel-back-nav.test.ts.

import { describe, it, expect, vi } from "vitest";
import { DiffPanelView } from "../../src/diff2/diff-panel-view";
import { emptyConflictsState } from "../../src/sync2/conflict-store-v2";

interface PanelHandle {
  deps: unknown;
  viewState: unknown;
  conflictEntries: unknown[];
  render: () => void;
  refreshing: boolean;
  refreshAgain: boolean;
  cleanPending: boolean;
  refreshConflicts(opts?: { clean?: boolean }): Promise<void>;
  onActivated(): void;
  focusConflictList: () => void;
}

function makePanel() {
  const panel = Object.create(DiffPanelView.prototype) as PanelHandle;
  const scan = vi.fn(async (_clean: boolean) => []);
  const invalidate = vi.fn();
  panel.deps = {
    vault: {
      getFiles: () => [],
      adapter: { exists: async () => false, stat: async () => null },
    },
    conflictStore: {
      getCachedState: () => emptyConflictsState(),
      getBySiblingPath: () => null,
    },
    scanDotSpaceConflicts: scan,
    conflictAnalyzer: { invalidate },
  };
  panel.focusConflictList = vi.fn();
  panel.viewState = { tab: "conflicts" };
  panel.conflictEntries = [];
  panel.render = vi.fn();
  panel.refreshing = false;
  panel.refreshAgain = false;
  panel.cleanPending = false;
  return { panel, scan, invalidate };
}

describe("Diff Panel — when the slow pass cleans up synthetic copies", () => {
  it("🔑 open / Ctrl+R (clean: true) → the cleanup runs", async () => {
    const { panel, scan } = makePanel();
    await panel.refreshConflicts({ clean: true });
    expect(scan.mock.calls).toEqual([[true]]);
  });

  it("a refresh the conflict model triggers only lists", async () => {
    const { panel, scan } = makePanel();
    await panel.refreshConflicts();
    expect(scan.mock.calls).toEqual([[false]]);
  });

  it("a clean request that lands during a running refresh is not lost to coalescing", async () => {
    const { panel, scan } = makePanel();
    let release!: () => void;
    scan.mockImplementationOnce(() => new Promise((r) => (release = () => r([]))));
    const first = panel.refreshConflicts();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    void panel.refreshConflicts({ clean: true });
    release();
    await first;
    expect(scan.mock.calls).toEqual([[false], [true]]);
  });
});

// Owner, 2026-10-12: EVERY time the Diff Panel tab gets the focus it works as
// Ctrl/Cmd+R — the files it shows are re-read: new conflicts of any kind
// appear, resolved or vanished ones go (also in dot-folders, where Obsidian
// sends no events), and the badge is recomputed too.
describe("Diff Panel — every focus is a Ctrl/Cmd+R", () => {
  it("🔑 focus → the full refresh with the cleanup", async () => {
    const { panel, scan } = makePanel();
    panel.onActivated();
    await vi.waitFor(() => expect(scan.mock.calls).toEqual([[true]]));
  });

  it("🔑 a full refresh asks the conflict model to recompute (the badge follows)", async () => {
    const { panel, invalidate } = makePanel();
    await panel.refreshConflicts({ clean: true });
    expect(invalidate).toHaveBeenCalled();
  });
});


// Owner, 2026-10-12: clicking a row whose conflict is already resolved (copy
// gone or identical to its file — removed outside Obsidian, say) opened an
// editor tab first — the panel went blank — and only then said "resolved".
// The check now happens IN THE PANEL, before anything opens: the window shows
// over the panel as it is, and after it the list is re-read (the row goes).
describe("Diff Panel — a click on an already resolved conflict", () => {
  interface Launch {
    launchEntry(entry: unknown, toRight: boolean): Promise<void>;
    showResolved: (basePath: string) => Promise<void>;
  }
  const entry = {
    basePath: ".test/test.md",
    siblingPath: ".test/test.conflict-from-Phone-2026-06-05T09-19-10Z.md",
    deviceLabel: "Phone",
    isoTimestamp: "2026-06-05T09-19-10Z",
    kind: "synthetic" as const,
  };
  const setup = (resolved: boolean) => {
    const { panel, scan } = makePanel();
    const openEditor = vi.fn();
    const showResolved = vi.fn(async () => {});
    (panel.deps as Record<string, unknown>).openEditor = openEditor;
    (panel.deps as Record<string, unknown>).isCopyResolved = async () => resolved;
    (panel as unknown as Launch).showResolved = showResolved;
    return { panel: panel as unknown as Launch, scan, openEditor, showResolved };
  };

  it("🔑 resolved → the window over the panel, NO editor opened, then the list is re-read", async () => {
    const { panel, scan, openEditor, showResolved } = setup(true);
    await panel.launchEntry(entry, false);
    expect(openEditor).not.toHaveBeenCalled();
    expect(showResolved).toHaveBeenCalledWith(".test/test.md");
    expect(scan.mock.calls).toEqual([[true]]);
  });

  it("still in conflict → the editor opens as before", async () => {
    const { panel, openEditor, showResolved } = setup(false);
    await panel.launchEntry(entry, true);
    expect(openEditor).toHaveBeenCalledWith(entry, true);
    expect(showResolved).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-18: a conflict in a dot-folder blinked several times on
// every refresh — the fast half (store + Obsidian's index, which never lists
// dot-paths) REPLACED the list without it, and the slow dot-space scan put it
// back a moment later. A dot-space row the panel already shows is carried
// over while its copy is still live on disk; the scan then has the last word.
describe("Diff Panel — a dot-folder conflict does not blink on refresh", () => {
  const DOT_BASE = ".test/test.md";
  const DOT_COPY = ".test/test.conflict-from-Phone-2026-10-18T10-00-00Z.md";
  const dotRow = {
    basePath: DOT_BASE,
    siblingPath: DOT_COPY,
    deviceLabel: "Phone",
    isoTimestamp: "2026-10-18T10-00-00Z",
    kind: "synthetic" as const,
  };

  function panelWithDotRow(copyOnDisk: boolean) {
    const { panel, scan } = makePanel();
    const deps = panel.deps as { vault: { adapter: Record<string, unknown> } };
    // A live copy: on disk, a different size from its base.
    deps.vault.adapter.stat = async (p: string) =>
      p === DOT_BASE ? { size: 5, mtime: 1 } : copyOnDisk && p === DOT_COPY ? { size: 9, mtime: 1 } : null;
    deps.vault.adapter.exists = async (p: string) => p === DOT_BASE || (copyOnDisk && p === DOT_COPY);
    panel.conflictEntries = [dotRow];
    const painted: string[][] = [];
    panel.render = vi.fn(() =>
      painted.push((panel.conflictEntries as Array<{ siblingPath: string }>).map((e) => e.siblingPath)),
    );
    return { panel, scan, painted };
  }

  it("🔑 the row is in EVERY paint of the refresh, not only after the scan", async () => {
    const { panel, scan, painted } = panelWithDotRow(true);
    scan.mockResolvedValue([dotRow] as never);
    await panel.refreshConflicts({ clean: true });
    expect(painted.length).toBeGreaterThan(0);
    for (const p of painted) expect(p).toEqual([DOT_COPY]);
  });

  it("its copy gone from disk → it leaves at the fast half already", async () => {
    const { panel, scan, painted } = panelWithDotRow(false);
    scan.mockResolvedValue([] as never);
    await panel.refreshConflicts({ clean: true });
    expect(painted[0]).toEqual([]);
    expect(panel.conflictEntries).toEqual([]);
  });

  it("the scan no longer finds it (e.g. out of scope now) → it leaves after the scan", async () => {
    const { panel, scan } = panelWithDotRow(true);
    scan.mockResolvedValue([] as never);
    await panel.refreshConflicts({ clean: true });
    expect(panel.conflictEntries).toEqual([]);
  });

  it("an ordinary-path synthetic row is NOT carried — the index decides for those", async () => {
    const { panel, scan, painted } = panelWithDotRow(true);
    const plain = { ...dotRow, basePath: "notes/a.md", siblingPath: "notes/a.conflict-from-Phone-2026-10-18T10-00-00Z.md" };
    const deps = panel.deps as { vault: { adapter: Record<string, unknown> } };
    deps.vault.adapter.stat = async () => ({ size: 9, mtime: 1 });
    panel.conflictEntries = [plain];
    scan.mockResolvedValue([] as never);
    await panel.refreshConflicts({ clean: true });
    expect(painted[0]).toEqual([]);
  });
});
