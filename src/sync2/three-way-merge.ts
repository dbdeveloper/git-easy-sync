// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { mergeLines } from "./diff3-merge";
import { detectEol, restoreEol } from "./eol";

// Outcome of a 3-way merge attempt. "clean" means non-overlapping
// edits or coincident edits that node-diff3 reconciled silently.
// "conflict" means the merger could not pick a side and emitted
// conflict markers in the output, expecting the user to resolve.
export type MergeOutcome =
  | { kind: "clean"; content: string }
  | { kind: "conflict"; conflictMarkedContent: string };

// Three-way text merge.
//   ours   = local content (the user's current work).
//   base   = the version both sides started from (last common ancestor).
//   theirs = the remote-side content we discovered during push.
//
// Returns either a clean merged string or a string with git-style
// conflict markers (<<<<<<<, =======, >>>>>>>) for the user to
// resolve through the conflict modal.
export function mergeText(
  ours: string,
  base: string,
  theirs: string,
): MergeOutcome {
  // Our diff3 (docs/tasks/DIFF3-MYERS.md): node-diff3's region walk on
  // Myers comparisons — same semantics, without node-diff3's blow-up on
  // repeated lines. Argument order (a=ours, o=base, b=theirs); both sides
  // making the identical change is a clean merge, not a conflict.
  const sep = /\r?\n/;
  const result = mergeLines(ours.split(sep), base.split(sep), theirs.split(sep))!;
  // result.result is an array of strings (with conflict markers already
  // inlined when result.conflict is true), joined with `\n` then restored
  // to `ours`' (local's) OWN dominant EOL style — NOT "any input has
  // CRLF". SYNC2-FIX.md §8.2.1 / NEW-DRAIN.md §III _diff3 CRLF residual
  // case (2026-08-28): scanning all three inputs let a CRLF `base` or
  // `theirs` silently flip a local LF-file to CRLF even when the lines
  // LOCAL actually touched were never edited. Restoring `ours`' own
  // style keeps the invariant "the merge changes what changed, not the
  // user's formatting" — reuses the same detectEol/restoreEol algorithm
  // already shipped and tested for the diff2 UI write-back path (bug-59).
  const joined = restoreEol(result.result.join("\n"), detectEol(ours));
  if (!result.conflict) {
    return { kind: "clean", content: joined };
  }
  return { kind: "conflict", conflictMarkedContent: joined };
}
