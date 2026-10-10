// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// A click on a file in Obsidian's file tree while one of OUR tabs is active
// (owner's field report, 2026-10-10). Our views are not navigable
// (navigation=false), so Obsidian looks for another VISIBLE tab that can show
// the file — and when that tab already shows it, nothing visibly happens, no
// matter how often the user clicks. In that case: focus the tab that already
// has the file (the most recently used one). Anything else — an ordinary tab
// active, the file open nowhere, a modifier click — stays Obsidian's.
// SIDEBAR views never count: Backlinks / Outline / Tags keep the file they
// follow in their state, and the first version opened the right sidebar.

export function explorerClickTarget(c: {
  activeIsOurs: boolean;
  modifier: boolean;
  clicked: string;
  leaves: Array<{ file: string | null; activeTime: number; sidebar: boolean }>;
}): number | null {
  if (!c.activeIsOurs || c.modifier) return null;
  let best: number | null = null;
  c.leaves.forEach((l, i) => {
    if (l.sidebar || l.file !== c.clicked) return;
    if (best === null || l.activeTime > c.leaves[best].activeTime) best = i;
  });
  return best;
}

// Every leaf of the workspace. ⚠️ Obsidian's iterateLeaves STOPS as soon as
// the callback returns something truthy — `(l) => leaves.push(l)` returns the
// new length, so it collected ONE tab per area (field diagnostic,
// 2026-10-10). The callback here returns nothing.
export function allLeaves<L>(workspace: {
  iterateAllLeaves(cb: (leaf: L) => unknown): void;
}): L[] {
  const out: L[] = [];
  workspace.iterateAllLeaves((leaf) => {
    out.push(leaf);
  });
  return out;
}
