// Drain journal — the persisted drain-in-progress state (NEW-DRAIN §V):
// 2-slot ping-pong pair `.runtime/tracked-files-{a,b}.json`, the SAME
// protocol as hot-metadata.ts / cursor-store (monotonic seq, the
// max-seq slot is NEVER written, target+seq derived from DISK on
// every write). Deliberately mirrored, not extracted into a shared
// base class — the two stores diverge in payload validation, and the
// invariant comments must live next to the code they guard.
//
// ONE blob bundles TrackedFiles + conflicts + conflictBranchName
// (owner decision 2026-08-23): they must be read back mutually
// consistent (METAFILE §2.1.2 grouping rule). head_hash /
// conflict_head_hash are NOT persisted — always re-read live (§II.7).
// Written once per COMPLETED batch ("BATCH ОБРОБЛЕНО!"), not per file;
// deleted by the epilogue when a drain fully completes (Phase 6) —
// a journal on disk at drain start means the previous run died
// mid-way, and its state seeds the restart.
//
// Blobs are NEVER serialized — bytes live in the content-addressed
// sync_store; the journal carries shas only. That is also what makes
// it the sweep's source №3 (§12.5): collectReferencedShas() returns
// every sha the interrupted drain still leans on — downloaded theirs,
// diff3 intermediates ("ours became theirs"), conflict bases — so the
// start-of-drain sweep can never reap work a previous attempt already
// paid for. The schema requirement exists NOW even though the sweep
// itself is wired at the Phase 5.5 cutover.

import { normalizePath, type Vault } from "obsidian";
import { DELETED, FileInfo, emptyFileInfo } from "./diff3";

export interface TrackedFile {
  base: FileInfo;
  remote: FileInfo;
  isManualConflict: boolean;
}

// §II.6 conflict record — the durable half arrives in Phase 5; the
// journal carries the shape from day one so the schema never forks.
export interface ConflictEntry {
  conflictBase: FileInfo;
  siblings: FileInfo[];
}

export interface DrainState {
  trackedFiles: Map<string, TrackedFile>;
  conflicts: Map<string, ConflictEntry>;
  conflictBranchName: string | null;
}

export function emptyDrainState(): DrainState {
  return {
    trackedFiles: new Map(),
    conflicts: new Map(),
    conflictBranchName: null,
  };
}

type Slot = "a" | "b";

// FileInfo → JSON without the blob (and back, blob always null).
// Exported: the durable conflict store v2 (Phase 5) serializes the
// SAME FileInfo/ConflictEntry shapes — one codec, no forked formats.
export function fileInfoToJson(f: FileInfo): Record<string, unknown> {
  return {
    path: f.path,
    size: f.size,
    mtime: f.mtime,
    sha: f.sha,
    mode: f.mode,
    deviceLabel: f.deviceLabel,
  };
}

export function fileInfoFromJson(raw: unknown): FileInfo {
  const out = emptyFileInfo();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.path === "string") out.path = r.path;
  if (typeof r.size === "number") out.size = r.size;
  if (typeof r.mtime === "number") out.mtime = r.mtime;
  if (typeof r.sha === "string") out.sha = r.sha;
  if (r.mode === "" || r.mode === DELETED) out.mode = r.mode;
  if (typeof r.deviceLabel === "string") out.deviceLabel = r.deviceLabel;
  return out;
}

export default class DrainJournal {
  private readonly vault: Vault;
  private readonly selfPluginId: string;

  constructor(deps: { vault: Vault; selfPluginId: string }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
  }

  private slotPath(slot: Slot): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/tracked-files-${slot}.json`,
    );
  }

  private async readSlot(
    slot: Slot,
  ): Promise<{ seq: number; state: DrainState } | null> {
    const p = this.slotPath(slot);
    if (!(await this.vault.adapter.exists(p))) return null;
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as Record<
        string,
        unknown
      >;
      if (typeof raw !== "object" || raw === null) return null;
      if (typeof raw.seq !== "number") return null;
      const state = emptyDrainState();
      if (typeof raw.conflictBranchName === "string") {
        state.conflictBranchName = raw.conflictBranchName;
      }
      if (raw.trackedFiles && typeof raw.trackedFiles === "object") {
        for (const [path, rec] of Object.entries(
          raw.trackedFiles as Record<string, unknown>,
        )) {
          if (typeof rec !== "object" || rec === null) continue;
          const r = rec as Record<string, unknown>;
          state.trackedFiles.set(path, {
            base: fileInfoFromJson(r.base),
            remote: fileInfoFromJson(r.remote),
            isManualConflict: r.isManualConflict === true,
          });
        }
      }
      if (raw.conflicts && typeof raw.conflicts === "object") {
        for (const [path, rec] of Object.entries(
          raw.conflicts as Record<string, unknown>,
        )) {
          if (typeof rec !== "object" || rec === null) continue;
          const r = rec as Record<string, unknown>;
          state.conflicts.set(path, {
            conflictBase: fileInfoFromJson(r.conflictBase),
            siblings: Array.isArray(r.siblings)
              ? r.siblings.map(fileInfoFromJson)
              : [],
          });
        }
      }
      return { seq: raw.seq, state };
    } catch {
      return null; // corrupt / torn → this slot loses
    }
  }

  // null = no (valid) journal on disk — a fresh drain, not a resumed
  // one. The caller starts from empty state + durable stores.
  async load(): Promise<DrainState | null> {
    const a = await this.readSlot("a");
    const b = await this.readSlot("b");
    const best = a === null ? b : b === null ? a : a.seq >= b.seq ? a : b;
    return best === null ? null : best.state;
  }

  // One ping-pong write per completed batch. Target + next seq from
  // DISK, never memory (same §2.1 invariant as hot-metadata — the
  // max-seq slot is the recovery fallback and is never overwritten).
  async persist(state: DrainState): Promise<void> {
    const a = await this.readSlot("a");
    const b = await this.readSlot("b");
    const seqA = a === null ? -1 : a.seq;
    const seqB = b === null ? -1 : b.seq;
    const nextSeq = Math.max(seqA, seqB) + 1;
    const target: Slot = seqA <= seqB ? "a" : "b";

    const trackedFiles: Record<string, unknown> = {};
    for (const [path, t] of state.trackedFiles) {
      trackedFiles[path] = {
        base: fileInfoToJson(t.base),
        remote: fileInfoToJson(t.remote),
        isManualConflict: t.isManualConflict,
      };
    }
    const conflicts: Record<string, unknown> = {};
    for (const [path, c] of state.conflicts) {
      conflicts[path] = {
        conflictBase: fileInfoToJson(c.conflictBase),
        siblings: c.siblings.map(fileInfoToJson),
      };
    }

    await this.ensureRuntimeDir();
    await this.vault.adapter.write(
      this.slotPath(target),
      JSON.stringify({
        seq: nextSeq,
        conflictBranchName: state.conflictBranchName,
        trackedFiles,
        conflicts,
      }),
    );
  }

  // Epilogue step 4 (Phase 6): a completed drain removes the journal —
  // its absence is what tells the next run "previous drain finished".
  async clear(): Promise<void> {
    for (const slot of ["a", "b"] as const) {
      const p = this.slotPath(slot);
      if (await this.vault.adapter.exists(p)) {
        await this.vault.adapter.remove(p);
      }
    }
  }

  // Sweep source №3 (§12.5): every sha the persisted drain state
  // still references. Includes bases ("ours became theirs"), remotes
  // (downloaded theirs / diff3 intermediates now sitting in
  // tracked.remote) and conflict bases + sibling shas.
  async collectReferencedShas(): Promise<Set<string>> {
    const state = await this.load();
    const out = new Set<string>();
    if (state === null) return out;
    const add = (f: FileInfo): void => {
      if (f.sha !== null) out.add(f.sha);
    };
    for (const t of state.trackedFiles.values()) {
      add(t.base);
      add(t.remote);
    }
    for (const c of state.conflicts.values()) {
      add(c.conflictBase);
      for (const s of c.siblings) add(s);
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
