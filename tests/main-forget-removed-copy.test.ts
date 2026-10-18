// @vitest-environment happy-dom
//
// Owner, 2026-10-18: a copy that the diff editor's [←] removed leaves the
// Diff Panel's list at once — the editor tells main.ts, main.ts tells every
// open panel, before the editor tab closes. This file pins the main.ts hop.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { DiffPanelView, DIFF2_PANEL_VIEW_TYPE } from "../src/diff2/diff-panel-view";

const COPY = "notes/a.conflict-from-Phone-2026-10-18T10-00-00Z.md";

describe("main.ts passes a copy [←] removed to the Diff Panel", () => {
  it("🔑 every open panel forgets that copy", () => {
    const p = Object.create(GitHubSyncPlugin.prototype) as unknown as {
      app: unknown;
      forgetRemovedCopy(siblingPath: string): void;
    };
    const panel = Object.create(DiffPanelView.prototype) as DiffPanelView;
    const forgetCopy = vi.fn();
    (panel as unknown as { forgetCopy: unknown }).forgetCopy = forgetCopy;
    p.app = {
      workspace: {
        getLeavesOfType: (type: string) => (type === DIFF2_PANEL_VIEW_TYPE ? [{ view: panel }] : []),
      },
    };
    p.forgetRemovedCopy(COPY);
    expect(forgetCopy).toHaveBeenCalledWith(COPY);
  });

  it("no panel open → nothing happens", () => {
    const p = Object.create(GitHubSyncPlugin.prototype) as unknown as {
      app: unknown;
      forgetRemovedCopy(siblingPath: string): void;
    };
    p.app = { workspace: { getLeavesOfType: () => [] } };
    expect(() => p.forgetRemovedCopy(COPY)).not.toThrow();
  });
});
