// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { base64ToArrayBuffer, requestUrl } from "obsidian";
import Logger from "src/logger";
import { GitHubSyncSettings } from "src/settings/settings";
import {
  isRetriableStatus,
  isWriteRetriableStatus,
  isRefUpdateRetriableStatus,
  retryUntil,
} from "src/utils";
// URL-encoding for GitHub Contents-API paths lives in the
// cross-platform contracts module (SYNC2 §3).
// Per SYNC2 §3 the migration is zero-cycle: no re-export
// shim, every call site (here + tests) imports directly from the
// new location.
import { encodePathForGithub } from "src/sync2/cross-platform";

export type RepoContent = {
  files: { [key: string]: GetTreeResponseItem };
  sha: string;
};

/**
 * Represents a single item in a tree response from the GitHub API.
 */
export type GetTreeResponseItem = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
  url: string;
};

export type NewTreeRequestItem = {
  path: string;
  mode: string;
  type: string;
  sha?: string | null;
  content?: string;
};

/**
 * Response received when we create a new binary blob on GitHub
 */
export type CreatedBlob = {
  sha: string;
};

/**
 * Represents a git blob response from the GitHub API.
 */
export type BlobFile = {
  sha: string;
  node_id: string;
  size: number;
  url: string;
  content: string;
  encoding: string;
};

// SYNC2 §5: `GithubAPIError` now lives in src/errors.ts.
// `makeGithubAPIError(status, message, body?)` returns the right
// subclass (NotFoundError, ConflictError, ValidationError, AuthError,
// RateLimitError) based on the status code, falling back to the
// base GithubAPIError for codes outside the mapped set. Existing
// catch sites that duck-type on `err.status` keep working
// unchanged; new catch sites use `err instanceof NotFoundError` etc.
import { makeGithubAPIError } from "src/errors";
import type WorkerClient from "src/worker/worker-client";

// Case-insensitive response-header lookup. The two transports
// disagree on key casing (Obsidian's requestUrl lowercases; the
// network worker passes fetch's Headers entries through as-is), and
// getContentsMetadataAtRef reads ETag/Content-Length from either.
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === "string") return direct;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

export default class GithubClient {
  // Optional Worker orchestra controller. When provided, every
  // HTTP request below routes through the network worker (Stage 6:
  // GitHub API in worker). When omitted (most unit tests, the
  // settings-tab connection probe), falls back to Obsidian's
  // requestUrl. Either way the same logging, retry, and error
  // classification logic runs.
  constructor(
    private settings: GitHubSyncSettings,
    private logger: Logger,
    private workerClient?: WorkerClient,
  ) {}

  headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.settings.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  // Wraps every requestUrl with timing + size instrumentation so a single
  // sync run shows up in the log as a sequence of "HTTP …" entries with
  // wall-clock duration, status, and body sizes. retryUntil calls fn()
  // once per attempt, so each retry shows up as its own line — handy for
  // pinning down whether a slow sync is one big call or a retry storm.
  private async timed(
    opts: Parameters<typeof requestUrl>[0],
    label: string,
  ): Promise<ReturnType<typeof requestUrl> extends Promise<infer R> ? R : never> {
    const method = (opts as { method?: string }).method ?? "GET";
    const body = (opts as { body?: string | ArrayBuffer }).body;
    const reqBytes =
      typeof body === "string"
        ? body.length
        : body instanceof ArrayBuffer
        ? body.byteLength
        : 0;
    const t0 = Date.now();

    // Stage 6: route every GitHub HTTP call through the network
    // worker when the orchestra is wired up. The worker uses
    // native fetch — CORS-validated on Capacitor mobile via the
    // Stage 6 diagnostic test. Falls back to Obsidian's
    // requestUrl when no workerClient is provided (most unit
    // tests, settings-tab connection probe, etc.).
    if (this.workerClient !== undefined) {
      // requestUrl accepts body as string OR ArrayBuffer; the
      // network worker only handles strings (we don't currently
      // need binary uploads from the engine — base64-encoded blob
      // content travels as a JSON string through createBlob).
      const reqBody =
        typeof body === "string"
          ? body
          : body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : undefined;
      const wr = await this.workerClient.httpRequest({
        url: (opts as { url: string }).url,
        method,
        headers: (opts as { headers?: Record<string, string> }).headers,
        body: reqBody,
      });
      const dt = Date.now() - t0;
      void this.logger.info(
        `HTTP ${method} ${label} duration=${dt}ms status=${wr.status} reqKB=${(reqBytes / 1024).toFixed(1)} respKB=${(wr.text.length / 1024).toFixed(1)}`,
      );
      // Shape the worker response to match requestUrl's
      // RequestUrlResponse — the rest of GithubClient reads
      // status / json / text without caring whether it came
      // from the worker or the main-thread path.
      return {
        status: wr.status,
        text: wr.text,
        json: wr.json,
        headers: wr.headers,
        arrayBuffer: new TextEncoder().encode(wr.text).buffer,
      } as ReturnType<typeof requestUrl> extends Promise<infer R> ? R : never;
    }

    const res = await requestUrl(opts);
    const dt = Date.now() - t0;
    const respBytes = res.arrayBuffer?.byteLength ?? 0;
    void this.logger.info(
      `HTTP ${method} ${label} duration=${dt}ms status=${res.status} reqKB=${(reqBytes / 1024).toFixed(1)} respKB=${(respBytes / 1024).toFixed(1)}`,
    );
    return res;
  }

  /**
   * Gets the content of the repo.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns Array of files in the directory in the remote repo
   */
  async getRepoContent({
    retry = false,
    maxRetries = 5,
  } = {}): Promise<RepoContent> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/trees/${this.settings.githubBranch}?recursive=1`,
            headers: this.headers(),
            throw: false,
          },
          "tree?recursive=1",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0, // Use 0 retries if retry is false
    );

    if (response.status < 200 || response.status >= 400) {
      // 404/409 specifically mean "no commits in this repo yet" — that's
      // how analyzeRemoteState detects a bare repo. It's an expected
      // signal, not an error, so log at info level to avoid noise in the
      // log file. Anything else really is unexpected and stays at error.
      if (response.status === 404 || response.status === 409) {
        this.logger.info("Repo has no commits yet (bare)", {
          status: response.status,
        });
      } else {
        this.logger.error("Failed to get repo content", response);
      }
      throw makeGithubAPIError(
        response.status,
        `Failed to get repo content, status ${response.status}`,
      );
    }

    const files = response.json.tree
      .filter((file: GetTreeResponseItem) => file.type === "blob")
      .reduce(
        (
          acc: { [key: string]: GetTreeResponseItem },
          file: GetTreeResponseItem,
        ) => ({ ...acc, [file.path]: file }),
        {},
      );
    return { files, sha: response.json.sha };
  }

  /**
   * Creates a new tree in the GitHub repository.
   *
   * @param tree The tree object to create
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the created tree
   */
  async createTree({
    tree,
    retry = false,
    maxRetries = 5,
  }: {
    // base_tree is optional: omit when bootstrapping a brand-new repo
    // (no commits yet, no tree to base on).
    tree: { tree: NewTreeRequestItem[]; base_tree?: string };
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/trees`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify(tree),
            throw: false,
          },
          `tree (entries=${tree.tree.length})`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create tree", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create tree, status ${response.status}`,
      );
    }
    return response.json.sha;
  }

  /**
   * Creates a new commit in the repository.
   *
   * @param message The commit message
   * @param treeSha The SHA of the tree
   * @param parent The SHA of the parent commit. Omit (or pass undefined)
   *   to create a root commit — needed when bootstrapping a brand-new
   *   repo that doesn't have any commits yet.
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the created commit
   */
  async createCommit({
    message,
    treeSha,
    parent,
    parents,
    author,
    retry = false,
    maxRetries = 5,
  }: {
    message: string;
    treeSha: string;
    // Single parent (existing call sites). Mutually exclusive with
    // `parents`; if both are passed, `parents` wins.
    parent?: string;
    // Multi-parent (pseudo-merge stage 7+: manual merge commits land
    // tree-of-main with parents=[main.head, branch.head]).
    parents?: string[];
    // Optional git identity + date. When provided, sent as BOTH the
    // commit `author` and `committer` so git's metadata date reflects
    // the local commit moment (not push time). `date` is ISO 8601
    // (with offset). When omitted, GitHub uses the authenticated
    // token's user + the current (push) time. See SYNC2.md §4.4.
    author?: { name: string; email: string; date: string };
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string> {
    const parentsArr =
      parents !== undefined ? parents : parent !== undefined ? [parent] : [];
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/commits`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({
              message: message,
              tree: treeSha,
              parents: parentsArr,
              // Set author AND committer to the same identity+date so
              // both git dates record the local commit moment.
              ...(author !== undefined
                ? { author, committer: author }
                : {}),
            }),
            throw: false,
          },
          "commit",
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create commit", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create commit, status ${response.status}`,
      );
    }
    return response.json.sha;
  }

  /**
   * §II.15 (Phase 4): create a commit on a READY tree and move the
   * branch ref — the MAIN-push tail of the new drain. Distinct from
   * the conflict branch's pushCommit-with-a-blob-list by NAME, per
   * the spec's 2026-08-30 rename note (one name meaning two shapes
   * on two sites was the hazard).
   *
   * Returns BOTH the new commit sha and committer date (ms) from the
   * same Create-Commit response — the mtime invariant stamps
   * committed_at onto every pushed path, and the response is parsed
   * for the sha anyway.
   *
   * `parent: null` = bare repo: a parentless commit + createReference
   * (the ref doesn't exist yet). Otherwise a plain non-force PATCH —
   * its 422 ("not a fast forward") throws ValidationError, which the
   * drain's 422-restart path catches.
   */
  async pushCommitFromTree({
    treeSha,
    parent,
    message,
    author,
    retry = false,
    maxRetries = 5,
  }: {
    treeSha: string;
    parent: string | null;
    message: string;
    // Optional git identity, sent as BOTH author and committer (same
    // contract as createCommit). ⚠️ Injecting a `date` here CHANGES
    // what the returned `committedAt` means: it is parsed from the
    // response's committer.date, and the drain stamps it onto every
    // pushed path's tracked.remote.mtime (§III mtime invariant) — so
    // with an injected date the invariant records YOUR date, not
    // GitHub's push time. Wiring this up is a Phase 5.5 step-4 (THE
    // SWITCH) decision, together with per-batch commit messages; no
    // caller passes it yet.
    author?: { name: string; email: string; date: string };
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ sha: string; committedAt: number }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/commits`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({
              message,
              tree: treeSha,
              parents: parent === null ? [] : [parent],
              ...(author !== undefined ? { author, committer: author } : {}),
            }),
            throw: false,
          },
          "commit-from-tree",
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create commit from tree", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create commit from tree, status ${response.status}`,
      );
    }
    const sha = response.json.sha as string;
    const dateIso =
      (response.json.committer?.date as string | undefined) ??
      (response.json.author?.date as string | undefined) ??
      "";
    const committedAt = Date.parse(dateIso) || 0;

    if (parent === null) {
      await this.createReference({
        ref: `refs/heads/${this.settings.githubBranch}`,
        sha,
        retry,
        maxRetries,
      });
    } else {
      await this.updateReference({
        ref: `heads/${this.settings.githubBranch}`,
        sha,
        retry,
        maxRetries,
      });
    }
    return { sha, committedAt };
  }

  /**
   * Head sha of an ARBITRARY branch by name (the drain's
   * conflict-branch read, NEW-DRAIN §II.7 — always read LIVE, never
   * persisted), or null when the branch doesn't exist (404).
   *
   * Uses the SINGULAR /git/ref/ endpoint deliberately: the plural
   * /git/refs/heads/{name} form does prefix MATCHING and answers with
   * an ARRAY when {name} is a proper prefix of other branches — .object
   * would be undefined and the read silently broken. The singular form
   * returns exactly one ref or 404. Same cache-buster as
   * getBranchHeadSha: this is a mutable ref and MUST be fresh.
   */
  async getBranchHeadShaByName({
    branch,
    retry = false,
    maxRetries = 5,
  }: {
    branch: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<string | null> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/ref/heads/${branch}?ts=${Date.now()}`,
            headers: this.headers(),
            throw: false,
          },
          `branch head ${branch}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get branch head sha by name", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get branch head sha for ${branch}, status ${response.status}`,
      );
    }
    return response.json.object.sha;
  }

  /**
   * The conflict-branch push (NEW-DRAIN §II.15 "Межа застосування"):
   * the OLD shape on purpose — a plain blob list (blobs already
   * uploaded by the caller), one commit, no accumulator, no inline
   * content. Units of files, so no rate-limit pressure.
   *
   * `parent: null` = the branch doesn't exist yet → a PARENTLESS root
   * commit whose tree holds ONLY `entries` (no base_tree), then
   * createReference. FINALIZE's merge commit (parents
   * [main, conflict]) later joins the histories, so main's
   * reachability is never affected. `parent` non-null → chain on the
   * parent's tree (base_tree) + non-force PATCH.
   *
   * Throws ValidationError (422) when `parent` is stale: PATCH
   * "not a fast forward", or createReference "Reference already
   * exists" (someone created the branch since our null read) — the
   * drain's 3-attempt re-read loop catches it ("АБСОЛЮТНО НЕМОЖЛИВО,
   * але…", §III).
   */
  async pushCommitToBranch({
    branch,
    parent,
    entries,
    message,
    author,
    retry = false,
    maxRetries = 5,
  }: {
    branch: string;
    parent: string | null;
    // sha null = tree DELETION entry (drain: ours-side deletion,
    // 4.6.b conflict). On a PARENTLESS root commit deletion entries
    // are FILTERED — deleting a path the tree never had is the
    // documented 422 BadObjectState (SYNC2 §7 postmortems).
    entries: Array<{ path: string; sha: string | null }>;
    message: string;
    // Same pass-through contract (and the same step-4 wiring note) as
    // pushCommitFromTree.
    author?: { name: string; email: string; date: string };
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ sha: string }> {
    // Resolve the effective parent: the branch's own head, or (fresh
    // branch) the CURRENT MAIN HEAD — the branch is born related.
    const effectiveParent =
      parent ?? (await this.getBranchHeadSha({ retry, maxRetries }));
    const parentCommit = await this.getCommit({
      sha: effectiveParent,
      retry,
      maxRetries,
    });
    const baseTree = parentCommit.tree.sha;
    // A deletion entry for a path the base tree does not carry would
    // 422 (BadObjectState) — the drain's shouldPush guard already
    // skips fresh-branch deletions, this filter is belt-and-braces
    // for direct callers.
    const treeSha = await this.createTree({
      tree: {
        tree: entries.map((e) => ({
          path: e.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: e.sha,
        })),
        base_tree: baseTree,
      },
      retry,
      maxRetries,
    });
    const sha = await this.createCommit({
      message,
      treeSha,
      parents: [effectiveParent],
      author,
      retry,
      maxRetries,
    });
    if (parent === null) {
      await this.createReference({
        ref: `refs/heads/${branch}`,
        sha,
        retry,
        maxRetries,
      });
    } else {
      await this.updateReference({ ref: `heads/${branch}`, sha, retry, maxRetries });
    }
    return { sha };
  }

  /**
   * Fetch a single commit's metadata (we only need its tree SHA).
   * Sync2 uses this during conflict reconciliation: after a HEAD
   * drift, we re-target the in-flight batch onto the new head, which
   * requires the head's tree SHA as `base_tree`.
   */
  async getCommit({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{
    tree: { sha: string };
    committer: { date: string };
    // Full commit message. Sync2 reads the trailing " (label)"
    // suffix here via parseDeviceSuffix to identify which device
    // authored a conflict's "theirs" side. Falls back to "" when
    // the API response is missing the field, which parses to the
    // UNKNOWN_DEVICE_LABEL sentinel.
    message: string;
  }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/commits/${sha}`,
            headers: this.headers(),
            throw: false,
          },
          "commit",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get commit", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get commit, status ${response.status}`,
      );
    }
    return {
      tree: { sha: response.json.tree.sha },
      committer: {
        date:
          response.json.committer?.date ??
          response.json.author?.date ??
          new Date(0).toISOString(),
      },
      message:
        typeof response.json.message === "string"
          ? response.json.message
          : "",
    };
  }

  /**
   * List commits that touched `path` on `branch`, newest-first — the
   * data source for the Phase 7 History timeline (HISTORY-DELETED §4.7
   * 7a.0). Returns `{sha, date, message}` per commit, where `sha` is the
   * COMMIT-sha (the open-handle the History view uses to fetch that
   * version's bytes via `getContentsAtRef`).
   *
   * `since` (ISO-8601) scopes to a period (period-filter, 7b.1);
   * `page`/`perPage` page the result (infinite-scroll, §4.3). This is a
   * SINGLE page per call — the caller loops pages, this does not.
   *
   * Unlike `getLatestCommitDateForPath` (a best-effort tie-break that
   * swallows failures to null), this feeds a UI list, so it distinguishes
   * empty-history (`[]` on a 200) from fetch-failure: it THROWS via
   * `makeGithubAPIError` on a non-2xx, matching `getContentsAtRef` /
   * `createTree`, so the view can render an error state.
   *
   * GET /repos/{o}/{r}/commits?path={path}&sha={branch}[&since=][&per_page=][&page=]
   */
  async listCommitsForPath({
    path,
    branch,
    since,
    perPage,
    page,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    branch: string;
    since?: string;
    perPage?: number;
    page?: number;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<Array<{ sha: string; date: string; message: string }>> {
    let query =
      `path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}`;
    if (since !== undefined) query += `&since=${encodeURIComponent(since)}`;
    if (perPage !== undefined) query += `&per_page=${perPage}`;
    if (page !== undefined) query += `&page=${page}`;
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/commits?${query}`,
            headers: this.headers(),
            throw: false,
          },
          "list-commits-for-path",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to list commits for path", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to list commits for ${path}@${branch}, status ${response.status}`,
      );
    }
    const arr = (response.json ?? []) as Array<{
      sha?: string;
      commit?: {
        message?: string;
        committer?: { date?: string };
        author?: { date?: string };
      };
    }>;
    return arr.map((c) => ({
      sha: c.sha ?? "",
      date: c.commit?.committer?.date ?? c.commit?.author?.date ?? "",
      message: c.commit?.message ?? "",
    }));
  }


  /**
   * Fetch the base64-encoded blob content at a specific commit ref.
   * Sync2 uses this for both base (lastSyncCommitSha) and theirs
   * (currentHead) sides of a 3-way merge during conflict
   * reconciliation. Returns null on 404 (path absent at that commit
   * — e.g. force-pushed history).
   *
   * **Large-file fallback (P0 fix for 2.0.1-beta5):**
   * GitHub's Contents API has a hard ~1 MB inline-content limit. For
   * files >1 MB and ≤100 MB the API returns status 200 with
   * `content: ""` (empty string) and `encoding: "none"`, expecting
   * the caller to fall back to the Blobs API to fetch the actual
   * bytes via the file's blob SHA. Before this fix, sync2 silently
   * decoded the empty content to a 0-byte ArrayBuffer, ran the 3-way
   * merge against "remote=∅", and concluded "ours wins" — pushing the
   * local content (which could itself be corrupted) over the
   * legitimate >1 MB remote file. This was reproduced as a
   * catastrophic data-loss incident on a user vault containing
   * ~1.5 MB markdown notes. See docs/PSEUDO-MERGE-MODE.md §16 Field
   * Postmortems.
   *
   * Fix: when Contents API returns empty content but reports `size > 0`,
   * fetch the actual bytes via `getBlob({ sha })`. Blobs API has its
   * own ~100 MB limit (separate from Contents API's 1 MB limit) and
   * works correctly for the entire range we care about for vault
   * sync. Logged at WARN level so the fallback path is visible in
   * production logs.
   *
   * See: https://docs.github.com/en/rest/repos/contents
   */
  async getContentsAtRef({
    path: filePath,
    ref,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    ref: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ content: string; sha: string } | null> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${encodePathForGithub(filePath)}?ref=${ref}`,
            headers: this.headers(),
            throw: false,
          },
          `contents/${filePath}@${ref.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get contents at ref", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get contents at ref, status ${response.status}`,
      );
    }

    const sha = response.json.sha as string;
    const size = (response.json.size as number) ?? 0;
    const content = (response.json.content as string | null) ?? "";
    const encoding = (response.json.encoding as string | undefined) ?? "";

    // Inline content present → use it directly. The typical < 1 MB
    // case. Encoding is "base64" with non-empty content.
    if (content !== "") {
      return { content, sha };
    }

    // Edge: file is actually empty on the server (size === 0). Treat
    // as a regular empty file — `content` of "" is correct already
    // (base64ToArrayBuffer("") gives a 0-byte ArrayBuffer, which is
    // what callers expect for an empty file).
    if (size === 0) {
      return { content: "", sha };
    }

    // File is >1 MB → Contents API truncated inline content per the
    // documented behavior (https://docs.github.com/en/rest/repos/contents).
    // `encoding` is "none" in this case. Fall back to Blobs API to fetch
    // the actual bytes (base64-encoded) via the file's blob SHA.
    this.logger.info(
      "getContentsAtRef: Contents API returned empty content for >1MB file; falling back to Blobs API",
      {
        path: filePath,
        ref: ref.slice(0, 7),
        size,
        encoding,
        sha,
      },
    );
    const blob = await this.getBlob({ sha, retry, maxRetries });
    return { content: blob.content, sha };
  }


  /**
   * Full recursive tree at an ARBITRARY commit/tree sha — the data
   * source of `fullTreeDiffAgainstColdBaseline` (NEW-DRAIN §II.12,
   * Phase 3). Differs from `getRepoContent` (branch-pinned, ignores
   * `truncated`) in exactly the two ways the new drain needs:
   * takes a sha, and READS the `truncated` flag (SPIKE-TREES-LIMIT
   * §4.2: the response caps at a documented 100k entries OR 7 MB —
   * ~5.6 MB already at 20k entries — so the flag is load-bearing,
   * not theoretical). Callers must treat `truncated: true` as a hard
   * error; this method only reports it. Blob entries only; per-entry
   * `size` comes in the same response for free.
   */
  async getRepoTree({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{
    files: Array<{ path: string; sha: string; size: number | null }>;
    truncated: boolean;
  }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/trees/${sha}?recursive=1`,
            headers: this.headers(),
            throw: false,
          },
          `tree/${sha.slice(0, 7)}?recursive=1`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get repo tree", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get repo tree at ${sha}, status ${response.status}`,
      );
    }
    const files = (response.json.tree as GetTreeResponseItem[])
      .filter((f) => f.type === "blob")
      .map((f) => ({
        path: f.path,
        sha: f.sha,
        size: typeof f.size === "number" ? f.size : null,
      }));
    return { files, truncated: response.json.truncated === true };
  }

  /**
   * Live per-path metadata via HEAD + raw media type — the Layer-2
   * transport (NEW-DRAIN §II.13, Phase 3). Supersedes
   * `getContentsMetadataAtRef` at the Phase 4 cutover; the old
   * GET-based method stays untouched for the old engine until then.
   *
   * Why HEAD (measured on the live API, §II.13): `GET /contents`
   * inlines base64 content for every file up to 1 MB, so the "cheap
   * check" was downloading the whole batch and throwing it away —
   * a 990 KB file cost a 1.3 MB body; HEAD costs 0 bytes and is ~3×
   * faster on big files. The `ETag` of the raw media type IS the
   * blob sha and `Content-Length` the raw size.
   *
   * ⚠️ ETag == blob-SHA is an OBSERVATION, not a GitHub contract
   * (unlike the 300-cap, which is frozen for our pinned API
   * version). Three-layer defence: (1) runtime shape check with GET
   * fallback below; (2) the P.19 integration CANARY asserts literal
   * EQUALITY against the documented `sha` field; (3) even a wrong
   * sha fails LOUDLY downstream (sync_store miss → getBlob 404),
   * never silently.
   *
   * The GET fallback receives inline content for files ≤1 MB — the
   * bytes already travelled, so they go to `blobSink` (the caller's
   * sync_store) instead of the bin; >1 MB files come with empty
   * content and `blob` stays null. Returns null when the path does
   * not exist at the ref (404 — a normal answer, not an error).
   */
  async getContentsMetadataAtRef({
    path: filePath,
    ref,
    blobSink,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    ref: string;
    blobSink?: {
      has(sha: string): Promise<boolean>;
      save(sha: string, bytes: ArrayBuffer): Promise<void>;
    };
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ sha: string; size: number; blob: ArrayBuffer | null } | null> {
    const url = `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${encodePathForGithub(filePath)}?ref=${ref}`;
    const headResponse = await retryUntil(
      async () => {
        return this.timed(
          {
            url,
            method: "HEAD",
            headers: {
              ...this.headers(),
              Accept: "application/vnd.github.raw+json",
            },
            throw: false,
          },
          `contents-head/${filePath}@${ref.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (headResponse.status === 404) return null;
    if (headResponse.status < 200 || headResponse.status >= 400) {
      this.logger.error("Failed HEAD contents metadata", headResponse);
      throw makeGithubAPIError(
        headResponse.status,
        `Failed HEAD contents metadata, status ${headResponse.status}`,
      );
    }

    const rawEtag = headerValue(headResponse.headers, "etag") ?? "";
    const etag = rawEtag.replace(/^W\//, "").replace(/^"|"$/g, "");
    if (/^[0-9a-f]{40}$/.test(etag)) {
      const len = headerValue(headResponse.headers, "content-length");
      return {
        sha: etag,
        size: len === null ? 0 : parseInt(len, 10) || 0,
        blob: null,
      };
    }

    // Fallback — the ETag isn't shaped like a blob sha. Don't guess:
    // take the DOCUMENTED `sha`/`size` fields from GET+json.
    this.logger.warn(
      "getContentsMetadataAtRef: ETag not a blob-SHA — falling back to GET",
      { path: filePath, etag: rawEtag },
    );
    const getResponse = await retryUntil(
      async () => {
        return this.timed(
          {
            url,
            headers: this.headers(),
            throw: false,
          },
          `contents-meta-fallback/${filePath}@${ref.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (getResponse.status === 404) return null;
    if (getResponse.status < 200 || getResponse.status >= 400) {
      this.logger.error("Failed GET contents metadata fallback", getResponse);
      throw makeGithubAPIError(
        getResponse.status,
        `Failed GET contents metadata fallback, status ${getResponse.status}`,
      );
    }
    const sha = getResponse.json.sha as string;
    const size = (getResponse.json.size as number) ?? 0;
    const content = (getResponse.json.content as string | null) ?? "";
    let blob: ArrayBuffer | null = null;
    if (content !== "") {
      // The bytes already came down the wire — a sin to discard
      // (§II.13): store them so the next getBlobFromSyncStore(sha)
      // needs no network. Empty content = >1 MB file (documented
      // Contents-API truncation) → blob simply not taken.
      blob = base64ToArrayBuffer(content);
      if (blobSink && !(await blobSink.has(sha))) {
        await blobSink.save(sha, blob);
      }
    }
    return { sha, size, blob };
  }

  /**
   * Lists files changed between two refs. Sync2 uses this in the
   * pull pass to discover remote-driven adds/modifies/deletes that
   * landed since the last successful sync. Returns the list as-is
   * from GitHub's compare API; the caller filters by gitignore /
   * isSyncable.
   */
  async compare({
    base,
    head,
    retry = false,
    maxRetries = 5,
  }: {
    base: string;
    head: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{
    status: "ahead" | "behind" | "identical" | "diverged";
    files: Array<{
      filename: string;
      status:
        | "added"
        | "modified"
        | "removed"
        | "renamed"
        | "copied"
        | "changed"
        | "unchanged";
      sha: string | null;
      previous_filename?: string;
    }>;
  }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/compare/${base}...${head}`,
            headers: this.headers(),
            throw: false,
          },
          `compare ${base.slice(0, 7)}...${head.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );
    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to compare refs", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to compare ${base}...${head}, status ${response.status}`,
      );
    }
    return {
      status: response.json.status,
      files: (response.json.files ?? []).map((f: Record<string, unknown>) => ({
        filename: f.filename as string,
        status: f.status as
          | "added"
          | "modified"
          | "removed"
          | "renamed"
          | "copied"
          | "changed"
          | "unchanged",
        sha: (f.sha as string | null) ?? null,
        previous_filename: f.previous_filename as string | undefined,
      })),
    };
  }

  /**
   * Creates a new branch reference pointing at a commit. Used when
   * bootstrapping a bare repo: after we've made the root commit via
   * createCommit (no parent), we still need to publish a ref so HEAD
   * resolves and the next sync's getRepoContent finds the tree.
   */
  async createReference({
    ref,
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({ ref, sha }),
            throw: false,
          },
          "refs (create)",
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create reference", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create reference, status ${response.status}`,
      );
    }
  }

  /**
   * Updates an arbitrary ref (not just the configured `githubBranch`)
   * to point at a new commit. Pseudo-merge mode uses this for conflict
   * branches (refs/heads/git-easy-sync-conflicts-*). Pass `ref` without
   * the "refs/" prefix — same shape GitHub's API expects after
   * "/git/refs/".
   *
   * @param ref e.g. "heads/git-easy-sync-conflicts-Obsidian-20260520143022-847"
   */
  async updateReference({
    ref,
    sha,
    force = false,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    sha: string;
    force?: boolean;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/${ref}`,
            headers: this.headers(),
            method: "PATCH",
            body: JSON.stringify({ sha, force }),
            throw: false,
          },
          `ref ${ref}${force ? " (force)" : ""}`,
        );
      },
      // Ref-update predicate: a 422 ("not a fast forward") is
      // non-transient — fail fast so the next drain reconciles
      // instead of retrying the doomed PATCH. See
      // isRefUpdateRetriableStatus + SYNC2.md §4.1.
      (res) => !isRefUpdateRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error(`Failed to update ref ${ref}`, response);
      throw makeGithubAPIError(
        response.status,
        `Failed to update ref ${ref}, status ${response.status}`,
      );
    }
  }

  /**
   * Delete a ref. Used to drop a conflict branch after finalize merge
   * back to main. Returns 204 on success and 422 if the ref does not
   * exist — the latter is treated as success ("already gone").
   */
  async deleteReference({
    ref,
    retry = false,
    maxRetries = 5,
  }: {
    ref: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<void> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/${ref}`,
            headers: this.headers(),
            method: "DELETE",
            throw: false,
          },
          `ref ${ref}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status === 204) return;
    if (response.status === 422) return; // already gone
    this.logger.error(`Failed to delete ref ${ref}`, response);
    throw makeGithubAPIError(
      response.status,
      `Failed to delete ref ${ref}, status ${response.status}`,
    );
  }

  /**
   * List refs whose names start with the given prefix. Pseudo-merge
   * uses this to enumerate active conflict branches during the
   * recovery sweep — e.g. `getMatchingRefs("heads/git-easy-sync-conflicts-")`.
   * Returns an empty array on 404 (no matches).
   */
  async getMatchingRefs({
    prefix,
    retry = false,
    maxRetries = 5,
  }: {
    prefix: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<Array<{ ref: string; sha: string }>> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/matching-refs/${prefix}`,
            headers: this.headers(),
            throw: false,
          },
          `matching-refs ${prefix}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status === 404) return [];
    if (response.status < 200 || response.status >= 400) {
      this.logger.error(
        `Failed to get matching refs for ${prefix}`,
        response,
      );
      throw makeGithubAPIError(
        response.status,
        `Failed to get matching refs ${prefix}, status ${response.status}`,
      );
    }
    const arr = response.json as Array<{ ref: string; object: { sha: string } }>;
    return arr.map((r) => ({
      ref: r.ref.replace(/^refs\//, ""),
      sha: r.object.sha,
    }));
  }

  /**
   * Gets the SHA of the branch head.
   *
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the branch head
   */
  async getBranchHeadSha({ retry = false, maxRetries = 5 } = {}) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            // The branch head is the ONE mutable ref we read; it MUST be fresh. The network
            // worker uses native `fetch`, so a CACHED response can be served — observed as a
            // ~6 ms "GET branch head" that returned a STALE head right after a push moved it,
            // which defeated processBatch's reconcile → the ref-update PATCH hit a 422 "not a
            // fast forward". Fix = a UNIQUE cache-buster query param (`ts`): the URL can never
            // be a cache hit, GitHub ignores the unknown param, and — unlike a `Cache-Control`
            // REQUEST header — it does NOT trigger a CORS preflight (GitHub's
            // Access-Control-Allow-Headers doesn't list cache-control, so that header gets the
            // request BLOCKED). All other GETs are @sha-addressed and stay cacheable. VERIFY
            // on device: a fixed head GET should be ~300 ms (network), NOT ~6 ms (cache).
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/heads/${this.settings.githubBranch}?ts=${Date.now()}`,
            headers: this.headers(),
            throw: false,
          },
          "branch head",
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get branch head sha", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get branch head sha, status ${response.status}`,
      );
    }
    return response.json.object.sha;
  }

  /**
   * Updates the branch head to point to a new commit.
   *
   * @param sha The SHA of the commit to point to
   * @param force If true, allow non-fast-forward updates (e.g. pointing the
   *   ref to an unrelated root commit). Used by bootstrap to collapse the
   *   bare-repo seed commit and the real initial commit into a single
   *   visible "Initial commit" on the branch.
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   */
  async updateBranchHead({
    sha,
    force = false,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    force?: boolean;
    retry?: boolean;
    maxRetries?: number;
  }) {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/refs/heads/${this.settings.githubBranch}`,
            headers: this.headers(),
            method: "PATCH",
            body: JSON.stringify({
              sha: sha,
              force,
            }),
            throw: false,
          },
          `branch head${force ? " (force)" : ""}`,
        );
      },
      // Ref-update predicate: 422 "not a fast forward" is
      // non-transient (the head moved; retrying the identical PATCH
      // can't help). Fail fast → next drain reconciles. Was
      // isWriteRetriableStatus, which retried 422 ~6× over ~33s and
      // read as a hang (field report 2026-05-31). See
      // isRefUpdateRetriableStatus + SYNC2.md §4.1.
      (res) => !isRefUpdateRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to update branch head sha", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to update branch head sha, status ${response.status}`,
      );
    }
  }

  /**
   * Creates a new blob in the GitHub remote, this is mainly used to upload binary files.
   *
   * @param content The content of the blob to upload
   * @param encoding Content encoding, can be "utf-8" or "base64". Defaults to "base64"
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The SHA of the newly uploaded blob
   */
  async createBlob({
    content,
    encoding = "base64",
    retry = false,
    maxRetries = 5,
  }: {
    content: string;
    encoding?: "utf-8" | "base64";
    retry?: boolean;
    maxRetries?: number;
  }): Promise<CreatedBlob> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/blobs`,
            headers: this.headers(),
            method: "POST",
            body: JSON.stringify({ content, encoding }),
            throw: false,
          },
          `blob (${encoding})`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create blob", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create blob, status ${response.status}`,
      );
    }
    return {
      sha: response.json["sha"],
    };
  }

  /**
   * Gets a blob from its sha
   *
   * @param sha The SHA of the blob
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   * @returns The blob file
   */
  async getBlob({
    sha,
    retry = false,
    maxRetries = 5,
  }: {
    sha: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<BlobFile> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/git/blobs/${sha}`,
            headers: this.headers(),
            throw: false,
          },
          `blob ${sha.slice(0, 7)}`,
        );
      },
      (res) => !isRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to get blob", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to get blob, status ${response.status}`,
      );
    }
    return response.json;
  }

  /**
   * Create a new file in the repo via the Contents API, the content must be
   * base64 encoded or the request will fail.
   *
   * The Contents API is the only thing that works on a brand-new bare
   * repository (no commits yet) — Git Data API endpoints return 409
   * "Git Repository is empty" until at least one ref exists. We use
   * createFile to seed the repo with its first commit, then switch to
   * Git Data API for everything that follows.
   *
   * Returns the SHAs the API gave us in the response — using these
   * directly avoids the eventual-consistency race that biting
   * getRepoContent right after a write would have.
   *
   * @param path Path to create in the repo
   * @param content Base64 encoded content of the file
   * @param message Commit message
   * @param retry Whether to retry the request on failure (default: false)
   * @param maxRetries Maximum number of retry attempts (default: 5)
   */
  async createFile({
    path,
    content,
    message,
    retry = false,
    maxRetries = 5,
  }: {
    path: string;
    content: string;
    message: string;
    retry?: boolean;
    maxRetries?: number;
  }): Promise<{ blobSha: string; treeSha: string; commitSha: string }> {
    const response = await retryUntil(
      async () => {
        return this.timed(
          {
            url: `https://api.github.com/repos/${this.settings.githubOwner}/${this.settings.githubRepo}/contents/${encodePathForGithub(path)}`,
            headers: this.headers(),
            method: "PUT",
            body: JSON.stringify({
              message: message,
              content: content,
              branch: this.settings.githubBranch,
            }),
            throw: false,
          },
          `contents/${path}`,
        );
      },
      (res) => !isWriteRetriableStatus(res.status),
      retry ? maxRetries : 0,
    );

    if (response.status < 200 || response.status >= 400) {
      this.logger.error("Failed to create file", response);
      throw makeGithubAPIError(
        response.status,
        `Failed to create file, status ${response.status}`,
      );
    }
    return {
      blobSha: response.json.content.sha,
      treeSha: response.json.commit.tree.sha,
      commitSha: response.json.commit.sha,
    };
  }

}
