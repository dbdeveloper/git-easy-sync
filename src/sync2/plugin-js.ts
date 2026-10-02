
// ⚰️ `isAtomicPluginFile`, `pluginDirFileRole` and `PluginDirFileRole`
// lived here until 2026-10-02. They were the OLD §28 resolver's idea of
// bundle atomicity — "styles.css follows main.js's winner" — and they
// had no caller after THE SWITCH.
//
// ⚠️ THE DECISION THEY CARRIED IS NOT DEAD, so read this before
// concluding atomicity was forgotten: the version resolver that
// replaced them (2026-10-02) decides a plugin-core COLLISION by
// `manifest.json`, and PLUGIN-UPDATE-COMPAT §5.12.5 records the limit
// in writing — a bundle that moved ONE-SIDEDLY (remote changed only
// main.js, local edited only styles.css) has no collision in either
// file, so each applies its own side and the bundle can still mix.
// Folder-level atomicity was considered and DEFERRED, not overlooked.

/**
 * Given a `<configDir>/plugins/<id>/...` path, return the plugin's
 * root folder (`<configDir>/plugins/<id>`). Used to locate the
 * sibling `manifest.json` carrying the plugin's semver. Returns
 * null when `path` doesn't sit under any plugin folder.
 */
export function pluginRootOf(
  path: string,
  configDir: string,
): string | null {
  const pluginsRoot = `${configDir}/plugins/`;
  if (!path.startsWith(pluginsRoot)) return null;
  const tail = path.slice(pluginsRoot.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return null;
  return `${configDir}/plugins/${tail.slice(0, slash)}`;
}

/**
 * Extract the `version` field from an Obsidian plugin manifest.
 * Tolerant: returns null on malformed JSON, missing field, or
 * non-string value (so callers fall back to mtime instead of
 * crashing on a borked manifest).
 */
export function readPluginVersion(manifestJson: string): string | null {
  try {
    const parsed = JSON.parse(manifestJson) as Record<string, unknown>;
    const v = parsed.version;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// ⚠️ `compareSemver` USED TO LIVE HERE and was deleted 2026-10-02.
// There is now exactly one semver comparison in the plugin
// (`./semver.ts`), because two encodings of one rule drift and the
// drift is silent — this file's version and the new one already
// disagreed about `1.0.0-beta` vs `1.0.0`.
//
// That disagreement was itself a decision, so it is recorded rather
// than lost: this version deliberately IGNORED pre-release tags and
// returned 0 ("we cannot know which beta is newer"), which handed the
// answer to the mtime tiebreak. The replacement orders them per semver
// 2.0.0 — a prerelease sorts BELOW the release it leads to — because
// that ordering is defined rather than guessed, and our own builds are
// published as `-beta`. A version string neither of them can parse
// still falls back to the clock.
