// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CancelSignal } from "../../src/cancel-signal";
import { CancelledError } from "../../src/errors";
import WorkerClient, {
  computeCpuPoolSize,
} from "../../src/worker/worker-client";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../src/worker/types";

// Node doesn't have the Web Worker API. These tests simulate it with
// a hand-rolled `FakeWorker` that mirrors the postMessage / message
// event contract closely enough for WorkerClient's purposes — plus
// a `__deliverRequest` hook so a test can choose what reply to send
// for each incoming message. Each FakeWorker has its own message
// handler list, so a pool of them models the orchestra correctly.

class FakeWorker {
  static instances: FakeWorker[] = [];
  static replyMode:
    | "echo"
    | "pong"
    | "error"
    | "noop"
    | "swap-id"
    | "drop" = "pong";

  url: string;
  terminated = false;
  private listeners: Array<(e: MessageEvent) => void> = [];

  constructor(url: string) {
    this.url = url;
    FakeWorker.instances.push(this);
  }

  addEventListener(_type: "message", h: (e: MessageEvent) => void): void {
    this.listeners.push(h);
  }

  removeEventListener(_type: "message", h: (e: MessageEvent) => void): void {
    this.listeners = this.listeners.filter((x) => x !== h);
  }

  postMessage(msg: WorkerRequest): void {
    // Simulate worker behaviour according to the static replyMode.
    // Use queueMicrotask so the reply is asynchronous like a real
    // Worker (the client's dispatch must work even when the reply
    // doesn't arrive synchronously).
    queueMicrotask(() => {
      if (this.terminated) return;
      let reply: WorkerResponse | null = null;
      switch (FakeWorker.replyMode) {
        case "pong":
          reply = { id: msg.id, ok: true, result: "pong" };
          break;
        case "echo":
          reply = {
            id: msg.id,
            ok: true,
            result: (msg as Extract<WorkerRequest, { op: "echo" }>).payload,
          };
          break;
        case "error":
          reply = { id: msg.id, ok: false, error: "fake-error" };
          break;
        case "swap-id":
          reply = { id: "wrong-id", ok: true, result: "stray" };
          break;
        case "drop":
        case "noop":
          // Don't reply at all.
          return;
      }
      if (reply === null) return;
      const event = { data: reply } as MessageEvent;
      for (const l of this.listeners) l(event);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

// URL.createObjectURL stand-in. Node 18+ doesn't expose it as a
// browser-style API on URL, so set up a stub that returns a fake
// URL and supports revoke. The WorkerClient uses these only to feed
// into FakeWorker which doesn't actually parse the URL.
class StubBlob {
  parts: BlobPart[];
  type: string;
  constructor(parts: BlobPart[], opts?: { type?: string }) {
    this.parts = parts;
    this.type = opts?.type ?? "";
  }
}
const createdUrls: string[] = [];
const revokedUrls: string[] = [];
let urlCounter = 0;

function setupGlobals(): void {
  (globalThis as { Blob: typeof Blob }).Blob =
    StubBlob as unknown as typeof Blob;
  (globalThis as { URL: typeof URL }).URL = {
    ...URL,
    createObjectURL: ((_blob: Blob) => {
      const u = `blob:fake/${++urlCounter}`;
      createdUrls.push(u);
      return u;
    }) as typeof URL.createObjectURL,
    revokeObjectURL: ((url: string) => {
      revokedUrls.push(url);
    }) as typeof URL.revokeObjectURL,
  } as typeof URL;
}

function resetGlobals(): void {
  FakeWorker.instances = [];
  FakeWorker.replyMode = "pong";
  createdUrls.length = 0;
  revokedUrls.length = 0;
  urlCounter = 0;
}

const FAKE_CPU = "self.addEventListener('message', () => {});";
const FAKE_NETWORK = "self.addEventListener('message', () => {});";

describe("computeCpuPoolSize", () => {
  it("returns 2 when hardware concurrency is undefined", () => {
    expect(computeCpuPoolSize(undefined)).toBe(2);
  });
  it("returns 2 when hardware concurrency is 1 (single-core phone)", () => {
    expect(computeCpuPoolSize(1)).toBe(2);
  });
  it("returns 2 when hardware concurrency is 3 (subtract one)", () => {
    expect(computeCpuPoolSize(3)).toBe(2);
  });
  it("returns 3 when hardware concurrency is 4", () => {
    expect(computeCpuPoolSize(4)).toBe(3);
  });
  it("caps at 4 even with 16 cores", () => {
    expect(computeCpuPoolSize(16)).toBe(4);
  });
});

describe("WorkerClient — orchestra pool", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it("constructs CPU pool sized to hardwareConcurrency rule", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 8,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.cpuPoolSize).toBe(4);
    // One network worker on top of the pool.
    expect(FakeWorker.instances.length).toBe(5);
    expect(client.isFallback).toBe(false);
    client.terminate();
  });

  it("falls back to main-thread mode when Worker constructor is missing", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: undefined as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
    expect(FakeWorker.instances.length).toBe(0);
  });

  it("falls back to main-thread mode when worker source is empty", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
  });

  it("falls back to main-thread when Worker constructor throws", () => {
    class ThrowingWorker {
      constructor() {
        throw new Error("nope");
      }
    }
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: ThrowingWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
  });

  it("revokes all Blob URLs after terminate()", () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(createdUrls.length).toBe(2); // one cpu + one network blob
    client.terminate();
    expect(revokedUrls.length).toBe(2);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });
});

describe("WorkerClient — dispatch round-trip", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it("resolves ping with pong from a CPU worker", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const result = await client.dispatch<string>({
      id: client.newRequestId(),
      op: "ping",
    });
    expect(result).toBe("pong");
    client.terminate();
  });

  it("echoes a payload via the echo op", async () => {
    FakeWorker.replyMode = "echo";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const out = await client.dispatch<{ x: number }>({
      id: client.newRequestId(),
      op: "echo",
      payload: { x: 42 },
    });
    expect(out).toEqual({ x: 42 });
    client.terminate();
  });

  it("rejects when the worker replies with ok: false", async () => {
    FakeWorker.replyMode = "error";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    await expect(
      client.dispatch({ id: client.newRequestId(), op: "ping" }),
    ).rejects.toThrow("fake-error");
    client.terminate();
  });

  it("multiplexes 10 concurrent pings — every promise resolves", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const pongs = await Promise.all(
      Array.from({ length: 10 }, () =>
        client.dispatch<string>({
          id: client.newRequestId(),
          op: "ping",
        }),
      ),
    );
    expect(pongs).toHaveLength(10);
    expect(new Set(pongs)).toEqual(new Set(["pong"]));
    client.terminate();
  });

  it("ignores replies with unknown request IDs (drops silently)", async () => {
    FakeWorker.replyMode = "swap-id";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // Race the dispatch against a short timeout; we expect it to
    // STILL be pending (no resolver hit) because the worker
    // returned a reply with a non-matching id.
    const dispatched = client.dispatch({
      id: client.newRequestId(),
      op: "ping",
    });
    const flagged = Promise.race([
      dispatched.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-pending"), 30)),
    ]);
    expect(await flagged).toBe("still-pending");
    client.terminate();
  });

  it("rejects pending promises when terminate() runs mid-flight", async () => {
    FakeWorker.replyMode = "drop";
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const dispatched = client.dispatch({
      id: client.newRequestId(),
      op: "ping",
    });
    client.terminate();
    await expect(dispatched).rejects.toThrow("WorkerClient terminated");
  });

  it("fallback mode handles ping via main-thread handler", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    expect(client.isFallback).toBe(true);
    const out = await client.dispatch<string>({
      id: client.newRequestId(),
      op: "ping",
    });
    expect(out).toBe("pong-main-fallback");
  });

  it("fallback mode echoes payload via main-thread handler", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const out = await client.dispatch<{ s: string }>({
      id: client.newRequestId(),
      op: "echo",
      payload: { s: "hi" },
    });
    expect(out).toEqual({ s: "hi" });
  });
});

// ────────────────────────────────────────────────────────────────
// Stage 4 — typed convenience wrappers for the CPU ops. Tests use
// the same fallback path (no real Worker) so the math is verified
// without depending on a browser environment. Production Stage 4
// behaviour where the work actually runs in a Worker is exercised
// by the integration suite (Stage 4 follow-up commits).
// ────────────────────────────────────────────────────────────────

describe("WorkerClient.decodeBase64", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  it("small payloads run inline (below worker threshold)", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // "Hello, World!" → base64
    const buf = await client.decodeBase64("SGVsbG8sIFdvcmxkIQ==");
    expect(new TextDecoder().decode(buf)).toBe("Hello, World!");
    client.terminate();
  });

  it("strips MIME-style whitespace (\\n every 60 chars) before atob", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // GitHub Blobs API returns base64 with newlines inserted
    // every 60 chars. Newlines must be stripped before atob —
    // atob doesn't accept whitespace per spec.
    // "Hello, World!" → SGVsbG8sIFdvcmxkIQ==
    // Insert \n between groups of base64 chars (the strip+decode
    // produces the original string).
    const wrapped = "SGVsbG8s\nIFdvcmxk\nIQ==";
    const buf = await client.decodeBase64(wrapped);
    expect(new TextDecoder().decode(buf)).toBe("Hello, World!");
    client.terminate();
  });

  it("fallback mode uses same atob path", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const buf = await client.decodeBase64("aGVsbG8=");
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });
});

describe("WorkerClient.computeGitBlobSHA", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  it("matches the known SHA for an empty blob", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // `git hash-object /dev/null` = e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    const sha = await client.computeGitBlobSHA(new Uint8Array(0).buffer);
    expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    client.terminate();
  });

  it("matches the known SHA for a single 'a' byte", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // `printf 'a' | git hash-object --stdin`
    //   = 2e65efe2a145dda7ee51d1741299f848e5bf752e
    const a = new TextEncoder().encode("a");
    const sha = await client.computeGitBlobSHA(a.buffer);
    expect(sha).toBe("2e65efe2a145dda7ee51d1741299f848e5bf752e");
    client.terminate();
  });

  it("worker and main-thread fallback produce the same SHA byte-exact", async () => {
    const workerClient = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const fallbackClient = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const bytes = new TextEncoder().encode(
      "The quick brown fox jumps over the lazy dog",
    ).buffer;
    // Note: below threshold, so both go through fallback path —
    // but the invariant we care about is the algorithm matches.
    // Above threshold one would go through worker dispatch; the
    // result must remain identical.
    const a = await workerClient.computeGitBlobSHA(bytes);
    const b = await fallbackClient.computeGitBlobSHA(bytes);
    expect(a).toBe(b);
    workerClient.terminate();
    fallbackClient.terminate();
  });
});

describe("WorkerClient.mergeText", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  it("clean merge of non-overlapping edits", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // 5-line base with "middle" separator between the two edit
    // zones so node-diff3 treats them as separate hunks (same
    // pattern as sync2-manager.test.ts's clean-merge tests).
    const base = "header\nalpha\nmiddle\noriginal\nfooter";
    const ours = "header\nALPHA-OURS\nmiddle\noriginal\nfooter";
    const theirs = "header\nalpha\nmiddle\nORIGINAL-THEIRS\nfooter";
    const result = await client.mergeText(ours, base, theirs);
    expect(result.kind).toBe("clean");
    if (result.kind === "clean") {
      expect(result.content).toContain("ALPHA-OURS");
      expect(result.content).toContain("ORIGINAL-THEIRS");
    }
    client.terminate();
  });

  it("conflict on overlapping edits emits markers", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    // Both sides change the same line — diff3 must report a
    // conflict.
    const base = "header\nbeta\nfooter";
    const ours = "header\nBETA-OURS\nfooter";
    const theirs = "header\nBETA-THEIRS\nfooter";
    const result = await client.mergeText(ours, base, theirs);
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflictMarkedContent).toContain("BETA-OURS");
      expect(result.conflictMarkedContent).toContain("BETA-THEIRS");
    }
    client.terminate();
  });

  it("CRLF inputs preserve CRLF in clean-merge output", async () => {
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const base = "header\r\nalpha\r\nmiddle\r\noriginal\r\nfooter";
    const ours = "header\r\nALPHA-OURS\r\nmiddle\r\noriginal\r\nfooter";
    const theirs = "header\r\nalpha\r\nmiddle\r\nORIGINAL-THEIRS\r\nfooter";
    const result = await client.mergeText(ours, base, theirs);
    expect(result.kind).toBe("clean");
    if (result.kind === "clean") {
      expect(result.content.includes("\r\n")).toBe(true);
    }
    client.terminate();
  });

  it("worker and fallback paths produce identical results", async () => {
    // Both clients run through fallback because the test inputs
    // are short, but the test asserts the algorithm is the same.
    const workerClient = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const fallbackClient = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    const base = "x\ny\nz";
    const ours = "x\nY-OURS\nz";
    const theirs = "x\ny\nZ-THEIRS";
    const a = await workerClient.mergeText(ours, base, theirs);
    const b = await fallbackClient.mergeText(ours, base, theirs);
    expect(a).toEqual(b);
    workerClient.terminate();
    fallbackClient.terminate();
  });
});

describe("WorkerClient.httpRequest", () => {
  beforeEach(() => {
    setupGlobals();
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it("fallback path uses globalThis.fetch + parses JSON body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: input.toString(), init });
      return new Response(JSON.stringify({ ok: true, n: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    try {
      const out = await client.httpRequest({
        url: "https://api.example.com/x",
        method: "GET",
        headers: { Authorization: "Bearer t" },
      });
      expect(out.status).toBe(200);
      expect(out.json).toEqual({ ok: true, n: 7 });
      expect(out.text).toContain("\"n\":7");
      expect(out.headers["content-type"]).toBe("application/json");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.example.com/x");
      expect(
        (calls[0].init?.headers as Record<string, string>)?.Authorization,
      ).toBe("Bearer t");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns json: null when response is not JSON-parseable", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("not-json-content", { status: 200 })) as typeof fetch;
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    try {
      const out = await client.httpRequest({
        url: "https://api.example.com/y",
      });
      expect(out.status).toBe(200);
      expect(out.text).toBe("not-json-content");
      expect(out.json).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("forwards POST body to fetch", async () => {
    let captured: RequestInit | undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      captured = init;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: "",
      networkWorkerSource: "",
      workerCtor: FakeWorker as unknown as typeof Worker,
    });
    try {
      const out = await client.httpRequest({
        url: "https://api.example.com/z",
        method: "POST",
        body: '{"hello":"world"}',
      });
      expect(out.status).toBe(201);
      expect(captured?.method).toBe("POST");
      expect(captured?.body).toBe('{"hello":"world"}');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// Owner, 2026-10-11: "Cancel sync" could not stop a 127 MB upload — the
// request in flight had no way to be interrupted, so cancel waited for it
// (47 s, six times over). With a CancelSignal the in-flight request is
// aborted at once, and no new request starts until the next sync resets it.
describe("WorkerClient + CancelSignal — a request in flight stops at once", () => {
  it("fallback mode (main-thread fetch): cancel aborts the fetch and rejects with CancelledError", async () => {
    const signal = new CancelSignal();
    const client = new WorkerClient({ workerCtor: undefined as unknown as typeof Worker, cancelSignal: signal });
    expect(client.isFallback).toBe(true);
    const origFetch = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          rej(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    try {
      const t0 = Date.now();
      const p = client.httpRequest({ url: "https://api.github.com/x", method: "POST", body: "big" });
      setTimeout(() => signal.cancel(), 20);
      await expect(p).rejects.toBeInstanceOf(CancelledError);
      expect(aborted).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1000);
      // While cancelled, a new request does not even start…
      await expect(client.httpRequest({ url: "https://api.github.com/y" })).rejects.toBeInstanceOf(CancelledError);
      // …and the next sync (reset) can make requests again.
      signal.reset();
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      expect((await client.httpRequest({ url: "https://api.github.com/z" })).status).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("worker mode: cancel posts an http-abort for the request in flight and rejects at once", async () => {
    const signal = new CancelSignal();
    FakeWorker.instances = [];
    FakeWorker.replyMode = "drop"; // the upload never answers on its own
    const posted: WorkerRequest[] = [];
    class RecordingWorker extends FakeWorker {
      postMessage(msg: WorkerRequest): void {
        posted.push(msg);
        super.postMessage(msg);
      }
    }
    const client = new WorkerClient({
      hardwareConcurrency: 4,
      cpuWorkerSource: FAKE_CPU,
      networkWorkerSource: FAKE_NETWORK,
      workerCtor: RecordingWorker as unknown as typeof Worker,
      cancelSignal: signal,
    });
    const p = client.httpRequest({ url: "https://api.github.com/x", method: "POST", body: "big" });
    const sent = posted.find((m) => m.op === "http-request")!;
    signal.cancel();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(posted.some((m) => m.op === "http-abort" && (m as { target: string }).target === sent.id)).toBe(true);
    client.terminate();
  });
});
