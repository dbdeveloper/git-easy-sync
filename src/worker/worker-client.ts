// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import type {
  WorkerRequest,
  WorkerResponse,
  WorkerKind,
  MergeTextResult,
  HashedBlob,
  HttpRequestResult,
} from "./types";
import { workerKindForOp } from "./types";
import { merge as diff3Merge } from "node-diff3";

// Worker orchestra controller — main-thread side. Holds the CPU
// worker pool + the single dedicated network worker and exposes a
// dispatch(op) API that returns a Promise<result>.
//
// Sources for the two worker entry points are inlined into the
// main bundle at build time as string constants (see
// esbuild.config.mjs — `define` substitutes `__CPU_WORKER_SOURCE__`
// / `__NETWORK_WORKER_SOURCE__` with the IIFE-bundled worker code).
// At runtime we turn each string into a Blob URL and pass it to
// `new Worker(url)`. Capacitor `app://` URLs in worker context are
// unproven, so we use the Blob URL pattern that proved reliable in
// the feasibility test (~46 ms round-trip for 2.6 MB base64 on
// Pixel 6 Pro).
//
// On platforms where `new Worker()` throws (very old Capacitor,
// strict CSP environments), the client falls back to running every
// op on the main thread synchronously — preserving correctness at
// the cost of UI responsiveness. The fallback is decided once at
// construction and cached.

// esbuild's `define` replaces these tokens with JSON-encoded
// strings at build time. Declared here so TypeScript accepts them
// at compile time. At test time (vitest / Node) the tokens aren't
// substituted, so we wrap access in `typeof` guards (which don't
// throw ReferenceError on undeclared globals) and gracefully fall
// through to main-thread mode if missing.
declare const __CPU_WORKER_SOURCE__: string;
declare const __NETWORK_WORKER_SOURCE__: string;

function getInjectedCpuSource(): string {
  return typeof __CPU_WORKER_SOURCE__ === "string"
    ? __CPU_WORKER_SOURCE__
    : "";
}
function getInjectedNetworkSource(): string {
  return typeof __NETWORK_WORKER_SOURCE__ === "string"
    ? __NETWORK_WORKER_SOURCE__
    : "";
}

// Lookup of resolvers waiting on each request ID. Workers reply via
// postMessage; the onmessage handler routes the response back to
// the correct Promise by ID.
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

// A single CPU worker plus its work-queue depth. The pool picks
// the least-busy worker per dispatch — a tiny load balancer.
interface PooledWorker {
  worker: Worker;
  inFlight: number;
}

// Stub fallback handlers used when Worker construction fails. Each
// op type that the orchestra handles needs an entry; Stage 3 only
// has ping/echo so the table is small. Stage 4 onwards extends.
type FallbackHandler = (req: WorkerRequest) => Promise<unknown>;

// Main-thread fallback for `decode-base64`. Strips whitespace then
// uses `atob` (available in browser + Node main thread). Mirrors
// the worker implementation byte-exactly.
function fallbackDecodeBase64(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s/g, "");
  const binStr = atob(clean);
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    out[i] = binStr.charCodeAt(i);
  }
  return out.buffer;
}

// Main-thread fallback for `compute-git-blob-sha`. Same algorithm
// as src/utils.ts calculateGitBlobSHA and the worker implementation
// — kept in sync; the Stage 4 worker-vs-fallback test asserts
// byte-exact identity.
async function fallbackComputeGitBlobSHA(
  bytes: ArrayBuffer,
): Promise<string> {
  const view = new Uint8Array(bytes);
  const header = new TextEncoder().encode(`blob ${view.length}\0`);
  const store = new Uint8Array(header.length + view.length);
  store.set(header, 0);
  store.set(view, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Main-thread fallback for `merge-text`. Same node-diff3 call the
// worker would make, same options.
function fallbackPickSeparator(...inputs: string[]): string {
  for (const s of inputs) {
    if (s.includes("\r\n")) return "\r\n";
  }
  return "\n";
}
function fallbackMergeText(
  ours: string,
  base: string,
  theirs: string,
): MergeTextResult {
  const result = diff3Merge(ours, base, theirs, {
    excludeFalseConflicts: true,
    stringSeparator: /\r?\n/,
  });
  const sep = fallbackPickSeparator(ours, base, theirs);
  const joined = result.result.join(sep);
  if (!result.conflict) {
    return { kind: "clean", content: joined };
  }
  return { kind: "conflict", conflictMarkedContent: joined };
}

const FALLBACK_HANDLERS: Record<WorkerRequest["op"], FallbackHandler> = {
  ping: async () => "pong-main-fallback",
  echo: async (req) =>
    (req as Extract<WorkerRequest, { op: "echo" }>).payload,
  "decode-base64": async (req) => {
    const r = req as Extract<WorkerRequest, { op: "decode-base64" }>;
    return fallbackDecodeBase64(r.b64);
  },
  "compute-git-blob-sha": async (req) => {
    const r = req as Extract<WorkerRequest, { op: "compute-git-blob-sha" }>;
    return await fallbackComputeGitBlobSHA(r.bytes);
  },
  "hash-git-blob": async (req) => {
    const r = req as Extract<WorkerRequest, { op: "hash-git-blob" }>;
    const result: HashedBlob = {
      sha: await fallbackComputeGitBlobSHA(r.bytes),
      bytes: r.bytes,
    };
    return result;
  },
  "merge-text": async (req) => {
    const r = req as Extract<WorkerRequest, { op: "merge-text" }>;
    return fallbackMergeText(r.ours, r.base, r.theirs);
  },
  "http-request": async (req) => {
    const r = req as Extract<WorkerRequest, { op: "http-request" }>;
    // Main-thread fallback for the network op. Uses native fetch
    // — same API the worker uses. Test environments mock
    // globalThis.fetch; the integration tests that exercise the
    // GithubClient also stub the HTTP layer at the client level,
    // so this path being identical to the worker keeps semantics
    // uniform.
    const init: RequestInit = {
      method: r.method ?? "GET",
      headers: r.headers,
    };
    if (r.body !== undefined) {
      init.body = r.body;
    }
    const resp = await fetch(r.url, init);
    const text = await resp.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON — leave null
    }
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: resp.status, text, json, headers };
  },
};

// Pool size for the CPU workers. Auto-tunes to one less than the
// reported logical-core count, clamped to [2, 4]. The clamping
// prevents pathological allocation on a 16-core desktop (each
// worker holds bundle + heap; 4 is enough parallelism for our
// per-batch workload) and ensures at least 2 even on a phone
// reporting a single core.
//
// `navigator.hardwareConcurrency` may be undefined in older
// WebViews; fall back to 2.
export function computeCpuPoolSize(
  hardwareConcurrency: number | undefined,
): number {
  const hc = typeof hardwareConcurrency === "number" ? hardwareConcurrency : 2;
  return Math.max(2, Math.min(4, hc - 1));
}

export default class WorkerClient {
  private cpuPool: PooledWorker[] = [];
  private networkWorker: Worker | null = null;
  private cpuBlobUrl: string | null = null;
  private networkBlobUrl: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  // True once we've decided to take the main-thread fallback path
  // (Worker construction threw at startup). Cached so we don't
  // re-try and re-throw every dispatch.
  private fallbackMode = false;

  // Constructor opts let tests inject mock worker sources and a
  // mock Worker constructor without involving the real Web Worker
  // API (Node has no global Worker class). Production calls pass
  // nothing; the esbuild `define` substitutions take effect.
  constructor(opts?: {
    hardwareConcurrency?: number;
    cpuWorkerSource?: string;
    networkWorkerSource?: string;
    // Allow test to supply a Worker-shaped mock. When omitted the
    // global `Worker` constructor is used.
    workerCtor?: new (url: string) => Worker;
  }) {
    const poolSize = computeCpuPoolSize(
      opts?.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency,
    );
    const cpuSource = opts?.cpuWorkerSource ?? getInjectedCpuSource();
    const networkSource =
      opts?.networkWorkerSource ?? getInjectedNetworkSource();
    const WorkerCtor =
      opts?.workerCtor ?? (globalThis as { Worker?: typeof Worker }).Worker;
    if (
      cpuSource === "" ||
      networkSource === "" ||
      typeof WorkerCtor !== "function" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      this.fallbackMode = true;
      return;
    }
    try {
      this.cpuBlobUrl = URL.createObjectURL(
        new Blob([cpuSource], { type: "application/javascript" }),
      );
      this.networkBlobUrl = URL.createObjectURL(
        new Blob([networkSource], { type: "application/javascript" }),
      );
      for (let i = 0; i < poolSize; i++) {
        const w = new WorkerCtor(this.cpuBlobUrl);
        w.addEventListener("message", (e: MessageEvent) =>
          this.onMessage(e.data as WorkerResponse),
        );
        this.cpuPool.push({ worker: w, inFlight: 0 });
      }
      this.networkWorker = new WorkerCtor(this.networkBlobUrl);
      this.networkWorker.addEventListener("message", (e: MessageEvent) =>
        this.onMessage(e.data as WorkerResponse),
      );
    } catch {
      this.fallbackMode = true;
      this.cleanupBlobUrls();
    }
  }

  // True if any Worker construction failed and we're routing every
  // op to a main-thread fallback. Tests + diagnostics check this.
  get isFallback(): boolean {
    return this.fallbackMode;
  }

  // True size of the CPU pool. Useful for tests that assert
  // auto-sizing matched expectations.
  get cpuPoolSize(): number {
    return this.cpuPool.length;
  }

  // Stage 3 surface: send an op, get a result. Stage 4-6 add typed
  // method wrappers (`mergeText`, `computeSha`, `getBlob`, …) on
  // top of this primitive.
  // `transfer`: buffers to MOVE to the worker instead of cloning them —
  // detached on this side once posted. Ignored in fallback mode (nothing
  // crosses a thread there).
  dispatch<T = unknown>(
    op: WorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.fallbackMode) {
      const handler = FALLBACK_HANDLERS[op.op];
      return handler(op) as Promise<T>;
    }
    return new Promise<T>((resolve, reject) => {
      const id = op.id;
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const kind = workerKindForOp(op.op);
      const target = this.pickTarget(kind);
      if (target === null) {
        this.pending.delete(id);
        reject(
          new Error(
            `WorkerClient: no ${kind} worker available — was the pool initialised?`,
          ),
        );
        return;
      }
      target.postMessage(op, transfer);
    });
  }

  // Generate a new request ID. Public for ergonomics so callers
  // don't have to import an internal counter.
  newRequestId(): string {
    this.requestCounter += 1;
    return `r${this.requestCounter}`;
  }

  // ────────────────────────────────────────────────────────────────
  // Typed convenience wrappers around dispatch — Stage 4 surface.
  //
  // Below each threshold (BASE64_WORKER_THRESHOLD,
  // SHA_WORKER_THRESHOLD, MERGE_WORKER_THRESHOLD) the call runs on
  // the main thread instead. Reasoning:
  //   - Worker round-trip costs ~5-10 ms of postMessage + structured
  //     clone. For small inputs the work itself is ~1 ms — the
  //     overhead dominates.
  //   - Setting the thresholds at "where the worker pays for itself"
  //     keeps the orchestra a net win for every call site, not a
  //     pessimization for small files.
  //
  // Thresholds derived from §5.4 of the plan; Stage 8 perf tests
  // will tune empirically.
  // ────────────────────────────────────────────────────────────────

  static readonly BASE64_WORKER_THRESHOLD = 2 * 1024 * 1024; // 2 MB
  static readonly SHA_WORKER_THRESHOLD = 100 * 1024; // 100 KB
  static readonly MERGE_WORKER_THRESHOLD = 100 * 1024; // 100 KB

  // Decode a base64 string to bytes. Routes the work to the CPU
  // pool when the input is large enough to make the round-trip
  // worthwhile; otherwise runs on main thread via the fallback
  // path (which uses the same atob-based implementation as the
  // worker).
  async decodeBase64(b64: string): Promise<ArrayBuffer> {
    if (this.fallbackMode || b64.length < WorkerClient.BASE64_WORKER_THRESHOLD) {
      return fallbackDecodeBase64(b64);
    }
    return await this.dispatch<ArrayBuffer>({
      id: this.newRequestId(),
      op: "decode-base64",
      b64,
    });
  }

  // Compute the git-blob SHA for these bytes. Routes to the CPU
  // pool when the buffer is large enough; otherwise runs inline.
  // The buffer is NOT transferred (caller usually needs to keep
  // using the bytes after the SHA call) — so above the threshold the
  // file is CLONED into the worker: a second full copy. Callers on the
  // hot commit path use hashGitBlob below, which moves the buffer
  // there and back instead.
  async computeGitBlobSHA(bytes: ArrayBuffer): Promise<string> {
    if (
      this.fallbackMode ||
      bytes.byteLength < WorkerClient.SHA_WORKER_THRESHOLD
    ) {
      return await fallbackComputeGitBlobSHA(bytes);
    }
    return await this.dispatch<string>({
      id: this.newRequestId(),
      op: "compute-git-blob-sha",
      bytes,
    });
  }

  // The SHA of a git blob, with the bytes MOVED to the worker and back
  // rather than cloned (COMMIT-PASS-PERF, 2026-10-04). Peak memory for a
  // file of size F drops from 3F (caller's bytes + clone + the worker's
  // header+bytes concat) to 2F — the concat is unavoidable while
  // crypto.subtle.digest has no incremental API.
  //
  // ⚠️ When the worker path runs, the ARGUMENT is detached on return
  // (byteLength 0). Use ONLY the returned `bytes` afterwards — reading
  // the argument would silently see an empty file. Below the threshold
  // (and in fallback mode) nothing crosses a thread and the returned
  // buffer IS the argument; callers must not rely on that either.
  //
  // A worker error rejects, and the bytes are gone with it: the caller
  // cannot retry without reading the file again.
  async hashGitBlob(bytes: ArrayBuffer): Promise<HashedBlob> {
    if (
      this.fallbackMode ||
      bytes.byteLength < WorkerClient.SHA_WORKER_THRESHOLD
    ) {
      return { sha: await fallbackComputeGitBlobSHA(bytes), bytes };
    }
    const sent = bytes.byteLength;
    const result = await this.dispatch<HashedBlob>(
      { id: this.newRequestId(), op: "hash-git-blob", bytes },
      [bytes],
    );
    // Cheap guard: a worker that handed back the wrong buffer (or an
    // empty one) must fail LOUDLY here, not become an empty blob stored
    // under a real sha further down.
    if (result.bytes.byteLength !== sent) {
      throw new Error(
        `WorkerClient.hashGitBlob: worker returned ${result.bytes.byteLength} bytes, sent ${sent}`,
      );
    }
    return result;
  }

  // Three-way text merge via node-diff3. Routes to the CPU pool
  // when the largest input is big enough that the merge itself
  // would dominate the round-trip cost; otherwise runs inline.
  async mergeText(
    ours: string,
    base: string,
    theirs: string,
  ): Promise<MergeTextResult> {
    const maxLen = Math.max(ours.length, base.length, theirs.length);
    if (this.fallbackMode || maxLen < WorkerClient.MERGE_WORKER_THRESHOLD) {
      return fallbackMergeText(ours, base, theirs);
    }
    return await this.dispatch<MergeTextResult>({
      id: this.newRequestId(),
      op: "merge-text",
      ours,
      base,
      theirs,
    });
  }

  // Stage 6: dispatch an HTTP request through the dedicated network
  // worker. Used by GithubClient to put every GitHub API call on
  // the network worker thread instead of the JS main thread —
  // single point of execution, simpler retry-loop accounting, and
  // (incidentally) main thread stays free for UI even during slow
  // network round-trips. The CORS feasibility test on Pixel 6 Pro
  // confirmed Capacitor's WebView allows worker-scope fetch
  // against api.github.com.
  async httpRequest(args: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<HttpRequestResult> {
    return await this.dispatch<HttpRequestResult>({
      id: this.newRequestId(),
      op: "http-request",
      url: args.url,
      method: args.method,
      headers: args.headers,
      body: args.body,
    });
  }

  // Terminate every worker and reject every pending request.
  // Stage 7 cancellation calls this to interrupt mid-flight work.
  // After terminate the client is unusable — caller must construct
  // a fresh one for the next sync.
  terminate(): void {
    for (const p of this.cpuPool) {
      try {
        p.worker.terminate();
      } catch {
        // ignore
      }
    }
    this.cpuPool = [];
    if (this.networkWorker) {
      try {
        this.networkWorker.terminate();
      } catch {
        // ignore
      }
      this.networkWorker = null;
    }
    this.cleanupBlobUrls();
    for (const [, p] of this.pending) {
      p.reject(new Error("WorkerClient terminated"));
    }
    this.pending.clear();
  }

  private cleanupBlobUrls(): void {
    if (this.cpuBlobUrl) {
      try {
        URL.revokeObjectURL(this.cpuBlobUrl);
      } catch {
        // ignore
      }
      this.cpuBlobUrl = null;
    }
    if (this.networkBlobUrl) {
      try {
        URL.revokeObjectURL(this.networkBlobUrl);
      } catch {
        // ignore
      }
      this.networkBlobUrl = null;
    }
  }

  // Pick the worker for a request. CPU dispatch picks the
  // least-loaded pool worker (cheap O(pool-size) scan; pool is
  // tiny). Network always goes to the single network worker.
  private pickTarget(kind: WorkerKind): Worker | null {
    if (kind === "network") {
      return this.networkWorker;
    }
    if (this.cpuPool.length === 0) return null;
    let best = this.cpuPool[0];
    for (let i = 1; i < this.cpuPool.length; i++) {
      if (this.cpuPool[i].inFlight < best.inFlight) {
        best = this.cpuPool[i];
      }
    }
    best.inFlight += 1;
    return best.worker;
  }

  private onMessage(resp: WorkerResponse): void {
    const pending = this.pending.get(resp.id);
    if (!pending) {
      // Reply for an ID we don't recognise. Could happen if
      // terminate() ran between request send and reply arrival.
      // Drop silently — the original requester already saw its
      // promise rejected.
      return;
    }
    this.pending.delete(resp.id);
    // Decrement load counter on the worker that handled this op.
    // We don't track which CPU worker the request went to so we
    // can't decrement specifically — but the pool entries are
    // small and load is approximate anyway; a periodic full reset
    // would also work. For Stage 3 simplicity, just leave inFlight
    // as a monotonic counter; pickTarget still picks the smallest.
    if (resp.ok) {
      pending.resolve(resp.result);
    } else {
      pending.reject(new Error(resp.error));
    }
  }
}
