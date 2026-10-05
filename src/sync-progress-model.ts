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

// The instant acknowledgement (owner, 2026-10-03). Shown the moment a
// click is accepted, BEFORE anything is known — no counters exist yet
// and inventing some would be the "Downloading 0 of 0" mistake the
// builder below already refuses to make.
//
// It is deliberately the same HEADER the progress notice uses, so the
// sequence reads as one message gaining detail rather than as two
// messages replacing each other: acknowledgement → commit outcome →
// counters → summary, all in the same notice.
export function syncStartedNoticeText(): string {
  return HEADER;
}

// The commit's texts (COMMIT-PASS-PERF §3.1, owner 2026-10-05). Each is
// shown only when its phase is FORECAST to take more than ~2 s — never
// on a timer:
//   "Committing…"            listing the files (dot-space) runs long;
//   "Checking all files…"    no statistics yet (the first commit after a
//                            RESET) — shown at once, unconditionally;
//   "Checking N of M files"  reading, hashing and storing — ONE counter
//                            for stages 2 and 3, M = candidates +
//                            deletions. "Checking", not "Committing": in
//                            the self-heal pass after a drain every file
//                            turns out unchanged and the result is
//                            "Nothing to commit".
//
// ⚠️ Present participle while it runs, PAST tense when it is done —
// the tense is the only thing that says "finished", and it says it for
// free. A bare "Commit N files" reads as an imperative, a button label
// telling the user to act; every other notice in this plugin already
// uses the participle ("Syncing with GitHub", "Downloading N of M"),
// so that one was the odd one out.
export function commitStartedNoticeText(): string {
  return "Committing…";
}

export function checkingAllFilesNoticeText(): string {
  return "Checking all files…";
}

export function checkingNoticeText(done: number, total: number): string {
  return total === 1
    ? `Checking ${done} of 1 file`
    : `Checking ${done} of ${total} files`;
}

export function commitDoneNoticeText(count: number): string {
  return count === 1 ? "Committed 1 file" : `Committed ${count} files`;
}

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

// ── THE TWO-SECTION NOTICE (owner, 2026-10-03) ──────────────────────
//
// WHY THIS EXISTS. Commit and drain are NOT mutually exclusive: the
// manager guards a drain against another drain and a commit against
// another commit, and nothing guards one against the other — by design,
// since R3b's Peterson protocol resolves their race on the queue
// DIRECTORY rather than in the scheduler. Committing while a sync runs
// is a feature of this plugin.
//
// So "one notice per operation" was the wrong unit, and both ways of
// having it are bad in the same way:
//   - two Notices STACK, and Obsidian sizes a stack to a common width,
//     so the shorter text sits in a padded box and jumps when its
//     neighbour expires (the §II.16 field defect, screenshots on file);
//   - one Notice shared by both phases is FOUGHT OVER — each handler
//     calls setMessage, so the last writer wins and the text flips
//     between phases (observed 2026-10-03: "Committing…" → "Syncing
//     with GitHub" → "Committing 100 of 250").
//
// The unit is the SECTION. One box, a fixed slot per phase, one
// renderer with two inputs — so no handler can overwrite another, and
// an ordering bug of that class stops being expressible.
//
// ⚠️ ORDER IS FIXED, NOT CHRONOLOGICAL. Commit above, drain below,
// whichever started first. Ordering by arrival would reintroduce the
// shuffling inside the box that we left the stack to escape.
export type NoticeSection =
  | { state: "none" }
  // ⚠️ A phase that has STARTED but has not earned a line yet (owner,
  // 2026-10-03). Becomes visible at `showAt` — and if the phase
  // settles first, the text is simply never shown.
  //
  // Why: on a vault with nothing to do, "Committing…" and "Syncing
  // with GitHub" appear and are replaced within milliseconds by
  // "Nothing to commit" / "Sync done". Four strings in a blink is not
  // information, it is flicker — "ні прочитати ні зрозуміти". A start
  // line earns its place only by the work lasting long enough to need
  // one.
  | { state: "pending"; text: string; showAt: number }
  | { state: "live"; text: string }
  // A finished phase keeps its last word for a moment. `until` is an
  // absolute ms timestamp so the renderer stays pure and testable.
  | { state: "settled"; text: string; until: number };

export interface NoticeState {
  commit: NoticeSection;
  drain: NoticeSection;
}

export const EMPTY_NOTICE_STATE: NoticeState = {
  commit: { state: "none" },
  drain: { state: "none" },
};

function visible(s: NoticeSection, nowMs: number): string | null {
  if (s.state === "live") return s.text;
  if (s.state === "pending") return s.showAt <= nowMs ? s.text : null;
  if (s.state === "settled" && s.until > nowMs) return s.text;
  return null;
}

// The whole text, or null when nothing is left to show — which is the
// signal to CLOSE the box. A settled section expiring while the other
// is still live shrinks the notice; the owner chose that over holding a
// ghost line to keep the height fixed.
export function renderNoticeState(
  s: NoticeState,
  nowMs: number,
): string | null {
  const parts = [visible(s.commit, nowMs), visible(s.drain, nowMs)].filter(
    (x): x is string => x !== null,
  );
  return parts.length === 0 ? null : parts.join("\n");
}

// When the renderer must be called again — the earliest expiry still in
// the future, or null if nothing is pending. A LIVE section never
// expires on its own: if its phase dies without reporting, the teardown
// events force it to settle (they are what guarantee the box closes).
export function nextNoticeDeadline(
  s: NoticeState,
  nowMs: number,
): number | null {
  // Both kinds of future moment: a pending section that is due to
  // APPEAR, and a settled one that is due to go. One timer, whichever
  // comes first.
  const times: number[] = [];
  for (const x of [s.commit, s.drain]) {
    if (x.state === "settled") times.push(x.until);
    if (x.state === "pending") times.push(x.showAt);
  }
  const future = times.filter((t) => t > nowMs);
  return future.length === 0 ? null : Math.min(...future);
}
