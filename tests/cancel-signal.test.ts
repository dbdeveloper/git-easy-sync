// Owner, 2026-10-11: "Cancel sync" did nothing for minutes. A 127 MB blob
// upload was being retried — 6 attempts of ~47 s with growing pauses — and
// the cancel checks sat only BETWEEN the drain's own steps, never inside the
// retry loops nor inside a request in flight. The owner had asked for a
// cancel exit from EVERY loop of sync/drain. These tests pin the two retry
// loops; the request in flight is pinned in the worker-client tests.

import { describe, expect, it } from "vitest";
import { CancelSignal } from "../src/cancel-signal";
import { CancelledError, NetworkError } from "../src/errors";
import { retryUntil } from "../src/utils";
import NetworkRetry from "../src/sync2/retry-network";

describe("CancelSignal", () => {
  it("sleep() ends at once when cancelled; reset() re-arms it", async () => {
    const s = new CancelSignal();
    const t0 = Date.now();
    setTimeout(() => s.cancel(), 20);
    await s.sleep(5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.isCancelled).toBe(true);
    s.reset();
    expect(s.isCancelled).toBe(false);
  });
});

describe("retryUntil honours the cancel signal (GitHub client retries)", () => {
  it("cancel during a backoff pause: no further attempt, a CancelledError at once", async () => {
    const s = new CancelSignal();
    let attempts = 0;
    const t0 = Date.now();
    setTimeout(() => s.cancel(), 30);
    await expect(
      retryUntil(
        async () => {
          attempts++;
          return { status: 503 };
        },
        (r) => r.status < 500,
        5,
        2000, // the first pause alone would be 2 s
        2,
        s,
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(attempts).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("already cancelled: not even the first attempt", async () => {
    const s = new CancelSignal();
    s.cancel();
    let attempts = 0;
    await expect(
      retryUntil(async () => (attempts++, { status: 200 }), () => true, 5, 10, 2, s),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(attempts).toBe(0);
  });

  it("a CancelledError thrown by the request itself is never retried", async () => {
    let attempts = 0;
    await expect(
      retryUntil(async () => {
        attempts++;
        throw new CancelledError();
      }, () => true, 5, 10),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(attempts).toBe(1);
  });
});

describe("NetworkRetry honours the cancel signal (the drain's retries)", () => {
  const vault = {
    adapter: {
      exists: async () => false,
      mkdir: async () => {},
      write: async () => {},
      remove: async () => {},
    },
  };

  it("cancel during the pause after a network error: returns CancelledError at once", async () => {
    const s = new CancelSignal();
    const retry = new NetworkRetry({
      vault: vault as never,
      selfPluginId: "git-easy-sync",
      baseDelayMs: 2000,
      cancelSignal: s,
    });
    let attempts = 0;
    const t0 = Date.now();
    setTimeout(() => s.cancel(), 30);
    const out = await retry.run(async () => {
      attempts++;
      throw new NetworkError("net down");
    });
    expect(out.error).toBeInstanceOf(CancelledError);
    expect(attempts).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
