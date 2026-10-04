import { describe, it, expect } from "vitest";
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
