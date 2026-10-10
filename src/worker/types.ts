// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Wire-format types shared between the main-thread `WorkerClient`
// and the two worker entry points (`cpu-worker.ts`, `network-worker.ts`).
//
// Discriminated unions on `op` give us exhaustive type checking on
// both sides; `id` is a per-request UUID that the client uses to
// route the reply back to the right pending Promise. The same envelope
// works for both CPU and network workers — dispatch happens client-side.
//
// Stage 3 ships only `ping` and `echo` ops. Stages 4-6 add the real
// work (decode-base64, merge-text, compute-sha, github-* calls).

export type WorkerRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "echo"; payload: unknown }
  // Stage 4 — CPU-bound ops. All go to the CPU worker pool.
  // Decode a base64 string to its raw bytes. Used by reconcile
  // when GitHub's Blobs API returns the file content as base64.
  | { id: string; op: "decode-base64"; b64: string }
  // Compute the git-blob SHA-1 (SHA-1 of "blob {len}\0{content}")
  // for a binary buffer. Used by reconcile to compare ours/theirs
  // SHAs without touching the network.
  | { id: string; op: "compute-git-blob-sha"; bytes: ArrayBuffer }
  // Same SHA, but `bytes` is TRANSFERRED to the worker and handed back
  // in the result (HashedBlob) instead of being cloned — no extra copy
  // of the file (COMMIT-PASS-PERF, 2026-10-04). The sender's buffer is
  // detached the moment it is posted.
  | { id: string; op: "hash-git-blob"; bytes: ArrayBuffer }
  // Which SHA-1 the worker hashes large files with: "wasm" (hash-wasm)
  // or "crypto.subtle" (its silent fallback). Asked once at start, for
  // the log (owner, 2026-10-11).
  | { id: string; op: "sha1-engine" }
  // Run node-diff3 three-way merge on three text strings. Used by
  // reconcile when ours/base/theirs all differ on a text file.
  // Result mirrors `MergeOutcome` from three-way-merge.ts.
  | {
      id: string;
      op: "merge-text";
      ours: string;
      base: string;
      theirs: string;
    }
  // Stage 6 — network worker. Sends one HTTP request and returns
  // the response payload along with retry-loop state. The actual
  // retry policy lives main-thread-side (per-call: getContentsAtRef
  // distinguishes 404 from 5xx differently than createBlob does),
  // but each individual fetch happens in the worker so the engine
  // stays single-point-of-network-execution.
  | {
      id: string;
      op: "http-request";
      url: string;
      method?: string;
      headers?: Record<string, string>;
      // Body for POST/PUT/PATCH. Strings only — JSON.stringify on the
      // main side so the wire-format stays a flat string.
      body?: string;
    };

export type WorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// Result shape for the merge-text op (mirrors src/sync2/three-way-merge.ts
// MergeOutcome). Duplicated here so worker scope doesn't have to
// import from the engine — keeps the worker bundle independent.
export type MergeTextResult =
  | { kind: "clean"; content: string }
  | { kind: "conflict"; conflictMarkedContent: string };

// Result of the hash-git-blob op: the SHA plus the very buffer that
// was sent, transferred back to the caller.
export interface HashedBlob {
  sha: string;
  bytes: ArrayBuffer;
}

// Result shape for the http-request op. Mirrors the subset of
// Obsidian's RequestUrlResponse the engine actually reads — body
// text + status + parsed JSON when applicable. Worker can't
// import obsidian, so we shape the response ourselves.
export interface HttpRequestResult {
  status: number;
  text: string;
  // null when the response isn't JSON-parseable. Engine code reads
  // `response.json` directly in many places; preserving the shape
  // keeps the GithubClient delegation a one-line swap.
  json: unknown;
  headers: Record<string, string>;
}

// Which worker should handle a given op. Stage 4 keeps all CPU
// ops on the pool; Stage 6 routes network ops to the dedicated
// network worker.
export type WorkerKind = "cpu" | "network";

export function workerKindForOp(op: WorkerRequest["op"]): WorkerKind {
  switch (op) {
    case "ping":
    case "echo":
    case "decode-base64":
    case "compute-git-blob-sha":
    case "hash-git-blob":
    case "sha1-engine":
    case "merge-text":
      return "cpu";
    case "http-request":
      return "network";
  }
}
