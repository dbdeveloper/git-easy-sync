// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The shape of our managed-section markers, and the ONE rule that keeps
// two plugin versions from fighting over them (PLUGIN-UPDATE-COMPAT
// §5.11, owner's decision 2026-09-30).
//
// THE DEFECT. Markers used to be identical in every version of the
// plugin, so a device on v1 met v2's body, found it "not canonical",
// rewrote it and pushed; the v2 device did the same in reverse, on every
// sync of every device, forever. `.obsidian/` resolves collisions
// silently (§II.1 п.3.b), so the user would see an endless run of
// `.gitignore` commits with nothing to explain them. Derived from the
// code, never observed — the plugin rename accidentally shielded us,
// because two DIFFERENT marker texts simply coexist.
//
// THE FIX. Each section carries the plugin version, and a plugin leaves
// alone any file stamped NEWER than itself. The cycle then has nowhere to
// go: the older device writes nothing, the newer one is already canonical.
//
// ⚙️ 2026-10-24 (owner): the version is NOT in the BEGIN marker any more —
// it is the line right under it (see "The VERSION LINE" below). BEGIN and
// END are now both CONSTANT, byte-identical in every version, and are
// recognised by exact text only. No public release ever had a version in
// BEGIN (the last release, 2.0.2-beta, predates the stamp), so the old
// stamped spelling is not recognised at all: on a dev vault it is left in
// the user's zone as plain text (owner: acceptable).

import { compareSemver } from "./semver";

export type SectionKind = "invariants" | "final";

export function beginMarker(kind: SectionKind): string {
  return `# ===== git-easy-sync ${kind} - DO NOT EDIT =====`;
}

export function endMarker(kind: SectionKind): string {
  return `# ===== end of git-easy-sync ${kind} =====`;
}

// Exact BEGIN, trailing whitespace aside (git ignores it too).
const BEGIN_RE = /^# ===== git-easy-sync (invariants|final) - DO NOT EDIT =====$/;

export function beginPattern(kind: SectionKind): RegExp {
  return new RegExp(`^# ===== git-easy-sync ${kind} - DO NOT EDIT =====$`);
}

export function parseBeginMarker(line: string): { kind: SectionKind } | null {
  const m = BEGIN_RE.exec(line.replace(/\s+$/, ""));
  return m === null ? null : { kind: m[1] as SectionKind };
}

// ── The VERSION LINE (owner, 2026-10-24) ────────────────────────────
//
// Since 2026-10-24 the BEGIN marker is written WITHOUT a version, and the
// version sits in its own line right under it:
//
//   # ===== git-easy-sync final - DO NOT EDIT =====
//   # ===== plugin version: 2.0.9-beta        =====
//
// Field finding (three vaults, one repo): a user rule added right above
// `final` on one device and a version bump of that very BEGIN line on
// another are changes to ADJACENT lines, and the drain's line merge made a
// `.gitignore.conflict-from-*` — after every release, for any device with
// an unsynced edit near a marker. A BEGIN line that never changes is a
// constant between the user's zone and the line that does.
//
// Aligned: the closing `=====` sits under the BEGIN marker's (owner); a
// version too long for that keeps one space. Recognised by PATTERN, any
// version and any padding, so another version's line is REPLACED, not
// duplicated — the same reason BEGIN is matched by pattern.
const VERSION_LINE_RE = /^# ===== plugin version: ([^\s]+) +=====$/;

export function versionLine(kind: SectionKind, version: string): string {
  const width = beginMarker(kind).length;
  const head = `# ===== plugin version: ${version} `;
  const tail = "=====";
  return head.length + tail.length >= width
    ? `${head}${tail}`
    : `${head}${" ".repeat(width - head.length - tail.length)}${tail}`;
}

export function versionLinePattern(): RegExp {
  return VERSION_LINE_RE;
}

// The version in a version line, or null when the line is not one.
export function parseVersionLine(line: string): string | null {
  const m = VERSION_LINE_RE.exec(line.replace(/\s+$/, ""));
  return m === null ? null : m[1];
}


// ── Files that are OURS OUTRIGHT ────────────────────────────────────
//
// `<configDir>/plugins/<self>/.gitignore` has no sections: every byte of
// it is ours and it is rewritten whole. So there is no marker PAIR to
// stamp — but the file travels between devices like any other, and two
// builds with different constants would rewrite it for each other
// forever, in the one file the section rule cannot reach.
//
// It gets a HEADER instead (owner, 2026-09-30): a line that says what
// the file is — so a reader who opens it is not left guessing — and
// carries the same version stamp, which brings the file under the same
// yield rule. `ownedFileHeader` is its only writer.
//
// 🔒 The recognizer below is frozen on the same terms as the section
// one: the version group is optional so a future unstamped spelling
// still reads as ours, and narrowing it orphans every file already
// written.
const OWNED_HEADER_RE =
  /^# ===== git-easy-sync (?:v([^\s]+) )?- managed file, DO NOT EDIT =====$/;

export function ownedFileHeader(version: string | null): string[] {
  const stamp = version === null ? "" : `v${version} `;
  return [
    `# ===== git-easy-sync ${stamp}- managed file, DO NOT EDIT =====`,
    "# This is the plugin's own folder. Everything here is local state -",
    "# your token, the sync queue, conflict records - and must never",
    "# leave this device. Only the files that ARE the plugin travel.",
    "# Edit the plugin's settings, not this file: it is rewritten whole",
    "# on every load.",
  ];
}

// The version stamped in an owned-file header line, or null when the
// line is not one.
export function parseOwnedFileHeader(line: string): string | null {
  const m = OWNED_HEADER_RE.exec(line.replace(/\s+$/, ""));
  if (m === null) return null;
  return m[1] ?? null;
}

// ── Our two lines inside SOMEONE ELSE'S file ────────────────────────
//
// A third-party plugin's own `.gitignore` gets a silencer when
// syncConfigDir is OFF: our comment, then `*`. The comment IS the
// signature — there are no markers in a file that is not ours.
//
// ⚠️ Recognition here is worth MORE than in our own files, and the
// measurement (2026-09-30) says why: with exact-text matching, two
// builds whose comments differ do not alternate — they ACCUMULATE, two
// lines per pass, in a file belonging to someone else. And a build
// asked to REMOVE another version's silencer cannot see it, so the `*`
// stays and keeps that plugin's folder hidden on every device. Both are
// worse than the ping-pong the section rule exists for.
//
// So the fix here is recognition alone, and deliberately NOT a yield:
// when a recognised pair is already present and wanted, we leave it
// exactly as we found it, whatever version wrote it. Rewriting it to
// our own spelling would be a rewrite war in a file we promised to
// touch minimally.
//
// 🔒 Frozen on the same terms as the other two recognizers: the version
// group is optional, so the pre-stamp spelling — the one on every disk
// today — still reads as ours.
const FOREIGN_SILENCER_RE =
  /^# syncConfigDir is OFF on this device \(git-easy-sync(?: v([^\s)]+))?\)\.$/;

export function foreignSilencerComment(version: string | null): string {
  const stamp = version === null ? "" : ` v${version}`;
  return `# syncConfigDir is OFF on this device (git-easy-sync${stamp}).`;
}

// The version stamped in our silencer comment, `null` when the line is
// ours but unstamped, and `undefined` when the line is not ours at all.
// Three outcomes, because "not ours" and "ours, no version" must not
// collapse: the first means keep your hands off, the second means we
// wrote it before stamps existed.
export function parseForeignSilencer(
  line: string,
): { version: string | null } | null {
  const m = FOREIGN_SILENCER_RE.exec(line.replace(/\s+$/, ""));
  if (m === null) return null;
  return { version: m[1] ?? null };
}

// The version that tells us to keep our hands off this file, or null
// when we may write.
//
// PER FILE, not per section — which is the owner's rule («старіший
// плагін не оновлюватиме ці умови взагалі») and also the only shape that
// is safe to implement: the two sections share lines, and rewriting one
// while preserving the other would have the bottom pass purge a line out
// of the section we promised not to touch.
//
// Two directions, both chosen rather than fallen into:
//   - NO stamp reads as v0, so we win. The opposite would freeze every
//     file written before the stamp existed, with nothing to thaw it.
//   - AN UNREADABLE stamp does not win either. Yielding to garbage
//     leaves a state with no automatic way out (the same reasoning
//     §7.1.1 applies to a corrupt manifest); overwriting it restores a
//     canonical stamp on the spot.
// ONE function for every managed file, whichever way it is stamped: a
// section's version line or an owned file's header. The caller does not
// have to know which kind of file it holds, and a new kind of stamp is
// added here rather than at each call site.
export function newerVersionIn(
  content: string,
  ownVersion: string,
): string | null {
  let newest: string | null = null;
  for (const line of content.split("\n")) {
    // A section's version line, or an owned file's header.
    const version = parseVersionLine(line) ?? parseOwnedFileHeader(line);
    if (version === null) continue;
    if (compareSemver(version, ownVersion) !== 1) continue;
    if (newest === null || compareSemver(version, newest) === 1) {
      newest = version;
    }
  }
  return newest;
}
