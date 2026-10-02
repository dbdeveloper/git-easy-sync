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
 * Role of a file inside `<configDir>/plugins/<id>/` for §28 conflict
 * resolution. The synced set of a plugin folder is gitignore-bounded
 * to exactly {main.js, manifest.json, styles.css, data.json} (see
 * gitignore-invariants.ts), and §28's absolute rule is that NONE of
 * them may ever produce a `*.conflict-from.*` sibling — they resolve
 * atomically instead. This predicate classifies which resolution rule
 * a path follows:
 *
 *   - "code"   → the version-coupled bundle: any `.js` (at any depth)
 *                or `manifest.json`. Resolved by plugin semver, then a
 *                canonical mtime tie-break. This is the old
 *                `isAtomicPluginFile` set.
 *   - "styles" → the top-level `styles.css`. Version-coupled to the
 *                bundle (updated JS may need updated CSS), so it FOLLOWS
 *                the "code" winner (§28 rule 1); only when the bundle is
 *                byte-identical on both sides does it fall back to its
 *                own mtime (§28 rule 3).
 *   - "data"   → the top-level `data.json` (synced only when the user
 *                opts in). Per-plugin state, resolved purely by mtime
 *                (§28 rule 4) — never version-coupled.
 *   - null     → anything else (normal 3-way / binary path).
 *
 * styles.css and data.json are matched only at the plugin root (a
 * nested `sub/styles.css` isn't the plugin's stylesheet and isn't
 * synced); `.js`/manifest.json match at any depth, mirroring
 * isAtomicPluginFile.
 */
export type PluginDirFileRole = "code" | "styles" | "data";

export function pluginDirFileRole(
  path: string,
  configDir: string,
): PluginDirFileRole | null {
  const pluginsRoot = `${configDir}/plugins/`;
  if (!path.startsWith(pluginsRoot)) return null;
  const tail = path.slice(pluginsRoot.length);
  const segs = tail.split("/");
  // Need at least `<id>/<file>`.
  if (segs.length < 2) return null;
  const name = segs[segs.length - 1];
  const isTopLevel = segs.length === 2;
  if (isTopLevel && name === "styles.css") return "styles";
  if (isTopLevel && name === "data.json") return "data";
  if (name.endsWith(".js") || name === "manifest.json") return "code";
  return null;
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
