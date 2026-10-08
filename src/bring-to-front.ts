// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// [Open] for a window that is already open must SHOW it (owner,
// 2026-10-08: "it can get lost among other windows, and then clicking
// [Open] does nothing").
//
// Pop-out window: `window.focus()` does not raise an Electron window.
// Obsidian raises its own pop-outs through the window's `electronWindow`
// (verified in obsidian-1.13.4.asar, WorkspaceWindow.focus):
//   e = this.win.electronWindow; e.isMinimized() && e.restore(); e.focus()
// `electronWindow` is not in the public API, so it is used only when it
// is there; otherwise the plain focus() is the best there is.
//
// Tab in the MAIN window: revealing it is not enough — the Settings
// dialog covers the main window, so Settings close first.

interface ElectronWindowLike {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export async function bringLeafToFront<L extends { view: { containerEl: { win: Window } } }>(
  leaf: L,
  deps: { mainWindow: Window; revealLeaf: (leaf: L) => Promise<void>; closeSettings: () => void },
): Promise<void> {
  const win = leaf.view.containerEl.win;
  if (win === deps.mainWindow) {
    deps.closeSettings();
    await deps.revealLeaf(leaf);
    return;
  }
  await deps.revealLeaf(leaf);
  const ew = (win as unknown as { electronWindow?: ElectronWindowLike }).electronWindow;
  if (ew) {
    if (ew.isMinimized()) ew.restore();
    ew.focus();
  } else {
    win.focus();
  }
}
