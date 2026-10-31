// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The diff editor's line comparison within limits (DIFF-EDITOR-V2.md §2.1.1,
// owner, 2026-10-30). Field: a 2 MB note with ~12 500 changed lines froze
// Obsidian for minutes on open — `diffLines` ran with no limit, on the main
// thread, and twice (session fingerprint + editor). Now the comparison runs
// ONCE per (base, sibling) pair through a runner (the CPU worker in
// production), within a time limit; every later `buildModel` of that pair
// takes the result from here. The number of diff groups is NOT a limit
// (owner, 2026-10-31): the slowness a 1000-group cap guarded against was a
// CM6 bug in Obsidian < 1.14.4 desktop; with it fixed, ~5000 groups in a
// 1.3 MB file scroll fluently.

import type { LineDiffPart } from "../worker/types";

// (base, sibling, signal) → the parts, or null = gave up (time limit).
// Rejects with CancelledError when `signal` aborts (the tab closed).
export type LineDiffRunner = (
  base: string,
  sibling: string,
  signal?: AbortSignal,
) => Promise<LineDiffPart[] | null>;

// The comparison ran out of time.
export class DiffTooLargeError extends Error {
  constructor() {
    super("the comparison took over three minutes");
  }
}

// The last two prepared pairs, newest first. Two, because one open may
// read the same pair twice in slightly different ways (the editor's text
// read and the session's byte read); a third pair is never live at once.
const cache: Array<{ base: string; sibling: string; parts: LineDiffPart[] }> = [];

export function cachedLineDiff(base: string, sibling: string): LineDiffPart[] | undefined {
  return cache.find((c) => c.base === base && c.sibling === sibling)?.parts;
}

export function clearLineDiffCache(): void {
  cache.length = 0;
}

// Diff groups as buildModel forms them: a run of changed parts, closed by
// common text (or the end).
export function countDiffGroups(parts: readonly LineDiffPart[]): number {
  let groups = 0;
  let open = false;
  for (const p of parts) {
    if (p.added || p.removed) {
      if (!open) groups += 1;
      open = true;
    } else {
      open = false;
    }
  }
  return groups;
}

// Compare the pair once (a no-op when it is already prepared). Throws
// DiffTooLargeError when it ran out of time; CancelledError when the tab
// closed. `compared` is false when the result came from the cache.
export async function prepareLineDiff(
  base: string,
  sibling: string,
  run: LineDiffRunner,
  signal?: AbortSignal,
): Promise<{ groups: number; ms: number; compared: boolean }> {
  const hit = cachedLineDiff(base, sibling);
  if (hit) return { groups: countDiffGroups(hit), ms: 0, compared: false };
  const t0 = performance.now();
  const parts = await run(base, sibling, signal);
  const ms = Math.round(performance.now() - t0);
  if (parts === null) throw new DiffTooLargeError();
  const groups = countDiffGroups(parts);
  cache.unshift({ base, sibling, parts });
  cache.length = Math.min(cache.length, 2);
  return { groups, ms, compared: true };
}
