// A WorkerClient whose CPU workers run the REAL src/worker/cpu-worker.ts
// code, with the browser's postMessage semantics — including TRANSFER.
//
// Why this exists (COMMIT-PASS-PERF, 2026-10-04): under vitest a plain
// `new WorkerClient()` is always in fallback mode (no global Worker), so
// every op runs inline and NOTHING is ever transferred or detached. A
// caller that keeps reading a buffer it has handed to the worker would
// stay green in every existing suite and send an empty file in
// production. Here each message crosses a simulated thread boundary via
// structuredClone(msg, { transfer }) — Node detaches transferred
// buffers exactly like a browser — so such a caller fails.
//
// Each fake worker evaluates its own fresh copy of cpu-worker.ts against
// a stub `self`. Loads are serialised: the module reads the global
// `self` once at evaluation time.
//
// ⚠️ Only CPU ops are served. The network worker gets the same class but
// is never sent anything by the tests that use this.

import { vi } from "vitest";
import WorkerClient from "../../src/worker/worker-client";

type Handler = (e: { data: unknown }) => void | Promise<void>;

let loadChain: Promise<void> = Promise.resolve();

class RealCpuWorker {
  private listeners: Handler[] = [];
  private handler: Handler | null = null;
  private readonly ready: Promise<void>;

  constructor(_url: string) {
    this.ready = loadChain = loadChain.then(() => this.load());
  }

  private async load(): Promise<void> {
    const g = globalThis as { self?: unknown };
    const prev = g.self;
    g.self = {
      addEventListener: (_type: string, h: Handler) => {
        this.handler = h;
      },
      // worker → main: clone WITH transfer, then deliver asynchronously.
      postMessage: (msg: unknown, transfer?: Transferable[]) => {
        const moved = structuredClone(msg, {
          transfer: (transfer ?? []) as Transferable[],
        });
        queueMicrotask(() => {
          for (const l of this.listeners) void l({ data: moved });
        });
      },
    };
    try {
      vi.resetModules();
      await import("../../src/worker/cpu-worker");
    } finally {
      g.self = prev;
    }
  }

  addEventListener(_type: "message", h: Handler): void {
    this.listeners.push(h);
  }

  // main → worker: clone WITH transfer NOW (so the caller's buffer is
  // detached at the moment of posting, as in a browser), deliver later.
  postMessage(msg: unknown, transfer?: Transferable[]): void {
    const moved = structuredClone(msg, {
      transfer: (transfer ?? []) as Transferable[],
    });
    void this.ready.then(() => this.handler?.({ data: moved }));
  }

  terminate(): void {}
}

export function makeRealCpuWorkerClient(): WorkerClient {
  return new WorkerClient({
    hardwareConcurrency: 4,
    cpuWorkerSource: "/* real cpu-worker.ts is loaded by the fake */",
    networkWorkerSource: "/* unused */",
    workerCtor: RealCpuWorker as unknown as typeof Worker,
  });
}

// Above WorkerClient.SHA_WORKER_THRESHOLD (100 KB): anything smaller is
// hashed inline and never crosses the boundary — a test using it would
// test nothing.
export const OVER_WORKER_THRESHOLD = 200 * 1024;
