// Conflict store v2 — the DURABLE home of manual conflicts
// (NEW-DRAIN §II.6/§III; MASTER-PLAN Фаза 5 крок 1). One file,
// `.runtime/conflicts.json` (a DATA file — no dot prefix, §2.2 п.4):
//
//   {
//     lastSiblingTxGuid: string | null,   // §II.11 — guid of the LAST
//                                          // SUCCESSFULLY COMMITTED
//                                          // STEP3 replace-transaction
//     conflicts: { "<base path>": { conflictBase, siblings: [...] } }
//   }
//
// This is NOT the old conflict-store.ts (773 lines, ConflictRecord
// shape) — that one keeps serving the live engine until the Phase 5.5
// cutover, when src/diff2/ ports here and v1 dies with the old drain.
//
// Semantics carried by the shape (§III process_conflicts contract):
// - `conflictBase` is the conflict-branch half — recoverable only
//   from the network, NEVER re-derived from an FS scan; whoever
//   rewrites an entry must carry it through verbatim.
// - `siblings` is an APPEND-ORDERED list (never a set, never
//   re-sorted): `last(siblings)` is what STEP3 works with, precisely
//   because it was appended last. An empty list is a LEGAL state
//   distinct from "no record" (a fresh STEP1 record whose STEP3
//   hasn't run yet) — it must keep blocking FINALIZE.
// - Blobs are never serialized (same codec as the drain journal —
//   shared, so the two formats can't fork).
//
// Load semantics: missing file → empty state (first run). A corrupt
// file also reads as empty — LOUDLY: the siblings half re-derives
// from the FS scan (process_conflicts), but conflictBase does not,
// so this is a real degradation the log must witness, not hide.
// atomicWriteFile's temp+rename makes the window rare (no torn JSON),
// not impossible (§II.11 — no fsync exists on this platform).

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import {
  ConflictEntry,
  fileInfoFromJson,
  fileInfoToJson,
} from "./drain-journal";
import type { FileInfo } from "./diff3";
import { buildSiblingFilePath } from "./conflict-siblings";

export const CONFLICTS_FILE = "conflicts.json";

export interface ConflictsState {
  entries: Map<string, ConflictEntry>;
  // §II.11: participates in the STEP3 replace-transaction recovery —
  // compared against the tx mark's guid to tell "did step 3 commit?".
  lastSiblingTxGuid: string | null;
}

export function emptyConflictsState(): ConflictsState {
  return { entries: new Map(), lastSiblingTxGuid: null };
}

export default class ConflictStoreV2 {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly logger:
    | { warn(message: string, data?: unknown): void }
    | undefined;

  // ── cached view (Phase 5.5 step 3a — the diff2 port's SYNC read
  // surface). `cachedState` is the SAME object the last load()
  // returned / save() received — the drain mutates its Map in place,
  // so `hasBase` tracks live mutations for free. The derived-name
  // sibling index, by contrast, is rebuilt only on load()/save(); a
  // mid-drain staleness window is deliberate and harmless for the one
  // hot consumer (ConflictWatcher.isRelevant): its
  // `.conflict-from-` substring fallback catches any sibling path
  // regardless of store state — do NOT "fix" that fallback away.
  private cachedState: ConflictsState = emptyConflictsState();
  private siblingPathIndex = new Map<
    string,
    { basePath: string; sibling: FileInfo }
  >();

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    logger?: { warn(message: string, data?: unknown): void };
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.logger = deps.logger;
  }

  private rebuildCache(state: ConflictsState): void {
    this.cachedState = state;
    this.siblingPathIndex = new Map();
    for (const [basePath, entry] of state.entries) {
      for (const sibling of entry.siblings) {
        this.siblingPathIndex.set(
          buildSiblingFilePath(basePath, sibling.mtime ?? 0, sibling.deviceLabel),
          { basePath, sibling },
        );
      }
    }
  }

  // The last loaded/saved state. UI readers (counter default formula,
  // panel refresh paths) treat it as read-only; all mutations flow
  // through the drain / process_conflicts, which save().
  getCachedState(): ConflictsState {
    return this.cachedState;
  }

  // O(1): does this base path carry a live conflict entry? (An entry
  // with siblings==[] is STILL a conflict — I.7.)
  hasBase(path: string): boolean {
    return this.cachedState.entries.has(path);
  }

  // O(1): is this vault path a TRACKED sibling's derived disk name?
  hasSiblingPath(path: string): boolean {
    return this.siblingPathIndex.has(path);
  }

  // Tracked-sibling lookup by disk name — the synthetic-detector's
  // tracked/synthetic discriminator. null = not tracked (synthetic).
  getBySiblingPath(
    siblingPath: string,
  ): { basePath: string; sibling: FileInfo } | null {
    return this.siblingPathIndex.get(siblingPath) ?? null;
  }

  private filePath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${CONFLICTS_FILE}`,
    );
  }

  async load(): Promise<ConflictsState> {
    const p = this.filePath();
    if (!(await this.vault.adapter.exists(p))) {
      const state = emptyConflictsState();
      this.rebuildCache(state);
      return state;
    }
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as Record<
        string,
        unknown
      >;
      if (typeof raw !== "object" || raw === null) {
        throw new Error("not an object");
      }
      const state = emptyConflictsState();
      if (typeof raw.lastSiblingTxGuid === "string") {
        state.lastSiblingTxGuid = raw.lastSiblingTxGuid;
      }
      if (raw.conflicts && typeof raw.conflicts === "object") {
        for (const [path, rec] of Object.entries(
          raw.conflicts as Record<string, unknown>,
        )) {
          if (typeof rec !== "object" || rec === null) continue;
          const r = rec as Record<string, unknown>;
          state.entries.set(path, {
            conflictBase: fileInfoFromJson(r.conflictBase),
            siblings: Array.isArray(r.siblings)
              ? r.siblings.map(fileInfoFromJson)
              : [],
          });
        }
      }
      this.rebuildCache(state);
      return state;
    } catch (e) {
      // conflictBase is network-borne and NOT re-derivable from disk —
      // losing it is a real degradation, so it never passes silently.
      this.logger?.warn(
        "conflict-store-v2: corrupt conflicts.json — starting empty; " +
          "sibling files on disk will re-enter as synthetic via the scan",
        { error: String(e) },
      );
      const state = emptyConflictsState();
      this.rebuildCache(state);
      return state;
    }
  }

  async save(state: ConflictsState): Promise<void> {
    this.rebuildCache(state); // save is the in-drain rebuild point
    const conflicts: Record<string, unknown> = {};
    for (const [path, c] of state.entries) {
      conflicts[path] = {
        conflictBase: fileInfoToJson(c.conflictBase),
        siblings: c.siblings.map(fileInfoToJson),
      };
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        lastSiblingTxGuid: state.lastSiblingTxGuid,
        conflicts,
      }),
    );
    await this.ensureRuntimeDir();
    await atomicWriteFile(
      this.vault,
      this.filePath(),
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
  }

  // Sweep source №4 (§12.5.D): while a conflict lives, its
  // conflictBase blob must NEVER be reaped — it is the diff3 ancestor
  // for every future STEP3 fold and is only refetchable while the
  // conflict branch still exists.
  async collectReferencedShas(): Promise<Set<string>> {
    const state = await this.load();
    const out = new Set<string>();
    for (const c of state.entries.values()) {
      if (c.conflictBase.sha !== null) out.add(c.conflictBase.sha);
      for (const s of c.siblings) {
        if (s.sha !== null) out.add(s.sha);
      }
    }
    return out;
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
