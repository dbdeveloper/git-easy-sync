// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// ConflictCounter — read-only UI counter for the conflict status
// indicators (status bar + ribbon). Reactive to vault.on events
// via ConflictWatcher; never mutates store. See
// docs/PSEUDO-MERGE-MODE.md §5 for the layer separation.
//
// Contract:
//
//   - markDirty() is O(1): sets dirty flag, schedules at most ONE
//     debounced recompute via the supplied microtask scheduler.
//     Multiple back-to-back calls coalesce into one scheduled task.
//
//   - getValue() is O(1): returns the CACHED count. Callers that
//     need a guaranteed-fresh value await flush() first.
//
//   - flush() is async: runs the recompute INLINE (does NOT wait
//     for the scheduler to fire). Loops until quiescent (dirty
//     cleared and no in-flight recompute). Used by drain at start
//     and by tests.
//
//   - subscribe(cb) registers a callback that fires after each
//     recompute, but ONLY if the value CHANGED. Returns an
//     unsubscribe function. Used by status bar + ribbon for
//     reactive UI.
//
// Default recompute formula (v2 port — production overrides it with
// the injected findAllConflicts count, TODO #7, so panel and badge
// can never diverge):
//   count = 0
//   for (basePath, entry) in store.getCachedState().entries:
//     for sibling in entry.siblings:
//       if exists(derived sibling disk name): count++
//   // v1 additionally skipped SHA-equal (auto-cleaning) siblings using
//   // the record's cached base/sibling shas; v2 entries carry no local
//   // base sha, and hashing here would put a read+SHA on a UI counter.
//   // The next process_conflicts prunes those entries anyway.

import { Vault } from "obsidian";
import ConflictStoreV2 from "./conflict-store-v2";
import { buildSiblingFilePath } from "./conflict-siblings";

export interface ConflictCounterDeps {
  vault: Vault;
  store: ConflictStoreV2;
  // Override clock for deterministic tests.
  now?: () => number;
  // Override microtask scheduler for deterministic tests (default
  // queueMicrotask). Tests inject a synchronous flushable scheduler.
  scheduleMicrotask?: (fn: () => void) => void;
  // TODO #7 — override the count formula. When provided (main.ts wires it to
  // the diff-panel's findAllConflicts), the badge/status-bar/menu count matches
  // EXACTLY what the diff-panel lists — tracked AND SYNTHETIC siblings — instead
  // of only the store's tracked records. Kept as an injected callback so this
  // sync2 module never imports the diff2 detector (the sync2 ↛ diff2 rule). The
  // default (no override) is the store-only count, used by the unit suite.
  countConflicts?: () => number;
}

export type CountChangeCallback = (count: number) => void;

export class ConflictCounter {
  private readonly vault: Vault;
  private readonly store: ConflictStoreV2;
  private readonly scheduleMicrotask: (fn: () => void) => void;
  private readonly countConflicts?: () => number;

  private cachedValue: number = 0;
  private dirty: boolean = false;
  // True while a microtask is queued but hasn't fired yet. Prevents
  // bulk markDirty() from queueing N tasks for one debounce window.
  private scheduled: boolean = false;
  // Non-null while a recompute is actually running. flush() awaits
  // this; markDirty() does not re-schedule if it's set (the in-flight
  // run will re-arm via the post-await dirty-check loop below).
  private currentRun: Promise<void> | null = null;
  // Separate from `dirty` — survives recompute cycles. Set by any
  // markDirty() call (including the initial state). Cleared only by
  // `consumeSweepRequest()`, which the drain calls at the start of
  // each cycle. Lets the drain skip its evaluateConflictState sweep
  // when nothing relevant changed since the last drain.
  // Initial `true` so the first drain after onload always runs the
  // sweep (we don't know what changed while the plugin was off).
  private sweepRequested: boolean = true;
  private readonly subscribers: Set<CountChangeCallback> = new Set();

  constructor(deps: ConflictCounterDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.scheduleMicrotask =
      deps.scheduleMicrotask ?? ((fn) => queueMicrotask(fn));
    this.countConflicts = deps.countConflicts;
  }

  // O(1). Sets the dirty flag (for UI counter recompute) AND the
  // sweep-requested flag (for drain). Schedules at most one debounced
  // recompute via the microtask scheduler. Back-to-back calls
  // coalesce into one scheduled callback.
  markDirty(): void {
    this.dirty = true;
    this.sweepRequested = true;
    if (this.scheduled || this.currentRun !== null) return;
    this.scheduled = true;
    this.scheduleMicrotask(() => {
      this.scheduled = false;
      void this.runIfDirty();
    });
  }

  // Drain-side companion to markDirty(). Atomically reads the sweep-
  // requested flag AND clears it. The drain calls this at the top of
  // each cycle:
  //
  //   if (store.records.length > 0 && counter.consumeSweepRequest()) {
  //     await evaluateConflictState(...)
  //   }
  //
  // Returns true:
  //   - on first call after construction (initial state forces sweep)
  //   - after any markDirty() since the previous consumeSweepRequest
  //
  // Returns false when nothing relevant has changed since the previous
  // drain — skips the per-record stat walk entirely on idle clicks.
  consumeSweepRequest(): boolean {
    const requested = this.sweepRequested;
    this.sweepRequested = false;
    return requested;
  }

  // O(1). Returns the cached count. UI surfaces (status bar, ribbon)
  // either subscribe() or check this after their own flush().
  getValue(): number {
    return this.cachedValue;
  }

  // Subscribe to count changes. Callback fires after each recompute
  // IF and only if the new value differs from the previous cache.
  // Returns an unsubscribe function.
  subscribe(callback: CountChangeCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // Force the recompute to run NOW, bypassing the microtask debounce.
  // Loops until quiescent (no dirty flag set, no in-flight run) so
  // markDirty() calls landing during a recompute are picked up.
  async flush(): Promise<void> {
    while (this.dirty || this.currentRun !== null) {
      if (this.currentRun !== null) {
        await this.currentRun;
      } else {
        await this.runIfDirty();
      }
    }
  }

  // ── internals ─────────────────────────────────────────────────────

  private async runIfDirty(): Promise<void> {
    if (!this.dirty) return;
    if (this.currentRun !== null) {
      // A run is already in progress — await it. The post-await
      // dirty-check loop in flush() will start another if needed.
      await this.currentRun;
      return;
    }
    this.dirty = false;
    this.currentRun = (async () => {
      const newCount = await this.computeCount();
      const changed = newCount !== this.cachedValue;
      this.cachedValue = newCount;
      if (changed) {
        // Snapshot so subscribers can unsubscribe during the loop
        // without invalidating iteration.
        for (const cb of [...this.subscribers]) {
          try {
            cb(newCount);
          } catch {
            // Best-effort: a throwing subscriber doesn't stop the rest.
          }
        }
      }
    })();
    try {
      await this.currentRun;
    } finally {
      this.currentRun = null;
    }
  }

  private async computeCount(): Promise<number> {
    // TODO #7 — when wired (main.ts), count EXACTLY what the diff-panel lists
    // (tracked + synthetic siblings, via findAllConflicts) so the badge / status
    // bar / menu can't undercount. The store-only walk below is the default.
    if (this.countConflicts) return this.countConflicts();
    let count = 0;
    for (const [basePath, entry] of this.store.getCachedState().entries) {
      for (const sibling of entry.siblings) {
        const name = buildSiblingFilePath(
          basePath,
          sibling.mtime ?? 0,
          sibling.deviceLabel,
        );
        // A tracked sibling whose file is gone is resolved-pending-prune
        // (the next process_conflicts drops it) — not counted.
        if (await this.vault.adapter.exists(name)) count++;
      }
    }
    return count;
  }
}
