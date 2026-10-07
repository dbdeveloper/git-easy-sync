// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Where "View log" opens the viewer (owner, 2026-10-08). On desktop: its
// OWN window — an OS window, so it shows ABOVE the Settings dialog; close
// it and Settings are still there, or drag its tab into the main window
// to keep it. Phones have no pop-out windows and Settings cover the whole
// screen, so Settings are closed first and the log opens as a tab. An
// open viewer is brought forward, never doubled.
export type LogViewerTarget = "reveal" | "popout" | "close-settings-then-tab";

export function logViewerTarget(s: {
  hasOpenViewer: boolean;
  canPopout: boolean;
}): LogViewerTarget {
  if (s.hasOpenViewer) return "reveal";
  return s.canPopout ? "popout" : "close-settings-then-tab";
}
