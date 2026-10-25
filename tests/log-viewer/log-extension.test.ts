// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, vi } from "vitest";
import { switchLogExtension } from "../../src/log-viewer/log-extension";

// LOG-VIEWER §2.23: the "log" extension follows the setting. Obsidian
// throws when another plugin holds the extension; turning it off needs
// Obsidian's internal unregister — without it, a restart.
describe("switchLogExtension", () => {
  const taken = () => {
    throw new Error('Attempting to register an existing file extension "log"');
  };

  it("🔑 on: registered", () => {
    const register = vi.fn();
    expect(switchLogExtension(true, false, { register })).toEqual({ result: "ok", registered: true });
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("🔑 on, but another plugin holds 'log' → taken, not registered", () => {
    expect(switchLogExtension(true, false, { register: taken })).toEqual({ result: "taken", registered: false });
  });

  it("on and already registered → nothing more", () => {
    const register = vi.fn();
    expect(switchLogExtension(true, true, { register })).toEqual({ result: "ok", registered: true });
    expect(register).not.toHaveBeenCalled();
  });

  it("🔑 off: unregistered through Obsidian's internal API", () => {
    const unregister = vi.fn();
    expect(switchLogExtension(false, true, { register: vi.fn(), unregister })).toEqual({ result: "ok", registered: false });
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("🔑 off without that API → applies after a restart (still registered now)", () => {
    expect(switchLogExtension(false, true, { register: vi.fn() })).toEqual({ result: "restart", registered: true });
  });

  it("off and not registered → nothing", () => {
    const unregister = vi.fn();
    expect(switchLogExtension(false, false, { register: vi.fn(), unregister })).toEqual({ result: "ok", registered: false });
    expect(unregister).not.toHaveBeenCalled();
  });
});
