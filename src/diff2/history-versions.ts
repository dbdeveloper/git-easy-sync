// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy.
//
// Phase 7 (History) data layer — DIFF-EDITOR-HISTORY-DELETED.md §4.7 stage 7a.0.
//
// A file's history is assembled from TWO sources:
//   - GitHub commits touching the path (`GithubClient.listCommitsForPath`),
//     identified by COMMIT-sha;
//   - local, not-yet-pushed versions sitting in `.push-queue/`
//     (`enumeratePushQueueVersions`), identified by their batch id.
//
// Merge design (with the user, 2026-07-03):
//   - Uniform row = { local, date, id, deviceLabel }. `id` is the
//     open-handle: a batchId when local (bytes via
//     `PushQueue.readFile(id, path)`), a commit-sha when remote (bytes via
//     `getContentsAtRef(id)`); `local` tells the opener which.
//   - `date` is the TRUE local authoring moment, not the push moment: for
//     GitHub rows we parse it out of the sync2 commit message
//     (`parseLocalTimestamp`) and fall back to the git committer date only
//     for commits this plugin didn't write. `deviceLabel` = provenance
//     (`parseDeviceSuffix`, "unknown" for foreign commits).
//   - NO lossy dedup. GitHub commit-shas and local push-queue blob-shas
//     are different namespaces, so "dedup by sha" across sources can never
//     match; and per [[feedback-preserve-all-commits]] two local edits at
//     different moments with identical bytes are two real artifacts.
//     Merge = concat + chronological sort (newest-first). In normal
//     operation the lists are disjoint anyway — the push-queue holds only
//     UNpushed batches; once pushed a batch leaves the queue and reappears
//     as a GitHub commit.

import {
  parseDeviceSuffix,
  parseLocalTimestamp,
} from "../sync2/commit-message";
import { AuthError } from "../errors";

/** One row in a file's history timeline. */
export interface HistoryVersion {
  // true  → `id` is a push-queue batchId (open via readFile(id, path));
  // false → `id` is a commit-sha    (open via getContentsAtRef(id)).
  local: boolean;
  // Epoch-ms local authoring moment (see module header).
  date: number;
  id: string;
  // Provenance ("who") — device label; "unknown" for foreign commits.
  deviceLabel: string;
}

/** Raw shape returned by `GithubClient.listCommitsForPath`. */
export type GithubCommit = { sha: string; date: string; message: string };

/**
 * 7a.3 — format a version's epoch-ms into the 20-char conflict-timestamp shape
 * ("YYYY-MM-DDTHH-MM-SSZ") that `formatConflictTimestamp` renders. Used for a
 * history editor's display fields (tab title + diff-marker date); display-only,
 * not part of any id. Both entry builders (main.ts open + the view's remount)
 * call this so the title can't drift.
 */
export function historyIsoTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/T(\d{2}):(\d{2}):(\d{2})/, "T$1-$2-$3");
}

/** Minimal PushQueue surface this module reads — `list()` + `read(id)`. */
export interface QueueVersionSource {
  list(): Promise<string[]>;
  read(id: string): Promise<{ id: string; createdAt: number; files: string[] }>;
}

/** Minimal GithubClient surface the history list needs. */
export interface HistoryCommitSource {
  listCommitsForPath(args: {
    path: string;
    branch: string;
  }): Promise<GithubCommit[]>;
}

/**
 * Local, not-yet-pushed versions of `path` from the push-queue, one per
 * batch whose snapshot includes the path. `deviceLabel` is this device's
 * current label (the batch has no commit message yet — it is written at
 * push time from the same label). Ordering is left to `mergeVersionList`.
 */
export async function enumeratePushQueueVersions(
  queue: QueueVersionSource,
  path: string,
  deviceLabel: string,
): Promise<HistoryVersion[]> {
  const out: HistoryVersion[] = [];
  for (const id of await queue.list()) {
    const batch = await queue.read(id);
    if (batch.files.includes(path)) {
      out.push({ local: true, date: batch.createdAt, id, deviceLabel });
    }
  }
  return out;
}

/**
 * Merge local (push-queue) + GitHub versions into one newest-first
 * timeline. Each GitHub commit's `date`/`deviceLabel` are parsed from its
 * message (true authoring moment + provenance), with the git committer
 * date as a fallback for commits this plugin didn't write. No lossy dedup
 * — see the module header. Pure; does not mutate its inputs.
 */
export function mergeVersionList(
  local: HistoryVersion[],
  github: GithubCommit[],
): HistoryVersion[] {
  const remote: HistoryVersion[] = github.map((c) => ({
    local: false,
    // Prefer the authoring moment from the message; fall back to the git
    // committer date. `Date.parse` yields NaN (not null) on a malformed
    // date, so `|| 0` keeps the row sortable (sorts as oldest) — GitHub
    // always returns a date, so this is belt-and-braces.
    date: parseLocalTimestamp(c.message) ?? (Date.parse(c.date) || 0),
    id: c.sha,
    deviceLabel: parseDeviceSuffix(c.message),
  }));
  const merged = [...local, ...remote];
  // Newest-first. Deterministic tie-break by `id` so equal timestamps
  // sort stably across engines.
  merged.sort((a, b) => b.date - a.date || b.id.localeCompare(a.id));
  return merged;
}

/**
 * 7a.2 — assemble a file's full version timeline for the diff2-history view.
 * Local (push-queue) versions are read FIRST and always returned — they need no
 * network and can't throw. GitHub commits are then loaded, but a failure (offline
 * / token-not-set / rate-limited) is CAUGHT and surfaced as `githubError:true`
 * rather than hiding the local unpushed versions (the view renders local-only +
 * a warning). Extracted from the view so this local-always contract is unit-
 * testable without an Obsidian ItemView runtime.
 */
export async function loadHistoryVersions(
  queue: QueueVersionSource,
  client: HistoryCommitSource,
  path: string,
  branch: string,
  deviceLabel: string,
  // §35 — every GitHub interaction begins by checking the token-expired latch.
  // When set, we DON'T touch the network: return local-only + tokenExpired:true
  // so the view shows the "TOKEN EXPIRED!" variant. noteAuthError latches the
  // marker if a first-time 401/403 slips through here (marker not yet set), so
  // this path becomes a full participant in the §35 gate.
  isTokenExpired?: () => boolean,
  noteAuthError?: (err: unknown) => void,
): Promise<{
  versions: HistoryVersion[];
  githubError: boolean;
  tokenExpired: boolean;
}> {
  const local = await enumeratePushQueueVersions(queue, path, deviceLabel);
  // Pre-flight gate: a latched token short-circuits before the network.
  if (isTokenExpired?.() ?? false) {
    return {
      versions: mergeVersionList(local, []),
      githubError: true,
      tokenExpired: true,
    };
  }
  let github: GithubCommit[] = [];
  let githubError = false;
  let tokenExpired = false;
  try {
    github = await client.listCommitsForPath({ path, branch });
  } catch (err) {
    githubError = true;
    if (err instanceof AuthError) {
      tokenExpired = true;
      noteAuthError?.(err); // latch the marker so the rest of the UI reflects it
    }
  }
  return { versions: mergeVersionList(local, github), githubError, tokenExpired };
}
