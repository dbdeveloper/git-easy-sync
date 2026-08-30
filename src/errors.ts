// Typed error classes — SYNC2 §5.
//
// Catch sites in the sync engine previously duck-typed on
// `(err as { status?: number }).status` and ad-hoc message-string
// matching. The same status code carried different meanings in
// different contexts (404 = "not found" or "bare repo"; 422 =
// "malformed request" or "remote state drifted under us"). This
// module replaces those tagless tuples with a class hierarchy:
// catch sites dispatch on `instanceof X`, retry decisions live on
// the class via the `retriable` getter, and the logger records the
// class name automatically through `describeError`'s `ctor` field.
//
//   SyncError                  (base — never thrown directly)
//   ├── NetworkError           (transient — retry)
//   ├── GithubAPIError         (typed HTTP response from GitHub)
//   │   ├── NotFoundError      (404)
//   │   ├── ConflictError      (409 — bare repo, ref mismatch)
//   │   ├── ValidationError    (422 — malformed request OR stale
//   │   │                        state per body.message; see
//   │   │                        SYNC2 §5 — both go here)
//   │   ├── AuthError          (401, 403)
//   │   └── RateLimitError     (429)
//   ├── PlatformError          (Capacitor / WebView; user-visible,
//   │                            non-retriable — e.g. Android's
//   │                            FILE_NOTCREATED from the
//   │                            2026-05-25 field bug)
//   └── StaleStateError        (compare diff says path exists at
//                                currentHead but a follow-up fetch
//                                returns null; covers 1.4 + the
//                                422 BadObjectState sub-case from
//                                1.5 when the catch site wants to
//                                distinguish — see SYNC2 §5)
//
// Migration policy (SYNC2 §3): zero-cycle. New code throws
// typed errors immediately; old code paths migrate as bugs touch
// them. The hierarchy can absorb new subclasses without breaking
// existing `instanceof` checks at parent classes.

// ── base ──────────────────────────────────────────────────────────

export abstract class SyncError extends Error {
  // Whether retryUntil should re-try the operation that produced
  // this error. Default false at the SyncError level; subclasses
  // override (NetworkError, RateLimitError set true).
  get retriable(): boolean {
    return false;
  }

  // The underlying error, if any. Carried for diagnostic transparency
  // — useful when the typed error was raised from a more primitive
  // failure (network exception, JSON-parse error inside a 4xx body,
  // etc.). describeError() walks this chain so the log gets the
  // ground-truth shape.
  readonly cause: unknown;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    // Preserves the class name in the .name field so
    // `error.toString()` and serialised forms read intuitively
    // ("StaleStateError: ..." rather than "Error: ...").
    this.name = new.target.name;
    this.cause = opts?.cause;
  }
}

// ── transport ─────────────────────────────────────────────────────

// Network-level failure (timeout, connection drop, DNS) — the
// request never produced a definitive HTTP response. Retriable.
// Use for errors that retryUntil's existing `isRetriableError`
// predicate would flag — see src/utils.ts § retry helpers.
export class NetworkError extends SyncError {
  get retriable(): boolean {
    return true;
  }
}

// ── GitHub HTTP responses ─────────────────────────────────────────

// Generic HTTP-error envelope from GitHub. Carries `status` and the
// parsed body when available. Most direct catch sites should prefer
// the specific subclass (NotFoundError, ValidationError, etc.);
// this class is used as the throw type when no subclass matches
// (e.g. unexpected 500-class status).
export class GithubAPIError extends SyncError {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    opts?: { cause?: unknown },
  ) {
    super(message, opts);
  }
}

// 404 — resource not found. Catch sites: bare-repo detection on
// branch-head reads, pull-side legitimate-deletion-skip in
// safeFetchContents, and the orphan-prevention path in
// applyRemoteAddOrModify (which converts a null to a more specific
// StaleStateError when the compare diff disagrees with the fetch).
export class NotFoundError extends GithubAPIError {
  constructor(message: string, body?: unknown, opts?: { cause?: unknown }) {
    super(message, 404, body, opts);
  }
}

// 409 — conflict. GitHub returns this on bare-repo HEAD reads and
// on ref-mismatch updates. Catch sites typically pair the handling
// with NotFoundError ("404 or 409 → bare repo").
export class ConflictError extends GithubAPIError {
  constructor(message: string, body?: unknown, opts?: { cause?: unknown }) {
    super(message, 409, body, opts);
  }
}

// 422 — semantic validation failure. Two sub-causes in practice:
// (a) client sent malformed payload; (b) request was well-formed but
// remote state drifted (`GitRPC::BadObjectState`, the 1.5 sub-case).
// SYNC2 §5 decided to model both as one class; catch sites
// that need the distinction inspect `body.message` directly.
//
// Retriable=false at this level — Phase 1's pre-flight validation
// already drops the stale-deletion 422 sub-case at push time, so a
// 422 that escapes the validator is most likely a genuine malformed
// request that retry can't fix.
export class ValidationError extends GithubAPIError {
  constructor(message: string, body?: unknown, opts?: { cause?: unknown }) {
    super(message, 422, body, opts);
  }
}

// 401 / 403 — auth (missing token, bad token, scope refusal, repo
// permission). Non-retriable from the client's POV — the operator
// must update the token or repo settings.
export class AuthError extends GithubAPIError {
  constructor(
    message: string,
    status: 401 | 403,
    body?: unknown,
    opts?: { cause?: unknown },
  ) {
    super(message, status, body, opts);
  }
}

// 429 — secondary rate limit / abuse detection. Retriable with
// backoff. The retryUntil predicate already handles 429 via
// isRetriableStatus; the typed class just gives catch sites a way
// to identify it for UI feedback ("waiting for rate-limit reset…").
export class RateLimitError extends GithubAPIError {
  constructor(message: string, body?: unknown, opts?: { cause?: unknown }) {
    super(message, 429, body, opts);
  }
  get retriable(): boolean {
    return true;
  }
}

// ── platform-level ────────────────────────────────────────────────

// Failure from the host platform's filesystem / WebView, not from
// GitHub. The 2026-05-25 field bug FILE_NOTCREATED from Android's
// `win.androidBridge.onmessage` is the canonical example: Obsidian
// Mobile refuses to materialise a file with Windows-forbidden chars
// in the name regardless of the underlying filesystem. Non-
// retriable (the rejection is deterministic until the input
// changes); should surface as a user-visible message describing
// what the user can do about it (rename the file, etc.).
export class PlatformError extends SyncError {}

// ── derived from observed inconsistency ──────────────────────────

// Two pieces of remote state observed within one sync click no
// longer agree with each other. The classic instance is the 1.4
// bug: compare diff lists a path as added/modified at currentHead,
// the subsequent getContentsAtRef returns null. Other plausible
// causes (in decreasing frequency): client URL-encoding bug, token
// permission drift between calls, GitHub replica eventual
// consistency, concurrent force-push that rewrote currentHead.
//
// Catch policy: log at error level with the conflicting facts
// (paths, request-ids, observed states); retry one drain. If the
// shape repeats, the underlying cause needs operator attention —
// the log entries with class=StaleStateError are the signal.
export class StaleStateError extends SyncError {}

// NEW-DRAIN §II.12 / SPIKE-TREES-LIMIT §4.2: the recursive tree GET
// came back with `truncated: true` — discovery past this point is
// structurally impossible with this mechanism (the response is capped
// at a documented 100k entries OR 7 MB, and 20k entries already
// measure ~5.6 MB). A HARD error, never a silent partial return:
// continuing with a cut list would be defect-A-class silent loss for
// every path past the cut. The named (unbuilt) fallback is a
// non-recursive per-directory walk — an owner decision when a real
// vault ever hits this.
export class TreeTruncatedError extends SyncError {}

// ── client construction helper ────────────────────────────────────

// Translates a GitHub HTTP response into the correct typed error.
// Used at the single point in src/github/client.ts where 4xx/5xx
// responses convert into thrown exceptions. Keeps the mapping
// table in one place rather than scattering `new XError` calls
// across every endpoint method.
export function makeGithubAPIError(
  status: number,
  message: string,
  body?: unknown,
): GithubAPIError {
  if (status === 404) return new NotFoundError(message, body);
  if (status === 409) return new ConflictError(message, body);
  if (status === 422) return new ValidationError(message, body);
  if (status === 401 || status === 403) {
    return new AuthError(message, status as 401 | 403, body);
  }
  if (status === 429) return new RateLimitError(message, body);
  return new GithubAPIError(message, status, body);
}
