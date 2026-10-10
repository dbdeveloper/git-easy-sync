import { describe, it, expect, vi } from "vitest";
import { calculateGitBlobSHA } from "../../src/utils";
import WorkerClient from "../../src/worker/worker-client";
import {
  makeRealCpuWorkerClient,
  OVER_WORKER_THRESHOLD,
} from "../helpers/real-cpu-worker";

// WorkerClient.hashGitBlob — the SHA with the buffer MOVED to the worker
// and back instead of cloned (COMMIT-PASS-PERF, 2026-10-04). Runs the
// REAL cpu-worker.ts through a transfer-faithful harness: a plain
// WorkerClient under vitest is in fallback mode and never transfers.

const bigFile = (): { bytes: ArrayBuffer; copy: Uint8Array } => {
  const u = new Uint8Array(OVER_WORKER_THRESHOLD);
  for (let i = 0; i < u.length; i++) u[i] = (i * 31 + 7) & 0xff;
  return { bytes: u.buffer, copy: u.slice() };
};

describe("WorkerClient.hashGitBlob (real cpu-worker, transfer semantics)", () => {
  it("worker path: the right SHA, the SAME bytes back, and the argument detached (moved, not copied)", async () => {
    const client = makeRealCpuWorkerClient();
    expect(client.isFallback).toBe(false);
    const { bytes, copy } = bigFile();
    const expected = await calculateGitBlobSHA(copy.slice().buffer);

    const r = await client.hashGitBlob(bytes);

    expect(r.sha).toBe(expected);
    expect(new Uint8Array(r.bytes)).toEqual(copy);
    // Proof the buffer was TRANSFERRED: the caller's handle is empty now.
    expect(bytes.byteLength).toBe(0);
    client.terminate();
  });

  it("matches the clone path (computeGitBlobSHA) byte-exact on the same content", async () => {
    const client = makeRealCpuWorkerClient();
    const a = bigFile();
    const b = bigFile();
    const viaClone = await client.computeGitBlobSHA(a.bytes);
    const viaTransfer = (await client.hashGitBlob(b.bytes)).sha;
    expect(viaTransfer).toBe(viaClone);
    client.terminate();
  });

  it("below the threshold: inline, the argument is untouched and returned as-is", async () => {
    const client = makeRealCpuWorkerClient();
    const small = new TextEncoder().encode("hello\n").buffer as ArrayBuffer;
    const r = await client.hashGitBlob(small);
    expect(r.bytes).toBe(small);
    expect(small.byteLength).toBe(6);
    expect(r.sha).toBe(
      await calculateGitBlobSHA(new TextEncoder().encode("hello\n").buffer as ArrayBuffer),
    );
    client.terminate();
  });

  it("fallback mode (no Worker): same result shape, nothing detached", async () => {
    const client = new WorkerClient({ cpuWorkerSource: "", networkWorkerSource: "" });
    expect(client.isFallback).toBe(true);
    const { bytes, copy } = bigFile();
    const r = await client.hashGitBlob(bytes);
    expect(r.bytes).toBe(bytes);
    expect(new Uint8Array(r.bytes)).toEqual(copy);
  });

  it("🔑 a worker that hands back a buffer of the wrong length fails LOUDLY (no silent empty blob)", async () => {
    const client = makeRealCpuWorkerClient();
    // Simulate a broken worker reply by intercepting dispatch.
    (client as unknown as { dispatch: unknown }).dispatch = async () => ({
      sha: "x",
      bytes: new ArrayBuffer(0),
    });
    const { bytes } = bigFile();
    await expect(client.hashGitBlob(bytes)).rejects.toThrow(/returned 0 bytes/);
    client.terminate();
  });

  it("the old clone path is unchanged: computeGitBlobSHA leaves the argument intact", async () => {
    const client = makeRealCpuWorkerClient();
    const { bytes } = bigFile();
    await client.computeGitBlobSHA(bytes);
    expect(bytes.byteLength).toBe(OVER_WORKER_THRESHOLD);
    client.terminate();
  });
});

// The worker's SHA-1 is WASM (hash-wasm), fed header and file as two
// pieces — no concat, no WebCrypto input copy (COMMIT-PASS-PERF,
// 2026-10-05). These run the REAL cpu-worker.ts; vi.doMock swaps what
// its fresh module instance gets for "hash-wasm".
describe("cpu-worker SHA-1: WASM without the concat, crypto.subtle as fallback", () => {
  const content = (seed: number, size = OVER_WORKER_THRESHOLD): Uint8Array => {
    const u = new Uint8Array(size);
    for (let i = 0; i < size; i++) u[i] = (i * 17 + seed) & 0xff;
    return u;
  };
  const reference = (u: Uint8Array): Promise<string> =>
    calculateGitBlobSHA(u.slice().buffer as ArrayBuffer); // crypto.subtle + concat

  it("the WASM path is the one taken, and it gives git's SHA", async () => {
    const real = await vi.importActual<typeof import("hash-wasm")>("hash-wasm");
    let created = 0;
    vi.doMock("hash-wasm", () => ({
      ...real,
      createSHA1: async () => {
        created += 1;
        return real.createSHA1();
      },
    }));
    try {
      const client = makeRealCpuWorkerClient();
      const u = content(1);
      const r = await client.hashGitBlob(u.slice().buffer as ArrayBuffer);
      expect(r.sha).toBe(await reference(u));
      expect(created).toBeGreaterThan(0);
      client.terminate();
    } finally {
      vi.doUnmock("hash-wasm");
    }
  });

  it("WASM unavailable (CSP / old WebView): falls back to crypto.subtle, same SHA", async () => {
    vi.doMock("hash-wasm", () => ({
      createSHA1: () => Promise.reject(new Error("WebAssembly is blocked")),
    }));
    try {
      const client = makeRealCpuWorkerClient();
      const u = content(2);
      const r = await client.hashGitBlob(u.slice().buffer as ArrayBuffer);
      expect(r.sha).toBe(await reference(u));
      expect(new Uint8Array(r.bytes)).toEqual(u);
      client.terminate();
    } finally {
      vi.doUnmock("hash-wasm");
    }
  });

  it("many requests in flight on the shared WASM instance never mix their data", async () => {
    const client = makeRealCpuWorkerClient();
    const inputs = Array.from({ length: 12 }, (_, i) =>
      content(10 + i, OVER_WORKER_THRESHOLD + i * 4096),
    );
    const results = await Promise.all(
      inputs.map((u) => client.hashGitBlob(u.slice().buffer as ArrayBuffer)),
    );
    for (let i = 0; i < inputs.length; i++) {
      expect(results[i].sha, `input ${i}`).toBe(await reference(inputs[i]));
    }
    client.terminate();
  });

  it("the clone op (computeGitBlobSHA) goes through the same WASM function", async () => {
    const client = makeRealCpuWorkerClient();
    const u = content(3);
    expect(await client.computeGitBlobSHA(u.slice().buffer as ArrayBuffer)).toBe(
      await reference(u),
    );
    client.terminate();
  });
});

// Owner, 2026-10-11 (manual checklist "WASM SHA-1 in the CPU worker"): the
// worker falls back to crypto.subtle SILENTLY, so a field log could not say
// which engine hashed the large files. The client can now ask, and the
// plugin logs the answer once at start.
describe("WorkerClient.sha1Engine — which SHA-1 hashes files ≥ 100 KB", () => {
  it("the real cpu-worker answers 'wasm' when WebAssembly is available", async () => {
    const client = makeRealCpuWorkerClient();
    expect(client.isFallback).toBe(false);
    expect(await client.sha1Engine()).toBe("wasm");
    client.terminate();
  });

  it("with no worker at all (fallback mode) it says so — main thread, crypto.subtle", async () => {
    const client = new WorkerClient();
    expect(client.isFallback).toBe(true);
    expect(await client.sha1Engine()).toBe("main-thread crypto.subtle (no worker)");
  });
});
