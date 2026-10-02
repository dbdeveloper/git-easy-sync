// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// "ASK AGAIN ABOUT THESE PATHS" — the note one drain leaves for the
// next (owner, 2026-10-02: «краще зайвий раз перепитати ніж щось
// пропустити»).
//
// THE PROBLEM IT SOLVES. Discovery answers with the delta between two
// commits. When a path is SKIPPED — the Vault-step could not write it,
// or a staged self-update failed its integrity check — the drain still
// finishes and `lastSyncCommitSha` still advances past the commit that
// carried the change. From then on the path is invisible: the local
// file matches its baseline (correctly — nothing was applied), and the
// remote change sits behind the base where no future delta will name
// it. The file stays old, silently, until some later commit happens to
// touch it.
//
// ⚠️ WRITE-AHEAD, NOT WRITE-AFTER (owner, 2026-10-02). The note is
// written BEFORE the drain moves on from the skip, never at the end of
// the run. Written afterwards it would have a window of its own: a run
// that reached its epilogue, advanced the pointer, and then failed to
// write the note would forget the skip forever. Recording the intent
// first and clearing it once the work is confirmed is the same
// discipline the self-update marker and the gitignore migration
// already follow here.
//
// IT CANNOT MAKE ANYTHING WORSE THAN ITS OWN ABSENCE. Nothing in this
// file writes to the vault, deletes anything, or pushes. Its only
// effect is "ask the server one more question", so every failure mode
// degrades in one direction: we forget to ask, which is exactly the
// state before the mechanism existed.
//
// FORMAT — one path per LINE, not a JSON array, and that is a
// durability decision rather than a style one:
//   - adding is an APPEND: no read-modify-write, so a concurrent
//     writer cannot be clobbered and a torn add cannot corrupt what is
//     already recorded;
//   - a torn append leaves a fragment with NO trailing newline, and
//     only complete lines are read — so the fragment is ignored rather
//     than mistaken for a path;
//   - removing a consumed path is the one rewrite, and it goes through
//     tmp → rename so the file is never half-replaced.
//
// The file is a MARKER by this project's convention: dot-prefixed, no
// extension, in `.runtime/` (per-device, never synced).

import type { DataAdapter } from "obsidian";

export const RECHECK_PATHS_MARKER = ".recheck-paths";
// ⚠️ NOT `.ges-tmp`: that suffix belongs to AtomicWriteRecovery.sweep,
// which walks the whole vault and would adopt our staging file as its
// own business. Two recovery mechanisms reaching for one file is how
// both end up wrong.
const REWRITE_SUFFIX = ".rewriting";

// Our own loadable files — the fallback when the note cannot be read
// at all: bounded, cheap, and covering the case that motivated this.
const SELF_FILES = ["main.js", "manifest.json", "styles.css"];

export function recheckMarkerPath(pluginDir: string): string {
  return `${pluginDir}/.runtime/${RECHECK_PATHS_MARKER}`;
}

export interface RecheckRequest {
  paths: string[];
  // True when a note existed but could not be read at all.
  torn: boolean;
}

async function ensureRuntimeDir(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<void> {
  const dir = `${pluginDir}/.runtime`;
  try {
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  } catch {
    // best-effort
  }
}

// APPEND, deliberately. No read, no rewrite: a second writer cannot be
// clobbered, and a torn append damages only its own line.
export async function addRecheckPaths(
  adapter: DataAdapter,
  pluginDir: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  await ensureRuntimeDir(adapter, pluginDir);
  const file = recheckMarkerPath(pluginDir);
  const payload = paths.map((p) => `${p}\n`).join("");
  try {
    if (typeof adapter.append === "function") {
      await adapter.append(file, payload);
      return;
    }
  } catch {
    // fall through to the read-modify-write below
  }
  // A runtime without `append` still gets a working note; it only
  // loses the clobber-resistance.
  try {
    const existing = (await adapter.exists(file))
      ? await adapter.read(file)
      : "";
    await adapter.write(file, existing + payload);
  } catch {
    // Best-effort by design: failing to leave a note must never fail
    // the drain that was already recovering from something else.
  }
}

export async function readRecheckPaths(
  adapter: DataAdapter,
  pluginDir: string,
  selfPluginDir: string,
): Promise<RecheckRequest> {
  const file = recheckMarkerPath(pluginDir);
  let raw: string;
  try {
    if (!(await adapter.exists(file))) return { paths: [], torn: false };
    raw = await adapter.read(file);
  } catch {
    // ⚠️ Unreadable is NOT "nothing owed". Dropping it silently is the
    // fail-silent direction this note exists to prevent, so fall back
    // to our own files — bounded to three paths, and the case the
    // mechanism was built for.
    return {
      paths: SELF_FILES.map((f) => `${selfPluginDir}/${f}`),
      torn: true,
    };
  }
  // ⚠️ ONLY COMPLETE LINES. A torn append leaves a fragment with no
  // trailing newline; reading it would mean asking about a path that
  // was never written. The fragment is dropped instead — the one
  // request it represents is lost, which is the mechanism's own
  // worst case and not a corruption.
  const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
  const paths = [
    ...new Set(
      complete
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    ),
  ];
  return { paths, torn: false };
}

// Remove ONE path — the shape the caller needs, because a drain that
// consumed a request must not wipe a request another writer added
// while it was running.
//
// The only rewrite in this file, so it is the only place that needs
// tmp → rename: the note must never be found half-replaced.
export async function dropRecheckPath(
  adapter: DataAdapter,
  pluginDir: string,
  pathToDrop: string,
): Promise<void> {
  const current = await readRecheckPaths(adapter, pluginDir, pluginDir);
  if (current.torn) return; // the fallback list is not a real note
  const left = current.paths.filter((p) => p !== pathToDrop);
  if (left.length === current.paths.length) return;
  const file = recheckMarkerPath(pluginDir);
  try {
    if (left.length === 0) {
      await clearRecheckPaths(adapter, pluginDir);
      return;
    }
    const tmp = `${file}${REWRITE_SUFFIX}`;
    await adapter.write(tmp, left.map((p) => `${p}\n`).join(""));
    // Capacitor refuses an existing destination; POSIX overwrites
    // atomically. The refusal — not a platform check — selects the
    // fallback, exactly as the self-update swap does.
    try {
      await adapter.rename(tmp, file);
    } catch {
      await adapter.remove(file);
      await adapter.rename(tmp, file);
    }
  } catch {
    // Best-effort: a note that survives costs one redundant question.
  }
}

export async function clearRecheckPaths(
  adapter: DataAdapter,
  pluginDir: string,
): Promise<void> {
  const file = recheckMarkerPath(pluginDir);
  try {
    if (await adapter.exists(file)) await adapter.remove(file);
  } catch {
    // Best-effort: a note that survives costs one redundant question.
  }
}
