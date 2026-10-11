import { describe, it, expect, beforeEach } from "vitest";
import {
  IntervalScheduler,
  IntervalSchedulerDeps,
} from "../../src/sync2/interval-scheduler";

// A tiny fake-timer harness: tracks each setInterval call so a test
// can fire the registered callback by hand. clearInterval marks the
// timer dead; subsequent fire() calls are silent no-ops.
function fakeTimer() {
  let nextId = 1;
  const fns = new Map<number, () => void>();
  const intervals = new Map<number, number>();
  return {
    setInterval: (fn: () => void, ms: number): number => {
      const id = nextId++;
      fns.set(id, fn);
      intervals.set(id, ms);
      return id;
    },
    clearInterval: (id: number): void => {
      fns.delete(id);
      intervals.delete(id);
    },
    fire: (id: number): void => {
      const fn = fns.get(id);
      if (fn) fn();
    },
    activeIds: (): number[] => [...fns.keys()],
    intervalOf: (id: number): number | undefined => intervals.get(id),
  };
}

// Spy-ops that record every call. Each op resolves immediately unless
// the test rejects() it to simulate a failure.
function makeOps() {
  const calls: string[] = [];
  let pending = false;
  let hasPendingError: Error | null = null;
  let drainError: Error | null = null;
  let fullSyncError: Error | null = null;
  const errors: { label: string; err: string }[] = [];
  return {
    calls,
    setPending(v: boolean) {
      pending = v;
    },
    setDrainError(e: Error | null) {
      drainError = e;
    },
    setFullSyncError(e: Error | null) {
      fullSyncError = e;
    },
    setHasPendingError(e: Error | null) {
      hasPendingError = e;
    },
    errors,
    deps: {
      hasPendingBatches: async (): Promise<boolean> => {
        calls.push("hasPendingBatches");
        if (hasPendingError) throw hasPendingError;
        return pending;
      },
      drain: async (): Promise<void> => {
        calls.push("drain");
        if (drainError) throw drainError;
      },
      fullSync: async (): Promise<void> => {
        calls.push("fullSync");
        if (fullSyncError) throw fullSyncError;
      },
      logError: (label: string, err: string) => {
        errors.push({ label, err });
      },
    },
  };
}

function makeDeps(
  ops: ReturnType<typeof makeOps>,
  timer: ReturnType<typeof fakeTimer>,
  cfg: {
    isConfigured?: boolean;
    intervalEnabled?: boolean;
    intervalMinutes?: number;
    autoCommit?: boolean;
  } = {},
): IntervalSchedulerDeps {
  return {
    isConfigured: () => cfg.isConfigured ?? true,
    intervalEnabled: () => cfg.intervalEnabled ?? false,
    intervalMinutes: () => cfg.intervalMinutes ?? 5,
    syncStartsWithCommit: () => cfg.autoCommit ?? false,
    hasPendingBatches: ops.deps.hasPendingBatches,
    drain: ops.deps.drain,
    fullSync: ops.deps.fullSync,
    logError: ops.deps.logError,
    setInterval: timer.setInterval,
    clearInterval: timer.clearInterval,
  };
}

describe("IntervalScheduler — start/stop", () => {
  let ops: ReturnType<typeof makeOps>;
  let timer: ReturnType<typeof fakeTimer>;

  beforeEach(() => {
    ops = makeOps();
    timer = fakeTimer();
  });

  it("start registers a setInterval; cadence is intervalMinutes when enabled", () => {
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, intervalMinutes: 3 }),
    );
    s.start();
    expect(timer.activeIds()).toHaveLength(1);
    const [id] = timer.activeIds();
    expect(timer.intervalOf(id)).toBe(3 * 60 * 1000);
  });

  it("start uses 5-min cadence as watchdog when interval is disabled", () => {
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: false, intervalMinutes: 1 }),
    );
    s.start();
    const [id] = timer.activeIds();
    expect(timer.intervalOf(id)).toBe(5 * 60 * 1000);
  });

  it("intervalMinutes < 1 clamps to 1 min (sanity floor)", () => {
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, intervalMinutes: 0 }),
    );
    s.start();
    const [id] = timer.activeIds();
    expect(timer.intervalOf(id)).toBe(1 * 60 * 1000);
  });

  it("second start() while a timer is active is a no-op", () => {
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true }),
    );
    s.start();
    s.start();
    expect(timer.activeIds()).toHaveLength(1);
  });

  it("stop() clears the registered timer", () => {
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true }),
    );
    s.start();
    expect(timer.activeIds()).toHaveLength(1);
    s.stop();
    expect(timer.activeIds()).toHaveLength(0);
  });
});

describe("IntervalScheduler.tick — interval ON + autoCommit ON", () => {
  it("calls fullSync, nothing else", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: true }),
    );
    await s.tick();
    expect(ops.calls).toEqual(["fullSync"]);
  });

  it("logs but doesn't throw when fullSync rejects", async () => {
    const ops = makeOps();
    ops.setFullSyncError(new Error("boom"));
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: true }),
    );
    await expect(s.tick()).resolves.not.toThrow();
    expect(ops.errors).toEqual([
      { label: "Interval sync failed", err: "Error: boom" },
    ]);
  });
});

describe("IntervalScheduler.tick — interval ON + autoCommit OFF", () => {
  it("calls drain (which pulls + pushes internally)", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: false }),
    );
    await s.tick();
    expect(ops.calls).toEqual(["drain"]);
  });

  it("logs but doesn't throw when drain rejects", async () => {
    const ops = makeOps();
    ops.setDrainError(new Error("net"));
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: false }),
    );
    await expect(s.tick()).resolves.not.toThrow();
    expect(ops.errors).toEqual([
      { label: "Interval drain failed", err: "Error: net" },
    ]);
  });
});

describe("IntervalScheduler.tick — watchdog mode (interval OFF)", () => {
  it("no work + interval OFF → no-op (no GitHub poll)", async () => {
    const ops = makeOps();
    ops.setPending(false);
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: false }),
    );
    await s.tick();
    expect(ops.calls).toEqual(["hasPendingBatches"]);
  });

  it("has pending + interval OFF → drain only", async () => {
    const ops = makeOps();
    ops.setPending(true);
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: false }),
    );
    await s.tick();
    expect(ops.calls).toEqual(["hasPendingBatches", "drain"]);
  });

  it("watchdog drain error is logged with watchdog label", async () => {
    const ops = makeOps();
    ops.setPending(true);
    ops.setDrainError(new Error("422"));
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: false }),
    );
    await s.tick();
    expect(ops.errors).toEqual([
      { label: "Interval watchdog drain failed", err: "Error: 422" },
    ]);
  });
});

describe("IntervalScheduler.tick — gating", () => {
  it("unconfigured plugin → tick is a no-op", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, {
        isConfigured: false,
        intervalEnabled: true,
        autoCommit: true,
      }),
    );
    await s.tick();
    expect(ops.calls).toEqual([]);
  });
});

describe("IntervalScheduler.runStartup", () => {
  it("autoCommit ON → fullSync", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { autoCommit: true }),
    );
    await s.runStartup();
    expect(ops.calls).toEqual(["fullSync"]);
  });

  it("autoCommit OFF → drain (which pulls + pushes)", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { autoCommit: false }),
    );
    await s.runStartup();
    expect(ops.calls).toEqual(["drain"]);
  });

  it("startup ignores intervalEnabled (always fullCycle, no watchdog)", async () => {
    const ops = makeOps();
    ops.setPending(false);
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, {
        intervalEnabled: false,
        autoCommit: false,
      }),
    );
    await s.runStartup();
    expect(ops.calls).toEqual(["drain"]);
  });

  it("unconfigured plugin → runStartup is a no-op", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { isConfigured: false }),
    );
    await s.runStartup();
    expect(ops.calls).toEqual([]);
  });

  it("logs Startup-prefixed error label when drain rejects", async () => {
    const ops = makeOps();
    ops.setDrainError(new Error("oops"));
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { autoCommit: false }),
    );
    await s.runStartup();
    expect(ops.errors).toEqual([
      { label: "Startup drain failed", err: "Error: oops" },
    ]);
  });
});

describe("IntervalScheduler — timer integration", () => {
  it("fire() on the registered timer triggers a tick", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: true }),
    );
    s.start();
    const [id] = timer.activeIds();
    timer.fire(id);
    // The setInterval callback is `void this.tick()`; let async land.
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.calls).toEqual(["fullSync"]);
  });

  it("multiple fires invoke tick multiple times", async () => {
    const ops = makeOps();
    const timer = fakeTimer();
    const s = new IntervalScheduler(
      makeDeps(ops, timer, { intervalEnabled: true, autoCommit: true }),
    );
    s.start();
    const [id] = timer.activeIds();
    timer.fire(id);
    timer.fire(id);
    timer.fire(id);
    await new Promise((r) => setTimeout(r, 0));
    expect(ops.calls).toEqual(["fullSync", "fullSync", "fullSync"]);
  });
});

// Owner, 2026-10-11: the "too large for the repo" pop-up shows for a manual
// Commit/Sync and for the sync at plugin start, but the PERIODIC sync must
// skip big files SILENTLY. Both automatic paths reach the same fullSync, so
// the scheduler now says which one it is.
describe("IntervalScheduler — fullSync says why it runs", () => {
  it("a periodic tick calls fullSync('interval'); the startup pulse calls fullSync('startup')", async () => {
    const reasons: string[] = [];
    const ops = makeOps();
    const timer = fakeTimer();
    const deps = makeDeps(ops, timer, { intervalEnabled: true, autoCommit: true });
    deps.fullSync = async (reason?: string) => {
      reasons.push(String(reason));
    };
    const s = new IntervalScheduler(deps);
    await s.tick();
    await s.runStartup();
    expect(reasons).toEqual(["interval", "startup"]);
  });
});
