// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { editorRefreshDecision } from "../../src/diff2/editor-tabs";

// Ctrl/Cmd+R inside a diff editor (owner, 2026-10-12): look at the disk again.
//   the conflict was resolved outside (copy gone / equal to its base)
//                                 → "resolved outside" [Close], tab closes;
//   base or copy changed on disk since the session started
//                                 → reopen as if the user opened it again: the
//                                   existing recovery window asks whether to
//                                   continue the saved edits or start over;
//   nothing changed               → nothing happens.
describe("editorRefreshDecision", () => {
  it("🔑 resolved outside → close (with the window)", () => {
    expect(editorRefreshDecision({ resolved: true, changedOnDisk: true })).toBe("close-resolved");
    expect(editorRefreshDecision({ resolved: true, changedOnDisk: false })).toBe("close-resolved");
  });

  it("🔑 changed on disk, still in conflict → reopen through recovery", () => {
    expect(editorRefreshDecision({ resolved: false, changedOnDisk: true })).toBe("reopen");
  });

  it("nothing changed → nothing", () => {
    expect(editorRefreshDecision({ resolved: false, changedOnDisk: false })).toBe("nothing");
  });
});
