// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER §2.23-2.24 (owner, 2026-10-25). Every open log file is
// polled once a second: a changed file is re-read — only its new lines
// appended when the text just grew — and a file that is gone closes its
// tab. "Gone" = missing at TWO polls in a row: a sync on a phone replaces
// a file as remove + rename, and one poll can land in between.

export interface FileStamp {
  size: number;
  mtime: number;
}

export interface PollState {
  last: FileStamp | null;
  misses: number;
}

export function pollStep(
  state: PollState,
  cur: FileStamp | null,
): { action: "none" | "changed" | "close"; state: PollState } {
  if (cur === null) {
    const misses = state.misses + 1;
    return { action: misses >= 2 ? "close" : "none", state: { last: state.last, misses } };
  }
  const changed =
    state.last === null || state.last.size !== cur.size || state.last.mtime !== cur.mtime;
  return { action: changed ? "changed" : "none", state: { last: cur, misses: 0 } };
}

// The text only GREW (its complete lines are a prefix of the new text):
// the new complete lines — a torn tail waits for the next read, blank
// lines are skipped as on open. Rewritten or truncated: null.
export function appendedLines(oldText: string, newText: string): string[] | null {
  const complete = oldText.slice(0, oldText.lastIndexOf("\n") + 1);
  if (!newText.startsWith(complete) || newText.length < oldText.length) return null;
  const parts = newText.slice(complete.length).split("\n");
  parts.pop(); // the torn tail, or "" after a final "\n"
  return parts.filter((l) => l.length > 0);
}
