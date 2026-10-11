// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// "Max size of auto-merged files" — the field's text (KB) → the stored
// byte limit. Pure, because tab.ts has no render harness.
//
// ⚠️ 0 is a VALUE, not an error: it turns auto-merge off for every file
// (NEW-DRAIN §II.1 rule 7). The old handler read `kb <= 0` as invalid and
// stored the 1 MB default, so "0" silently did nothing. Owner, 2026-10-11:
// an emptied field and a negative number are 0 as well — the next time
// Settings opens, the field shows the 0 that was stored. Anything else
// that is not a finite number is treated the same way.
export function autoMergeSizeBytesFromInput(raw: string): number {
  const kb = Number(raw.trim());
  if (!Number.isFinite(kb) || kb <= 0) return 0;
  return Math.round(kb * 1024);
}
