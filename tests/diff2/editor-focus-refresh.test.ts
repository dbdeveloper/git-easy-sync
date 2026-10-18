// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { DiffEditorView } from "../../src/diff2/diff-editor-view";

// Owner, 2026-10-12: EVERY time a diff-editor tab gets the focus it works as
// Ctrl/Cmd+R — a resolved conflict closes (no window since 2026-10-18, then
// the Diff Panel), one
// of two separate files gone closes ("One of the files is gone"), files
// changed on disk reopen through the recovery window. One check per focus: a
// focus arriving while one runs (its own window moves the focus) is not a
// second check, and nothing runs before the editor is mounted.
interface EditorHandle {
  mounted: boolean;
  refreshFromDisk: () => Promise<void>;
  onActivated(): Promise<void>;
}

function makeEditor(mounted = true) {
  const ed = Object.create(DiffEditorView.prototype) as EditorHandle;
  ed.mounted = mounted;
  let release!: () => void;
  const refresh = vi.fn(() => new Promise<void>((r) => (release = r)));
  ed.refreshFromDisk = refresh;
  return { ed, refresh, release: () => release() };
}

describe("diff-editor — every focus is a Ctrl/Cmd+R", () => {
  it("🔑 focus → the same check as Ctrl/Cmd+R", async () => {
    const { ed, refresh, release } = makeEditor();
    const p = ed.onActivated();
    release();
    await p;
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a focus while a check is running is not a second check", async () => {
    const { ed, refresh, release } = makeEditor();
    const p = ed.onActivated();
    await ed.onActivated();
    release();
    await p;
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("nothing before the editor is mounted", async () => {
    const { ed, refresh } = makeEditor(false);
    await ed.onActivated();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-12 (field): [←] on a conflict resolved outside closed the
// editor, and the NEXT tab (a markdown note) became active — not the Diff
// Panel. Every way a conflict editor leaves goes to the panel (opening it if
// it is closed): resolved outside on [←], the copy gone at mount, Cancel in
// the recovery window. A History editor and two separate files just close.
describe("diff-editor — leaving a conflict editor lands in the Diff Panel", () => {
  interface Leave {
    leaf: { detach: () => void };
    state: unknown;
    deps: unknown;
    onLeaveDetail(): void;
  }
  const COPY = "notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md";
  const setup = (origin: string, siblingPath: string) => {
    const ed = Object.create(DiffEditorView.prototype) as Leave;
    const detach = vi.fn();
    const showDiffPanel = vi.fn();
    ed.leaf = { detach };
    ed.state = { origin, basePath: "notes/a.md", siblingPath, openMode: "user" };
    ed.deps = { showDiffPanel };
    return { ed, detach, showDiffPanel };
  };

  it("🔑 a conflict editor closes AND the Diff Panel becomes the active tab", () => {
    const { ed, detach, showDiffPanel } = setup("conflict", COPY);
    ed.onLeaveDetail();
    expect(detach).toHaveBeenCalled();
    expect(showDiffPanel).toHaveBeenCalled();
  });

  it("two separate files just close", () => {
    const { ed, showDiffPanel } = setup("conflict", "notes/b.md");
    ed.onLeaveDetail();
    expect(showDiffPanel).not.toHaveBeenCalled();
  });

  it("a History editor just closes", () => {
    const { ed, showDiffPanel } = setup("history", "notes/a.md");
    ed.onLeaveDetail();
    expect(showDiffPanel).not.toHaveBeenCalled();
  });
});

// [←] after a save: a conflict goes to the Diff Panel (unchanged); two
// separate files just close (owner, 2026-10-12 — the panel is about conflicts).
describe("diff-editor — [←] after a save", () => {
  interface Exit {
    leaf: { detach: () => void };
    state: unknown;
    deps: unknown;
    onCommitExit(entry: unknown, opts?: { copyRemoved?: boolean }): void;
  }
  const setup = (siblingPath: string) => {
    const ed = Object.create(DiffEditorView.prototype) as Exit;
    const detach = vi.fn();
    const onEditorCommitted = vi.fn();
    const onCopyRemoved = vi.fn();
    ed.leaf = { detach };
    ed.state = { origin: "conflict", basePath: "notes/a.md", siblingPath, openMode: "user" };
    ed.deps = { onEditorCommitted, onCopyRemoved };
    return { ed, detach, onEditorCommitted, onCopyRemoved, entry: { basePath: "notes/a.md", siblingPath } };
  };

  // Owner, 2026-10-18: the panel must not show the row of a copy this [←]
  // removed, not even for a moment — it is told BEFORE this tab closes
  // (closing it is what brings the panel back on screen).
  it("🔑 the copy removed → the panel is told BEFORE the tab closes", () => {
    const copy = "notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md";
    const { ed, detach, onCopyRemoved, entry } = setup(copy);
    ed.onCommitExit(entry, { copyRemoved: true });
    expect(onCopyRemoved).toHaveBeenCalledWith(copy);
    expect(onCopyRemoved.mock.invocationCallOrder[0]).toBeLessThan(detach.mock.invocationCallOrder[0]);
  });

  it("the copy still there → the panel is not told anything", () => {
    const { ed, onCopyRemoved, entry } = setup("notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md");
    ed.onCommitExit(entry);
    expect(onCopyRemoved).not.toHaveBeenCalled();
  });

  it("a conflict → the Diff Panel", () => {
    const { ed, onEditorCommitted, entry } = setup("notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md");
    ed.onCommitExit(entry);
    expect(onEditorCommitted).toHaveBeenCalledWith("conflict", "notes/a.md");
  });

  it("🔑 two separate files → the tab just closes", () => {
    const { ed, detach, onEditorCommitted, entry } = setup("notes/b.md");
    ed.onCommitExit(entry);
    expect(detach).toHaveBeenCalled();
    expect(onEditorCommitted).not.toHaveBeenCalled();
  });
});

// Owner, 2026-10-18: a conflict resolved outside the editor is too late for
// any window — on focus / Ctrl+Cmd+R the tab just closes and the user lands
// in the Diff Panel.
describe("diff-editor — focus finds the conflict resolved outside", () => {
  it("🔑 no window: the tab closes, then the Diff Panel", async () => {
    const { ConflictResolvedModal } = await import("../../src/diff2/recovery-dialog");
    const prompt = vi.spyOn(ConflictResolvedModal.prototype, "prompt").mockResolvedValue(undefined as never);
    try {
      const ed = Object.create(DiffEditorView.prototype) as unknown as Record<string, unknown> & {
        refreshFromDisk(): Promise<void>;
      };
      const detach = vi.fn();
      const showDiffPanel = vi.fn();
      ed.entry = { basePath: "notes/a.md", siblingPath: "notes/a.conflict-from-Phone-2026-06-05T09-19-10Z.md" };
      ed.state = { origin: "conflict" };
      ed.leaf = { detach };
      ed.app = {};
      ed.deps = {
        vault: { adapter: { exists: async () => true } },
        isCopyResolved: async () => true,
        showDiffPanel,
      };
      await ed.refreshFromDisk();
      expect(prompt).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(1);
      expect(showDiffPanel).toHaveBeenCalledTimes(1);
    } finally {
      prompt.mockRestore();
    }
  });
});
