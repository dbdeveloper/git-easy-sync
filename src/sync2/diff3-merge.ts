// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The region walk below (`diff3MergeRegions`, `diff3Merge`, `merge`) is
// adapted from node-diff3 (src/diff3.mjs), under the MIT License:
//   Copyright (c) 2006, 2008 Tony Garnock-Jones <tonyg@lshift.net>
//   Copyright (c) 2006, 2008 LShift Ltd. <query@lshift.net>
//   Copyright (c) 2019-2025 Bryan Housel <bhousel@gmail.com>
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions: The above copyright notice and this permission
// notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

// Three-way merge of LINE arrays (docs/tasks/DIFF3-MYERS.md). node-diff3's
// own two-way comparison is a textbook Hunt–McIlroy LCS with a linear
// candidate scan: every repeated line (blank lines!) is paired with every
// other, and a 93 KB note took 40 s, a 2 MB one more than 16 minutes. Its
// region walk is fine, so it is kept as it is; only the comparison is
// replaced by Myers (`diffArrays` from `diff`), whose cost follows the
// number of CHANGES, not the repeats. On lines that never repeat the
// longest common subsequence is unique and the result is byte-identical
// to node-diff3 (pinned by test); with repeats, either side of a tie is an
// equally valid merge.

import { diffArrays } from "diff";

export interface MergeLimits {
  // Give up when one side's edit distance exceeds this (deterministic —
  // the tests use it).
  maxEditLength?: number;
  // Give up after this many ms PER SIDE (production). diffArrays is
  // synchronous: this bounds a merge only when it runs off the main thread.
  timeout?: number;
}

export interface LineMergeResult {
  conflict: boolean;
  result: string[];
}

interface Hunk {
  ab: "a" | "b";
  oStart: number;
  oLength: number;
  abStart: number;
  abLength: number;
}

// The changed spans between `o` and `side`, as node-diff3's diffIndices
// would report them — but found by Myers. null = the limit was hit.
function hunksOf(
  o: string[],
  side: string[],
  ab: "a" | "b",
  limits: MergeLimits,
): Hunk[] | null {
  const opts: { maxEditLength?: number; timeout?: number } = {};
  if (limits.maxEditLength !== undefined) opts.maxEditLength = limits.maxEditLength;
  if (limits.timeout !== undefined) opts.timeout = limits.timeout;
  const changes = Object.keys(opts).length > 0
    ? diffArrays(o, side, opts as { maxEditLength: number })
    : diffArrays(o, side);
  if (changes === undefined) return null;
  const hunks: Hunk[] = [];
  let oi = 0;
  let si = 0;
  let open: Hunk | null = null;
  for (const ch of changes) {
    const n = ch.count ?? ch.value.length;
    if (!ch.added && !ch.removed) {
      if (open !== null) {
        hunks.push(open);
        open = null;
      }
      oi += n;
      si += n;
      continue;
    }
    if (open === null) open = { ab, oStart: oi, oLength: 0, abStart: si, abLength: 0 };
    if (ch.removed) {
      open.oLength += n;
      oi += n;
    } else {
      open.abLength += n;
      si += n;
    }
  }
  if (open !== null) hunks.push(open);
  return hunks;
}

type Region =
  | { stable: true; content: string[] }
  | { stable: false; aContent: string[]; oContent: string[]; bContent: string[] };

// node-diff3 diff3MergeRegions, with its hunks supplied by Myers.
function diff3MergeRegions(
  a: string[],
  o: string[],
  b: string[],
  hunksA: Hunk[],
  hunksB: Hunk[],
): Region[] {
  // A STABLE sort keeps 'a' before 'b' at the same oStart, as node-diff3's
  // (concat a's, then b's, then Array.sort — stable in modern engines).
  const hunks = [...hunksA, ...hunksB].sort((x, y) => x.oStart - y.oStart);
  const results: Region[] = [];
  let currOffset = 0;
  const advanceTo = (endOffset: number) => {
    if (endOffset > currOffset) {
      results.push({ stable: true, content: o.slice(currOffset, endOffset) });
      currOffset = endOffset;
    }
  };

  let i = 0;
  while (i < hunks.length) {
    let hunk = hunks[i++];
    const regionStart = hunk.oStart;
    let regionEnd = hunk.oStart + hunk.oLength;
    const regionHunks = [hunk];
    advanceTo(regionStart);

    // Pull every hunk that overlaps OR TOUCHES the region into it.
    while (i < hunks.length) {
      const next = hunks[i];
      if (next.oStart > regionEnd) break;
      regionEnd = Math.max(regionEnd, next.oStart + next.oLength);
      regionHunks.push(next);
      i++;
    }

    if (regionHunks.length === 1) {
      // One side changed this part of `o`, the other did not: no conflict.
      if (hunk.abLength > 0) {
        const buffer = hunk.ab === "a" ? a : b;
        results.push({ stable: true, content: buffer.slice(hunk.abStart, hunk.abStart + hunk.abLength) });
      }
    } else {
      // Both sides touched it: merge each side's hunks into one span, then
      // correct for the skew between the side and `o`.
      const bounds = {
        a: [a.length, -1, o.length, -1],
        b: [b.length, -1, o.length, -1],
      };
      for (hunk of regionHunks) {
        const oStart = hunk.oStart;
        const oEnd = oStart + hunk.oLength;
        const abStart = hunk.abStart;
        const abEnd = abStart + hunk.abLength;
        const bd = bounds[hunk.ab];
        bd[0] = Math.min(abStart, bd[0]);
        bd[1] = Math.max(abEnd, bd[1]);
        bd[2] = Math.min(oStart, bd[2]);
        bd[3] = Math.max(oEnd, bd[3]);
      }
      const aStart = bounds.a[0] + (regionStart - bounds.a[2]);
      const aEnd = bounds.a[1] + (regionEnd - bounds.a[3]);
      const bStart = bounds.b[0] + (regionStart - bounds.b[2]);
      const bEnd = bounds.b[1] + (regionEnd - bounds.b[3]);
      results.push({
        stable: false,
        aContent: a.slice(aStart, aEnd),
        oContent: o.slice(regionStart, regionEnd),
        bContent: b.slice(bStart, bEnd),
      });
    }
    currOffset = regionEnd;
  }
  advanceTo(o.length);
  return results;
}

const sameLines = (x: string[], y: string[]) =>
  x.length === y.length && x.every((line, k) => line === y[k]);

// node-diff3 `merge(a, o, b, { excludeFalseConflicts: true })`: both sides
// making the same change is not a conflict; a real one is written with the
// unlabelled markers. null = a limit was hit — the caller treats it as a
// conflict for the user, never as a merge.
export function mergeLines(
  a: string[],
  o: string[],
  b: string[],
  limits: MergeLimits = {},
): LineMergeResult | null {
  const hunksA = hunksOf(o, a, "a", limits);
  if (hunksA === null) return null;
  const hunksB = hunksOf(o, b, "b", limits);
  if (hunksB === null) return null;
  let conflict = false;
  const result: string[] = [];
  for (const region of diff3MergeRegions(a, o, b, hunksA, hunksB)) {
    if (region.stable) {
      result.push(...region.content);
    } else if (sameLines(region.aContent, region.bContent)) {
      result.push(...region.aContent);
    } else {
      conflict = true;
      result.push("<<<<<<<", ...region.aContent, "=======", ...region.bContent, ">>>>>>>");
    }
  }
  return { conflict, result };
}
