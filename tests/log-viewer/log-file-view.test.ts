// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { logFileViewerDeps, SILENT_LOG_SOURCE } from "../../src/log-viewer/log-file-view";

// LOG-VIEWER §2.23: a *.log clicked in the file explorer. Our CURRENT log
// is live from the logger, exactly as from Settings; any other file is
// polled and has no logger behind it — Settings → Logging never acts on it.
describe("logFileViewerDeps", () => {
  const adapter = { stat: async () => null, read: async () => "" };
  const logger = { recentLines: () => [], subscribe: () => () => {}, onLifecycle: () => () => {} };

  it("🔑 our current log → live, with the real logger", () => {
    const d = logFileViewerDeps("git-easy-sync-test.log", { adapter, ownLogPath: () => "git-easy-sync-test.log", logger: () => logger });
    expect(d.live).toBe(true);
    expect(d.logger()).toBe(logger);
    expect(d.logPath).toBe("git-easy-sync-test.log");
  });

  it("🔑 any other file → polled, the silent source (no lines, no Clean / off)", () => {
    const d = logFileViewerDeps("git-easy-sync-Mobile.log", { adapter, ownLogPath: () => "git-easy-sync-test.log", logger: () => logger });
    expect(d.live).toBe(false);
    expect(d.logger()).toBe(SILENT_LOG_SOURCE);
    expect(SILENT_LOG_SOURCE.recentLines()).toEqual([]);
  });
});
