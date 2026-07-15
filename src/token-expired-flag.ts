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

// §35 — the two auth-failure classes GitHub actually lets us distinguish. We
// CANNOT tell "expired" from "wrong token" (both are 401 "Bad credentials"),
// but 401 vs 403 are genuinely different problems with different fixes, so the
// marker records which one so the Settings "sync status" card + the recovery
// modal explain what happened — the same text at occurrence and after a reload.
//   • "invalid" — 401: token invalid / expired / revoked / mistyped → new token.
//   • "scope"   — 403: token valid but lacks the required permissions → re-scope.
// This tag is what the marker FILE stores (so it survives a plugin reload); a
// legacy marker (old ISO-timestamp content) or an unreadable one defaults to
// "invalid", the common case.
export type TokenExpiredKind = "invalid" | "scope";

// The AuthError → kind mapping (or null when the error is not an auth failure).
// The one wiring bit a unit test can pin (the call SITES live in untestable
// main.ts). Only an AuthError latches the marker; SUCCESS returns null and thus
// does NOT clear it (§35 sticky latch — clearing is a settings edit / probe).
export function authErrorKind(err: unknown): TokenExpiredKind | null {
  if (!(err instanceof AuthError)) return null;
  return err.status === 403 ? "scope" : "invalid";
}

// The user-facing, actionable message for each class. One place so the Settings
// card and the modal stay in lockstep.
export function tokenExpiredMessage(kind: TokenExpiredKind): string {
  return kind === "scope"
    ? "GitHub token lacks the required permissions (Contents: Read+Write, " +
        "Metadata: Read). Update the token's scope or generate a new one in the " +
        "Remote Repository settings to resume syncing."
    : "GitHub token is invalid or expired. Set a new token in the Remote " +
        "Repository settings to resume syncing.";
}

export class TokenExpiredFlag {
  private readonly runtimeDir: string;
  private readonly path: string;
  // Authoritative in-memory state; the file mirrors it best-effort.
  private expired = false;
  // Which auth-failure class the latch represents. Meaningful only while
  // `expired`; seeded from the file at init() so it survives a reload.
  private kind: TokenExpiredKind = "invalid";

  constructor(
    private readonly vault: Vault,
    pluginDir: string,
  ) {
    this.runtimeDir = normalizePath(`${pluginDir}/.runtime`);
    this.path = normalizePath(`${this.runtimeDir}/token_expired`);
  }

  // Seed the in-memory flag + kind from disk. Call once at onload. The file
  // CONTENT is the kind tag ("invalid" / "scope"); a legacy marker (old ISO
  // timestamp) or any other content falls back to "invalid" (the common case).
  async init(): Promise<void> {
    try {
      this.expired = await this.vault.adapter.exists(this.path);
      if (this.expired) {
        const raw = (await this.vault.adapter.read(this.path)).trim();
        this.kind = raw === "scope" ? "scope" : "invalid";
      }
    } catch {
      this.expired = false; // unreadable → assume OK; a real auth fail re-sets
    }
  }

  // Synchronous in-memory authority for the §7 menu (built inside a click).
  isExpiredCached(): boolean {
    return this.expired;
  }

  // The current auth-failure class (only meaningful while expired). Drives the
  // Settings card + modal message.
  getKind(): TokenExpiredKind {
    return this.kind;
  }

  // Fresh on-disk read (Settings may want truth independent of this session).
  async isExpired(): Promise<boolean> {
    try {
      return await this.vault.adapter.exists(this.path);
    } catch {
      return this.expired;
    }
  }

  // Latch the marker with its class. Re-writes when the CLASS changes (401→403)
  // even if already latched, so the persisted message stays truthful.
  set(kind: TokenExpiredKind = "invalid"): void {
    if (this.expired && this.kind === kind) return; // same state — skip churn
    this.expired = true;
    this.kind = kind;
    void this.write(kind);
  }

  clear(): void {
    if (!this.expired) return;
    this.expired = false;
    void this.write(null);
  }

  // Apply a per-drain / per-probe auth outcome. Only latches on an AuthError
  // (with its 401/403 class); a success (null/undefined) is deliberately NOT a
  // clear (§35 sticky latch — clearing is a settings edit / probe).
  note(err: unknown): void {
    const kind = authErrorKind(err);
    if (kind) this.set(kind);
  }

  // File content = the kind tag (null → remove the marker).
  private async write(kind: TokenExpiredKind | null): Promise<void> {
    try {
      if (kind) {
        if (!(await this.vault.adapter.exists(this.runtimeDir))) {
          await this.vault.adapter.mkdir(this.runtimeDir);
        }
        await this.vault.adapter.write(this.path, kind);
      } else if (await this.vault.adapter.exists(this.path)) {
        await this.vault.adapter.remove(this.path);
      }
    } catch {
      // Best-effort mirror — the in-memory flag is authoritative, so a failed
      // write just means the marker won't survive a restart; not load-bearing.
    }
  }
}
