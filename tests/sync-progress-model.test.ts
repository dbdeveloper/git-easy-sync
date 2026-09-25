// §II.16 — the notice text, as a pure model.
//
// Every rule here is about what is ABSENT, and absence is exactly what
// eyeballing a running sync cannot verify: you see the case in front of
// you, never the three that were correctly hidden.

import { describe, it, expect } from "vitest";
import {
  progressNoticeText,
  syncSummaryText,
} from "../src/sync-progress-model";

const nums = (over?: Partial<Parameters<typeof progressNoticeText>[0]>) => ({
  pullDone: 0,
  pullTotal: 0,
  pushDone: 0,
  pushTotal: 0,
  conflicts: 0,
  ...over,
});

describe("progressNoticeText", () => {
  it("before any counter arrives, the header stands ALONE", () => {
    // The commit pass is still running and the drain has reported
    // nothing. "Working on it" is the honest statement; inventing
    // "0 of 0" to fill the space would read as stuck.
    expect(progressNoticeText(nums())).toBe("Syncing with GitHub");
  });

  it("a push-only sync carries NO download line", () => {
    // A line that never moves reads as a hang — the opposite of what a
    // progress display is for.
    expect(progressNoticeText(nums({ pushDone: 3, pushTotal: 5 }))).toBe(
      "Syncing with GitHub\nUploading 3 of 5",
    );
  });

  it("a pull-only sync carries NO upload line", () => {
    expect(progressNoticeText(nums({ pullDone: 2, pullTotal: 10 }))).toBe(
      "Syncing with GitHub\nDownloading 2 of 10",
    );
  });

  it("both directions at once — the shape this engine actually produces", () => {
    // Pull and push interleave here; there is no "first all down, then
    // all up" phase to report, so both counters are live together.
    expect(
      progressNoticeText(
        nums({ pullDone: 2, pullTotal: 10, pushDone: 3, pushTotal: 5 }),
      ),
    ).toBe("Syncing with GitHub\nDownloading 2 of 10\nUploading 3 of 5");
  });

  it("the conflict line appears only when there ARE conflicts, and is singular at one", () => {
    expect(progressNoticeText(nums({ conflicts: 0 }))).not.toContain("⚠");
    expect(progressNoticeText(nums({ conflicts: 1 }))).toContain(
      "⚠ 1 file needs resolving",
    );
    expect(progressNoticeText(nums({ conflicts: 2 }))).toContain(
      "⚠ 2 files need resolving",
    );
  });

  it("no git vocabulary anywhere — the words are for someone who never used it", () => {
    const text = progressNoticeText(
      nums({ pullDone: 1, pullTotal: 2, pushDone: 1, pushTotal: 2, conflicts: 1 }),
    );
    for (const jargon of ["pull", "push", "commit", "branch", "repo"]) {
      expect(text.toLowerCase(), jargon).not.toContain(jargon);
    }
  });
});

describe("syncSummaryText", () => {
  it("all three zero → the bare message, no empty clauses", () => {
    // "Sync done — 0 sent, 0 received" is noise dressed as information.
    expect(syncSummaryText({ sent: 0, received: 0, conflicts: 0 })).toBe(
      "Sync done",
    );
  });

  it("one clause per NON-ZERO number, in a fixed order", () => {
    expect(syncSummaryText({ sent: 6, received: 0, conflicts: 0 })).toBe(
      "Sync done — 6 sent",
    );
    expect(syncSummaryText({ sent: 0, received: 2, conflicts: 0 })).toBe(
      "Sync done — 2 received",
    );
    expect(syncSummaryText({ sent: 0, received: 0, conflicts: 3 })).toBe(
      "Sync done — 3 in conflict",
    );
  });

  it("every combination joins with a comma, keeping the order sent → received → conflict", () => {
    expect(syncSummaryText({ sent: 6, received: 2, conflicts: 0 })).toBe(
      "Sync done — 6 sent, 2 received",
    );
    expect(syncSummaryText({ sent: 6, received: 0, conflicts: 3 })).toBe(
      "Sync done — 6 sent, 3 in conflict",
    );
    expect(syncSummaryText({ sent: 0, received: 2, conflicts: 3 })).toBe(
      "Sync done — 2 received, 3 in conflict",
    );
    expect(syncSummaryText({ sent: 6, received: 2, conflicts: 3 })).toBe(
      "Sync done — 6 sent, 2 received, 3 in conflict",
    );
  });
});
