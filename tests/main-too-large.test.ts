// @vitest-environment happy-dom
//
// A file over GitHub's API limit (measured: 40 MiB) is left out of every
// commit (change-detector MAX_SYNC_FILE_BYTES).
//
// Owner, 2026-10-11 (supersedes "once per session"): the user must be nagged
// until they act. On EVERY commit pass, EACH such file gets its OWN pop-up,
// on screen for at least 5 s, telling them to add it to .gitignore. It stops
// by itself once the file is no longer a candidate — deleted, moved into an
// ignored folder, or matched by a .gitignore rule — because the size check
// sits AFTER the .gitignore check in the detector (see change-detector tests).
// The log WARN stays once per file per session: a one-minute interval would
// otherwise fill the log with the same line.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { recordedNotices, clearRecordedNotices } from "../mock-obsidian";

interface Handle {
  logger: { warn: (m: string, d?: unknown) => void; info: () => void };
  reportTooLarge(path: string, size: number): void;
}

function plugin(): { p: Handle; warn: ReturnType<typeof vi.fn> } {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as Handle;
  const warn = vi.fn();
  p.logger = { warn, info: () => {} };
  return { p, warn };
}

describe("a file too large for GitHub nags on every commit", () => {
  it("every pass: one pop-up per file, ≥ 5 s, naming the file, both sizes and the fix", () => {
    clearRecordedNotices();
    const { p } = plugin();
    p.reportTooLarge("PXL_20261009_080926016.TS.mp4", 213_890_092); // pass 1
    p.reportTooLarge("PXL_20261009_080926016.TS.mp4", 213_890_092); // pass 2
    expect(recordedNotices).toHaveLength(2);
    for (const n of recordedNotices) {
      const text = String(n.message);
      expect(text).toContain("PXL_20261009_080926016.TS.mp4");
      expect(text).toContain("214 MB");
      expect(text).toContain("40 MB");
      expect(text).toContain(".gitignore");
      expect(text).toContain("Settings");
      expect(n.duration ?? 0).toBeGreaterThanOrEqual(5000);
    }
  });

  it("each file gets its OWN pop-up", () => {
    clearRecordedNotices();
    const { p } = plugin();
    p.reportTooLarge("a.mp4", 150 * 1024 * 1024);
    p.reportTooLarge("b.mp4", 150 * 1024 * 1024);
    expect(recordedNotices.map((n) => String(n.message).includes("a.mp4") ? "a" : "b")).toEqual(["a", "b"]);
  });

  it("the log WARN is once per file per session (the pop-up is what repeats)", () => {
    clearRecordedNotices();
    const { p, warn } = plugin();
    p.reportTooLarge("a.mp4", 150 * 1024 * 1024);
    p.reportTooLarge("a.mp4", 150 * 1024 * 1024);
    p.reportTooLarge("a.mp4", 150 * 1024 * 1024);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(recordedNotices).toHaveLength(3);
  });
});
