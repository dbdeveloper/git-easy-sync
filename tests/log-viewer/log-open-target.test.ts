// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { logViewerTarget } from "../../src/log-viewer/log-open-target";

// Owner, 2026-10-08: on desktop the log opens in its OWN window, above
// Settings (close it → back in Settings; or drag its tab into the main
// window). Phones have no pop-out windows: a FULL-SCREEN modal above
// Settings (closing it returns to Settings). An open viewer is shown,
// never doubled.
describe("logViewerTarget", () => {
  it("🔑 an open viewer is revealed — never a second one", () => {
    expect(logViewerTarget({ hasOpenViewer: true, canPopout: true })).toBe("reveal");
    expect(logViewerTarget({ hasOpenViewer: true, canPopout: false })).toBe("reveal");
  });

  it("🔑 desktop: a pop-out window", () => {
    expect(logViewerTarget({ hasOpenViewer: false, canPopout: true })).toBe("popout");
  });

  it("🔑 phone: a full-screen modal above Settings", () => {
    expect(logViewerTarget({ hasOpenViewer: false, canPopout: false })).toBe("modal");
  });
});
