// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// "Max size of auto-merged files" — stored as `maxAutoMergedFileSizeKb`,
// in the KB the user types (owner, 2026-10-11). Pure, because tab.ts has
// no render harness.
//
// ⚠️ 0 is a VALUE, not an error: it turns auto-merge off for every file
// (NEW-DRAIN §II.1 rule 7). The old handler read `kb <= 0` as invalid and
// stored the 1 MB default, so "0" silently did nothing. An emptied field
// and a negative number are 0 as well (owner) — the next time Settings
// opens, the field shows the 0 that was stored. Anything else that is
// not a finite number is treated the same way.
export function autoMergeSizeKbFromInput(raw: string): number {
  const kb = Number(raw.trim());
  if (!Number.isFinite(kb) || kb <= 0) return 0;
  return Math.round(kb);
}

export const DEFAULT_AUTO_MERGE_KB = 1024;

// The engine's byte limit. Like every other key, a missing one takes the
// default. The byte-valued `maxAutoMergeSizeBytes` older builds left in
// data.json is not this key and is ignored, not migrated (owner: one user
// so far, no migration code yet).
export function autoMergeLimitBytes(settings: { maxAutoMergedFileSizeKb?: number }): number {
  return (settings.maxAutoMergedFileSizeKb ?? DEFAULT_AUTO_MERGE_KB) * 1024;
}
