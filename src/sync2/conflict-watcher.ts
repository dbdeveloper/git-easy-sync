// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, TAbstractFile, EventRef } from "obsidian";
import ConflictStoreV2 from "./conflict-store-v2";
import { ConflictCounter } from "./conflict-counter";

// ConflictWatcher. Subscribes to `vault.on('delete' | 'modify' |
// 'rename')` and, on each event, runs an O(1) fast-path check
// — is the touched path in conflicts.json (v2 cached view) as a base
// path OR a tracked sibling's derived disk name? If yes, calls
// `counter.markDirty()`. If no (99% of real vault traffic), bails
// out immediately.
//
// The watcher is READ-ONLY: it does NOT mutate the store, does NOT
// call evaluateConflictState, does NOT delete files. All resolution
// happens at drain-start (the single point of state mutation
// described in docs/PSEUDO-MERGE-MODE.md §5). The watcher's only
// job is to keep the UI counter reactive — when the user deletes a
// sibling, the badge updates before the next [Sync] click.
//
// The strict separation prevents the mid-drain races that arise when
// the same listener mutates state the drain is also writing.

export interface ConflictWatcherDeps {
  vault: Vault;
  store: ConflictStoreV2;
  counter: ConflictCounter;
}

export class ConflictWatcher {
  private readonly vault: Vault;
  private readonly store: ConflictStoreV2;
  private readonly counter: ConflictCounter;
  private refs: EventRef[] = [];

  constructor(deps: ConflictWatcherDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.counter = deps.counter;
  }

  // Register vault listeners. Idempotent — calling start() twice
  // does NOT register duplicate handlers. Call this once at plugin
  // onload after the store has been loaded.
  start(): void {
    if (this.refs.length > 0) return;
    this.refs.push(
      this.vault.on("delete", (file: TAbstractFile) => {
        this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("modify", (file: TAbstractFile) => {
        this.handle(file.path);
      }),
    );
    this.refs.push(
      this.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Both the new and old paths might be relevant: oldPath was a
        // sibling/base before the rename; the new path becomes one if
        // the user renamed sibling content onto base.
        this.handle(file.path);
        if (oldPath !== file.path) this.handle(oldPath);
      }),
    );
  }

  // Unsubscribe from vault events. Called from plugin onunload.
  stop(): void {
    for (const ref of this.refs) {
      this.vault.offref(ref);
    }
    this.refs = [];
  }

  // Manually trigger handling for a path. Public for tests + for
  // callers that want to force a counter refresh without going
  // through the vault event dispatcher. O(1) — just the fast-path
  // Set check plus a counter.markDirty() call (which is itself
  // O(1) — sets a flag, schedules a debounced recompute).
  handle(path: string): void {
    if (!this.isRelevant(path)) return;
    this.counter.markDirty();
  }

  // O(1) fast-path: is `path` either a base file with a live conflict entry, a
  // TRACKED sibling's derived disk name, OR a `*.conflict-from-*` sibling the
  // store does NOT know about (a SYNTHETIC conflict — TODO #7)? The store checks
  // use the v2 cached view's indexes; the synthetic check is a cheap substring
  // on the name. The substring fallback is ALSO the reason the sibling index's
  // mid-drain staleness window is harmless — do not remove it. Without the
  // synthetic check, creating/deleting a synthetic sibling (e.g. the user moves
  // a conflict pair into a new folder, or deletes a synthetic sibling) would not
  // re-fire the counter, leaving the badge stale vs the diff-panel.
  private isRelevant(path: string): boolean {
    return (
      this.store.hasBase(path) ||
      this.store.hasSiblingPath(path) ||
      path.includes(".conflict-from-")
    );
  }
}
