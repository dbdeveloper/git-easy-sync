// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Hardcoded commit-message formats. Each message is a fixed phrase
// plus two substitutions: the LOCAL commit timestamp and the trailing
// `(deviceLabel)`.
//
// Why the timestamp lives in the message body (not just git
// metadata): sync2 commits LOCALLY (the batch is frozen to
// `.push-queue/` with a `createdAt`) but PUSHES later — sometimes
// much later, when the device next has network. The commit object is
// created at push time, so git's committer/author date reflects the
// PUSH moment, not when the user actually committed. Embedding the
// batch's `createdAt` (rendered in local time with UTC offset) makes
// the true local-commit moment visible and greppable in `git log`,
// and — as a side benefit — every message becomes unique, so a
// specific commit (or a group from one date) is trivial to find.
// The trailing `(deviceLabel)` still carries provenance + multi-
// device disambiguation.

// Renders an epoch-millis timestamp in LOCAL time with a UTC offset,
// e.g. "2026-05-18 07:59:04.352+02:00". Local components + offset so
// the reader sees the device's wall-clock, while the trailing offset
// keeps it unambiguous when commits from devices in different
// timezones sit side by side.
export function formatLocalTimestamp(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const p3 = (n: number): string => String(n).padStart(3, "0");
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time =
    `${p2(d.getHours())}:${p2(d.getMinutes())}:` +
    `${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`;
  // getTimezoneOffset() is minutes BEHIND UTC (e.g. -120 for +02:00),
  // so negate to get minutes EAST of UTC.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offset = `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
  return `${date} ${time}${offset}`;
}

// Sentinel used wherever sync2 needs a stand-in for an unknown device
// — both at READ time (parseDeviceSuffix on a commit with no trailing
// "(label)") and at WRITE time (every formatX function below when
// settings.deviceLabel is empty or missing). One constant, one
// literal "unknown", everywhere.
export const UNKNOWN_DEVICE_LABEL = "unknown";

// Escape parens in the deviceLabel so the trailing-paren regex used
// by parseDeviceSuffix stays unambiguous. `(` → `[`, `)` → `]`.
// Square brackets render naturally in commit messages and stay
// parseable. Spaces and Unicode survive untouched.
function safeLabel(deviceLabel: string): string {
  const raw =
    !deviceLabel || deviceLabel.length === 0
      ? UNKNOWN_DEVICE_LABEL
      : deviceLabel;
  return raw.replace(/\(/g, "[").replace(/\)/g, "]");
}

// ISO 8601 form of the same local timestamp, for git's author/
// committer `date` field — e.g. "2026-05-18T07:59:04.352+02:00".
// Identical wall-clock + offset to formatLocalTimestamp, just with
// the 'T' separator git expects. Used by the optional git-author
// identity path (SYNC2.md §4.4) so git metadata records the local
// commit moment, not push time.
export function toGitAuthorDate(ms: number): string {
  return formatLocalTimestamp(ms).replace(" ", "T");
}

// User-driven sync batch (syncAll, syncFile). Default for any batch
// the engine doesn't explicitly mark as synthetic / branch-bound /
// merge. `whenMs` is the batch's createdAt (local commit moment).
export function formatSyncMessage(deviceLabel: string, whenMs: number): string {
  return `Sync at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Synthetic batch from drain Phase B side-batch synthesis. Marks the
// commit that propagates a closed conflict's live base state to main.
export function formatResolveConflictMessage(
  deviceLabel: string,
  whenMs: number,
): string {
  return `Resolve conflict at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Intermediate commit on the per-device conflict-branch: snapshot of
// the user's local copy at registration time, or edit-while-in-
// conflict push. NOT a main-bound commit; lands on the
// `github-easy-sync-conflicts-<device>-<ts>-<ms>` branch.
export function formatConflictMessage(
  deviceLabel: string,
  whenMs: number,
): string {
  return `Conflict at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Marker commit on the conflict-branch right before the finalize
// merge. Preserves the user's live state as the branch tip.
export function formatFinalStateMessage(
  deviceLabel: string,
  whenMs: number,
): string {
  return `Final state at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Finalize merge-commit on main. Has TWO parents (main.head +
// branch.head); the merge-commit makes branch.head reachable from
// main so the intermediate "conflict" commits stay GC-safe after
// deleteRef.
export function formatMergeConflictBranchMessage(
  deviceLabel: string,
  whenMs: number,
): string {
  return `Merge conflict-branch at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Bare-repo bootstrap commit. Written by the Contents API seed when
// the target branch has no commits yet (`getBranchHeadSha` returns
// 404 / 409).
export function formatInitMessage(
  deviceLabel: string,
  whenMs: number,
): string {
  return `Init at ${formatLocalTimestamp(whenMs)} (${safeLabel(deviceLabel)})`;
}

// Pick the commit message format for a batch at processBatch time
// based on its `synthetic` flag. Synthetic = Phase B side-batch from
// drain conflict-resolution → "Resolve conflict at … ({label})".
// Non-synthetic = user-driven sync click → "Sync at … ({label})".
// `whenMs` is the batch's createdAt — the true local-commit moment,
// NOT push time. Centralised here so the inline derivation in
// processBatch is a one-liner and the formatX choice stays
// consistent across call sites.
export function commitMessageForBatch(
  synthetic: boolean,
  deviceLabel: string,
  whenMs: number,
): string {
  return synthetic
    ? formatResolveConflictMessage(deviceLabel, whenMs)
    : formatSyncMessage(deviceLabel, whenMs);
}

// Inverse of the trailing `(label)` suffix: pulls the device label
// off any commit message produced by sync2. Falls back to
// UNKNOWN_DEVICE_LABEL for hand-edited or non-sync2 commits.
//
// Every formatX function above appends `(safeLabel(...))` so this
// regex matches all sync2-produced messages uniformly. Used by
// sync2-manager to identify the foreign device on an existing
// commit (for the multi-device "who pushed this?" observability
// log line).
export function parseDeviceSuffix(message: string): string {
  const m = /\s\(([^()]+)\)\s*$/.exec(message);
  return m ? m[1] : UNKNOWN_DEVICE_LABEL;
}

// Reverse of formatLocalTimestamp: recover the TRUE local commit moment
// (epoch-ms) embedded in a sync2 commit message. All formatX messages end
// with "<verb> at <local-time+offset> (label)"; the timestamp is
// formatLocalTimestamp's exact shape, e.g. "2026-07-01 10:00:00.123+03:00"
// (space between date and time, ISO-parseable after that space → "T").
//
// Phase 7 History (HISTORY-DELETED §4.7 7a.0) shows WHEN a version was
// authored, not when it pushed — git's committer date is the PUSH moment
// (SYNC2 §4.4), so the message timestamp is the correct source. Returns
// null for a message this plugin didn't write (web edit, adoption, foreign
// tool) so the caller can fall back to the git date. Lives here so the
// parser and formatLocalTimestamp stay format-locked in one file.
export function parseLocalTimestamp(message: string): number | null {
  const m =
    /\bat (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2})/.exec(
      message,
    );
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isNaN(ms) ? null : ms;
}
