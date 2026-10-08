// Owner, 2026-10-08: pressing [Open] for an already open viewer must
// actually SHOW it — a pop-out lost behind other windows (or minimized)
// is raised, a tab in the main window is not left under Settings.
import { describe, expect, it } from "vitest";
import { bringLeafToFront } from "../src/bring-to-front";

function setup(where: "main" | "popout", opts: { minimized?: boolean; electron?: boolean } = {}) {
  const calls: string[] = [];
  const mainWin = { focus: () => calls.push("main.focus") } as unknown as Window;
  const electronWindow = {
    isMinimized: () => opts.minimized ?? false,
    restore: () => calls.push("restore"),
    focus: () => calls.push("electron.focus"),
  };
  const popWin = {
    focus: () => calls.push("win.focus"),
    ...(opts.electron === false ? {} : { electronWindow }),
  } as unknown as Window;
  const leaf = { view: { containerEl: { win: where === "main" ? mainWin : popWin } } };
  const deps = {
    mainWindow: mainWin,
    revealLeaf: async () => {
      calls.push("reveal");
    },
    closeSettings: () => calls.push("closeSettings"),
  };
  return { calls, leaf, deps };
}

describe("bringLeafToFront", () => {
  it("🔑 pop-out: revealed, then its OS window raised the way Obsidian does it; Settings stay", async () => {
    const s = setup("popout");
    await bringLeafToFront(s.leaf, s.deps);
    expect(s.calls).toEqual(["reveal", "electron.focus"]);
  });

  it("🔑 a minimized pop-out is restored first", async () => {
    const s = setup("popout", { minimized: true });
    await bringLeafToFront(s.leaf, s.deps);
    expect(s.calls).toEqual(["reveal", "restore", "electron.focus"]);
  });

  it("no electronWindow (not Electron, or Obsidian changed it): plain window.focus()", async () => {
    const s = setup("popout", { electron: false });
    await bringLeafToFront(s.leaf, s.deps);
    expect(s.calls).toEqual(["reveal", "win.focus"]);
  });

  it("🔑 a tab in the MAIN window: Settings close first, or the tab stays under them", async () => {
    const s = setup("main");
    await bringLeafToFront(s.leaf, s.deps);
    expect(s.calls).toEqual(["closeSettings", "reveal"]);
  });
});
