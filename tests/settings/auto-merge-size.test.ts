// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import {
  autoMergeSizeKbFromInput,
  autoMergeLimitBytes,
} from "../../src/settings/auto-merge-size";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";

// "Max size of auto-merged files" (owner, 2026-10-11). 0 is a real value:
// auto-merge OFF, every two-sided change goes to the user (NEW-DRAIN
// §II.1 rule 7). The field used to treat 0 as invalid and silently store
// the 1 MB default, so setting 0 changed nothing (field, ~/Obsidian-test).
describe("autoMergeSizeKbFromInput", () => {
  it("0 is stored as 0 — auto-merge off, not the default", () => {
    expect(autoMergeSizeKbFromInput("0")).toBe(0);
  });

  it("the field's KB are stored as typed", () => {
    expect(autoMergeSizeKbFromInput("1024")).toBe(1024);
    expect(autoMergeSizeKbFromInput(" 2048 ")).toBe(2048);
    expect(autoMergeSizeKbFromInput("1.4")).toBe(1);
  });

  it("an emptied field or a negative number is 0 (owner's rule)", () => {
    expect(autoMergeSizeKbFromInput("")).toBe(0);
    expect(autoMergeSizeKbFromInput("   ")).toBe(0);
    expect(autoMergeSizeKbFromInput("-5")).toBe(0);
  });

  it("anything that is not a number is 0 too", () => {
    expect(autoMergeSizeKbFromInput("abc")).toBe(0);
    expect(autoMergeSizeKbFromInput("Infinity")).toBe(0);
  });
});

// Like every other key: a missing one takes the default, 1024 KB = 1 MB.
// The old byte-valued `maxAutoMergeSizeBytes` of older builds is ignored.
describe("autoMergeLimitBytes", () => {
  it("defaults to 1024 KB = 1 MB", () => {
    expect(DEFAULT_SETTINGS.maxAutoMergedFileSizeKb).toBe(1024);
    expect(autoMergeLimitBytes({})).toBe(1_048_576);
  });

  it("KB → bytes; 0 stays 0, the engine's 'every conflict is manual'", () => {
    expect(autoMergeLimitBytes({ maxAutoMergedFileSizeKb: 2048 })).toBe(2_097_152);
    expect(autoMergeLimitBytes({ maxAutoMergedFileSizeKb: 0 })).toBe(0);
  });

  it("the old byte-valued key is ignored", () => {
    const legacy = { maxAutoMergeSizeBytes: 5 } as Record<string, unknown>;
    expect(autoMergeLimitBytes(legacy)).toBe(1_048_576);
  });
});
