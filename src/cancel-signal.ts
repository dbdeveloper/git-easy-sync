// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// ONE cancel signal for a sync (owner, 2026-10-11). "Cancel sync" did
// nothing for minutes: a 127 MB upload was being retried six times with
// growing pauses, and the cancel checks sat only between the drain's own
// steps. The owner had asked for a cancel exit from EVERY loop. The drain's
// step loops read `cancelRequested`; the loops below them — the GitHub
// client's retries (retryUntil), the drain's retries (NetworkRetry) and a
// request in flight (WorkerClient → the network worker's fetch) — listen
// to this object.
//
// cancel(): sets the flag and wakes every waiter (a pause in progress ends
// at once). reset(): re-arms it at the start of the next sync.

import { CancelledError } from "./errors";

export class CancelSignal {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  reset(): void {
    this.cancelled = false;
  }

  // Called once if cancel() happens while subscribed. Returns unsubscribe.
  onCancel(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError();
  }

  // A pause that ends early on cancel (the caller checks isCancelled).
  sleep(ms: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const off = this.onCancel(done);
      function done(): void {
        clearTimeout(t);
        off();
        resolve();
      }
    });
  }
}
