// Intra-chunk CHARACTER-level diff highlighting (R7.4).
//
// For a `diff` chunk that has both ours and theirs sides, compute
// character-range spans on each side marking the exact characters that
// DIFFER from the other side. The DiffPane overlays these spans with a
// stronger side tint so they stand out from the subtle line tint.
//
// CHARACTER-level (diffChars), not word-level: a one-letter change
// (`True` vs `true`) must highlight only `T`/`t`, not the whole word
// (user, bug-8). The function/type/file names keep the historical
// "word" wording — the granularity is the only thing that changed.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R7.4 (intra-chunk highlighting)
//
// Pure module — no DOM, no CodeMirror.

import { diffChars, diffWords } from "diff";

// BOTH diffChars and diffWords are Myers O(n·d) → O(n·m) worst case on DIFFERING content.
// Measured on 2 differing sides (jsdiff): diffWords 16 KB/side = 2.7 s, 32 KB/side = 11.6 s;
// diffChars 32 KB/side = 91 s — pure quadratic (2× size ⇒ ~4× time). So the old "fall back
// to word-level for big blocks" did NOT save anything: word-level is quadratic too. The
// product of the two sides' lengths is the cost knob. Two thresholds:
//   - ≤ CHAR_DIFF_BUDGET      → diffChars   (precise per-character; ~14 ms at the cap)
//   - ≤ WORD_DIFF_BUDGET      → diffWords   (coarser; ~24 ms at the cap)
//   - >  WORD_DIFF_BUDGET     → SKIP: no intra-chunk highlight at all (the line-level tint
//                               already marks the whole group as changed). This is what
//                               fixes the multi-minute UI freeze on a large conflict group
//                               (user: a ~2 MB history "Restore"). Matches how VS Code /
//                               GitHub cap intra-line diffing by size.
// The SKIP cap overrides the `wordLevel` user preference — a forced word diff on a 2 MB
// block would hang exactly the same.
const CHAR_DIFF_BUDGET = 200_000;
const WORD_DIFF_BUDGET = 2_000_000;

export interface WordSpan {
  // Character offsets within the side's joined text (oursText or
  // theirsText respectively). Use these to build Decoration.mark
  // ranges relative to each side's start offset in the merged doc.
  start: number;
  end: number;
}

export interface WordDiffResult {
  oursSpans: WordSpan[];   // words present in ours but not in theirs (or different)
  theirsSpans: WordSpan[]; // words present in theirs but not in ours (or different)
}

// TODO(perf) diagnostic — the render layer (buildDecorations) is a pure StateField update
// with no plugin logger, so a module-level sink bridges intra-chunk-diff timing to the file
// log. main.ts wires it to `logger.info` at onload; null (default) → no-op (unit tests). It
// fires PER GROUP but only for NOTABLE ones: any group that hit the skip cap (a big group —
// confirms the O(n²) freeze is now avoided), or any char/word diff that still took ≥ the
// threshold (catches a medium-group hitch). Keep until the large-file perf work is done.
export interface WordDiffPerf {
  oursLen: number;
  theirsLen: number;
  mode: "char" | "word" | "skip";
  ms: number;
}
let perfSink: ((p: WordDiffPerf) => void) | null = null;
export function setWordDiffPerfSink(fn: ((p: WordDiffPerf) => void) | null): void {
  perfSink = fn;
}
const PERF_LOG_MS = 15;

// Compute character-level diff between two text fragments. The result
// describes which character ranges on each side are visually
// "different" — those get the overlay highlight per R7.4.
//
// `diff.diffChars` returns parts with `value`, `added`, `removed`.
// We walk twice:
//   - To compute ours-side spans, track a running offset across all
//     non-added parts (added = "in theirs but not ours" → skip).
//     `removed` ranges become ours-spans.
//   - To compute theirs-side spans, track a running offset across
//     all non-removed parts. `added` ranges become theirs-spans.
export function computeWordDiff(
  oursText: string,
  theirsText: string,
  wordLevel = false, // Settings "Diff highlight mode" — true → whole changed WORDS (diffWords)
): WordDiffResult {
  // Size guard FIRST (both algorithms are quadratic on differing content). Above the word
  // budget → no intra-chunk highlight (the group's line tint remains); this is the freeze
  // fix and it overrides the wordLevel preference.
  const t0 = performance.now();
  const product = oursText.length * theirsText.length;
  if (product > WORD_DIFF_BUDGET) {
    perfSink?.({ oursLen: oursText.length, theirsLen: theirsText.length, mode: "skip", ms: 0 });
    return { oursSpans: [], theirsSpans: [] };
  }
  // wordLevel (user preference) OR the char budget (per-character too slow above it) → the
  // coarser word-level; otherwise the precise per-character diff.
  const useWords = wordLevel || product > CHAR_DIFF_BUDGET;
  const parts = useWords ? diffWords(oursText, theirsText) : diffChars(oursText, theirsText);
  const oursSpans: WordSpan[] = [];
  const theirsSpans: WordSpan[] = [];

  let oursPos = 0;
  let theirsPos = 0;

  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      theirsSpans.push({ start: theirsPos, end: theirsPos + len });
      theirsPos += len;
    } else if (part.removed) {
      oursSpans.push({ start: oursPos, end: oursPos + len });
      oursPos += len;
    } else {
      oursPos += len;
      theirsPos += len;
    }
  }

  if (perfSink) {
    const ms = Math.round(performance.now() - t0);
    if (ms >= PERF_LOG_MS) {
      perfSink({ oursLen: oursText.length, theirsLen: theirsText.length, mode: useWords ? "word" : "char", ms });
    }
  }
  return {
    oursSpans: mergeAdjacent(oursSpans),
    theirsSpans: mergeAdjacent(theirsSpans),
  };
}

// Merge spans that abut each other (end of one === start of next).
// `diff.diffWords` sometimes splits a single visual change across
// multiple part records (whitespace-only fragments produced as
// separate "common" parts inside an otherwise-modified run); a
// single mark-decoration is cheaper to render than many.
function mergeAdjacent(spans: WordSpan[]): WordSpan[] {
  if (spans.length === 0) return spans;
  const out: WordSpan[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const prev = out[out.length - 1];
    const cur = spans[i];
    if (cur.start === prev.end) {
      prev.end = cur.end;
    } else {
      out.push(cur);
    }
  }
  return out;
}
