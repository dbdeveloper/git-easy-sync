// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER §2.23 (owner, 2026-10-25): a *.log file clicked in the file
// explorer opens here — an ordinary tab of the main window (many logs
// must not multiply windows), registered for the "log" extension only
// while Settings → Logging → "Open any *.log file in the plugin log
// viewer" is on. The content is the same LogViewerPanel as everywhere.
// Our CURRENT log is live from the logger; any other file is polled. The
// tab closes when its file is gone; Esc does not close it (§2.24).

import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { LogViewerPanel, type LogViewerDeps } from "./log-viewer-panel";
import type { LogFileAdapter } from "./log-load";
import { keepLeafFocus } from "../ui/keep-focus";

export const LOG_FILE_VIEW_TYPE = "git-easy-sync-log-file";

// A log with no logger behind it: no recent lines, nothing live, no
// Settings → Logging events.
export const SILENT_LOG_SOURCE: ReturnType<LogViewerDeps["logger"]> = {
  recentLines: () => [],
  subscribe: () => () => {},
  onLifecycle: () => () => {},
};

export interface LogFileViewEnv {
  adapter: LogFileAdapter;
  ownLogPath: () => string; // where the plugin's logger writes now
  logger: LogViewerDeps["logger"];
}

export function logFileViewerDeps(path: string, env: LogFileViewEnv): LogViewerDeps {
  const live = path === env.ownLogPath();
  return {
    adapter: env.adapter,
    logPath: path,
    live,
    logger: live ? env.logger : () => SILENT_LOG_SOURCE,
  };
}

export class LogFileView extends FileView {
  private panel: LogViewerPanel | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly env: LogFileViewEnv,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LOG_FILE_VIEW_TYPE;
  }

  getIcon(): string {
    return "scroll-text";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "log";
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    keepLeafFocus(this, () => this.panel?.focus());
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.panel?.destroy();
    this.panel = new LogViewerPanel(logFileViewerDeps(file.path, this.env), {
      onClose: () => this.leaf.detach(),
    });
    await this.panel.mount(this.contentEl);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.panel?.destroy();
    this.panel = null;
  }
}
