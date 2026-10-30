// V2 diff-model — the terminal-inside representation that replaces the old
// `\0`/`\1` joined-doc (DIFF-EDITOR-V2.md §2.1–§2.2, §2.2.11; integration
// contract DIFF-EDITOR.md §0).
//
// The document is PLAIN text where every ver-block carries a protected
// terminal `\n`, so its range is never zero-width (the lynchpin that makes a
// CM6 RangeSet viable — validated by the 1a/1b geometry spikes). There are NO
// sentinel characters, so the §1.3 `\0`/`\1` collision check is gone.
//
// Structure is a plain list of `VerRange` (NOT a CM6 RangeSet — that wrapping
// is a Phase-3 rendering concern). Convention is **terminal-inside**:
//   - range [from, to) covers the ver-block's CONTENT *plus* its terminal `\n`;
//   - the terminal `\n` is the char at index `to-1` (doc[to-1] === '\n');
//   - content = doc.slice(from, to-1);  content length = (to-from)-1;
//   - empty ver-block ⟺ (to-from) === 1  (just the terminal `\n`); never 0-width.
// Within a group the two ranges abut: ver2.from === ver1.to. Groups are always
// separated by ≥1 normal line (jsdiff never emits two adjacent changed regions).
//
// Round-trip invariant (DIFF-EDITOR.md §0.3): splitModel(buildModel(base,
// sibling)) === (base, sibling) byte-exact — including the EOL-less last line
// (variant (a), §2.2.12) and 0-byte sides, both of which fall out for free
// because split() drops exactly the terminal `\n` it added.
//
// Diff library: `diff` (jsdiff), default `diffLines` (no options) — same call
// the old joined-doc used (DIFF-EDITOR.md §1.4). A pair the editor prepared
// (line-diff.ts, DIFF-EDITOR-V2.md §2.1.1 — compared once, off the main
// thread, within limits) takes that result instead of comparing again.

import { diffLines } from "diff";
import { cachedLineDiff } from "./line-diff";

export interface VerRange {
  from: number;
  to: number;
  ver: 1 | 2;
  group: number;
}

export interface DiffModel {
  doc: string;
  ranges: VerRange[];
}

// (base, sibling) → terminal-inside doc + ranges. Removed lines accumulate into
// ver1 (base side), added into ver2 (sibling side); a common part flushes the
// pending diff region as one group, then is appended verbatim as normal text.
export function buildModel(base: string, sibling: string): DiffModel {
  const parts = cachedLineDiff(base, sibling) ?? diffLines(base, sibling);
  let doc = "";
  const ranges: VerRange[] = [];
  let group = -1;
  let ver1 = "";
  let ver2 = "";

  const flush = (): void => {
    // diffLines never yields an empty/empty region; the guard is defensive.
    if (ver1 === "" && ver2 === "") return;
    group += 1;
    const f1 = doc.length;
    doc += ver1 + "\n"; // ver1 content (may be "") + terminal \n
    ranges.push({ from: f1, to: doc.length, ver: 1, group });
    const f2 = doc.length;
    doc += ver2 + "\n"; // ver2 content (may be "") + terminal \n
    ranges.push({ from: f2, to: doc.length, ver: 2, group });
    ver1 = "";
    ver2 = "";
  };

  for (const part of parts) {
    if (part.added) ver2 += part.value;
    else if (part.removed) ver1 += part.value;
    else {
      flush();
      doc += part.value; // normal text — shared by both sides, verbatim
    }
  }
  flush();
  return { doc, ranges };
}

// Canonical, deterministic serialization of a DiffModel — the V2 replay-validity
// fingerprint input (DIFF-EDITOR.md §2.5 / §0.5: joinedDocSha). buildModel is
// deterministic (jsdiff + fixed flush order) and never throws (no sentinels),
// so SHA(serializeModel(buildModel(base, sibling))) is reproducible from
// (base, sibling) alone. Captures BOTH the clean doc AND the group partition
// (ranges), so a structural change (different diff regions) shifts the
// fingerprint even when the doc text happens to coincide. The VerRange keys are
// always written in {from,to,ver,group} order by buildModel, so JSON.stringify
// is stable here.
export function serializeModel(m: DiffModel): string {
  return JSON.stringify({ doc: m.doc, ranges: m.ranges });
}

// (doc, ranges) → (base, sibling). Walk in document order: normal gaps go to
// both sides; a ver1 range's content (terminal `\n` dropped) to base, a ver2
// range's content to sibling. The terminal `\n` is internal — never written.
export function splitModel(
  doc: string,
  ranges: VerRange[],
): { base: string; sibling: string } {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let base = "";
  let sibling = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.from > pos) {
      const normal = doc.slice(pos, r.from);
      base += normal;
      sibling += normal;
    }
    const content = doc.slice(r.from, r.to - 1); // drop terminal \n
    if (r.ver === 1) base += content;
    else sibling += content;
    pos = r.to;
  }
  if (pos < doc.length) {
    const tail = doc.slice(pos);
    base += tail;
    sibling += tail;
  }
  return { base, sibling };
}
