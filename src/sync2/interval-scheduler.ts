// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// IntervalScheduler — the timer + startup orchestration that drives
// background syncs and the watchdog drain. Lives outside main.ts so
// its three decision branches (interval-enabled, watchdog, startup)
// can be unit-tested without spinning up a real Obsidian instance.
//
// Three modes:
//
//   1. Interval-enabled (syncStrategy === "interval") + autoCommit ON
//      Every tick + startup: full sync (commit + pull + push) like a
//      manual Sync click.
//
//   2. Interval-enabled + autoCommit OFF
//      Every tick + startup: drain. drain() does pull + push of any
//      pending batches in one cycle; with no pending batches it
//      effectively becomes pull-only. The user's own edits stay
//      uncommitted (no findChanges/enqueue inside drain).
//
//   3. Interval-disabled (syncStrategy !== "interval")
//      Tick is a 5-min watchdog: only fires drain when the on-disk
//      queue has pending batches (retries pushes that failed earlier).
//      Empty queue → no-op, no GitHub poll. Startup behaviour is the
//      same as #2: the user opted into "sync on startup" so we still
//      drain to drag pending work + remote changes up to date.

export interface IntervalSchedulerDeps {
  // Settings predicates. Read live so the scheduler picks up settings
  // changes on the next tick without rebuilding.
  isConfigured: () => boolean;
  intervalEnabled: () => boolean;
  intervalMinutes: () => number;
  syncStartsWithCommit: () => boolean;

  // Sync2Manager ops the scheduler drives. All async; rejections are
  // caught and routed to logError so a single failed tick doesn't
  // tear down the interval.
  hasPendingBatches: () => Promise<boolean>;
  drain: () => Promise<void>;
  // Why it runs (owner, 2026-10-11): the periodic sync skips files too
  // large for the repo SILENTLY; the startup sync shows the pop-up like a
  // manual one.
  fullSync: (reason: "interval" | "startup") => Promise<void>;

  logError: (label: string, err: string) => void;

  // Timer hooks. Defaults wire to window.setInterval/clearInterval in
  // production; tests inject a fake-timer so they can advance time
  // and assert tick behaviour without real sleeps.
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
}

export class IntervalScheduler {
  private timerId: number | null = null;

  constructor(private readonly deps: IntervalSchedulerDeps) {}

  // Returns the active timer id (or null when stopped). Plugin code
  // uses this to hand the id to Obsidian's registerInterval() so the
  // timer is cleaned up on plugin disable, parallel to our own stop().
  getTimerId(): number | null {
    return this.timerId;
  }

  // Wire up the timer. The cadence is intervalMinutes when interval is
  // enabled; otherwise hardcoded 5 min (watchdog default). Subsequent
  // start() calls while a timer is already active are no-ops.
  start(): void {
    if (this.timerId !== null) return;
    const enabled = this.deps.intervalEnabled();
    const minutes = enabled ? Math.max(1, this.deps.intervalMinutes()) : 5;
    const ms = minutes * 60 * 1000;
    this.timerId = this.deps.setInterval(() => {
      void this.tick();
    }, ms);
  }

  stop(): void {
    if (this.timerId === null) return;
    this.deps.clearInterval(this.timerId);
    this.timerId = null;
  }

  // One interval iteration. Exposed (not just private) so tests can
  // drive it directly without juggling fake timers.
  async tick(): Promise<void> {
    if (!this.deps.isConfigured()) return;
    if (!this.deps.intervalEnabled()) {
      await this.watchdogTick();
      return;
    }
    await this.fullCycle("Interval");
  }

  // Plugin-onload entry point: same decision as a manual interval tick
  // when intervalEnabled would have been true, regardless of the
  // actual syncStrategy setting. "Sync on startup" means "behave as if
  // I clicked Sync right now"; the strategy switch governs subsequent
  // ticks, not the one-shot startup pulse.
  async runStartup(): Promise<void> {
    if (!this.deps.isConfigured()) return;
    await this.fullCycle("Startup");
  }

  private async watchdogTick(): Promise<void> {
    const hasWork = await this.deps.hasPendingBatches();
    if (!hasWork) return;
    try {
      await this.deps.drain();
    } catch (err) {
      this.deps.logError("Interval watchdog drain failed", `${err}`);
    }
  }

  private async fullCycle(label: "Interval" | "Startup"): Promise<void> {
    if (this.deps.syncStartsWithCommit()) {
      try {
        await this.deps.fullSync(label === "Interval" ? "interval" : "startup");
      } catch (err) {
        this.deps.logError(`${label} sync failed`, `${err}`);
      }
      return;
    }
    try {
      await this.deps.drain();
    } catch (err) {
      this.deps.logError(`${label} drain failed`, `${err}`);
    }
  }
}
