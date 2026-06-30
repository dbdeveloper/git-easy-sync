// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Helpers for sync2's plugin-js conflict resolution path. Obsidian
// plugin bundles (`<configDir>/plugins/<id>/main.js`) are minified
// single-line megabytes-of-text blobs — a 3-way text merge on them
// produces incoherent garbage that can crash Obsidian on load. Both
// the legacy plugin and sync2 (after porting this in) special-case
// `.js` files inside a plugin folder: pull-side conflicts are
// resolved atomically by the plugin's semver, falling back to mtime
// when semvers tie or can't be parsed. The mtime tie-break compares
// the LOCAL file's mtime against the remote file's LAST-CHANGE commit
// date (the commit that last touched that file) — NOT the branch HEAD
// date, which would wrongly favour the remote whenever HEAD advanced
// past the file (SYNC2 §7).
//
// Pure functions only — no I/O. Tested in plugin-js.test.ts. (The
// timestamps are gathered by readPluginJsContext in sync2-manager.ts,
// which calls client.getLatestCommitDateForPath for the "theirs" side.)

/**
 * Returns true if `path` lives inside the Obsidian plugins/<id>/
 * subtree AND is either a `.js` bundle or the plugin's
 * `manifest.json`. Both file types are version-coupled in a plugin
 * release: the bundle's API surface is paired with the manifest's
 * `version` field, so resolving them by anything other than that
 * version (or its mtime fallback) produces broken hybrids.
 *
 * Every other path — `styles.css`, user notes, etc. — goes through
 * the normal 3-way text merge.
 *
 * Examples (configDir = ".obsidian"):
 *   .obsidian/plugins/foo/main.js          → true
 *   .obsidian/plugins/foo/lib/util.js      → true (any depth)
 *   .obsidian/plugins/foo/manifest.json    → true
 *   .obsidian/plugins/foo/styles.css       → false (text merge)
 *   .obsidian/some/script.js               → false (not under plugins/)
 *   note.js                                → false (not under configDir)
 */
export function isAtomicPluginFile(
  path: string,
  configDir: string,
): boolean {
  const isJs = path.endsWith(".js");
  const isManifest = path.endsWith("/manifest.json");
  if (!isJs && !isManifest) return false;
  const pluginsRoot = `${configDir}/plugins/`;
  if (!path.startsWith(pluginsRoot)) return false;
  // Must have at least one path segment past `plugins/` before the
  // filename — i.e. `.obsidian/plugins/<id>/<...>`. A bare
  // `.obsidian/plugins/foo.js` doesn't fit any plugin and falls
  // back to text merge.
  const tail = path.slice(pluginsRoot.length);
  return tail.includes("/");
}

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

/**
 * Numeric semver compare for the "MAJOR.MINOR.PATCH" form plugins
 * publish. Pre-release tags ("1.0.0-beta") are split off and
 * ignored — a 1.0.0-beta vs 1.0.0 tie falls back to mtime, which is
 * the safe choice (we can't know which beta is newer without
 * out-of-band info). Non-numeric segments default to 0 to keep the
 * comparator total.
 *
 * Returns:
 *   negative if a < b
 *   zero      if a == b
 *   positive  if a > b
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): [number, number, number] => {
    // Strip a leading "v" and anything after a "-" / "+" marker
    // (pre-release / build metadata).
    const stripped = s
      .replace(/^v/, "")
      .replace(/[-+].*$/, "");
    const parts = stripped.split(".").map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  return a2 - b2;
}
