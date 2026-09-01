// Hybrid discovery, Layer 1 (NEW-DRAIN §II.12) + getCommitInfoForPath
// (§III, P.23-26). Phase 3 primitives; the new drain (Phase 4) is the
// caller. Layer 2 (§II.13) lives in the client as
// getContentsMetadataAtRef — it is a per-path transport, not a
// discovery pass.
//
// ONE function serves BOTH degraded triggers: compare() truncating at
// exactly 300 files, and compare() 404 on force-push (base no longer
// reachable from head). Both fall back to the SAME
// fullTreeDiffAgainstColdBaseline — a full recursive tree read diffed
// against OUR OWN per-file baselines, not against git history. That
// is also why the fallback feeds _diff3 a REAL base: force-push
// breaks GitHub's ability to walk base→head, it does not touch our
// on-disk memory; diff2 (base=null) would turn every divergence into
// a spurious MANUAL_CONFLICT (§II.1 rule 4.2).
//
// Cold start is the SAME branch (§II.12 step 0): base == null goes
// straight to the tree fallback, and an empty baseline map naturally
// yields the whole repo — no separate bootstrap mechanism exists.
//
// Error contract: NOT_FOUND from compare() never escapes (it IS the
// force-push trigger). Everything else (NetworkError, AuthError, and
// TreeTruncatedError from the fallback) THROWS — the §III call site
// wraps discovery in retryOnNetworkError and owns the token latch.

import { NotFoundError, TreeTruncatedError } from "../errors";
import { parseDeviceSuffix } from "./commit-message";

// The spec-wide sentinel for "this side is a deletion" (§III uses it
// on local/remote/base alike). The git null-sha — no real blob can
// ever hash to it.
export const DELETED_SHA_HASH = "0000000000000000000000000000000000000000";

// One remote-side change candidate. `sha === DELETED_SHA_HASH` +
// `deleted: true` = the path is gone at head. `size` is known only on
// the tree-fallback path (the tree carries it for free; compare()
// has no size at all — Layer 2 / lazy rule-7 fills it later). `mtime`
// is ALWAYS null here — no discovery source carries dates; the three
// conflict-birth sites fill it via getCommitInfoForPath (§VII.4).
export interface RemoteFileChange {
  path: string;
  sha: string;
  size: number | null;
  mtime: null;
  deleted: boolean;
}

// A COMPLETE picture of what the repo holds at ONE pinned commit, kept
// so that later steps can answer "what is the remote sha/size of this
// path?" without a per-path request.
//
// Why this is sound rather than a cache of a mutable thing: `atCommit`
// is a commit SHA, never a branch name, and a commit's tree is
// immutable. Asking the Contents API for `<path>@<commitSha>` can only
// ever return what this map already holds — so the map is not a stale
// copy of the answer, it IS the answer.
//
// Absence of a path means the path does not exist at that commit,
// which is exactly what a 404 from the Contents API means. That
// equivalence holds ONLY because the tree was complete: a truncated
// tree never produces a snapshot (fullTreeDiffAgainstColdBaseline
// throws instead), and consumers re-assert `atCommit` before use.
export interface RemoteTreeSnapshot {
  atCommit: string;
  paths: Map<string, { sha: string; size: number | null }>;
}

export interface DiscoveryResult {
  changes: RemoteFileChange[];
  // Present only when discovery read the FULL tree (cold start, or a
  // fallback from compare). The compare path sees a diff, not a
  // complete picture, so it cannot answer for unrelated paths.
  tree: RemoteTreeSnapshot | null;
}

// GitHub's documented, API-version-frozen compare() cap
// (SPIKE-COMPARE-300 §1) — at exactly this count the list is
// untrustworthy and the tree fallback REPLACES it.
export const COMPARE_FILES_CAP = 300;

export interface DiscoveryLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
}

// Structural client surface — the fake in unit tests implements
// exactly this; the real GithubClient satisfies it as-is.
export interface DiscoveryClient {
  compare(args: { base: string; head: string; retry?: boolean }): Promise<{
    files: Array<{
      filename: string;
      status: string;
      sha: string | null;
      previous_filename?: string;
    }>;
  }>;
  getRepoTree(args: { sha: string; retry?: boolean }): Promise<{
    files: Array<{ path: string; sha: string; size: number | null }>;
    truncated: boolean;
  }>;
}

export interface DiscoveryDeps {
  client: DiscoveryClient;
  // Per-file baselines (Phase 1 cold buckets). `allPaths` +
  // `getMany` group bucket access internally — discovery never
  // walks the buckets itself.
  baselines: {
    allPaths(): Promise<string[]>;
    getMany(paths: string[]): Promise<Map<string, { baselineSha: string }>>;
  };
  // May be async in production (gitignore walks read files).
  isSyncable: (path: string) => boolean | Promise<boolean>;
  logger?: DiscoveryLogger;
}

export async function getChangedFilesFromGitHubRepo(
  deps: DiscoveryDeps,
  base: string | null,
  head: string,
): Promise<DiscoveryResult> {
  // Step 0 — cold start: compare() without a base is impossible by
  // definition; the tree fallback doesn't need one.
  if (base === null) {
    return fullTreeDiffAgainstColdBaseline(deps, head);
  }

  // Step 1 — always compare() first: cheapest (one call) and the
  // ONLY way to detect force-push. Its 404 is NOT a network error —
  // handled here, never propagated; transient 5xx/429 retry inside
  // compare() as usual.
  let files: Awaited<ReturnType<DiscoveryClient["compare"]>>["files"];
  try {
    files = (await deps.client.compare({ base, head, retry: true })).files;
  } catch (err) {
    if (err instanceof NotFoundError) {
      deps.logger?.warn(
        "getChangedFilesFromGitHubRepo: compare() 404 — force-push, tree-diff fallback",
        { base, head },
      );
      return fullTreeDiffAgainstColdBaseline(deps, head);
    }
    throw err;
  }

  // Step 3 — exactly 300: compare() truncated. The tree fallback
  // REPLACES (never supplements) the partial list.
  if (files.length >= COMPARE_FILES_CAP) {
    deps.logger?.warn(
      "getChangedFilesFromGitHubRepo: compare() truncated at 300 — tree-diff fallback",
      { base, head },
    );
    return fullTreeDiffAgainstColdBaseline(deps, head);
  }

  // Step 2 — the common path: a COMPLETE list under the cap. The
  // element carries {path, sha} and nothing else useful: no size
  // (Layer 2 / lazy rule-7 fills it), no dates (getCommitInfoForPath
  // fills mtime at the conflict-birth sites only). A rename is two
  // candidates — the new path as a change, previous_filename as a
  // deletion (SPIKE-COMPARE-300 §2.2: the tag is similarity-derived
  // sugar; set-difference semantics are what our code has always
  // used).
  const out: RemoteFileChange[] = [];
  for (const f of files) {
    if (!(await deps.isSyncable(f.filename))) continue;
    if (f.status === "removed") {
      out.push(deletedChange(f.filename));
      continue;
    }
    if (
      f.status === "renamed" &&
      typeof f.previous_filename === "string" &&
      (await deps.isSyncable(f.previous_filename))
    ) {
      out.push(deletedChange(f.previous_filename));
    }
    out.push({
      path: f.filename,
      sha: f.sha ?? DELETED_SHA_HASH,
      size: null,
      mtime: null,
      deleted: f.sha === null,
    });
  }
  // No snapshot: compare() answers "what changed", not "what exists".
  return { changes: out, tree: null };
}

// The shared fallback for BOTH triggers plus cold start. Base-free by
// construction: reads the FULL tree at head and checks EVERY path
// against our baselines. Cost is O(whole vault), not O(diff) —
// measured ~278 B/entry, ≈5.6 MB per 20k files (SPIKE-TREES-LIMIT §3)
// — deliberately not optimised (the dual-tree walk stays a
// documented, unimplemented idea).
export async function fullTreeDiffAgainstColdBaseline(
  deps: DiscoveryDeps,
  head: string,
): Promise<DiscoveryResult> {
  const tree = await deps.client.getRepoTree({ sha: head, retry: true });
  if (tree.truncated) {
    // Hard error, NEVER a silent partial return (SPIKE-TREES-LIMIT
    // §4.2: the documented cap is 100k entries OR 7 MB, and 20k
    // entries already measure ~5.6 MB — this is a real ceiling).
    throw new TreeTruncatedError(
      "fullTreeDiffAgainstColdBaseline: recursive tree response truncated — " +
        "discovery is structurally impossible with this mechanism at this vault size",
    );
  }

  // Two maps from one response, deliberately different in scope:
  //   snapshot — EVERY blob, because it answers "what does the repo
  //     hold at this commit?" and a path can be un-syncable here while
  //     still existing on the server (the gitignore may have moved
  //     since the batch was written). Filtering it would make an
  //     existing file look deleted.
  //   treePaths — syncable only, because THAT is our sync scope and
  //     the diff below must not resurrect ignored paths.
  const snapshot: RemoteTreeSnapshot = { atCommit: head, paths: new Map() };
  const treePaths = new Map<string, { sha: string; size: number | null }>();
  for (const f of tree.files) {
    snapshot.paths.set(f.path, { sha: f.sha, size: f.size });
    if (await deps.isSyncable(f.path)) {
      treePaths.set(f.path, { sha: f.sha, size: f.size });
    }
  }

  const knownPaths: string[] = [];
  for (const p of await deps.baselines.allPaths()) {
    if (await deps.isSyncable(p)) knownPaths.push(p);
  }
  const baselines = await deps.baselines.getMany(knownPaths);

  // Union: everything WE know + everything the server has now.
  const allPaths = new Set<string>([...knownPaths, ...treePaths.keys()]);
  const out: RemoteFileChange[] = [];
  for (const path of allPaths) {
    const baselineSha = baselines.get(path)?.baselineSha ?? null;
    const live = treePaths.get(path) ?? null;
    if (baselineSha === (live?.sha ?? null)) continue; // unchanged vs our memory
    out.push(
      live === null
        ? deletedChange(path)
        : {
            path,
            sha: live.sha,
            // The ONLY discovery path that yields sizes for free —
            // they ride the same tree response.
            size: live.size,
            mtime: null,
            deleted: false,
          },
    );
  }
  return { changes: out, tree: snapshot };
}

function deletedChange(path: string): RemoteFileChange {
  return {
    path,
    sha: DELETED_SHA_HASH,
    size: null,
    mtime: null,
    deleted: true,
  };
}

// ── getCommitInfoForPath (§III; §VIII P.23-26) ────────────────────

// (device_label, committed_at) for the commit that last touched
// `path` at/before `atSha` — ONE request for BOTH fields. Called
// ONLY at the three conflict-birth sites (§VII.4): discovery never
// carries dates (verified live — neither compare() nor the tree
// has them), and for non-conflict paths nobody reads mtime, so one
// lazy call per conflict is the whole cost.
export interface CommitInfoClient {
  listCommitsForPath(args: {
    path: string;
    branch: string;
    perPage?: number;
    retry?: boolean;
  }): Promise<Array<{ sha: string; date: string; message: string }>>;
}

export async function getCommitInfoForPath(
  client: CommitInfoClient,
  path: string,
  atSha: string,
): Promise<{ deviceLabel: string; committedAtMs: number } | null> {
  const commits = await client.listCommitsForPath({
    path,
    branch: atSha,
    perPage: 1,
    retry: true,
  });
  if (commits.length === 0) return null;
  const top = commits[0];
  const parsed = Date.parse(top.date);
  return {
    // A commit made outside this plugin has no trailing "(label)" —
    // parseDeviceSuffix already answers UNKNOWN_DEVICE_LABEL, and
    // committedAtMs stays REAL, so a sibling name comes out as
    // "…conflict-from-unknown-<date>…", never with an empty date
    // (P.24/P.26).
    deviceLabel: parseDeviceSuffix(top.message),
    committedAtMs: Number.isNaN(parsed) ? 0 : parsed,
  };
}
