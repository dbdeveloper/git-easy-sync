// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { DiffEditorView } from "../../src/diff2/diff-editor-view";

// Owner, 2026-10-12: EVERY time a diff-editor tab gets the focus it works as
// Ctrl/Cmd+R — a resolved conflict closes (window, then the Diff Panel), one
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
