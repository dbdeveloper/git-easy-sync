// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// §II.16 — the TEXT of the sync progress notice and its closing
// summary, as PURE functions.
//
// Pure for the same reason `status-bar-model.ts` is: the rules here are
// all about what to HIDE, and a rule about absence cannot be verified
// by looking at a screenshot of the present case. "Show the line only
// when the number is non-zero" has four combinations for the summary
// alone, and three of them are invisible states.
//
// No git vocabulary. "Pull" and "push" are empty words to someone who
// never used git, and this notice exists precisely for the moment the
// user is waiting and anxious.

export interface SyncProgressNumbers {
  pullDone: number;
  pullTotal: number;
  pushDone: number;
  pushTotal: number;
  conflicts: number;
}

const HEADER = "Syncing with GitHub";

// The live notice, refreshed in place while the sync runs.
//
// Every line is conditional. A sync that only sends files must not
// carry a dead "Downloading 0 of 0" — a line that never changes reads
// as "stuck", which is the opposite of what a progress display is for.
// Before the first counter arrives (the commit pass still running) the
// header stands alone: the honest statement at that moment is "working
// on it", and inventing numbers to fill the space would be worse.
export function progressNoticeText(p: SyncProgressNumbers): string {
  const lines = [HEADER];
  if (p.pullTotal > 0) {
    lines.push(`Downloading ${p.pullDone} of ${p.pullTotal}`);
  }
  if (p.pushTotal > 0) {
    lines.push(`Uploading ${p.pushDone} of ${p.pushTotal}`);
  }
  if (p.conflicts > 0) {
    lines.push(
      p.conflicts === 1
        ? "⚠ 1 file needs resolving"
        : `⚠ ${p.conflicts} files need resolving`,
    );
  }
  return lines.join("\n");
}

// The closing summary — what THE SWITCH dropped when it emptied
// onSyncCompleted, restored with a body (owner, 2026-09-25).
//
// Same rule: a clause per non-zero number, and when all three are zero
// the message is the bare "Sync done". "Sync done — 0 sent, 0 received"
// is noise dressed up as information.
export function syncSummaryText(n: {
  sent: number;
  received: number;
  conflicts: number;
}): string {
  const parts: string[] = [];
  if (n.sent > 0) parts.push(`${n.sent} sent`);
  if (n.received > 0) parts.push(`${n.received} received`);
  if (n.conflicts > 0) parts.push(`${n.conflicts} in conflict`);
  return parts.length === 0 ? "Sync done" : `Sync done — ${parts.join(", ")}`;
}
