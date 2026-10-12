// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// ConflictAnalyzer (owner, 2026-10-12; was "ConflictCounter" — it stopped
// being just a counter when it began to hold the conflict model). The ONE
// module that decides, for TRACKED conflicts, what is still in force: it
// reads the drain's ledger (conflicts.json) plus the disk, builds the
// conflict model (conflict-model.ts), keeps it in memory and tells its
// subscribers whenever the picture changes. It never writes the ledger or
// a file. Synthetic copies are not its business — the Diff Panel finds
// those itself, only where they are needed.
//
// Contract:
//
//   - invalidate() is O(1): marks the model stale, schedules at most ONE
//     debounced recompute via the supplied microtask scheduler.
//     Back-to-back calls coalesce into one scheduled task. Anyone may call
//     it — the vault-event watcher, the drain, the commit pass, the UI.
//
//   - refresh() is async: recomputes NOW (does not wait for the
//     scheduler), looping until quiescent. Callers that must act on a
//     fresh picture (the commit pass, the drain) await it.
//
//   - getModel() / filesInConflict(): the cached model and its count (the
//     badge's number) — O(1).
//
//   - subscribe(cb) fires after a recompute whenever the PICTURE changed
//     (not only the number). Status bar, ribbon, Diff Panel and the
//     editor-tab cleaner subscribe.

import { Vault } from "obsidian";
import ConflictStoreV2 from "./conflict-store-v2";
import { buildConflictModel, type ConflictModel } from "./conflict-model";
import { calculateGitBlobSHA } from "../utils";

export interface ConflictAnalyzerDeps {
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
  // The hash the conflict model uses (production: the worker's).
  computeSha?: (bytes: ArrayBuffer) => Promise<string>;
}

export type ModelChangeCallback = (count: number) => void;

export class ConflictAnalyzer {
  private readonly vault: Vault;
  private readonly store: ConflictStoreV2;
  private readonly scheduleMicrotask: (fn: () => void) => void;
  private readonly countConflicts?: () => number;

  private cachedValue: number = 0;
  // The conflict model (owner, 2026-10-12): ONE read-only picture of the
  // ledger plus the disk, rebuilt on every recompute; the count is its
  // filesInConflict. Readers take it from here instead of re-deriving.
  private model: ConflictModel | null = null;
  private modelSignature = "";
  private readonly computeSha: (bytes: ArrayBuffer) => Promise<string>;
  private dirty: boolean = false;
  // True while a microtask is queued but hasn't fired yet. Prevents
  // bulk invalidate() from queueing N tasks for one debounce window.
  private scheduled: boolean = false;
  // Non-null while a recompute is actually running. flush() awaits
  // this; invalidate() does not re-schedule if it's set (the in-flight
  // run will re-arm via the post-await dirty-check loop below).
  private currentRun: Promise<void> | null = null;
  // Separate from `dirty` — survives recompute cycles. Set by any
  // invalidate() call (including the initial state). Cleared only by
  // `consumeSweepRequest()`, which the drain calls at the start of
  // each cycle. Lets the drain skip its evaluateConflictState sweep
  // when nothing relevant changed since the last drain.
  // Initial `true` so the first drain after onload always runs the
  // sweep (we don't know what changed while the plugin was off).
  private sweepRequested: boolean = true;
  private readonly subscribers: Set<ModelChangeCallback> = new Set();

  constructor(deps: ConflictAnalyzerDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.scheduleMicrotask =
      deps.scheduleMicrotask ?? ((fn) => queueMicrotask(fn));
    this.countConflicts = deps.countConflicts;
    this.computeSha = deps.computeSha ?? calculateGitBlobSHA;
  }

  // The latest conflict model (null before the first recompute).
  getModel(): ConflictModel | null {
    return this.model;
  }

  // The commit pass's "unchanged?" reference for a file with a conflict
  // record (owner, 2026-10-12), read from the model in memory — the caller
  // refresh()es first. While the conflict is in force: its conflict-branch
  // version (conflictBase.sha; null = the branch records a deletion). Once
  // it is not (copies gone / equal to the base / only duplicates left):
  // undefined, so the file is compared with its baseline like any other and
  // a resolution made through the file system is sent in the same sync. A
  // record whose copy is not written yet (siblings == []) stays in force.
  conflictBaseShaFor(path: string): string | null | undefined {
    const entry = this.store.getCachedState().entries.get(path);
    if (entry === undefined) return undefined;
    if (entry.siblings.length === 0) return entry.conflictBase.sha;
    return this.model?.entries.get(path)?.inForce ? entry.conflictBase.sha : undefined;
  }

  // O(1). Sets the dirty flag (for the model recompute) AND the
  // sweep-requested flag (for drain). Schedules at most one debounced
  // recompute via the microtask scheduler. Back-to-back calls
  // coalesce into one scheduled callback.
  invalidate(): void {
    this.dirty = true;
    this.sweepRequested = true;
    if (this.scheduled || this.currentRun !== null) return;
    this.scheduled = true;
    this.scheduleMicrotask(() => {
      this.scheduled = false;
      void this.runIfDirty();
    });
  }

  // Drain-side companion to invalidate(). Atomically reads the sweep-
  // requested flag AND clears it. The drain calls this at the top of
  // each cycle:
  //
  //   if (store.records.length > 0 && counter.consumeSweepRequest()) {
  //     await evaluateConflictState(...)
  //   }
  //
  // Returns true:
  //   - on first call after construction (initial state forces sweep)
  //   - after any invalidate() since the previous consumeSweepRequest
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
  filesInConflict(): number {
    return this.cachedValue;
  }

  // Subscribe to count changes. Callback fires after each recompute
  // IF and only if the new value differs from the previous cache.
  // Returns an unsubscribe function.
  subscribe(callback: ModelChangeCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // "Recompute NOW and let me wait" (owner, 2026-10-12) — with or without a
  // prior invalidate(): whoever needs a fresh picture to ACT on (commit,
  // drain, the pre-sync gates) calls just this. Bypasses the microtask
  // debounce; loops until quiescent so invalidate() calls landing during a
  // recompute are picked up.
  async refresh(): Promise<void> {
    this.dirty = true;
    this.sweepRequested = true;
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
      const signature = this.signatureOf(this.model);
      // Subscribers hear a change of the PICTURE, not only of the number:
      // one of two copies resolved leaves the count at 1, but the panel
      // and the editor-tab cleaner must still react.
      const changed = newCount !== this.cachedValue || signature !== this.modelSignature;
      this.cachedValue = newCount;
      this.modelSignature = signature;
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
    // TODO #7 — an optional hook to count EXACTLY what the diff-panel lists
    // (tracked + synthetic). ⚠️ NOT wired in main.ts: the badge / status bar /
    // menu count TRACKED files only — the store walk below is what runs.
    if (this.countConflicts) return this.countConflicts();
    // FILES IN CONFLICT, not conflict copies (owner, 2026-10-09): the badge
    // says how many files are kept from the server until resolved — now as
    // the conflict model sees them (owner, 2026-10-12): a file counts while
    // it has a LIVE tracked copy, i.e. on disk and different from its base.
    // A copy deleted or made equal to the base by hand stops counting as
    // soon as a recompute sees it; the drain then prunes the ledger.
    this.model = await buildConflictModel(
      { adapter: this.vault.adapter as never, computeSha: this.computeSha },
      this.store.getCachedState(),
      [],
    );
    return this.model.filesInConflict;
  }

  private signatureOf(model: ConflictModel | null): string {
    if (model === null) return "";
    const parts: string[] = [];
    for (const e of model.entries.values()) {
      for (const c of e.copies) parts.push(`${c.path}=${c.state}`);
    }
    return parts.sort().join("\n");
  }
}
