// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Conflict-branch naming helper. See docs/PSEUDO-MERGE-MODE.md §4.3
// for the per-device branch lifecycle and §10 Scenarios A–E for the
// shape of the names in context.
//
// Pure function. Returns a bare branch name (no `refs/heads/`
// prefix) with the shape:
//
//   <plugin-id>-conflicts-<deviceLabel>-<YYYYMMDDHHMMSS>-<mmm>
//
// Examples (with plugin id "git-easy-sync"):
//   git-easy-sync-conflicts-Obsidian-20260520143022-847
//   git-easy-sync-conflicts-Phone-20260601090015-003
//
// The msec suffix guards against cross-device sub-second collisions
// (two devices, both with the default `"Obsidian"` label, hitting
// drain at the same second). On the 422 "Reference already exists"
// edge, callers re-generate with a freshly-clocked now() — the
// chance of a second collision is vanishingly small.

import manifest from "../../manifest.json";

export const CONFLICT_BRANCH_PREFIX = `${manifest.id}-conflicts-`;

// Sanitize a device label for safe inclusion in a git branch name.
// git accepts a wide ASCII set but disallows: space, tilde, caret,
// colon, question mark, asterisk, open-bracket, control chars, the
// literal sequence "..", trailing dot, and a few more (see git-
// check-ref-format(1)). We use a conservative whitelist:
//   - keep ASCII letters, digits, `_`, `-`
//   - everything else collapses to `_`
//   - leading/trailing dashes/underscores trimmed
//   - empty result falls back to "unknown"
function sanitizeLabel(label: string): string {
  const replaced = label.replace(/[^A-Za-z0-9_-]/g, "_");
  const trimmed = replaced.replace(/^[-_]+|[-_]+$/g, "");
  return trimmed.length > 0 ? trimmed : "unknown";
}

// Format the timestamp as YYYYMMDDhhmmssfff in UTC. Same shape
// push-queue's batch IDs use, so the two surfaces sort together
// when listed alongside each other.
function formatStamp(ms: number): { stamp: string; mmm: string } {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  const stamp =
    `${d.getUTCFullYear()}` +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());
  const mmm = pad(d.getUTCMilliseconds(), 3);
  return { stamp, mmm };
}

export function buildConflictBranchName(
  deviceLabel: string,
  nowMs: number,
): string {
  const label = sanitizeLabel(deviceLabel);
  const { stamp, mmm } = formatStamp(nowMs);
  return `${CONFLICT_BRANCH_PREFIX}${label}-${stamp}-${mmm}`;
}

// Quick predicate for the recovery sweep + matching-refs caller.
// Recognizes any name produced by buildConflictBranchName.
export function isConflictBranchName(name: string): boolean {
  return name.startsWith(CONFLICT_BRANCH_PREFIX);
}
