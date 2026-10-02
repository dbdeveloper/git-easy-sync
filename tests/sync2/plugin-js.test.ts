import { describe, it, expect } from "vitest";
import {
  isAtomicPluginFile,
  pluginDirFileRole,
  pluginRootOf,
  readPluginVersion,
} from "../../src/sync2/plugin-js";

describe("isAtomicPluginFile", () => {
  const cfg = ".obsidian";
  it("returns true for .js under .obsidian/plugins/<id>/", () => {
    expect(isAtomicPluginFile(".obsidian/plugins/foo/main.js", cfg)).toBe(
      true,
    );
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/lib/util.js", cfg),
    ).toBe(true);
    expect(
      isAtomicPluginFile(".obsidian/plugins/bar/dist/index.js", cfg),
    ).toBe(true);
  });
  it("returns true for manifest.json under .obsidian/plugins/<id>/", () => {
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/manifest.json", cfg),
    ).toBe(true);
    // Nested manifest.json too (rare but valid path).
    expect(
      isAtomicPluginFile(".obsidian/plugins/foo/sub/manifest.json", cfg),
    ).toBe(true);
  });
  it("returns false for other text files under a plugin folder", () => {
    expect(isAtomicPluginFile(".obsidian/plugins/foo/styles.css", cfg)).toBe(
      false,
    );
    expect(isAtomicPluginFile(".obsidian/plugins/foo/README.md", cfg)).toBe(
      false,
    );
  });
  it("returns false for .js or manifest.json outside a plugin folder", () => {
    expect(isAtomicPluginFile("scripts/build.js", cfg)).toBe(false);
    expect(isAtomicPluginFile(".obsidian/snippets/x.js", cfg)).toBe(false);
    expect(isAtomicPluginFile(".obsidian/plugins/loose.js", cfg)).toBe(false);
    expect(isAtomicPluginFile("manifest.json", cfg)).toBe(false);
  });
});

describe("pluginDirFileRole (§28)", () => {
  const cfg = ".obsidian";
  it("classifies the coupled bundle as 'code' (any depth)", () => {
    expect(pluginDirFileRole(".obsidian/plugins/foo/main.js", cfg)).toBe("code");
    expect(pluginDirFileRole(".obsidian/plugins/foo/manifest.json", cfg)).toBe("code");
    expect(pluginDirFileRole(".obsidian/plugins/foo/lib/util.js", cfg)).toBe("code");
    expect(pluginDirFileRole(".obsidian/plugins/foo/sub/manifest.json", cfg)).toBe("code");
  });
  it("classifies the top-level styles.css as 'styles'", () => {
    expect(pluginDirFileRole(".obsidian/plugins/foo/styles.css", cfg)).toBe("styles");
  });
  it("classifies the top-level data.json as 'data'", () => {
    expect(pluginDirFileRole(".obsidian/plugins/foo/data.json", cfg)).toBe("data");
  });
  it("does NOT treat a nested styles.css / data.json as the plugin's own", () => {
    // Only the top-level ones are synced + version-coupled.
    expect(pluginDirFileRole(".obsidian/plugins/foo/themes/styles.css", cfg)).toBe(null);
    expect(pluginDirFileRole(".obsidian/plugins/foo/state/data.json", cfg)).toBe(null);
  });
  it("returns null for other files and paths outside a plugin folder", () => {
    expect(pluginDirFileRole(".obsidian/plugins/foo/README.md", cfg)).toBe(null);
    expect(pluginDirFileRole(".obsidian/plugins/loose.js", cfg)).toBe(null);
    expect(pluginDirFileRole(".obsidian/snippets/x.js", cfg)).toBe(null);
    expect(pluginDirFileRole("note.md", cfg)).toBe(null);
  });
  it("respects a custom configDir", () => {
    expect(pluginDirFileRole(".obs-custom/plugins/foo/styles.css", ".obs-custom")).toBe("styles");
  });
});

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
