// Network retry — ONE helper instead of five hand-rolled loops
// (NEW-DRAIN §II.10). Phase 2 primitive; every network site of the
// new drain (§III) and both getBlobFromRepo calls inside _diff3 go
// through it in Phase 4.
//
// Retries WITH exponential backoff ONLY NetworkError. Every other
// error (AuthError/TOKEN_EXPIRED, 422/ValidationError, ...) returns
// immediately — the layer that owns that error class (422-CAP, the
// token latch) stays external and unchanged.
//
// The `.runtime/sync_network_error` mark is the user-facing trace:
// written when attempts are exhausted (ribbon turns red, settings
// show the reason + "retry when the network is back"), removed ONCE
// per run on the FIRST successful network call — not on run start
// (that would lie "network is fine" before the first real attempt),
// and not on every success (pointless FS writes).
//
// One instance = one run scope (a drain / a syncAll), same ownership
// rule as sync-store's verifiedShas: the clear-once state must die
// with the run that earned it.

import { normalizePath, type Vault } from "obsidian";
import { NetworkError } from "../errors";

export const NETWORK_ERROR_MARK_NAME = "sync_network_error";

export function networkErrorMarkPath(
  vault: Vault,
  selfPluginId: string,
): string {
  return normalizePath(
    `${vault.configDir}/plugins/${selfPluginId}/.runtime/${NETWORK_ERROR_MARK_NAME}`,
  );
}

export async function hasNetworkErrorMark(
  vault: Vault,
  selfPluginId: string,
): Promise<boolean> {
  return vault.adapter.exists(networkErrorMarkPath(vault, selfPluginId));
}

export interface NetworkRetryDeps {
  vault: Vault;
  selfPluginId: string;
  // Owner decision 2026-08-23: same order of magnitude as the 422 cap.
  maxAttempts?: number; // default 5
  baseDelayMs?: number; // default 1000 → 1s, 2s, 4s, 8s (~15 s total)
  // Injectable so tests don't sleep real seconds.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type RetryOutcome<T> =
  | { result: T; error: null }
  | { result: null; error: unknown };

export default class NetworkRetry {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  // Clear-once-per-run latch (see header).
  private clearedThisRun = false;

  constructor(deps: NetworkRetryDeps) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.maxAttempts = deps.maxAttempts ?? 5;
    this.baseDelayMs = deps.baseDelayMs ?? 1000;
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  // op may throw NetworkError (retried), or anything else (returned
  // immediately). Returns (result, error) — error null on success.
  async run<T>(op: () => Promise<T>): Promise<RetryOutcome<T>> {
    let attempt = 0;
    for (;;) {
      try {
        const result = await op();
        await this.markNetworkRecoveredIfNeeded();
        return { result, error: null };
      } catch (e) {
        if (!(e instanceof NetworkError)) {
          return { result: null, error: e }; // not this helper's concern
        }
        attempt += 1;
        if (attempt >= this.maxAttempts) {
          await this.writeNetworkErrorMark(e);
          return { result: null, error: e };
        }
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  private async markNetworkRecoveredIfNeeded(): Promise<void> {
    if (this.clearedThisRun) return;
    this.clearedThisRun = true;
    const p = networkErrorMarkPath(this.vault, this.selfPluginId);
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }

  private async writeNetworkErrorMark(e: NetworkError): Promise<void> {
    const p = networkErrorMarkPath(this.vault, this.selfPluginId);
    const dir = p.slice(0, p.lastIndexOf("/"));
    let acc = "";
    for (const part of dir.split("/")) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
    await this.vault.adapter.write(
      p,
      JSON.stringify({ message: e.message, at: this.now() }),
    );
  }
}
