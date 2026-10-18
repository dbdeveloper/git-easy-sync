// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { diskChangedSinceSeen, editorRefreshDecision } from "../../src/diff2/editor-tabs";

// Ctrl/Cmd+R / focus / a file event inside a diff editor: look at the disk again.
//   the conflict was resolved outside (copy gone / equal to its base)
//                                 → the tab closes, no window (owner, 2026-10-18);
//   base or copy changed on disk since the user last saw it
//                                 → ask "Files changed outside the editor"
//                                   [Reload and start over] / [Continue]
//                                   (owner, 2026-10-18);
//   nothing new                   → nothing happens.
describe("editorRefreshDecision", () => {
  it("🔑 resolved outside → close", () => {
    expect(editorRefreshDecision({ pair: true, resolved: true, fileGone: false, changedOnDisk: true })).toBe("close-resolved");
    expect(editorRefreshDecision({ pair: true, resolved: true, fileGone: false, changedOnDisk: false })).toBe("close-resolved");
  });

  it("🔑 changed on disk, still in conflict → ask", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: false, changedOnDisk: true })).toBe("ask-changed");
  });

  it("nothing changed → nothing", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: false, changedOnDisk: false })).toBe("nothing");
  });
});

// What "changed" means (owner, 2026-10-18): the disk differs from what the
// user saw LAST — the session start at first, then the disk at each answer
// in the window. Back at the session-start bytes → nothing to reload.
describe("diskChangedSinceSeen", () => {
  it("🔑 the disk moved away from the session start → changed", () => {
    expect(diskChangedSinceSeen({ start: "S", now: "N1", seen: null })).toBe(true);
  });

  it("🔑 the user already answered about exactly this disk → not again", () => {
    expect(diskChangedSinceSeen({ start: "S", now: "N1", seen: "N1" })).toBe(false);
  });

  it("🔑 it changed AGAIN after the answer → changed", () => {
    expect(diskChangedSinceSeen({ start: "S", now: "N2", seen: "N1" })).toBe(true);
  });

  it("back at the session-start bytes → nothing to reload", () => {
    expect(diskChangedSinceSeen({ start: "S", now: "S", seen: "N1" })).toBe(false);
    expect(diskChangedSinceSeen({ start: "S", now: "S", seen: null })).toBe(false);
  });
});

// Two SEPARATE files (owner, 2026-10-12): not a file and its own conflict
// copy — two ordinary files, or two copies of one file. Nothing about them is
// "resolved"; if one of them is gone the comparison cannot go on: "One of the
// files is gone" [Close].
describe("editorRefreshDecision — two separate files", () => {
  it("🔑 one of the files is gone → close with 'file gone'", () => {
    expect(editorRefreshDecision({ pair: false, resolved: false, fileGone: true, changedOnDisk: false })).toBe(
      "close-file-gone",
    );
  });

  it("'resolved' never applies to them", () => {
    expect(editorRefreshDecision({ pair: false, resolved: true, fileGone: false, changedOnDisk: false })).toBe(
      "nothing",
    );
  });

  it("changed on disk → ask, as for a conflict", () => {
    expect(editorRefreshDecision({ pair: false, resolved: false, fileGone: false, changedOnDisk: true })).toBe(
      "ask-changed",
    );
  });

  it("for a conflict pair a missing file is the conflict's business (copy gone = resolved; base gone = conflict goes on)", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: true, changedOnDisk: false })).toBe("nothing");
  });
});

