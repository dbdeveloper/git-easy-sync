import { describe, it, expect } from "vitest";
import {
  pluginRootOf,
  readPluginVersion,
} from "../../src/sync2/plugin-js";


describe("pluginRootOf", () => {
  const cfg = ".obsidian";
  it("returns the plugin folder for nested paths", () => {
    expect(pluginRootOf(".obsidian/plugins/foo/main.js", cfg)).toBe(
      ".obsidian/plugins/foo",
    );
    expect(pluginRootOf(".obsidian/plugins/foo/lib/x.js", cfg)).toBe(
      ".obsidian/plugins/foo",
    );
  });
  it("returns null when path is not under plugins/<id>/", () => {
    expect(pluginRootOf(".obsidian/plugins/loose.js", cfg)).toBe(null);
    expect(pluginRootOf("note.md", cfg)).toBe(null);
  });
});

describe("readPluginVersion", () => {
  it("returns the version field on well-formed manifests", () => {
    expect(readPluginVersion('{"version":"1.2.3","id":"x"}')).toBe("1.2.3");
  });
  it("returns null on malformed JSON", () => {
    expect(readPluginVersion("not json")).toBe(null);
  });
  it("returns null when version is missing or non-string", () => {
    expect(readPluginVersion('{"id":"x"}')).toBe(null);
    expect(readPluginVersion('{"version":42}')).toBe(null);
    expect(readPluginVersion('{"version":""}')).toBe(null);
  });
});

// `compareSemver` moved to ../../src/sync2/semver.ts (2026-10-02) —
// one comparison for the whole plugin. Its table lives in
// semver.test.ts, including the case the two implementations
// disagreed about: `1.0.0-beta` now sorts BELOW `1.0.0` instead of
// tying with it.
