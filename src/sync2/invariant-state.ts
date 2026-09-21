// Freshness markers for the managed .gitignore files — own file in
// .runtime/ (METAFILE-REFACTOR §1.B; owner decision 2026-08-02).
//
// This is neither hot (not a global sync parameter) nor cold (not a
// per-file baseline): it is per-device bookkeeping whose source of
// truth is the LOCAL DISK, not GitHub. Losing it costs one extra full
// GitignoreInvariants.enforce() pass — never data. That recovery
// model is why the write is a PLAIN adapter.write (DOT-FILES §3.1.2):
// a torn write reads as corrupt → treated as empty → the next enforce
// re-derives everything by re-hashing the real files.
//
// SHAPE (DOT-FILES §3.1.2, since 2026-09-21): a map keyed by
// VAULT-RELATIVE PATH, not three fixed slots. The set of managed files
// is variable — third-party `plugins/*/.gitignore` appear and vanish
// with their plugins — so the old
// `configDirGitignore`/`selfPluginGitignore`/`rootGitignore` triple
// could not express it. Consequences, all deliberate:
//   (a) records for vanished files are REMOVED (see remove());
//   (b) a newly-appeared foreign .gitignore is simply an absent record,
//       i.e. the full read+splice+write path — no special case;
//   (c) there is no migration from the old shape. An on-disk file in the
//       three-slot form fails sanitize() and reads as empty, which is
//       exactly the store's documented degraded mode: one extra pass.
//
// Each record carries a fingerprint PER SECTION, measured over that
// section's body WITHOUT its markers. Two jobs at once:
//   - freshness: "is what we last wrote still what we want to write?"
//     `mtime`+`size` only answer "did anyone touch the FILE?", and they
//     cannot see a plugin upgrade that changed the constant while the
//     file on disk sat untouched (§3.1.3);
//   - repair anchor: when a marker is orphaned, `len` locates the old
//     body's span and `sha` confirms it really is ours.
// A section that should not exist in a given file (no `invariants` in
// configDir; no `final` in a foreign plugin at syncConfigDir=ON) is
// simply absent from the record.
//
// ⚠️ `len` is in UTF-8 BYTES. Our own generated content is ASCII since
// 2026-09-21, but the user's content next to it is not, and the unit has
// to be pinned independently of what the constant currently holds.

import { normalizePath, type Vault } from "obsidian";

// One managed section's fingerprint. `sha` is a git blob SHA over the
// body bytes; `len` is that body's UTF-8 byte length. They travel
// together: calculateGitBlobSHA binds the length into its preimage
// (`blob <len>\0`), so `len` cannot be forged apart from `sha`.
export interface SectionFingerprint {
  sha: string;
  len: number;
}

export type SectionId = "invariants" | "final";

export interface InvariantFileState {
  mtime: number;
  size: number;
  invariants?: SectionFingerprint;
  final?: SectionFingerprint;
}

// path (vault-relative) → record.
export type Sync2InvariantState = Record<string, InvariantFileState>;

function sanitizeFingerprint(raw: unknown): SectionFingerprint | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = raw as Partial<SectionFingerprint>;
  if (typeof v.sha !== "string" || typeof v.len !== "number") return undefined;
  return { sha: v.sha, len: v.len };
}

function sanitize(raw: unknown): Sync2InvariantState {
  const out: Sync2InvariantState = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Partial<InvariantFileState>;
    if (typeof v.mtime !== "number" || typeof v.size !== "number") continue;
    const rec: InvariantFileState = { mtime: v.mtime, size: v.size };
    const invariants = sanitizeFingerprint(v.invariants);
    if (invariants) rec.invariants = invariants;
    const final = sanitizeFingerprint(v.final);
    if (final) rec.final = final;
    out[path] = rec;
  }
  return out;
}

export default class InvariantStateStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private state: Sync2InvariantState = {};

  constructor(deps: { vault: Vault; selfPluginId: string }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
  }

  private filePath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/gitignore-invariants.json`,
    );
  }

  // Missing or corrupt file → empty state → the next enforce() pass
  // re-derives it from the real files (the accepted degraded mode).
  async load(): Promise<void> {
    const p = this.filePath();
    if (!(await this.vault.adapter.exists(p))) {
      this.state = {};
      return;
    }
    try {
      this.state = sanitize(JSON.parse(await this.vault.adapter.read(p)));
    } catch {
      this.state = {};
    }
  }

  get(): Sync2InvariantState {
    return this.state;
  }

  // Record for one managed file, or undefined when we have never
  // brought that file to canonical (a fresh install, a newly-appeared
  // foreign plugin, or a state file we could not read).
  getFor(path: string): InvariantFileState | undefined {
    return this.state[path];
  }

  // Mutate one path's record and persist the whole (tiny) record with a
  // plain write — see the header for why no staging is needed here.
  async set(path: string, value: InvariantFileState): Promise<void> {
    this.state = { ...this.state, [path]: value };
    await this.persist();
  }

  // Drop the record for a file that is gone from disk. The restore pass
  // calls this for a foreign plugin that was uninstalled: we do not
  // recreate its .gitignore, so keeping a fingerprint for it would be a
  // claim about a file that no longer exists.
  async remove(path: string): Promise<void> {
    if (!(path in this.state)) return;
    const next = { ...this.state };
    delete next[path];
    this.state = next;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.ensureRuntimeDir();
    await this.vault.adapter.write(this.filePath(), JSON.stringify(this.state));
  }

  private async ensureRuntimeDir(): Promise<void> {
    const dir = normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime`,
    );
    if (await this.vault.adapter.exists(dir)) return;
    let acc = "";
    for (const part of dir.split("/")) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }
}
