// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Types shared across the sync2 stack. Kept deliberately small and free
// of legacy field carry-over: sync2 builds its own state model, it does
// not consume the legacy manifest schema.

// One file's place in the sync world from sync2's point of view.
// Only files that have made at least one round-trip with GitHub are
// represented; files added locally and not yet pushed are simply
// absent from the snapshot store and surface as `added` from
// ChangeDetector.findChanges() until they're pushed.
export type FileSnapshot = {
  // POSIX path relative to vault root.
  path: string;
  // Git blob SHA last seen on the remote for this path.
  remoteSha: string;
  // mtime+size pair of the local file at the moment remoteSha was
  // recorded. Used by ChangeDetector to short-circuit unchanged files
  // without reading them.
  mtime: number;
  size: number;
};

// A change discovered by ChangeDetector for one file.
export type FileChange =
  | { kind: "added"; path: string; size: number; mtime: number }
  | {
      kind: "modified";
      path: string;
      size: number;
      mtime: number;
      previousRemoteSha: string;
    }
  | { kind: "deleted"; path: string; previousRemoteSha: string };

// One push-queue batch waiting on disk. Always represents the user's
// intent at the moment the batch was enqueued; later edits do not
// retroactively mutate it. The one writable slot is `uploadedBlobs`,
// which tracks per-file `createBlob` results for resume — see below.
export type QueueBatch = {
  // Timestamp-suffixed directory name, e.g. "20260503093823777".
  id: string;
  // Epoch-millis local commit moment (Date.now() at enqueue). The
  // commit object is created later at push time, so git's
  // author/committer date reflects the push, not this; the commit
  // MESSAGE carries this value (rendered local + offset) so the true
  // commit moment is visible. 0 for legacy batches with no recorded
  // createdAt — callers fall back to the current time.
  createdAt: number;
  // Whether the runner is currently uploading this batch. Persisted as
  // an ".in-progress" marker file inside the batch directory.
  inProgress: boolean;
  // Whether the runner has ever started pushing this batch — set
  // when processBatch begins and NEVER cleared (the only cleanup is
  // queue.delete on commit success). Once set, the batch is
  // "frozen": mergeIntoLatestPending refuses to fold new changes
  // into it even when consolidateCommits is on. Models the
  // user's rule "in-progress OR failed batch is blocked from
  // merges; new sync clicks create a new batch instead".
  attempted: boolean;
  // True for Phase B side-batches synthesized from drain conflict-
  // resolution (push to main as "resolve conflict ({label})"); false
  // for user-driven batches from syncAll / syncFile (push as "sync
  // ({label})"). processBatch derives the message inline from this
  // field + the current `deviceLabel` setting via
  // `commitMessageForBatch` in src/sync2/commit-message.ts; no
  // template is persisted. See docs/PSEUDO-MERGE-MODE.md §10 Scenario
  // E for how synthetic side-batches arise.
  synthetic: boolean;
  // Snapshot of the parent commit SHA at enqueue time. Used as the
  // first-pick parent; if the remote has moved since, the runner
  // resolves the conflict before pushing.
  parentCommitSha: string | null;
  // Snapshot of the parent's tree SHA. Reused as `base_tree` so the
  // POST tree request ships only the changed entries.
  parentTreeSha: string | null;
  // Files included in this batch, by path relative to the batch's
  // vault/ subdirectory.
  files: string[];
  // Paths to delete on the remote, listed verbatim from
  // deleted-paths.txt.
  deletions: string[];
  // Per-file blob SHAs that `createBlob` already returned for this
  // batch in a prior (possibly crashed) attempt. Resume of an
  // interrupted push consults this map before issuing another
  // createBlob — if `path` is present, the SHA is reused inline in
  // the tree entry and the network call is skipped. Empty on first
  // attempt; populated incrementally as `createBlob` calls succeed.
  // Survives across plugin reloads because it lives in .meta.json.
  // Cleared implicitly when the batch dir is deleted on commit
  // success — staleness is impossible by construction.
  uploadedBlobs: Record<string, string>;
  // mtime per snapshotted file, captured at enqueue time BEFORE
  // copyFileFromVault's canonical-write-back can bump the live vault
  // file's mtime. Reconcile uses this as the local-side timestamp
  // for binary/plugin-js atomic resolution — using the live mtime
  // instead would silently flip the answer toward "local wins" any
  // time canonicalization rewrote the file. Empty for batches that
  // predate this field (defensive — caller falls back to 0).
  fileMtimes: Record<string, number>;
};

