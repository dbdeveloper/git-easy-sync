// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The conflict model (owner, 2026-10-12): ONE read-only picture of the
// conflicts, built from the drain's ledger (conflicts.json) plus the disk —
// the ground truth of what the user did since the last drain. Every reader
// (badge, status bar, panel, pre-sync gates, editor tabs, the commit pass)
// reads it; nothing in it is ever written back — only the drain changes the
// ledger.
//
// Per copy:
//   live        — on disk, differs from the base, not a duplicate;
//   gone        — not on disk (deleted, renamed away). The ledger keeps it
//                 until the drain, and the user may still put it back;
//   equals-base — byte-equal to the base: that conflict is resolved;
//   duplicate   — same bytes as a copy that survives. The survivor is the
//                 drain's choice (process_conflicts 2.2): tracked beats
//                 synthetic, then the newer timeLabel.
// A base is IN FORCE while it has a live TRACKED copy; synthetic copies show,
// but never keep a tracked conflict alive.
//
// Cost: every copy is stat'ed; a sha is needed only where equality is
// possible — a copy of the base's CURRENT size, or of another copy's size.
// A tracked copy whose size+mtime still match its record uses the record's
// sha (the content cache the drain keeps); anything else is read once. The
// base is hashed lazily, at most once. Raw bytes, like the drain.

import { buildSiblingFilePath } from "./conflict-siblings";
import { FileInfo } from "./diff3";
import { baseFacts, type ConflictLiveDeps } from "./conflict-live";

export type CopyState = "live" | "gone" | "equals-base" | "duplicate";

export interface ModelCopy {
  path: string; // the copy's path on disk
  kind: "tracked" | "synthetic";
  timeLabel: number;
  state: CopyState;
  duplicateOf?: string; // the surviving copy's path
}

export interface ModelEntry {
  basePath: string;
  copies: ModelCopy[];
  inForce: boolean;
}

export interface ConflictModel {
  entries: Map<string, ModelEntry>;
  filesInConflict: number; // bases in force — the badge's number
}

export interface SyntheticCopy {
  path: string;
  basePath: string;
  timeLabel: number;
}

interface Measured {
  copy: ModelCopy;
  record: FileInfo | null;
  size: number | null; // null = gone
  mtime: number | null;
  sha: string | null;
}

export async function buildConflictModel(
  deps: ConflictLiveDeps,
  ledger: { entries: Map<string, { siblings: FileInfo[] }> },
  synthetic: SyntheticCopy[],
): Promise<ConflictModel> {
  const bases = new Set<string>([...ledger.entries.keys(), ...synthetic.map((s) => s.basePath)]);
  const entries = new Map<string, ModelEntry>();
  let filesInConflict = 0;

  for (const basePath of bases) {
    const base = await baseFacts(deps, basePath);
    const measured: Measured[] = [];
    for (const f of ledger.entries.get(basePath)?.siblings ?? []) {
      const p = buildSiblingFilePath(basePath, f.timeLabel ?? 0, f.deviceLabel);
      measured.push(await measure(deps, p, "tracked", f.timeLabel ?? 0, f));
    }
    for (const s of synthetic) {
      if (s.basePath !== basePath) continue;
      if (measured.some((m) => m.copy.path === s.path)) continue; // tracked already
      measured.push(await measure(deps, s.path, "synthetic", s.timeLabel, null));
    }

    const present = measured.filter((m) => m.size !== null);
    // A sha only where equality is possible: the base's size, or a size
    // another present copy shares.
    const sizes = new Map<number, number>();
    for (const m of present) sizes.set(m.size!, (sizes.get(m.size!) ?? 0) + 1);
    for (const m of present) {
      const needed = m.size === base.size || (sizes.get(m.size!) ?? 0) > 1;
      if (!needed) continue;
      const r = m.record;
      m.sha =
        r !== null && r.sha !== null && r.size === m.size && r.mtime === m.mtime
          ? r.sha
          : await deps.computeSha(await deps.adapter.readBinary(m.copy.path));
    }

    for (const m of measured) {
      if (m.size === null) m.copy.state = "gone";
      else if (m.size === base.size && m.sha !== null && m.sha === (await base.sha())) {
        m.copy.state = "equals-base";
      }
    }

    // Duplicates among what is still live, by the drain's ranking.
    const bySha = new Map<string, Measured[]>();
    for (const m of measured) {
      if (m.copy.state !== "live" || m.sha === null) continue;
      bySha.set(m.sha, [...(bySha.get(m.sha) ?? []), m]);
    }
    for (const group of bySha.values()) {
      if (group.length < 2) continue;
      const pool = group.some((m) => m.copy.kind === "tracked")
        ? group.filter((m) => m.copy.kind === "tracked")
        : group;
      const survivor = pool.reduce((a, b) => (b.copy.timeLabel > a.copy.timeLabel ? b : a));
      for (const m of group) {
        if (m === survivor) continue;
        m.copy.state = "duplicate";
        m.copy.duplicateOf = survivor.copy.path;
      }
    }

    const inForce = measured.some((m) => m.copy.kind === "tracked" && m.copy.state === "live");
    if (inForce) filesInConflict++;
    entries.set(basePath, { basePath, copies: measured.map((m) => m.copy), inForce });
  }
  return { entries, filesInConflict };
}

async function measure(
  deps: ConflictLiveDeps,
  path: string,
  kind: "tracked" | "synthetic",
  timeLabel: number,
  record: FileInfo | null,
): Promise<Measured> {
  const st = await deps.adapter.stat(path);
  return {
    copy: { path, kind, timeLabel, state: "live" },
    record,
    size: st === null ? null : st.size,
    mtime: st === null ? null : st.mtime,
    sha: null,
  };
}
