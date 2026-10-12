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
    expect(editorRefreshDecision({ pair: true, resolved: true, fileGone: false, changedOnDisk: true })).toBe("close-resolved");
    expect(editorRefreshDecision({ pair: true, resolved: true, fileGone: false, changedOnDisk: false })).toBe("close-resolved");
  });

  it("🔑 changed on disk, still in conflict → reopen through recovery", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: false, changedOnDisk: true })).toBe("reopen");
  });

  it("nothing changed → nothing", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: false, changedOnDisk: false })).toBe("nothing");
  });
});

// Two SEPARATE files (owner, 2026-10-12): not a file and its own conflict
// copy — two ordinary files, or two copies of one file. Nothing about them is
// "resolved"; if one of them is gone the comparison cannot go on: "One of the
// files is gone" [Exit].
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

  it("changed on disk → reopen through recovery, as for a conflict", () => {
    expect(editorRefreshDecision({ pair: false, resolved: false, fileGone: false, changedOnDisk: true })).toBe(
      "reopen",
    );
  });

  it("for a conflict pair a missing file is the conflict's business (copy gone = resolved; base gone = conflict goes on)", () => {
    expect(editorRefreshDecision({ pair: true, resolved: false, fileGone: true, changedOnDisk: false })).toBe("nothing");
  });
});

