// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Network worker — single dedicated thread that owns every GitHub
// HTTP call. Stage 3 implements only `ping` for orchestra wiring
// validation. Stage 6 migrates all GitHub API surface here:
// getBranchHead, getContentsAtRef (incl. Blobs-API fallback),
// getBlob, getCompare, getTree, createBlob, createTree,
// createCommit, updateBranchHead — plus retry / rate-limit /
// error-classification policy.
//
// Why a SINGLE network worker (not a pool):
//
//   - Pre-flight validation, deletion-queue accounting, and
//     rate-limit backoff are simpler when serial.
//   - GitHub API quota is per-token, not per-thread — adding
//     parallelism gains nothing.
//   - Eliminates a whole class of "two requests for the same
//     resource race each other" bugs.
//
// IMPORTANT: bundled as an IIFE by esbuild (see esbuild.config.mjs).
// Worker scope; no Obsidian APIs available.

import type { WorkerRequest, WorkerResponse } from "./types";

const w = self as unknown as {
  addEventListener: (
    type: "message",
    handler: (e: MessageEvent<WorkerRequest>) => void,
  ) => void;
  postMessage: (msg: WorkerResponse) => void;
};

// Stage 6: native fetch executor. The CORS feasibility test on a
// Pixel 6 Pro confirmed that Capacitor's WebView allows fetch()
// inside a Web Worker to call api.github.com cross-origin with
// Authorization Bearer headers — round-trip ~800 ms including
// worker construction overhead. That validated the migration.
// One AbortController per request in flight, so "http-abort" can stop it.
const inFlight = new Map<string, AbortController>();

async function executeHttpRequest(
  msg: Extract<WorkerRequest, { op: "http-request" }>,
  signal?: AbortSignal,
): Promise<{
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}> {
  const init: RequestInit = {
    method: msg.method ?? "GET",
    headers: msg.headers,
    signal,
  };
  if (msg.body !== undefined) {
    init.body = msg.body;
  }
  const resp = await fetch(msg.url, init);
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON-shaped (e.g., empty body for 204; rate-limit HTML
    // body for 429). The caller decides what that means.
  }
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: resp.status, text, json, headers };
}

w.addEventListener("message", async (e) => {
  const msg = e.data;
  try {
    switch (msg.op) {
      case "ping": {
        w.postMessage({ id: msg.id, ok: true, result: "pong-network" });
        return;
      }
      case "echo": {
        // Network worker also handles echo so a single op map
        // works for sanity-checking either side, even though
        // production traffic will dispatch ping/echo to CPU.
        w.postMessage({ id: msg.id, ok: true, result: msg.payload });
        return;
      }
      case "http-request": {
        const ctrl = new AbortController();
        inFlight.set(msg.id, ctrl);
        try {
          const result = await executeHttpRequest(msg, ctrl.signal);
          w.postMessage({ id: msg.id, ok: true, result });
        } finally {
          inFlight.delete(msg.id);
        }
        return;
      }
      case "http-abort": {
        // The client has already rejected the request; no reply needed.
        inFlight.get(msg.target)?.abort();
        return;
      }
    }
  } catch (err) {
    w.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
