// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Seed markers for the managed .gitignore files (DOT-FILES §8.0).
//
// THE PROBLEM. `enforce()` writes the managed .gitignore files before
// any sync has happened, so on a cold start the local file meets the
// repo's own .gitignore with NO common ancestor. Rule 4.2 then reads
// our own write as a user edit made offline and raises a MANUAL
// CONFLICT the user never caused — measured twice on real GitHub.
//
// THE MARKER. A file whose content is byte-identical to what WE seed
// is not user content; it is our proposal. Recording its sha lets the
// drain treat that content as the BASE for one path — the "fake
// ancestor" — so the repo's version reads as an ordinary edit on top
// of it (rule 4.3, a clean pull). The next enforce() splices our block
// into the adopted file and it travels back as a normal local change.
//
// WHY A MARKER RATHER THAN COMPARING AGAINST THE CONSTANT:
//   - it survives restarts (we may seed on load and sync days later);
//   - it records the bytes we ACTUALLY wrote, so a plugin upgrade that
//     changes the canonical block doesn't invalidate the claim;
//   - its ABSENCE is meaningful and free: a .gitignore that existed
//     before us is simply unmarked, and takes the ordinary path with
//     no special-casing anywhere.
//
// LIFECYCLE — recomputed on every enforce pass, per managed file:
//   content == our canonical seed → set(path, sha)
//   anything else                 → clear(path)
// So a user edit (which enforce deliberately does NOT overwrite
// outside our block) drops the claim on the very next pass, and the
// path reverts to ordinary rules — including a legitimate conflict.
//
// NOT MARKED, deliberately: <configDir>/plugins/<self>/.gitignore.
// That file is a CONSTANT the plugin owns outright (owner, 2026-09-20:
// "будь-які його зміни повинні відкидатись і замінюватись нашим
// константним значенням") — it never adopts a remote version, so it
// has nothing to negotiate and needs no ancestor.
//
// Storage model mirrors invariant-state.ts: a PLAIN write into
// `.runtime/`, no atomic protocol. Losing or corrupting this file
// costs at most one manufactured conflict on a first sync, never data
// — and a torn read degrades to "no markers", which is the
// conservative direction (ordinary rules, nothing silently adopted).

import { normalizePath, type Vault } from "obsidian";

const SEEDS_FILE = "gitignore-seeds.json";

export interface GitignoreSeedsDeps {
  vault: Vault;
  selfPluginId: string;
}

export default class GitignoreSeedStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private seeds = new Map<string, string>();

  constructor(deps: GitignoreSeedsDeps) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
  }

  private filePath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${SEEDS_FILE}`,
    );
  }

  async load(): Promise<void> {
    this.seeds = new Map();
    const p = this.filePath();
    try {
      if (!(await this.vault.adapter.exists(p))) return;
      const raw = JSON.parse(await this.vault.adapter.read(p)) as unknown;
      if (typeof raw !== "object" || raw === null) return;
      for (const [path, sha] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        if (typeof sha === "string" && sha.length > 0) {
          this.seeds.set(path, sha);
        }
      }
    } catch {
      // Corrupt/torn → no markers. The conservative direction: every
      // path takes the ordinary rules and nothing is silently adopted.
      this.seeds = new Map();
    }
  }

  // The recorded sha for a path, or undefined when the path carries no
  // claim. `undefined` is the normal state for every file we did not
  // write ourselves.
  get(path: string): string | undefined {
    return this.seeds.get(path);
  }

  // True iff this exact content is one we seeded — the question the
  // drain actually asks.
  matches(path: string, sha: string | null): boolean {
    return sha !== null && this.seeds.get(path) === sha;
  }

  async set(path: string, sha: string): Promise<void> {
    if (this.seeds.get(path) === sha) return; // idempotent, no write
    this.seeds.set(path, sha);
    await this.persist();
  }

  async clear(path: string): Promise<void> {
    if (!this.seeds.has(path)) return;
    this.seeds.delete(path);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const dir = normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime`,
    );
    if (!(await this.vault.adapter.exists(dir))) {
      let acc = "";
      for (const part of dir.split("/")) {
        acc = acc === "" ? part : `${acc}/${part}`;
        if (!(await this.vault.adapter.exists(acc))) {
          await this.vault.adapter.mkdir(acc);
        }
      }
    }
    const obj: Record<string, string> = {};
    for (const [k, v] of this.seeds) obj[k] = v;
    await this.vault.adapter.write(this.filePath(), JSON.stringify(obj));
  }
}
