// Cross-platform contracts — single home for the differences between
// the platforms `git-easy-sync` runs on. Each piece below used to
// live in a different module and was authored independently; adding a
// new platform constraint required touching N files and trusting
// nobody missed one. This module consolidates the lot so the
// invariant "any new cross-platform quirk goes here first" is
// enforceable by code review.
//
// Three concerns currently centralised (SYNC2 §3):
//
//   1. Filename character constraints (Obsidian Android rejects
//      `< > : " | ? * \` because of Windows FAT/NTFS compatibility;
//      Obsidian itself rejects `# ^ [ ]` because they collide with
//      wiki-link grammar). Canonicalised by sanitizeFilename().
//
//   2. URL-encoding for GitHub Contents-API paths. The endpoint
//      embeds the path in the URL, so URL-syntax characters in vault
//      paths (`?`, `#`, ` `, `%`, ...) need percent-encoding per
//      segment to avoid 404. Provided by encodePathForGithub().
//
//   3. Capacitor `adapter.rename` does not overwrite an existing
//      destination — iOS and Android throw "Destination file already
//      exists" where POSIX would silently overwrite. The portable
//      pattern is `if (exists(dst)) remove(dst); rename(src, dst)`.
//      Provided by safeRename().
//
// Future additions will likely include Platform.isDesktopApp /
// isMobile predicates (once the diff2 external-diff-tool work lands;
// see DIFF2_IMPLEMENTATION_PLAN.md R6). When that arrives, it goes
// here too.

import type { DataAdapter } from "obsidian";

// ── 1. Filename character constraints ─────────────────────────────

// Two distinct families:
//
// Family 1 — Windows FAT/NTFS-forbidden ASCII (`< > : " | ? * \`).
// Allowed by Desktop Obsidian (POSIX/APFS/NTFS-on-modern-Windows) but
// rejected by Obsidian Android's file-create path as a cross-platform-
// compatibility safeguard. The asymmetric failure motivated the
// 2026-05-25 filename-sanitizer hotfix (2.0.1-beta2).
//
// Family 2 — Obsidian-app-level forbidden across all platforms
// (`# ^ [ ]`). Obsidian Desktop AND Mobile reject file-create with
// these because they collide with wiki-link grammar
// (`[[note#heading]]`, `[[note^block-id]]`, `[[link]]`). The plugin
// can never see them in a local vault, but they can land on GitHub
// from outside (raw git, web UI, another tool) — pull-side handling
// is the only defence.
//
// Mapping was selected for visual fidelity in the original character's
// typographic role: curly quote for `"`, modifier-letter colon for
// `:`, fullwidth glyphs for the rest. All replacements are single
// Unicode codepoints outside both forbidden sets and accepted by
// every vault adapter we ship to.
export const FORBIDDEN_TO_CANONICAL: Record<string, string> = {
  // Family 1.
  '"': "“",   // U+201C LEFT DOUBLE QUOTATION MARK
  "<": "＜",  // U+FF1C FULLWIDTH LESS-THAN SIGN
  ">": "＞",  // U+FF1E FULLWIDTH GREATER-THAN SIGN
  ":": "꞉",   // U+A789 MODIFIER LETTER COLON
  "|": "｜",  // U+FF5C FULLWIDTH VERTICAL LINE
  "?": "？",  // U+FF1F FULLWIDTH QUESTION MARK
  "*": "＊",  // U+FF0A FULLWIDTH ASTERISK
  "\\": "＼", // U+FF3C FULLWIDTH REVERSE SOLIDUS
  // Family 2.
  "#": "＃",  // U+FF03 FULLWIDTH NUMBER SIGN
  "^": "＾",  // U+FF3E FULLWIDTH CIRCUMFLEX ACCENT
  "[": "［",  // U+FF3B FULLWIDTH LEFT SQUARE BRACKET
  "]": "］",  // U+FF3D FULLWIDTH RIGHT SQUARE BRACKET
};

// Anchored to the exact ASCII set so the cheap pre-check stays O(n)
// in path length without allocating a stripped copy when nothing
// matches. Built once; reused by sanitizeFilename + needsSanitization.
const FORBIDDEN_REGEX = /["<>:|?*\\#^\[\]]/;

// Returns the canonical form of `path`. Identity-equal (same string
// reference) when no forbidden char is present — the fast path
// matters because most vault paths are clean.
export function sanitizeFilename(path: string): string {
  if (!FORBIDDEN_REGEX.test(path)) return path;
  let out = "";
  for (const ch of path) {
    out += FORBIDDEN_TO_CANONICAL[ch] ?? ch;
  }
  return out;
}

// Cheap predicate — short-circuits as soon as one forbidden char is
// found. Use to gate work that's only relevant when a rename is
// actually needed (logging, queueing).
export function needsSanitization(path: string): boolean {
  return FORBIDDEN_REGEX.test(path);
}

// ── 2. GitHub Contents-API URL encoding ───────────────────────────

// Encode a vault path as a GitHub Contents-API URL segment. The
// `/repos/.../contents/<path>` endpoint embeds the path directly in
// the URL — characters that have URL syntax meaning (`?`, `#`, ` `,
// `%`, etc.) must be percent-encoded or the server truncates the
// path at the first syntax char and returns 404. `/` is the path
// separator and must NOT be encoded — encode per-segment and rejoin.
//
// Field bug reference (2026-05-25 — see SYNC2 §7.3): a
// file named `[1] File ^ opa?.md` pushed via GitHub Web UI was
// unreachable by pull because the raw `?` ended the URL path. The
// initial inline fix lived in `src/github/client.ts`; this module
// became its canonical home as part of the cross-platform contracts
// consolidation (SYNC2 §3).
//
// `encodeURIComponent` handles all the Family-1 and Family-2
// forbidden chars correctly. The chars it leaves un-encoded
// (unreserved per RFC 3986: `* ' ( ) ! ~`) are accepted by GitHub
// as URL-path bytes verbatim.
export function encodePathForGithub(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// ── 3. Adapter.rename portability ─────────────────────────────────

// Rename `src` to `dst`, removing `dst` first if it exists. On
// Capacitor (Obsidian Android + iOS) `adapter.rename` throws
// "Destination file already exists" when the destination is
// occupied — POSIX `rename` would silently overwrite. The
// `if (exists(dst)) remove(dst); rename(src, dst)` dance is the
// portable pattern; this helper makes it a one-liner at call sites
// and centralises the rationale.
//
// Use at every write-then-rename callsite in the codebase. Examples
// (all already follow the pattern; this just gives them a single
// canonical implementation to share):
//
//   - atomic-write.ts — promotes `.ges-tmp` staging file to its
//     final name during Pull-Replace (SYNC2 §2.3, Step 3).
//   - conflict-store.ts — persistRecord renames `meta.json.tmp` to
//     `meta.json` after every store mutation.
//   - pending-deletions-store.ts — same persistRecord pattern.
//
// Idempotent: calling safeRename(adapter, src, src) is undefined
// behaviour (you've asked the adapter to rename a file to itself);
// don't do that. Callers must ensure `src` and `dst` differ.
export async function safeRename(
  adapter: DataAdapter,
  src: string,
  dst: string,
): Promise<void> {
  if (await adapter.exists(dst)) {
    await adapter.remove(dst);
  }
  await adapter.rename(src, dst);
}
