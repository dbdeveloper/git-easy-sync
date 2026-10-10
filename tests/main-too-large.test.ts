// @vitest-environment happy-dom
//
// Owner, 2026-10-11: a file over GitHub's 100 MB API limit is left out of the
// commit (change-detector MAX_SYNC_FILE_BYTES). The user must be told — but
// with the interval sync running every minute, a toast per pass would be
// spam. Once per file per session: the log line and one pop-up.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { recordedNotices, clearRecordedNotices } from "../mock-obsidian";

interface Handle {
  logger: { warn: (m: string, d?: unknown) => void; info: () => void };
  reportTooLarge(path: string, size: number): void;
}

describe("a file too large for GitHub is reported once per session", () => {
  it("first time: a WARN and a pop-up naming the file and both sizes; the same file again: silence", () => {
    clearRecordedNotices();
    const p = Object.create(GitHubSyncPlugin.prototype) as unknown as Handle;
    const warn = vi.fn();
    p.logger = { warn, info: () => {} };

    p.reportTooLarge("PXL_20261009_080926016.TS.mp4", 213_890_092);
    p.reportTooLarge("PXL_20261009_080926016.TS.mp4", 213_890_092);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(recordedNotices).toHaveLength(1);
    const text = String(recordedNotices[0].message);
    expect(text).toContain("PXL_20261009_080926016.TS.mp4");
    expect(text).toContain("204 MB");
    expect(text).toContain("100 MB");
  });

  it("another file still gets its own report", () => {
    clearRecordedNotices();
    const p = Object.create(GitHubSyncPlugin.prototype) as unknown as Handle;
    p.logger = { warn: vi.fn(), info: () => {} };
    p.reportTooLarge("a.mp4", 150 * 1024 * 1024);
    p.reportTooLarge("b.mp4", 150 * 1024 * 1024);
    expect(recordedNotices).toHaveLength(2);
  });
});
