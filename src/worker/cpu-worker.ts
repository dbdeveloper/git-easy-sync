// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// CPU worker — runs in a separate thread inside Obsidian's WebView
// (Chromium on desktop, Capacitor's WebView on mobile).
//
// Worker scope has `self`, `postMessage`, `addEventListener`, plus
// standard Web APIs (`atob`, `crypto.subtle`, `fetch`, `Uint8Array`,
// `TextEncoder`/`TextDecoder`). No Obsidian APIs are available here
// — the main thread is the only place that can touch `vault.adapter`.
//
// Stage 3 implements only `ping` and `echo` for orchestra wiring
// validation. Stage 4 adds `decode-base64`, `merge-text` (node-diff3),
// and `compute-sha`. Stage 6 leaves all GitHub HTTP ops to the
// network worker — this worker stays pure-CPU.
//
// IMPORTANT: bundled as an IIFE by esbuild (see esbuild.config.mjs).
// The whole file becomes a self-executing string that `WorkerClient`
// turns into a Blob URL at runtime. No ES module syntax at the top
// level after bundling.

import type {
  WorkerRequest,
  WorkerResponse,
  MergeTextResult,
} from "./types";
import { merge as diff3Merge } from "node-diff3";
import { detectEol, restoreEol } from "../sync2/eol";

// Worker `self` is `DedicatedWorkerGlobalScope` — but bundling
// against the standard TS dom lib drags in Window types. We type
// the post side narrowly and assert.
const w = self as unknown as {
  addEventListener: (
    type: "message",
    handler: (e: MessageEvent<WorkerRequest>) => void,
  ) => void;
  postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void;
};

// Pure-JS base64 → ArrayBuffer. Worker scope has `atob`, which
// returns a binary string (each char = one byte). We copy into a
// Uint8Array. Strips whitespace first (GitHub's Blobs-API responses
// arrive as MIME-style 60-char lines separated by \n, which atob
// rejects with `InvalidCharacterError`). Same pattern as the
// pre-Stage-4 fallback implementation.
function decodeBase64(b64: string): ArrayBuffer {
  const clean = b64.replace(/\s/g, "");
  const binStr = atob(clean);
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    out[i] = binStr.charCodeAt(i);
  }
  return out.buffer;
}

// Compute the SHA-1 git would assign to a blob of these bytes — the SHA
// of `"blob <size>\0" + bytes`. Same RESULT as src/utils.ts
// calculateGitBlobSHA (the byte-exact identity tests pin it); a
// different METHOD (COMMIT-PASS-PERF, 2026-10-05):
//
// WASM SHA-1 (hash-wasm) fed in two pieces — the header, then the
// file's own buffer — so nothing is concatenated. crypto.subtle only
// takes ONE contiguous buffer, which forced a header+bytes copy of the
// whole file, and WebCrypto copies its input once more by spec: about 3F
// at peak for a file of size F (measured: 975 MB for 300 MB in Node).
// hash-wasm streams the buffer through a fixed 16 KB window inside its
// WASM memory (subarray views, no copy of the file): about 1F (351 MB
// measured). Speed is the same or slightly better (device A/B: ~5%).
//
// ⚠️ SYNCHRONOUS from init() to digest(). That is why it lives HERE and
// not on the main thread, where it would freeze the UI ~1 s per 50 MB —
// the same reason node-diff3 and base64 decoding moved here (SYNC2 §8).
// It is also what makes ONE shared instance safe: no await between
// init and digest, so two requests can never interleave on it.
//
// If the WASM cannot be instantiated (a CSP or an old WebView), fall
// back to crypto.subtle — slower on memory, never wrong.
import { createSHA1 } from "hash-wasm";
type WasmSha1 = Awaited<ReturnType<typeof createSHA1>>;
let wasmSha1: Promise<WasmSha1 | null> | null = null;
function loadWasmSha1(): Promise<WasmSha1 | null> {
  if (wasmSha1 === null) wasmSha1 = createSHA1().catch(() => null);
  return wasmSha1;
}

async function computeGitBlobSHA(bytes: ArrayBuffer): Promise<string> {
  const view = new Uint8Array(bytes);
  const header = new TextEncoder().encode(`blob ${view.length}\0`);
  const h = await loadWasmSha1();
  if (h !== null) {
    h.init();
    h.update(header);
    h.update(view);
    return h.digest("hex");
  }
  const store = new Uint8Array(header.length + view.length);
  store.set(header, 0);
  store.set(view, header.length);
  const hash = await crypto.subtle.digest("SHA-1", store);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// node-diff3 three-way text merge. Mirrors src/sync2/three-way-merge.ts
// mergeText — same options (excludeFalseConflicts + LF-tolerant
// stringSeparator), same EOL restoration (ours' own dominant style, not
// "any input has CRLF" — NEW-DRAIN.md §III _diff3 CRLF residual case,
// 2026-08-28). Result shape matches MergeTextResult for postMessage
// transit. Keep this in sync with three-way-merge.ts by hand — this file
// is bundled standalone (esbuild IIFE) and can't share a runtime import
// with the main-thread module, only the source-level helper (../sync2/eol).
function mergeText(
  ours: string,
  base: string,
  theirs: string,
): MergeTextResult {
  const result = diff3Merge(ours, base, theirs, {
    excludeFalseConflicts: true,
    stringSeparator: /\r?\n/,
  });
  const joined = restoreEol(result.result.join("\n"), detectEol(ours));
  if (!result.conflict) {
    return { kind: "clean", content: joined };
  }
  return { kind: "conflict", conflictMarkedContent: joined };
}

w.addEventListener("message", async (e) => {
  const msg = e.data;
  try {
    switch (msg.op) {
      case "ping": {
        w.postMessage({ id: msg.id, ok: true, result: "pong" });
        return;
      }
      case "echo": {
        w.postMessage({ id: msg.id, ok: true, result: msg.payload });
        return;
      }
      case "decode-base64": {
        const buf = decodeBase64(msg.b64);
        // Transfer the resulting ArrayBuffer back zero-copy. The
        // worker side no longer references it after postMessage,
        // and the caller never sent it in (the input was a string),
        // so transfer is safe and saves a memcpy of the decoded
        // bytes (up to a few MB) on the main thread side.
        w.postMessage({ id: msg.id, ok: true, result: buf }, [buf]);
        return;
      }
      case "compute-git-blob-sha": {
        const sha = await computeGitBlobSHA(msg.bytes);
        w.postMessage({ id: msg.id, ok: true, result: sha });
        return;
      }
      case "hash-git-blob": {
        // The caller TRANSFERRED its buffer here (no copy); hand the same
        // buffer back the same way, so the file is never held twice
        // across the two threads. Nothing here may touch msg.bytes after
        // this postMessage — it is detached on our side from then on.
        const sha = await computeGitBlobSHA(msg.bytes);
        w.postMessage(
          { id: msg.id, ok: true, result: { sha, bytes: msg.bytes } },
          [msg.bytes],
        );
        return;
      }
      case "sha1-engine": {
        const h = await loadWasmSha1();
        w.postMessage({ id: msg.id, ok: true, result: h !== null ? "wasm" : "crypto.subtle" });
        return;
      }
      case "merge-text": {
        const out = mergeText(msg.ours, msg.base, msg.theirs);
        w.postMessage({ id: msg.id, ok: true, result: out });
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
