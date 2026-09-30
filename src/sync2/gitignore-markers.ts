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
// THE FIX. The BEGIN marker carries the plugin version, and a plugin
// leaves alone any section stamped NEWER than itself. The cycle then has
// nowhere to go: the older device writes nothing, the newer one is
// already canonical.
//
// 🔒 WHAT IS FROZEN IS THE RECOGNIZER, NOT THE LINE. This is the same
// compatibility contract DOT-FILES §3.1.3 states for the literal text,
// moved up one level: the regexp must keep matching BOTH the pre-stamp
// form (everything already on disk and in every repo) and the stamped
// one. Narrowing it later has exactly the consequence the frozen literal
// had — an existing section stops being recognised, a second one is
// appended, and the stale block can override the fresh one by
// last-match-wins.
//
// ⚠️ END IS NOT VERSIONED, deliberately. Two carriers of one value would
// need a rule for what happens when they disagree (a hand edit, a torn
// write, a merged foreign tail) and there is nothing to derive that rule
// from. A versioned END would also have to be matched loosely, or a
// section whose BEGIN is new and whose END is old would never pair and
// would orphan. Unversioned, the END line is byte-identical across all
// versions — it is the one part that always pairs.

import { compareSemver } from "./semver";

export type SectionKind = "invariants" | "final";

// The line we WRITE. `version === null` produces the pre-stamp spelling
// byte for byte — that is what makes the change backward-compatible in
// the only direction that matters: what is already on disk.
export function beginMarker(kind: SectionKind, version: string | null): string {
  const stamp = version === null ? "" : `v${version} `;
  return `# ===== git-easy-sync ${kind} ${stamp}- DO NOT EDIT =====`;
}

export function endMarker(kind: SectionKind): string {
  return `# ===== end of git-easy-sync ${kind} =====`;
}

// 🔒 THE FROZEN RECOGNIZER. The version group is optional; anything else
// is exact. `[^\s]+` rather than a semver shape on purpose: a stamp we
// cannot parse must still be RECOGNISED as our marker (so the section is
// replaced rather than duplicated) — judging whether it is a usable
// version is a separate question, answered in `newerSectionVersion`.
const BEGIN_RE =
  /^# ===== git-easy-sync (invariants|final) (?:v([^\s]+) )?- DO NOT EDIT =====$/;

export function beginPattern(kind: SectionKind): RegExp {
  return new RegExp(
    `^# ===== git-easy-sync ${kind} (?:v[^\\s]+ )?- DO NOT EDIT =====$`,
  );
}

export function parseBeginMarker(
  line: string,
): { kind: SectionKind; version: string | null } | null {
  const m = BEGIN_RE.exec(line.replace(/\s+$/, ""));
  if (m === null) return null;
  return { kind: m[1] as SectionKind, version: m[2] ?? null };
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
export function newerSectionVersion(
  content: string,
  ownVersion: string,
): string | null {
  let newest: string | null = null;
  for (const line of content.split("\n")) {
    const m = parseBeginMarker(line);
    if (m === null || m.version === null) continue;
    if (compareSemver(m.version, ownVersion) !== 1) continue;
    if (newest === null || compareSemver(m.version, newest) === 1) {
      newest = m.version;
    }
  }
  return newest;
}
