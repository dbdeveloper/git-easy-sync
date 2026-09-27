// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1.6 Крок E6 — remove from the REMOTE the nested
// `.gitignore` files the migration consolidated into the root.
//
// Why this is a step of its own rather than part of the migration:
//
//   1. The migration runs at plugin startup, and on a fresh install there
//      may be no credentials at all yet — no token, no owner/repo. Network
//      is simply not available at that moment.
//   2. The migration RAISES the gate that forbids syncing (§8.1.5a), so a
//      network action inside it would contradict its own rule.
//
// So the migration only records the local paths it renamed, and the first
// SUCCESSFUL drain afterwards performs the deletions. The paths are stored
// as paths, never as `{path, sha}`: an arbitrary interval passes before
// that drain, so the only correct answer to "is this path on the server"
// is the one read at the time.
//
// ⚠️ A local rename to `*.bak` propagates NOTHING, which is the whole
// reason this exists. Those files are out of scope for the sync engine —
// that is what the migration is about — so nothing in the ordinary change
// detection would ever propose them for deletion. Left on the remote,
// plain git keeps seeing the hierarchy, i.e. exactly the divergence §8.1
// exists to remove.

import { formatGitignoreCleanupMessage } from "./commit-message";
import {
  clearRemotePending,
  readDoneMarker,
  type MigrationDeps,
} from "./gitignore-migration";

// The narrow slice of GithubClient this needs — explicit so a test fakes
// exactly this surface and nothing more, the same convention
// DrainGithubClient follows.
export interface RemoteCleanupClient {
  getBranchHeadSha(args?: { retry?: boolean }): Promise<string>;
  getCommit(args: { sha: string; retry?: boolean }): Promise<{
    tree: { sha: string };
  }>;
  getRepoTree(args: { sha: string; retry?: boolean }): Promise<{
    files: Array<{ path: string }>;
    truncated: boolean;
  }>;
  pushCommitToBranch(args: {
    branch: string;
    parent: string | null;
    entries: Array<{ path: string; sha: string | null }>;
    message: string;
    retry?: boolean;
  }): Promise<{ sha: string }>;
}

export type RemoteCleanupOutcome =
  // Nothing recorded — the overwhelmingly common case, and the reason this
  // costs one small local read on an ordinary sync.
  | "nothing-pending"
  // Recorded paths, none of them on the remote. Cleared: there is nothing
  // to delete and nothing to come back for.
  | "nothing-on-remote"
  | "deleted"
  // The tree came back truncated, so absence from the listing proves
  // nothing. Kept for a later attempt.
  | "deferred-truncated"
  // Network or API failure. Kept.
  | "failed";

export interface RemoteCleanupResult {
  outcome: RemoteCleanupOutcome;
  deleted: string[];
  reason?: string;
}

export async function deleteMigratedFromRemote(deps: {
  migration: MigrationDeps;
  client: RemoteCleanupClient;
  branch: string;
  deviceLabel: string;
}): Promise<RemoteCleanupResult> {
  const marker = await readDoneMarker(deps.migration);
  const pending = marker?.remotePending ?? [];
  if (pending.length === 0) return { outcome: "nothing-pending", deleted: [] };

  const log = deps.migration.logger;
  try {
    const head = await deps.client.getBranchHeadSha({ retry: true });
    const commit = await deps.client.getCommit({ sha: head, retry: true });
    const tree = await deps.client.getRepoTree({
      sha: commit.tree.sha,
      retry: true,
    });

    if (tree.truncated) {
      // ⚠️ `truncated` breaks the "absent means deleted" equality the whole
      // filter rests on — the same reason discovery refuses a truncated
      // tree (§II.13.2). Guessing here would send a deletion entry for a
      // path that is still present, or for one that never was; the latter
      // is the known 422 BadObjectState. Waiting costs nothing: the
      // pending list survives.
      log?.warn(
        "gitignore remote cleanup deferred: the repo tree came back truncated",
        { pending },
      );
      return {
        outcome: "deferred-truncated",
        deleted: [],
        reason: "repo tree truncated",
      };
    }

    const present = new Set(tree.files.map((f) => f.path));
    const toDelete = pending.filter((p) => present.has(p));

    if (toDelete.length === 0) {
      // Either they were never pushed (a vault whose nested `.gitignore`
      // files predate any sync) or a previous attempt landed and only the
      // marker write failed. Both mean: done, clear it.
      log?.info("gitignore remote cleanup: nothing to delete on the remote", {
        pending,
      });
      await clearRemotePending(deps.migration);
      return { outcome: "nothing-on-remote", deleted: [] };
    }

    await deps.client.pushCommitToBranch({
      branch: deps.branch,
      parent: head,
      entries: toDelete.map((path) => ({ path, sha: null })),
      message: formatGitignoreCleanupMessage(
        deps.deviceLabel,
        toDelete.length,
        deps.migration.nowMs(),
      ),
      retry: true,
    });
    // AFTER the push, deliberately. If this write fails the next attempt
    // finds the paths absent and takes the branch above — it never sends a
    // second deletion entry for the same path.
    await clearRemotePending(deps.migration);
    log?.info("gitignore remote cleanup: deleted", { paths: toDelete });
    return { outcome: "deleted", deleted: toDelete };
  } catch (err) {
    // Kept, not cleared: an unfinished cleanup that forgets its list is a
    // divergence nobody will ever notice again.
    log?.warn("gitignore remote cleanup failed — will retry", {
      err: `${err}`,
      pending,
    });
    return { outcome: "failed", deleted: [], reason: `${err}` };
  }
}
