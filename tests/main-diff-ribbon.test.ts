// @vitest-environment happy-dom
//
// Owner, 2026-10-10: after every plugin reload the Diff ribbon icon jumped to
// the very top of the ribbon, and had to be dragged back next to Sync and
// Commit by hand. Obsidian remembers a ribbon item's place under
// `<plugin id>:<title>`, the title passed to addRibbonIcon — and that title
// carried the conflict COUNT ("Diff-Panel (2 files in conflict)"). Every load
// with a different count registered a "new" item with no saved place; the
// owner's workspace.json held three keys for the one icon.

import { describe, expect, it } from "vitest";
import GitHubSyncPlugin from "../src/main";

// Obsidian's DOM extensions, used for the count badge.
const proto = HTMLElement.prototype as unknown as {
  createSpan?: (o?: { cls?: string; text?: string }) => HTMLElement;
  setText?: (t: string) => void;
};
proto.setText ??= function (this: HTMLElement, t: string) {
  this.textContent = t;
};
proto.createSpan ??= function (this: HTMLElement, o) {
  const s = document.createElement("span");
  if (o?.cls) s.className = o.cls;
  if (o?.text) s.textContent = o.text;
  this.appendChild(s);
  return s;
};

interface RibbonHandle {
  addRibbonIcon(icon: string, title: string, cb: () => void): HTMLElement;
  conflictCounter: { getValue(): number };
  diffRibbonIcon: HTMLElement | null;
  diffRibbonConflictBadge: HTMLElement | null;
  showDiffRibbonIcon(): void;
}

function makePlugin(count: number): { p: RibbonHandle; titles: string[] } {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as RibbonHandle;
  const titles: string[] = [];
  p.addRibbonIcon = (_icon, title) => {
    titles.push(title);
    return document.createElement("div");
  };
  p.conflictCounter = { getValue: () => count };
  p.diffRibbonIcon = null;
  p.diffRibbonConflictBadge = null;
  return { p, titles };
}

describe("the Diff ribbon icon keeps its place", () => {
  it.each([0, 1, 2])(
    "registers under ONE stable title whatever the conflict count (%i); the count lives only in the tooltip",
    (count) => {
      const { p, titles } = makePlugin(count);
      p.showDiffRibbonIcon();
      expect(titles).toEqual(["Diff-Panel"]);
      const tooltip = p.diffRibbonIcon!.getAttribute("aria-label");
      if (count === 0) expect(tooltip).toBe("Diff-Panel");
      else expect(tooltip).toMatch(/^Diff-Panel \(\d file/);
    },
  );
});
