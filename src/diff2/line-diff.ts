// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The diff editor's line comparison within limits (DIFF-EDITOR-V2.md §2.1.1,
// owner, 2026-10-30). Field: a 2 MB note with ~12 500 changed lines froze
// Obsidian for minutes on open — `diffLines` ran with no limit, on the main
// thread, and twice (session fingerprint + editor). Now the comparison runs
// ONCE per (base, sibling) pair through a runner (the CPU worker in
// production), within a time limit and a limit on diff groups; every later
// `buildModel` of that pair takes the result from here.

import type { LineDiffPart } from "../worker/types";

// Starting value 1000 — to be tuned in the field (the phone may need less).
// TEMPORARILY 10 000 (owner, 2026-10-30): the field test opens files of
// different sizes to find where the editor gets slow; set the real value
// from those numbers.
export const MAX_DIFF_GROUPS = 10_000;

// (base, sibling, signal) → the parts, or null = gave up (time limit).
// Rejects with CancelledError when `signal` aborts (the tab closed).
export type LineDiffRunner = (
  base: string,
  sibling: string,
  signal?: AbortSignal,
) => Promise<LineDiffPart[] | null>;

export class DiffTooLargeError extends Error {
  constructor(
    readonly reason: "time" | "groups",
    readonly groups?: number,
  ) {
    super(reason === "time" ? "the comparison took over a minute" : `${groups} changed places`);
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

// Compare the pair once (a no-op when it is already prepared) and check the
// limits. Throws DiffTooLargeError over a limit; CancelledError when the tab
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
  if (parts === null) throw new DiffTooLargeError("time");
  const groups = countDiffGroups(parts);
  if (groups > MAX_DIFF_GROUPS) throw new DiffTooLargeError("groups", groups);
  cache.unshift({ base, sibling, parts });
  cache.length = Math.min(cache.length, 2);
  return { groups, ms, compared: true };
}
