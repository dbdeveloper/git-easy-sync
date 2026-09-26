// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { pluginsDataJsonToggleState } from "../../src/settings/toggle-rules";

describe("Sync plugins data.json is subordinate to Sync configs", () => {
  it("parent OFF ⇒ forced off AND unreachable, even with a stored true", () => {
    // The stored `true` is the case that matters: it is what a user who
    // once enabled data.json sync would carry into turning configs off.
    expect(pluginsDataJsonToggleState(false, true)).toEqual({
      value: false,
      disabled: true,
    });
    expect(pluginsDataJsonToggleState(false, false)).toEqual({
      value: false,
      disabled: true,
    });
  });

  it("🔑 parent ON only makes it REACHABLE — it never re-arms itself", () => {
    // The asymmetry is the whole point. Re-enabling config sync must not
    // silently resume publishing credentials the user switched off; the
    // stored value is honoured, not overridden, in this direction.
    expect(pluginsDataJsonToggleState(true, false)).toEqual({
      value: false,
      disabled: false,
    });
    expect(pluginsDataJsonToggleState(true, true)).toEqual({
      value: true,
      disabled: false,
    });
  });

  it("the OFF verdict does not depend on what was stored", () => {
    // Stated separately because it is the safety property: no input on
    // the `stored` axis can produce a lit toggle while the parent is off.
    for (const stored of [true, false]) {
      expect(pluginsDataJsonToggleState(false, stored).value).toBe(false);
    }
  });
});
