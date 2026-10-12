// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { editorOpenDecision } from "../../src/diff2/editor-tabs";

// Opening a diff editor for a conflict already resolved outside it (owner,
// 2026-10-12) — its copy gone or byte-equal to its base:
//   the USER opened it        → no editor; "already resolved" [Continue];
//   Obsidian restored it, and it is the tab in FOCUS → "resolved outside"
//                               [Close], then it closes;
//   restored, not in focus    → closes silently.
// An unresolved conflict always mounts.
describe("editorOpenDecision", () => {
  it("unresolved → mount, however it was opened", () => {
    expect(editorOpenDecision({ resolved: false, userOpened: true, focused: true })).toBe("mount");
    expect(editorOpenDecision({ resolved: false, userOpened: false, focused: false })).toBe("mount");
  });

  it("🔑 resolved + opened by the user → tell them it is already resolved", () => {
    expect(editorOpenDecision({ resolved: true, userOpened: true, focused: true })).toBe("notify-already-resolved");
  });

  it("🔑 resolved + restored + in focus → tell them, then close", () => {
    expect(editorOpenDecision({ resolved: true, userOpened: false, focused: true })).toBe("notify-resolved-outside");
  });

  it("resolved + restored + not in focus → close silently", () => {
    expect(editorOpenDecision({ resolved: true, userOpened: false, focused: false })).toBe("close-silently");
  });
});
