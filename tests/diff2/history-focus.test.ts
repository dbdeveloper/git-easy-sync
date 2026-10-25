// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { historyTakesFocus } from "../../src/diff2/diff-history-view";

// Owner, 2026-10-25: the History list often lost the keyboard (pale
// cursor, arrows dead) — a sync re-renders open History tabs QUIETLY, and
// the list took the focus back only if it had held it at that instant.
describe("historyTakesFocus — after a render", () => {
  it("a full render (opening) → yes", () => {
    expect(historyTakesFocus({ quiet: false, hadFocus: false, active: false })).toBe(true);
  });
  it("quiet, the list had the focus → yes", () => {
    expect(historyTakesFocus({ quiet: true, hadFocus: true, active: false })).toBe(true);
  });
  it("🔑 quiet, THIS tab is the active one → yes, even if the focus had slipped", () => {
    expect(historyTakesFocus({ quiet: true, hadFocus: false, active: true })).toBe(true);
  });
  it("quiet, another tab active, no focus here → no (never steal it)", () => {
    expect(historyTakesFocus({ quiet: true, hadFocus: false, active: false })).toBe(false);
  });
});
