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
// ⚠ Phase 1 boundary (recorded in METAFILE §4): the record keeps
// TODAY's slot shape `{mtime, hash}` per managed file. The richer
// DOT-FILES §3.1.3 form ({mtime,size,blockSha,blockLen}, keyed by
// path) is dot-space BEHAVIOR — it arrives with that workstream, not
// with the storage move.

import { normalizePath, type Vault } from "obsidian";

export interface InvariantFileState {
  mtime: number;
  hash: string;
}

export interface Sync2InvariantState {
  configDirGitignore?: InvariantFileState;
  selfPluginGitignore?: InvariantFileState;
  // Root <vault>/.gitignore — managed to forcibly hide conflict-
  // sibling files from sync. Same shape as the other two:
  // mtime+hash cache, splice-on-edit invariant block.
  rootGitignore?: InvariantFileState;
}

function sanitize(raw: unknown): Sync2InvariantState {
  const out: Sync2InvariantState = {};
  if (typeof raw !== "object" || raw === null) return out;
  const slots: Array<keyof Sync2InvariantState> = [
    "configDirGitignore",
    "selfPluginGitignore",
    "rootGitignore",
  ];
  for (const slot of slots) {
    const v = (raw as Record<string, unknown>)[slot] as
      | Partial<InvariantFileState>
      | undefined;
    if (
      v &&
      typeof v === "object" &&
      typeof v.mtime === "number" &&
      typeof v.hash === "string"
    ) {
      out[slot] = { mtime: v.mtime, hash: v.hash };
    }
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

  // Mutate one slot and persist the whole (tiny) record with a plain
  // write — see the header for why no staging is needed here.
  async set(
    slot: keyof Sync2InvariantState,
    value: InvariantFileState,
  ): Promise<void> {
    this.state = { ...this.state, [slot]: value };
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
