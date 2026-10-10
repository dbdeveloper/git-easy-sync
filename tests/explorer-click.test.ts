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

const leaf = (file: string | null, activeTime: number) => ({ file, activeTime });

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
