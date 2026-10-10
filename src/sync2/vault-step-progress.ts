// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// THE PROGRESS LOG — what a drain has ALREADY settled with the repo, one
// line per path (SYNC2-NEW-DRAIN §II.19, owner 2026-10-10).
//
// THE PROBLEM IT SOLVES. Baselines (each file's common base with the
// repo) are written by the drain's epilogue only. Any exit before it —
// cancel, network drop, an expired token, a dead battery — leaves the
// files the run had already pulled, deleted or pushed without baselines,
// and the next commit pass (it runs BEFORE the drain and knows no
// journal) takes them for local additions: a spare commit of identical
// content and a full re-hash. Correctness does not depend on this file
// (§IV.2 row 7a covers it); cost and noise do.
//
// NOT A COPY OF THE JOURNAL — only the change of one field: "for this
// path the common base is now this remote version, and it is on disk".
//
// ⚠️ AFTER, NEVER BEFORE. A line is appended only once the vault write /
// removal has finished (or the push is confirmed). A line written ahead
// of the write would claim "X on disk" while the old A is still there,
// and a merge against base X would read A as "the user reverted X" —
// silent loss. A crash between the write and the line loses one line,
// which costs one spare commit and nothing else.
//
// ⚠️ NEVER REPLAYED AFTER A NEWER BASELINE WRITE. A stale line would roll
// a base back (P=X over P=Z). Replay therefore runs FIRST — before the
// commit pass and before the drain — and the epilogue deletes the file
// right after it has written every baseline itself.
//
// FORMAT — JSONL, appended, never rewritten: a torn append damages only
// its own (newline-less) last line, which is ignored.

import type { DataAdapter } from "obsidian";

export const PROGRESS_FILE = "vault-step-progress.jsonl";

export type ProgressRecord =
  | { path: string; sha: string; size: number }
  | { path: string; deleted: true };

export interface ProgressBaselines {
  getMany(
    paths: string[],
  ): Promise<Map<string, { baselineSha: string; mtime: number; size: number }>>;
  setMany(
    entries: Array<{ path: string; baselineSha: string; mtime: number; size: number }>,
  ): Promise<void>;
  removeMany(paths: string[]): Promise<void>;
}

export function progressFilePath(pluginDir: string): string {
  return `${pluginDir}/.runtime/${PROGRESS_FILE}`;
}

// mtime 0 is for a baseline whose sha CHANGES (D.15: a live stat taken
// after a write could swallow an edit made in between). A baseline that
// already carries the very sha being written describes content the
// change detector proved at that {mtime, size}; any later edit moves the
// mtime off it, so keeping the pair cannot hide one. The size is kept
// too: the writer's own may be the honest-0 fallback, and {proven mtime,
// 0} would never short-circuit (owner's field report, 2026-10-10).
export async function keepProvenStats(
  baselines: Pick<ProgressBaselines, "getMany">,
  writes: Array<{ path: string; baselineSha: string; mtime: number; size: number }>,
): Promise<void> {
  if (writes.length === 0) return;
  const existing = await baselines.getMany(writes.map((w) => w.path));
  for (const w of writes) {
    const old = existing.get(w.path);
    if (old === undefined || old.baselineSha !== w.baselineSha) continue;
    w.mtime = old.mtime;
    w.size = old.size;
  }
}

async function ensureRuntimeDir(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<void> {
  const dir = `${pluginDir}/.runtime`;
  if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
}

// Best-effort: a lost line costs one spare commit, never correctness, so
// a failing append must not fail the drain that is mid-work.
// `dirKnown`: the caller has already seen `.runtime/` exist this run —
// one `exists` round trip less per pulled file on a phone.
export async function appendProgress(
  adapter: DataAdapter,
  pluginDir: string,
  records: ProgressRecord[],
  dirKnown = false,
): Promise<boolean> {
  if (records.length === 0) return dirKnown;
  const payload = records.map((r) => `${JSON.stringify(r)}\n`).join("");
  try {
    if (!dirKnown) await ensureRuntimeDir(adapter, pluginDir);
    await adapter.append(progressFilePath(pluginDir), payload);
    return true;
  } catch {
    // see above
    return false;
  }
}

// Read → apply to the baselines → delete. Idempotent: a crash between
// applying and deleting replays the same lines to the same result.
// Returns how many complete lines were applied.
export async function replayProgress(
  adapter: DataAdapter,
  pluginDir: string,
  baselines: ProgressBaselines,
): Promise<number> {
  const file = progressFilePath(pluginDir);
  if (!(await adapter.exists(file))) return 0;
  const raw = await adapter.read(file);
  // ONLY COMPLETE LINES — a torn append has no trailing newline.
  const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
  const last = new Map<string, ProgressRecord>(); // the last line wins
  let applied = 0;
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue;
    let rec: ProgressRecord;
    try {
      rec = JSON.parse(line) as ProgressRecord;
    } catch {
      continue; // a damaged line is a lost line, nothing worse
    }
    if (typeof rec?.path !== "string") continue;
    last.delete(rec.path); // keep insertion order = order of the last write
    last.set(rec.path, rec);
    applied++;
  }
  const writes: Array<{ path: string; baselineSha: string; mtime: number; size: number }> = [];
  const removals: string[] = [];
  for (const rec of last.values()) {
    if ("deleted" in rec) removals.push(rec.path);
    else writes.push({ path: rec.path, baselineSha: rec.sha, mtime: 0, size: rec.size });
  }
  await keepProvenStats(baselines, writes);
  if (writes.length > 0) await baselines.setMany(writes);
  if (removals.length > 0) await baselines.removeMany(removals);
  await adapter.remove(file);
  return applied;
}

export async function clearProgress(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<void> {
  const file = progressFilePath(pluginDir);
  if (await adapter.exists(file)) await adapter.remove(file);
}
