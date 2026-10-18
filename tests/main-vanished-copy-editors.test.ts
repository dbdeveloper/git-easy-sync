// @vitest-environment happy-dom
//
// Owner, 2026-10-11: a conflict whose COPY is gone is resolved, and its open
// diff-editor tabs close — whoever removed the copy. The decision itself is
// closeEditorsOfVanishedCopies (tests/diff2/close-vanished-copies.test.ts);
// this file pins the WIRING in main.ts: the plugin reads its editor leaves'
// serialized state, and runs the check after a conflict reconcile and after
// every drain. Those two checkpoints do not depend on vault events, which
// Obsidian never sends for dot-paths.

import { beforeEach, describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { clearRecordedNotices, recordedNotices } from "../mock-obsidian";
import { autosaveDir, deriveAutosaveId } from "../src/diff2/autosave-store";
import { DIFF2_EDITOR_VIEW_TYPE } from "../src/diff2/diff-editor-view";
import { ConflictResolvedModal } from "../src/diff2/recovery-dialog";

const BASE = "notes/a.md";
const COPY = "notes/a.conflict-from-Mac-2026-10-11T20-25-53Z.md";

interface Handle {
  app: unknown;
  logger: unknown;
  closeVanishedCopyEditors(): Promise<void>;
  reconcileConflictsV2(): Promise<void>;
  handleDrainIdle(): void;
  closeCancelSyncModal(): void;
  settleDrainSection(text: string): void;
  sync2Manager: unknown;
  syncCancelRequested: boolean;
}

function pluginWithEditorTab(copyOnDisk: boolean, autosaveOnDisk = false) {
  const dir = autosaveDir(deriveAutosaveId("tracked", BASE, COPY));
  const detach = vi.fn();
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as Handle;
  p.app = {
    workspace: {
      activeLeaf: null,
      getLeavesOfType: (type: string) =>
        type === DIFF2_EDITOR_VIEW_TYPE
          ? [
              {
                getViewState: () => ({
                  state: { origin: "conflict", basePath: BASE, siblingPath: COPY },
                }),
                detach,
              },
            ]
          : [],
    },
    vault: {
      adapter: {
        exists: async (path: string) =>
          path === BASE || (copyOnDisk && path === COPY) || (autosaveOnDisk && path === dir),
        // The copy (when present) differs from the base in size: unresolved.
        stat: async (path: string) =>
          path === BASE ? { size: 5, mtime: 1 } : copyOnDisk && path === COPY ? { size: 9, mtime: 1 } : null,
        rmdir: async () => {},
      },
    },
  };
  p.logger = { info: () => {}, warn: () => {}, error: () => {} };
  (p as unknown as { workerClient: unknown }).workerClient = { computeGitBlobSHA: async () => "sha" };
  return { p, detach };
}

describe("main.ts closes the editors of vanished conflict copies", () => {
  beforeEach(() => clearRecordedNotices());

  it("🔑 reads the leaves' serialized state: a tab whose copy is gone is detached", async () => {
    const { p, detach } = pluginWithEditorTab(false);
    await p.closeVanishedCopyEditors();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  // Owner, 2026-10-11: work left unsaved in that editor is moot once the
  // conflict was resolved outside it — discarded SILENTLY, even with an
  // autosave on disk.
  it("🔑 unsaved work is discarded without a word", async () => {
    const { p, detach } = pluginWithEditorTab(false, true);
    await p.closeVanishedCopyEditors();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(recordedNotices).toHaveLength(0);
  });

  // The model's rule through main.ts (owner, 2026-10-12): a copy that still
  // EXISTS but is byte-equal to its base is resolved — its tab closes.
  it("🔑 a copy present but byte-equal to its base → resolved, its tab is detached", async () => {
    const { p, detach } = pluginWithEditorTab(true);
    const adapter = (p.app as { vault: { adapter: Record<string, unknown> } }).vault.adapter;
    adapter.stat = async (path: string) => (path === BASE || path === COPY ? { size: 5, mtime: 7 } : null);
    adapter.readBinary = async () => new TextEncoder().encode("same\n").buffer;
    (p as unknown as { workerClient: unknown }).workerClient = {
      computeGitBlobSHA: async (b: ArrayBuffer) => `sha-${b.byteLength}`,
    };
    await p.closeVanishedCopyEditors();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  // A pass may wait on the focused tab's window; an overlapping pass would
  // show a SECOND window for the same tab. Passes never overlap, and any
  // number of triggers during one pass coalesce into ONE more.
  it("🔑 cleaner passes never overlap; triggers during a pass coalesce into one more", async () => {
    const { p } = pluginWithEditorTab(true);
    let running = 0;
    let maxRunning = 0;
    let passes = 0;
    (p as unknown as { closeVanishedCopyEditorsOnce(): Promise<void> }).closeVanishedCopyEditorsOnce = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      passes++;
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all([
      p.closeVanishedCopyEditors(),
      p.closeVanishedCopyEditors(),
      p.closeVanishedCopyEditors(),
    ]);
    expect(maxRunning).toBe(1);
    expect(passes).toBe(2);
  });

  // Field, 2026-10-18: the tab's OWN [←] writes the base, writes the copy
  // equal to it, then removes the copy — each step an event that starts a
  // pass while the tab is still open and focused. That change is not
  // "outside the editor": the pass leaves a tab that is saving alone — no
  // window, no detach; its [←] closes it.
  it("🔑 a tab in the middle of its own [←] is skipped: no window, no detach", async () => {
    const { p, detach } = pluginWithEditorTab(false);
    const ws = (p.app as { workspace: Record<string, unknown> }).workspace;
    const leaf = {
      getViewState: () => ({ state: { origin: "conflict", basePath: BASE, siblingPath: COPY } }),
      detach,
      view: { isCommitting: () => true },
    };
    ws.activeLeaf = leaf;
    ws.getLeavesOfType = (type: string) => (type === DIFF2_EDITOR_VIEW_TYPE ? [leaf] : []);
    const prompt = vi.spyOn(ConflictResolvedModal.prototype, "prompt").mockResolvedValue(undefined as never);
    try {
      await p.closeVanishedCopyEditors();
      expect(prompt).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    } finally {
      prompt.mockRestore();
    }
  });

  // Field, 2026-10-18: the copy was there at stat and gone at read (removed
  // in between). A copy that is gone is resolved — not an error.
  it("🔑 the copy vanishes between its stat and its read → resolved, its tab is detached", async () => {
    const { p, detach } = pluginWithEditorTab(true);
    const adapter = (p.app as { vault: { adapter: Record<string, unknown> } }).vault.adapter;
    let copyThere = true;
    adapter.stat = async (path: string) =>
      path === BASE || (copyThere && path === COPY) ? { size: 5, mtime: 7 } : null;
    adapter.exists = async (path: string) => path === BASE || (copyThere && path === COPY);
    adapter.readBinary = async (path: string) => {
      if (path === COPY) {
        copyThere = false;
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return new TextEncoder().encode("same\n").buffer;
    };
    await p.closeVanishedCopyEditors();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  // Field, 2026-10-18: the copy was deleted in the FILE EXPLORER — so the
  // explorer, not the editor, was Obsidian's active leaf. The editor was
  // still the tab the user was working in (the most recent main-area leaf):
  // it closes WITHOUT a window (resolved outside = too late for one) and the
  // user lands in the Diff Panel.
  it("🔑 the most recent main-area tab (explorer active) → no window, then the Diff Panel", async () => {
    const { p, detach } = pluginWithEditorTab(false);
    const ws = (p.app as { workspace: Record<string, unknown> }).workspace;
    const leaf = {
      getViewState: () => ({ state: { origin: "conflict", basePath: BASE, siblingPath: COPY } }),
      detach,
    };
    ws.activeLeaf = { explorer: true };
    ws.getMostRecentLeaf = () => leaf;
    ws.getLeavesOfType = (type: string) => (type === DIFF2_EDITOR_VIEW_TYPE ? [leaf] : []);
    const panel = vi.fn(async () => ({}));
    (p as unknown as { activateDiffEditView: unknown }).activateDiffEditView = panel;
    const prompt = vi.spyOn(ConflictResolvedModal.prototype, "prompt").mockResolvedValue(undefined as never);
    try {
      await p.closeVanishedCopyEditors();
      expect(prompt).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(1);
      expect(panel).toHaveBeenCalledTimes(1);
    } finally {
      prompt.mockRestore();
    }
  });

  it("a background tab (another tab is the most recent) → closes, the focus stays put", async () => {
    const { p, detach } = pluginWithEditorTab(false);
    const ws = (p.app as { workspace: Record<string, unknown> }).workspace;
    ws.getMostRecentLeaf = () => ({ other: true });
    const panel = vi.fn(async () => ({}));
    (p as unknown as { activateDiffEditView: unknown }).activateDiffEditView = panel;
    await p.closeVanishedCopyEditors();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(panel).not.toHaveBeenCalled();
  });

  it("a tab whose copy is still there stays", async () => {
    const { p, detach } = pluginWithEditorTab(true);
    await p.closeVanishedCopyEditors();
    expect(detach).not.toHaveBeenCalled();
  });

  // Owner, 2026-10-11: conflicts.json is the DRAIN's ledger — only the drain
  // changes it. The UI points (onload, panel open, editor close) READ: they
  // refresh the counter and close dead editor tabs, and never save the store
  // or delete a file, even for a copy that is gone or equal to its base.
  it("🔑 the UI reconcile writes NOTHING: no store save, no file removed", async () => {
    const { p } = pluginWithEditorTab(true);
    const save = vi.fn(async () => {});
    const load = vi.fn(async () => ({
      lastSiblingTxGuid: null,
      entries: new Map([
        [BASE, {
          conflictBase: { path: BASE, sha: "cb", size: null, mtime: null, blob: null, mode: "", deviceLabel: null },
          // A copy that is NOT on disk: the old reconcile pruned it and saved.
          siblings: [{ path: BASE, sha: "x", size: 1, mtime: null, blob: null, mode: "", deviceLabel: "Mac", timeLabel: 1 }],
        }],
      ]),
    }));
    const remove = vi.fn(async () => {});
    const h = p as unknown as Record<string, unknown>;
    h.conflictStoreV2 = { load, save, getCachedState: () => ({ entries: new Map() }) };
    h.conflictAnalyzer = { invalidate: vi.fn() };
    h.workerClient = { computeGitBlobSHA: async () => "sha" };
    (p.app as { vault: { adapter: Record<string, unknown> } }).vault.adapter.remove = remove;
    (p.app as { vault: { adapter: Record<string, unknown> } }).vault.adapter.stat = async () => null;
    (p.app as { vault: { adapter: Record<string, unknown> } }).vault.adapter.list = async () => ({ files: [], folders: [] });

    await p.reconcileConflictsV2();

    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((h.conflictAnalyzer as { invalidate: ReturnType<typeof vi.fn> }).invalidate).toHaveBeenCalled();
  });

  it("runs after a conflict reconcile (onload, panel open, editor close)", async () => {
    const { p } = pluginWithEditorTab(false);
    const spy = vi.fn(async () => {});
    p.closeVanishedCopyEditors = spy;
    await p.reconcileConflictsV2();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runs after every drain — the cancelled one too", () => {
    const { p } = pluginWithEditorTab(false);
    p.closeCancelSyncModal = () => {};
    p.settleDrainSection = () => {};
    p.syncCancelRequested = true; // the earliest return in handleDrainIdle
    p.sync2Manager = { wasLastDrainCancelled: () => true };
    const spy = vi.fn(async () => {});
    p.closeVanishedCopyEditors = spy;
    p.handleDrainIdle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
