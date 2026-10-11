// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { autoMergeSizeBytesFromInput } from "../../src/settings/auto-merge-size";

// "Max size of auto-merged files" (owner, 2026-10-11). 0 is a real value:
// auto-merge OFF, every two-sided change goes to the user (NEW-DRAIN
// §II.1 rule 7). The field used to treat 0 as invalid and silently store
// the 1 MB default, so setting 0 changed nothing (field, ~/Obsidian-test).
describe("autoMergeSizeBytesFromInput", () => {
  it("0 is stored as 0 — auto-merge off, not the default", () => {
    expect(autoMergeSizeBytesFromInput("0")).toBe(0);
  });

  it("a size in KB is stored in bytes", () => {
    expect(autoMergeSizeBytesFromInput("1024")).toBe(1_048_576);
    expect(autoMergeSizeBytesFromInput(" 2048 ")).toBe(2_097_152);
    expect(autoMergeSizeBytesFromInput("1.5")).toBe(1536);
  });

  it("an emptied field or a negative number is 0 (owner's rule)", () => {
    expect(autoMergeSizeBytesFromInput("")).toBe(0);
    expect(autoMergeSizeBytesFromInput("   ")).toBe(0);
    expect(autoMergeSizeBytesFromInput("-5")).toBe(0);
  });

  it("anything that is not a number is 0 too", () => {
    expect(autoMergeSizeBytesFromInput("abc")).toBe(0);
    expect(autoMergeSizeBytesFromInput("Infinity")).toBe(0);
  });
});
