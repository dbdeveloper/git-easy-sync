// RESET-PLUGIN core (SYNC2-RESET-PLUGIN.md, Phase 1.6).
//
// D1: reset destroys the whole `.runtime/` directory — not per-store
// API cleanup — so every current AND future runtime artifact dies
// without being individually remembered here. D4 (reversed by the
// owner, 2026-08-30): the vault is NOT touched — `*.conflict-from-*`
// sibling files stay in place; a later re-enable picks them up as
// synthetic conflicts.
//
// O6 crash protocol (owner's final design): reset STARTS by writing
// `<configDir>/plugins/<id>/.reset-in-progress` — TOP-LEVEL in the
// plugin dir, dot-prefixed — and the marker dies LAST, after the
// settings (data.json) cleanup, so it covers the WHOLE reset. Why
// top-level is safe despite the 2026-07-03 BRAT reload-loop history
// (autosave-store.ts): the leading dot hides the file from Obsidian's
// index/watcher, and the self-plugin gitignore is an allowlist
// (`*` + !main.js/!manifest.json/!styles.css/!.gitignore), so sync
// can never pick it up. Living OUTSIDE `.runtime/` also collapses the
// wipe to a single recursive rmdir — no ordering games.
//
// Onload: a surviving marker means an interrupted reset the user had
// already confirmed — the caller (main.ts, BEFORE any store loads and
// BEFORE the token latch is constructed) replays the tail:
// wipe → settings = DEFAULTS → removeResetMarker.
//
// O4: reset creates NOTHING — every store re-creates its directories
// lazily on first write.

import { normalizePath, type Vault } from "obsidian";

export const RESET_MARKER_NAME = ".reset-in-progress";

function pluginDir(vault: Vault, selfPluginId: string): string {
  return normalizePath(`${vault.configDir}/plugins/${selfPluginId}`);
}

function runtimeDir(vault: Vault, selfPluginId: string): string {
  return normalizePath(`${pluginDir(vault, selfPluginId)}/.runtime`);
}

function markerPath(vault: Vault, selfPluginId: string): string {
  return normalizePath(
    `${pluginDir(vault, selfPluginId)}/${RESET_MARKER_NAME}`,
  );
}

export async function hasResetMarker(
  vault: Vault,
  selfPluginId: string,
): Promise<boolean> {
  return vault.adapter.exists(markerPath(vault, selfPluginId));
}

async function writeResetMarker(
  vault: Vault,
  selfPluginId: string,
): Promise<void> {
  // The plugin dir always exists in production (our own code runs
  // from it); the segment walk covers tests.
  const dir = pluginDir(vault, selfPluginId);
  let acc = "";
  for (const part of dir.split("/")) {
    acc = acc === "" ? part : `${acc}/${part}`;
    if (!(await vault.adapter.exists(acc))) await vault.adapter.mkdir(acc);
  }
  await vault.adapter.write(markerPath(vault, selfPluginId), "");
}

// D1 wipe: one recursive rmdir. Idempotent — a missing dir is fine.
export async function wipeRuntimeDir(
  vault: Vault,
  selfPluginId: string,
): Promise<void> {
  const dir = runtimeDir(vault, selfPluginId);
  if (!(await vault.adapter.exists(dir))) return;
  await vault.adapter.rmdir(dir, true);
}

// The LAST step of reset, called only after the settings (data.json)
// cleanup. Idempotent.
export async function removeResetMarker(
  vault: Vault,
  selfPluginId: string,
): Promise<void> {
  const marker = markerPath(vault, selfPluginId);
  if (await vault.adapter.exists(marker)) {
    await vault.adapter.remove(marker);
  }
}

export interface ResetDeps {
  vault: Vault;
  selfPluginId: string;
  // O3 (owner decision): a running drain is CANCELLED, not waited out
  // passively and not a reason to refuse — the user already confirmed
  // the stop. `.runtime/` is never wiped under a live drain.
  cancelDrain(): void;
  isDrainRunning(): boolean;
  // In-memory re-initialization of every store that caches runtime
  // state (hot metadata, baselines cache, invariant state, conflict
  // index, pending deletions, conflict counter). Runs AFTER the wipe;
  // without it, write-through would resurrect pre-reset ghosts from
  // RAM — the spec §1's original motivating bug.
  reinitStores(): Promise<void>;
}

export type ResetOutcome = "done" | "drain-stuck";

// The runtime half of reset (O2/O6 order): drain guard → marker →
// wipe → in-memory re-init. The caller owns the rest, IN THIS ORDER:
// token-latch clear → settings = DEFAULTS → removeResetMarker (dies
// last) → scheduler restart.
export async function resetRuntimeState(
  deps: ResetDeps,
  opts?: { drainWaitMs?: number; pollMs?: number },
): Promise<ResetOutcome> {
  const drainWaitMs = opts?.drainWaitMs ?? 60_000;
  const pollMs = opts?.pollMs ?? 200;

  if (deps.isDrainRunning()) {
    deps.cancelDrain();
    const deadline = Date.now() + drainWaitMs;
    while (deps.isDrainRunning()) {
      if (Date.now() > deadline) return "drain-stuck";
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  await writeResetMarker(deps.vault, deps.selfPluginId);
  await wipeRuntimeDir(deps.vault, deps.selfPluginId);
  await deps.reinitStores();
  return "done";
}
