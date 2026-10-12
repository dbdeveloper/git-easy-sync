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
}

function makePanel() {
  const panel = Object.create(DiffPanelView.prototype) as PanelHandle;
  const scan = vi.fn(async (_clean: boolean) => []);
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
  };
  panel.viewState = { tab: "conflicts" };
  panel.conflictEntries = [];
  panel.render = vi.fn();
  panel.refreshing = false;
  panel.refreshAgain = false;
  panel.cleanPending = false;
  return { panel, scan };
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
