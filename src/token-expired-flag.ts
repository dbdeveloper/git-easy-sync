// E1 — persistent ".token_expired" marker (TODO.md §5 / DIFF2 R2.7.3.a).
//
// A file under the plugin's own dir (`<configDir>/plugins/<id>/.token_expired`)
// that records the LAST KNOWN auth state, so Settings and the status-bar menu
// (§7) can show "Token expired" with NO live network check and NO events. The
// marker is gitignored by the seeded `plugins/*/*` block (like `.conflicts/`),
// so this device-local auth state never syncs to GitHub.
//
// The IN-MEMORY flag is authoritative; the file is a best-effort mirror:
//   - init() seeds the in-memory flag from disk once at onload.
//   - set()/clear() update the in-memory flag SYNCHRONOUSLY (so the §7 menu can
//     read it synchronously while building) and fire-and-forget the file write.
// This sidesteps any set/clear write race — readers trust memory, not the file.
//
// Set on a confirmed AuthError (401/403). Once set it is a STICKY LATCH (TODO
// §35): a later successful DRAIN/sync call does NOT clear it. A token that just
// 401'd stays expired until the user acts, and an eventually-consistent success
// must never unlatch it. There are exactly TWO clear paths, both deliberate
// user actions in settings/tab.ts:
//   (a) editing one of the three "Remote Repository" fields — token / owner /
//       repo (owner/repo count because pointing at a different remote is a
//       reconfiguration too);
//   (b) a SUCCESSFUL "Test connection" probe — the one live re-check that is
//       independent of the marker; in practice it only succeeds (and thus
//       clears) once the token actually works, else it 401s and re-sets.
// A non-auth failure (offline, 404, 422) leaves it unchanged (offline ≠ expired).

import { normalizePath, type Vault } from "obsidian";
import { AuthError } from "./errors";

// Pure mapping for the per-drain outcome — the one wiring bit a unit test can
// pin (the call SITES live in untestable main.ts). Only an AuthError latches the
// marker; SUCCESS (null/undefined) DOES NOT clear it (§35 sticky latch — the
// clear path is a Remote-Repository settings edit, not a later successful call).
export type AuthOutcome = "set" | "noop";

export function classifyAuthOutcome(err: unknown): AuthOutcome {
  if (err instanceof AuthError) return "set";
  return "noop";
}

export class TokenExpiredFlag {
  private readonly runtimeDir: string;
  private readonly path: string;
  // Authoritative in-memory state; the file mirrors it best-effort.
  private expired = false;

  constructor(
    private readonly vault: Vault,
    pluginDir: string,
  ) {
    this.runtimeDir = normalizePath(`${pluginDir}/.runtime`);
    this.path = normalizePath(`${this.runtimeDir}/token_expired`);
  }

  // Seed the in-memory flag from disk. Call once at onload (one exists()).
  async init(): Promise<void> {
    try {
      this.expired = await this.vault.adapter.exists(this.path);
    } catch {
      this.expired = false; // unreadable → assume OK; a real auth fail re-sets
    }
  }

  // Synchronous in-memory authority for the §7 menu (built inside a click).
  isExpiredCached(): boolean {
    return this.expired;
  }

  // Fresh on-disk read (Settings may want truth independent of this session).
  async isExpired(): Promise<boolean> {
    try {
      return await this.vault.adapter.exists(this.path);
    } catch {
      return this.expired;
    }
  }

  set(): void {
    if (this.expired) return; // already set — skip the write churn
    this.expired = true;
    void this.write(true);
  }

  clear(): void {
    if (!this.expired) return;
    this.expired = false;
    void this.write(false);
  }

  // Apply a per-drain / per-probe auth outcome. Only latches on an AuthError;
  // a success (null/undefined) is deliberately NOT a clear (§35 sticky latch —
  // clearing is a Remote-Repository settings edit, see settings/tab.ts).
  note(err: unknown): void {
    if (classifyAuthOutcome(err) === "set") this.set();
  }

  private async write(on: boolean): Promise<void> {
    try {
      if (on) {
        if (!(await this.vault.adapter.exists(this.runtimeDir))) {
          await this.vault.adapter.mkdir(this.runtimeDir);
        }
        await this.vault.adapter.write(this.path, new Date().toISOString());
      } else if (await this.vault.adapter.exists(this.path)) {
        await this.vault.adapter.remove(this.path);
      }
    } catch {
      // Best-effort mirror — the in-memory flag is authoritative, so a failed
      // write just means the marker won't survive a restart; not load-bearing.
    }
  }
}
