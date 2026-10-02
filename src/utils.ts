// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { base64ToArrayBuffer } from "obsidian";

// Dump everything reachable about a caught value into a plain object.
// Use at catch sites where we want maximum debug signal regardless of
// what was thrown — Capacitor's native-bridge errors on iOS/Android,
// strings, plain objects without an Error shape, undefined, etc. The
// resulting object always serializes to something useful (never `{}`).
export function describeError(err: unknown): Record<string, unknown> {
  const info: Record<string, unknown> = {
    type: typeof err,
    string: safeString(err),
  };
  if (err === null) {
    info.null = true;
    return info;
  }
  if (err === undefined) {
    info.undefined = true;
    return info;
  }
  if (typeof err !== "object") {
    return info;
  }
  const e = err as Record<string, unknown>;
  info.ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
  // Known Error-shape fields. Read via direct access so prototype
  // accessors (cross-realm Errors from Capacitor / WebView bridge)
  // are pulled out alongside own properties.
  for (const key of ["name", "message", "stack", "code", "cause"]) {
    const v = e[key];
    if (v !== undefined) info[key] = v;
  }
  // All own properties — covers structured error shapes with custom
  // fields (HTTP error codes, plugin-specific context).
  const ownProps: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(err)) {
    if (!(key in info)) ownProps[key] = e[key];
  }
  if (Object.keys(ownProps).length > 0) info.ownProps = ownProps;
  return info;
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "[unstringifiable]";
  }
}

const TEXT_EXTENSIONS = [
  // Notes / docs
  ".md",
  ".txt",
  ".csv",
  ".log",
  // Data / config
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".eslintrc",
  // Markup
  ".html",
  ".htm",
  ".svg",
  ".xml",
  // Source
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
] as const;


/**
 * Best-guess "is this a text file?" check used by sync2 to decide
 * between inline-content tree entries and createBlob upload paths.
 */
export function hasTextExtension(filePath: string): boolean {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) return true;
  }
  return false;
}

/**
 * Compute the same SHA-1 git would for a blob with this content.
 * Used to compare local files against remote tree SHAs without
 * uploading anything.
 */
export async function calculateGitBlobSHA(
  content: ArrayBuffer,
): Promise<string> {
  const bytes = new Uint8Array(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const store = new Uint8Array(header.length + bytes.length);
  store.set(header, 0);
  store.set(bytes, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decide whether an HTTP status from a GitHub API call is worth retrying.
 *
 *  Retry: 422 (state-conflict), 429 (rate limit), 5xx (transient server).
 *  Don't retry: 401 (bad token), 403 (permission / abuse), 404 (wrong
 *  repo / branch), other 4xx — configuration / auth problems where
 *  retrying just delays the inevitable error notice.
 */
export function isRetriableStatus(status: number): boolean {
  if (status === 422 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Write-endpoint retry predicate. Identical to `isRetriableStatus`
 * plus 409.
 *
 * READ endpoints (`getRepoContent`, `getBranchHeadSha`, …) must NOT
 * retry 409: GitHub uses 404/409 to signal "Git Repository is empty"
 * on a bare repo, and sync2's bootstrap relies on getting that
 * signal back immediately. Burning retry slots there just delays
 * the start of seedBareRepo.
 *
 * WRITE endpoints (`createTree`, `createCommit`, `createBlob`,
 * `updateBranchHead`, `createFile`) can hit a different 409: GitHub's
 * own docs phrase it as "the Git repository is empty or
 * **unavailable**", where "unavailable" includes the brief window
 * where a freshly-written ref or commit hasn't propagated across
 * GitHub's internal replicas yet (observed empirically as a ~20%
 * flake on a second sync issued ~10ms after a first sync's
 * `updateBranchHead` completed — see GitHub Community discussion
 * #62198 for the same shape). `retryUntil`'s exponential backoff
 * (1s → 2s → 4s …) reliably clears the window; non-flaky runs pay
 * nothing because the very first attempt returns 200.
 */
export function isWriteRetriableStatus(status: number): boolean {
  if (status === 409) return true;
  return isRetriableStatus(status);
}

/**
 * Retry predicate for git-ref UPDATES (PATCH /git/refs/heads/...),
 * i.e. `updateBranchHead` / `updateReference`. Identical to the
 * write predicate EXCEPT it does NOT retry 422.
 *
 * A 422 on a ref update is "Update is not a fast forward" (or a
 * bad-ref-state variant): the remote head moved between the push's
 * head-read and the PATCH, so the commit we built no longer
 * fast-forwards. Re-issuing the IDENTICAL PATCH cannot help — the
 * head won't move back; recovery requires reconciling the batch
 * against the new head, which the next drain does (processBatch
 * Case 4). The old behaviour (422 treated as transient via
 * `isWriteRetriableStatus`) retried the doomed PATCH ~6 times over
 * ~33 s of exponential backoff, which the user experienced as a
 * hang before the push failed (field report 2026-05-31). Fail fast
 * instead: throw immediately so the batch stays queued and the next
 * drain reconciles.
 *
 * Note: the OTHER 422 the push pipeline sees — GitRPC::BadObjectState
 * on a redundant deletion entry in POST /git/trees — is a genuinely
 * self-resolving case and stays retriable via `createTree`'s
 * `isWriteRetriableStatus`. This predicate is scoped to ref updates
 * only, so that case is untouched.
 */
export function isRefUpdateRetriableStatus(status: number): boolean {
  if (status === 422) return false;
  return isWriteRetriableStatus(status);
}

/**
 * Recognise a transient connection-level error worth retrying.
 *
 * Three runtimes hit this codepath:
 *   - Node (integration tests): undici raises `TypeError("fetch
 *     failed")` with `cause: SocketError` whose `code` is one of
 *     UND_ERR_*. Sometimes the underlying Node `net` code
 *     (ECONNRESET / ETIMEDOUT / EPIPE / ENOTFOUND / EAI_AGAIN) is
 *     what surfaces — usually inside the cause chain.
 *   - Electron (Obsidian Desktop production): Chromium's `net`
 *     module reports its own ERR_* codes — ERR_NETWORK_CHANGED,
 *     ERR_INTERNET_DISCONNECTED, ERR_CONNECTION_RESET / CLOSED /
 *     ABORTED, ERR_NAME_NOT_RESOLVED — bubbled through `requestUrl`.
 *   - Mobile WebView (iOS / Android): Capacitor exposes
 *     fetch-style errors; message often just reads "Failed to
 *     fetch" / "network error" with no code attached.
 *
 * We walk up to five `cause` levels because undici wraps the inner
 * SocketError inside an outer TypeError. The message heuristic is
 * the last-resort matcher for runtimes that don't set `code`.
 *
 * Narrow on purpose: any HTTP status returned by the server (4xx /
 * 5xx) reaches us as a successful `requestUrl` response, not a
 * throw. Those keep flowing through the status-code retry predicates
 * (`isRetriableStatus` / `isWriteRetriableStatus`). This helper
 * answers only the "throw before any HTTP response" question.
 */
export function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const r = cur as {
      code?: unknown;
      errno?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const code = typeof r.code === "string" ? r.code : "";
    const message = typeof r.message === "string" ? r.message : "";
    // undici socket / timeout family.
    if (
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_SOCKET_TIMEOUT"
    ) {
      return true;
    }
    // Node net / DNS error codes.
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH"
    ) {
      return true;
    }
    // Electron / Chromium net errors (Obsidian Desktop production).
    if (
      code === "ERR_NETWORK_CHANGED" ||
      code === "ERR_INTERNET_DISCONNECTED" ||
      code === "ERR_CONNECTION_RESET" ||
      code === "ERR_CONNECTION_CLOSED" ||
      code === "ERR_CONNECTION_ABORTED" ||
      code === "ERR_CONNECTION_REFUSED" ||
      code === "ERR_NAME_NOT_RESOLVED" ||
      code === "ERR_NETWORK_ACCESS_DENIED" ||
      code === "ERR_TIMED_OUT"
    ) {
      return true;
    }
    // Message-only fallback: runtimes that don't attach a code.
    // Patterns are narrow — only well-known socket-level phrasing,
    // not generic "error" / "network" strings that could mask
    // logic bugs.
    if (
      message.includes("other side closed") ||
      message.includes("socket hang up") ||
      message.includes("Failed to fetch") ||
      message.toLowerCase() === "fetch failed" ||
      message.toLowerCase() === "network error"
    ) {
      return true;
    }
    cur = r.cause;
  }
  return false;
}

/**
 * Retry an async function with exponential backoff until its result
 * passes a condition or maxRetries is reached.
 *
 * Two retry paths share the same backoff counter:
 *   - Result-based: condition(result) === false → wait + retry.
 *     Drives HTTP status retries (5xx / 429 / 422 / 409 for writes).
 *   - Throw-based: fn() throws AND `isRetriableError(err)` is true →
 *     wait + retry. Drives socket-level error recovery (undici
 *     SocketError, Electron net errors, Node ECONNRESET / ETIMEDOUT,
 *     etc.). Non-retriable throws bubble out immediately.
 *
 * When the caller opts out of retry (maxRetries=0), both paths
 * collapse: the first response is returned regardless of condition,
 * and the first throw rethrows immediately.
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      if (retries < maxRetries && isRetriableError(err)) {
        retries++;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= backoffFactor;
        continue;
      }
      throw err;
    }
    if (condition(result) || retries >= maxRetries) return result;
    retries++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}

// ⚰️ `decodeBase64String` and `copyToClipboard` lived here until
// 2026-10-02. Both were callers' helpers from before THE SWITCH —
// base64 decoding moved into the worker path, and the one UI that
// copied text was replaced. Neither had a caller or a test.
