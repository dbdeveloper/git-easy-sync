// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// "ASK AGAIN ABOUT THESE PATHS" — the note a drain leaves for the next
// one (owner, 2026-10-02: «краще зайвий раз перепитати ніж щось
// пропустити»).
//
// THE PROBLEM IT SOLVES. Discovery answers with the delta between two
// commits. When a path is SKIPPED — the Vault-step could not write it,
// or a staged self-update turned out to be corrupt — the drain still
// finishes, and `lastSyncCommitSha` still advances past the commit
// that carried the change. From then on the path is invisible: the
// local file matches its baseline (correctly — nothing was applied),
// and the remote change sits behind the base where no future delta
// will mention it. The file simply stays old, silently, until some
// later commit happens to touch it again.
//
// Leaving a note costs one tiny write on a path that already went
// wrong, and the next drain asks the server about those paths
// DIRECTLY (`getContentsMetadataAtRef`) instead of waiting for a delta
// that will never name them.
//
// ⚠️ The file is a MARKER by this project's convention: dot-prefixed,
// no extension, in `.runtime/` (per-device, never synced). It carries
// JSON, which the convention explicitly allows — what makes a file a
// marker is what it DECIDES, not how much it says.

import type { DataAdapter } from "obsidian";

export const RECHECK_PATHS_MARKER = ".recheck-paths";

// Our own loadable files. The fallback set when the note itself cannot
// be read: bounded, cheap, and covering the case the mechanism was
// built for.
const SELF_FILES = ["main.js", "manifest.json", "styles.css"];

export function recheckMarkerPath(pluginDir: string): string {
  return `${pluginDir}/.runtime/${RECHECK_PATHS_MARKER}`;
}

export interface RecheckRequest {
  paths: string[];
  // True when a note existed but could not be read as a path list.
  torn: boolean;
}

// MERGES with whatever is already there. Two writers reach this file —
// the drain's skip sites and the bootloader's integrity check — and a
// request from one must never erase the other's (the precedent is
// `remotePending` in the gitignore migration: "a forced run can
// precede the consuming drain").
export async function addRecheckPaths(
  adapter: DataAdapter,
  pluginDir: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const file = recheckMarkerPath(pluginDir);
  const existing = await readRecheckPaths(adapter, pluginDir, pluginDir);
  const merged = [...new Set([...existing.paths, ...paths])].sort();
  try {
    await adapter.write(file, JSON.stringify(merged));
  } catch {
    // Best-effort by design: failing to leave a note must never fail
    // the drain that was already recovering from something else.
  }
}

// `selfPluginDir` is used only to build the fallback list, so the
// caller does not have to know which files are ours.
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
    return { paths: [], torn: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return {
        paths: parsed.filter((p): p is string => typeof p === "string"),
        torn: false,
      };
    }
  } catch {
    // fall through
  }
  // ⚠️ A torn note is NOT discarded. Dropping it is the fail-silent
  // direction — exactly what this file exists to prevent — so we fall
  // back to asking about our OWN files, which is the case that
  // motivated the mechanism and is bounded to three paths.
  return {
    paths: SELF_FILES.map((f) => `${selfPluginDir}/${f}`),
    torn: true,
  };
}

// Remove ONE path from the note — the shape the epilogue needs, since
// a drain that consumed a request must not wipe a request the
// bootloader added while it was running.
export async function dropRecheckPath(
  adapter: DataAdapter,
  pluginDir: string,
  pathToDrop: string,
): Promise<void> {
  const current = await readRecheckPaths(adapter, pluginDir, pluginDir);
  if (current.torn) return; // the fallback list is not a real note
  const left = current.paths.filter((p) => p !== pathToDrop);
  if (left.length === current.paths.length) return;
  try {
    if (left.length === 0) {
      await clearRecheckPaths(adapter, pluginDir);
    } else {
      await adapter.write(recheckMarkerPath(pluginDir), JSON.stringify(left));
    }
  } catch {
    // Best-effort: a note that survives costs one redundant question.
  }
}

// Cleared only by a drain that FINISHED. A run that aborts leaves the
// note alive, and the next one asks again — the same "the record goes
// last" discipline the plugin hold follows.
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
