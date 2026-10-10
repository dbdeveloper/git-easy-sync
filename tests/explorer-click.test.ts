// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner's field report (2026-10-10): with one of OUR tabs active (Diff
// Panel, …), clicking a file in the file tree that is already open in
// another tab did nothing. Our views are not navigable (navigation=false),
// so Obsidian re-opened the file into a visible tab that already showed it.
// Now the click is taken over in that one case: focus the existing tab.

import { describe, expect, it } from "vitest";
import { explorerClickTarget } from "../src/explorer-click";

const leaf = (file: string | null, activeTime: number, sidebar = false) => ({ file, activeTime, sidebar });

describe("explorerClickTarget", () => {
  it("🔑 our tab active + the file open elsewhere → that tab (the most recently used one)", () => {
    expect(
      explorerClickTarget({
        activeIsOurs: true,
        modifier: false,
        clicked: "notes/a.md",
        leaves: [leaf("notes/b.md", 5), leaf("notes/a.md", 3), leaf("notes/a.md", 9)],
      }),
    ).toBe(2);
  });

  // Owner's field report (same day): the first version picked the RIGHT
  // SIDEBAR — Backlinks / Outline / Tags keep the file they follow in their
  // state, so "a tab with this file" matched a sidebar view and opened the
  // sidebar. Sidebars never count.
  it("🔑 a SIDEBAR view that follows the file (Backlinks…) is never chosen", () => {
    expect(
      explorerClickTarget({
        activeIsOurs: true,
        modifier: false,
        clicked: "notes/a.md",
        leaves: [leaf("notes/a.md", 3), leaf("notes/a.md", 99, true)],
      }),
    ).toBe(0);
    expect(
      explorerClickTarget({
        activeIsOurs: true,
        modifier: false,
        clicked: "notes/a.md",
        leaves: [leaf("notes/a.md", 99, true)],
      }),
    ).toBeNull();
  });

  it("an ordinary tab is active → leave the click to Obsidian", () => {
    expect(
      explorerClickTarget({ activeIsOurs: false, modifier: false, clicked: "notes/a.md", leaves: [leaf("notes/a.md", 1)] }),
    ).toBeNull();
  });

  it("the file is not open anywhere → leave it to Obsidian (it opens it as usual)", () => {
    expect(
      explorerClickTarget({ activeIsOurs: true, modifier: false, clicked: "notes/a.md", leaves: [leaf("notes/b.md", 1)] }),
    ).toBeNull();
  });

  it("a modifier click (Ctrl/Cmd → new tab, …) → leave it to Obsidian", () => {
    expect(
      explorerClickTarget({ activeIsOurs: true, modifier: true, clicked: "notes/a.md", leaves: [leaf("notes/a.md", 1)] }),
    ).toBeNull();
  });
});

// Field diagnostic (2026-10-10): the handler saw only ONE tab per area. Obsidian's
// iterateLeaves STOPS as soon as the callback returns something truthy, and
// `(l) => leaves.push(l)` returns the new length. allLeaves must collect them all.
describe("allLeaves", () => {
  it("🔑 collects EVERY leaf from an iterator that stops on a truthy return (as Obsidian's does)", async () => {
    const { allLeaves } = await import("../src/explorer-click");
    const areas = [["a", "b", "c"], ["explorer"], ["backlinks", "outline"]];
    const workspace = {
      iterateAllLeaves(cb: (l: string) => unknown) {
        for (const area of areas) {
          for (const l of area) if (cb(l)) break;
        }
      },
    };
    expect(allLeaves(workspace)).toEqual(["a", "b", "c", "explorer", "backlinks", "outline"]);
  });
});
