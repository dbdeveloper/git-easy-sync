// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// 2.0.2-beta2 self-update bootloader. The first code that runs at the
// top of our plugin's onload(), before logger, settings, or anything
// else. Recovers a pending self-update for any of:
//
//   - main.js        (running code, atomic-swap target)
//   - manifest.json  (plugin metadata Obsidian reads on enable)
//   - styles.css     (CSS Obsidian re-applies on enable)
//
// data.json is intentionally OUT OF SCOPE: it's per-device state we
// never pull from remote, so it has no recovery to do.
//
// CORRECTNESS NOTE — why marker file, not SHA comparison
// ────────────────────────────────────────────────────────
// The bootloader runs BEFORE the snapshot store loads, so it has no
// "ground truth" SHA to verify a ges-tmp file's integrity against.
// SHA(ges-tmp) computed at startup is just the hash of whatever
// bytes happen to be on disk — if the write was interrupted, those
// bytes are partial and the SHA is meaningless. A previous draft of
// this bootloader compared SHA(file) to SHA(ges-tmp) and applied
// when they differed; that incorrectly applied corrupted bytes when
// ges-tmp was partial.
//
// The fix: a separate marker file `.<basename>.<ext>.ges-tmp.` is
// written by the drain ONLY AFTER the ges-tmp write fully
// completes. The bootloader uses MARKER PRESENCE as the integrity
// signal:
//
//   marker present + ges-tmp present  →  ges-tmp is verified complete,
//                                          apply forward (Case A)
//   marker present + ges-tmp absent   →  swap completed before crash,
//                                          remove orphan marker (Case B)
//   marker absent  + ges-tmp present  →  write was incomplete OR
//                                          marker write never landed;
//                                          drop ges-tmp (Case C).
//                                          Next sync re-pulls.
//   marker absent  + ges-tmp absent   →  nothing pending (Case D)
//
// The marker filename shape `.<basename>.<ext>.ges-tmp.` matches
// the modify-in-place marker convention from PSEUDO-MERGE-MODE
// §19.1. This is intentional: the existing AtomicWriteRecovery.sweep
// (which runs LATER in onload, at initSync2 time) already handles
// markers via its modify-in-place recovery branch. So the sweep
// provides a free defense-in-depth layer — if the bootloader is
// somehow bypassed (e.g., a code bug at the very top of main()
// causes onload to fall through), the sweep catches the same case.

import type { DataAdapter } from "obsidian";
import { addRecheckPaths } from "./recheck-paths";
import { pluginUpdatedText, readPluginVersion } from "./plugin-js";
import { recordSelfUpdateApplied } from "./self-update-applied";

// Files in our plugin's directory the bootloader recovers. Each gets
// the same 4-case marker logic. data.json is excluded — we don't
// sync it from remote, so there's no pending-update concept for it.
const SELF_UPDATE_FILES = ["main.js", "manifest.json", "styles.css"];

export interface BootloaderDeps {
  // Git-blob SHA of the given bytes. OPTIONAL by design: this runs at
  // the very top of onload, and a composition that cannot hash must
  // still be able to apply — a wiring gap here would otherwise stop
  // every self-update silently. Absent → the marker degrades to the
  // presence-only signal it was before 2026-10-02.
  computeSha?: (bytes: ArrayBuffer) => Promise<string>;
  // Keep `<file>.ges-bak` after a successful apply. Default false —
  // the backup is scaffolding, and leaving it would put a stale copy
  // of our own code in the plugin folder forever. Set on the ONE
  // platform where the swap window cannot be closed, so a user whose
  // phone died mid-swap has something to rename back.
  keepBackup?: boolean;
  adapter: DataAdapter;
  pluginDir: string; // e.g. ".obsidian/plugins/git-easy-sync"
  // Closure that invokes app.plugins.reloadPlugin(<self id>). Wrapped
  // so tests can capture the call without touching Obsidian's
  // internal API and so the bootloader stays platform-agnostic.
  reloadPlugin: () => void;
  // Optional. Surfaces `Plugin "<label>" updated` so the user sees
  // SOMETHING happen before the reload fires. Always our own plugin —
  // the label names it (e.g. "git-easy-sync"), matching the
  // sibling-plugin reload notice in main.ts.
  notice?: (msg: string, durationMs?: number) => void;
  // Display label for OUR plugin (manifest.id). Used in the notice.
  // Falls back to "git-easy-sync" when omitted.
  pluginLabel?: string;
  // The version of the code RUNNING this bootloader (its bundled
  // manifest). Compared with the manifest on disk after the apply so the
  // toast can say "updated to <new>" (owner, 2026-10-05).
  fromVersion?: string;
  // Optional. Logger sink for diagnostic lines. Falls back to
  // console in production (logger isn't initialised yet at
  // bootloader time).
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
  // Defaults to setTimeout. Tests pass a synchronous shim that
  // captures the scheduled callback.
  scheduleReload?: (cb: () => void, delayMs: number) => void;
}

// Per-file recovery outcome. Aggregated into BootloaderResult below.
type FileResult =
  | { kind: "no-pending" }
  | { kind: "cleanup-marker-orphan" }
  | { kind: "drop-orphan-ges-tmp" }
  | { kind: "applied" }
  | { kind: "failed"; reason: string };

export type BootloaderResult =
  | { action: "no-pending" }
  | { action: "applied"; appliedFiles: string[] }
  | { action: "failed"; reason: string; failedFile: string };

// Derives the staging filename for an original. main.js →
// main.ges-tmp.js. manifest.json → manifest.ges-tmp.json.
export function stagingNameFor(
  fileName: string,
  suffix: "ges-tmp" | "ges-bak",
): string {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0) return `${fileName}.${suffix}`;
  const base = fileName.slice(0, dotIdx);
  const ext = fileName.slice(dotIdx);
  return `${base}.${suffix}${ext}`;
}

// Derives the marker filename: .<basename>.<ext>.ges-tmp.
export function markerNameFor(fileName: string): string {
  return `.${fileName}.ges-tmp.`;
}

async function recoverOneFile(
  deps: BootloaderDeps,
  fileName: string,
): Promise<FileResult> {
  const { adapter, pluginDir, log } = deps;
  const finalPath = `${pluginDir}/${fileName}`;
  const tmpPath = `${pluginDir}/${stagingNameFor(fileName, "ges-tmp")}`;
  const markerPath = `${pluginDir}/${markerNameFor(fileName)}`;
  const bakPath = `${pluginDir}/${stagingNameFor(fileName, "ges-bak")}`;

  const markerExists = await adapter.exists(markerPath);
  const tmpExists = await adapter.exists(tmpPath);

  // ⚠️ THE MARKER CARRIES THE EXPECTED SHA (owner, 2026-10-02), and
  // this check is what makes the staged bytes TRUSTWORTHY rather than
  // merely PRESENT.
  //
  // Presence alone only ever proved that `writeBinary` RETURNED — not
  // that the bytes reached the disk. On a phone that gap is real: a
  // write can return before its data is durable and Android kills apps
  // routinely, leaving a complete marker beside a TRUNCATED staging
  // file. The atomic rename would then install that truncation
  // flawlessly over working code. Atomicity guarantees we install
  // something COMPLETELY; it says nothing about whether what we install
  // is VALID.
  //
  // An empty marker is a pair staged by a build from BEFORE this
  // change: applied as it always was, because dropping it would strand
  // an update for no reason.
  if (markerExists && tmpExists && deps.computeSha !== undefined) {
    const expected = (await readMarkerSha(adapter, markerPath)) ?? "";
    if (expected !== "") {
      const actual = await shaOfFile(adapter, deps.computeSha, tmpPath);
      if (actual !== expected) {
        log?.(
          `Self-update bootloader: ${fileName} staged bytes FAILED the sha ` +
            `the marker promised — dropped, running code untouched`,
          { expected, actual },
        );
        // Both halves go: a pair that cannot be trusted must not be
        // retried into the same mistake on the next start.
        try {
          await adapter.remove(tmpPath);
        } catch {
          // best-effort
        }
        try {
          await adapter.remove(markerPath);
        } catch {
          // best-effort
        }
        // ...and ASK AGAIN. Dropping the pair leaves the update
        // stranded otherwise: the baseline still describes the file on
        // disk (correctly — nothing was applied), and the commit that
        // carried the new version is already behind the sync pointer,
        // so no future delta will mention it. The note is what makes
        // the next drain ask the server directly.
        await addRecheckPaths(adapter, pluginDir, [finalPath]);
        return { kind: "drop-orphan-ges-tmp" };
      }
    }
  }

  // Case A: marker + ges-tmp → apply forward
  if (markerExists && tmpExists) {
    try {
      // ⚠️ THE BACKUP IS A COPY, NOT A RENAME — owner, 2026-10-01, and
      // this is the one place in the plugin where that distinction is
      // existential rather than stylistic.
      //
      // Renaming the live file aside leaves a window in which
      // `main.js` DOES NOT EXIST. Every other torn write in this vault
      // is repaired at our next onload; this one cannot be, because
      // the repair code lives inside the file that is missing —
      // Obsidian simply does not load us, and the user is left to
      // reinstall by hand. A copy leaves the live file untouched, so
      // the swap below is the FIRST moment anything happens to it.
      if (await adapter.exists(finalPath)) {
        if (await adapter.exists(bakPath)) {
          await adapter.remove(bakPath);
        }
        await copyOrRename(adapter, finalPath, bakPath);
      }
      // ONE call on desktop: POSIX rename overwrites atomically, so
      // there is no instant in which the path is empty. Capacitor
      // REFUSES an existing destination (iOS/Android), and that
      // refusal — not a platform check — is what selects the fallback:
      // one code path, the platform decides which branch it takes.
      // The mobile window is one syscall wide and cannot be removed
      // through the adapter; `.ges-bak` beside the file is what a
      // human can act on if it ever fires.
      try {
        await adapter.rename(tmpPath, finalPath);
      } catch {
        await adapter.remove(finalPath);
        await adapter.rename(tmpPath, finalPath);
      }
      try {
        await adapter.remove(markerPath);
      } catch {
        // best-effort
      }
      if (deps.keepBackup !== true) {
        try {
          await adapter.remove(bakPath);
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      log?.(`Self-update bootloader: ${fileName} apply failed`, {
        err: `${err}`,
      });
      return { kind: "failed", reason: "apply-failed" };
    }
    log?.(
      `Self-update bootloader: ${fileName} marker + ges-tmp → applied forward`,
    );
    return { kind: "applied" };
  }

  // Case B: marker without ges-tmp → cleanup orphan marker
  if (markerExists && !tmpExists) {
    try {
      await adapter.remove(markerPath);
    } catch (err) {
      log?.(`Failed to remove ${fileName} orphan marker`, {
        err: `${err}`,
      });
    }
    log?.(`Self-update bootloader: ${fileName} marker orphan cleaned`);
    return { kind: "cleanup-marker-orphan" };
  }

  // Case C: ges-tmp without marker → drop
  if (!markerExists && tmpExists) {
    try {
      await adapter.remove(tmpPath);
    } catch (err) {
      log?.(`Failed to drop ${fileName} incomplete ges-tmp`, {
        err: `${err}`,
      });
    }
    log?.(
      `Self-update bootloader: ${fileName} incomplete ges-tmp dropped (no marker)`,
    );
    return { kind: "drop-orphan-ges-tmp" };
  }

  // Case D: nothing pending
  return { kind: "no-pending" };
}

export async function runSelfUpdateBootloader(
  deps: BootloaderDeps,
): Promise<BootloaderResult> {
  const {
    reloadPlugin,
    notice,
    log,
    pluginLabel = "git-easy-sync",
    scheduleReload = (cb, delay) => setTimeout(cb, delay),
  } = deps;
  const logFn =
    log ??
    ((msg: string, ctx?: Record<string, unknown>) => {
      try {
        console.log(`[git-easy-sync bootloader] ${msg}`, ctx ?? {});
      } catch {
        // ignore
      }
    });

  const appliedFiles: string[] = [];
  for (const fileName of SELF_UPDATE_FILES) {
    const r = await recoverOneFile({ ...deps, log: logFn }, fileName);
    if (r.kind === "failed") {
      return {
        action: "failed",
        reason: r.reason,
        failedFile: fileName,
      };
    }
    if (r.kind === "applied") {
      appliedFiles.push(fileName);
    }
    // Cases B/C/D for this file: continue with next file. The
    // changes happened (marker cleared, ges-tmp dropped) but don't
    // require reload by themselves.
  }

  if (appliedFiles.length === 0) {
    return { action: "no-pending" };
  }

  // Tell the NEXT onload what landed, so the baseline can follow (see
  // self-update-applied.ts). Only with a hash function: without one we
  // cannot vouch for the bytes, and the commit re-checks them instead.
  if (deps.computeSha !== undefined) {
    const entries: Array<{ path: string; sha: string }> = [];
    for (const fileName of appliedFiles) {
      try {
        const p = `${deps.pluginDir}/${fileName}`;
        const sha = await shaOfFile(deps.adapter, deps.computeSha, p);
        if (sha !== null) entries.push({ path: p, sha });
      } catch {
        // unreadable right after the apply → no record for it
      }
    }
    await recordSelfUpdateApplied(deps.adapter, deps.pluginDir, entries);
  }

  // At least one of (main.js, manifest.json, styles.css) was applied —
  // schedule reloadPlugin. Obsidian re-reads all three on plugin
  // enable, so a single reload picks up any combination of changes.
  scheduleReload(() => {
    try {
      reloadPlugin();
    } catch (err) {
      logFn("reloadPlugin call failed", { err: `${err}` });
    }
  }, 500);
  // Always our own plugin — name it, don't count files. A single
  // reload picks up any combination of (main.js, manifest.json,
  // styles.css), so the file list is an implementation detail the user
  // doesn't need; the applied set is still logged below for diagnostics.
  let toVersion: string | null = null;
  try {
    toVersion = readPluginVersion(
      await deps.adapter.read(`${deps.pluginDir}/manifest.json`),
    );
  } catch {
    // Unreadable → the toast just says "updated".
  }
  notice?.(
    pluginUpdatedText(pluginLabel, deps.fromVersion ?? null, toVersion),
    3000,
  );
  logFn("Self-update bootloader: apply complete, reload scheduled", {
    appliedFiles,
  });
  return { action: "applied", appliedFiles };
}

// The marker's content, trimmed. Unreadable → treated as empty, i.e.
// "no promise was made", which falls back to the presence-only rule.
async function readMarkerSha(
  adapter: DataAdapter,
  markerPath: string,
): Promise<string | null> {
  try {
    return (await adapter.read(markerPath)).trim();
  } catch {
    return null;
  }
}

async function shaOfFile(
  adapter: DataAdapter,
  computeSha: (bytes: ArrayBuffer) => Promise<string>,
  path: string,
): Promise<string | null> {
  try {
    return await computeSha(await adapter.readBinary(path));
  } catch {
    return null;
  }
}

// `copy` is the Obsidian DataAdapter API we want; a runtime that does
// not expose it (older builds, a test double) falls back to the rename
// that was here before. Degrading is better than throwing: the window
// comes back, which is exactly where we were yesterday.
async function copyOrRename(
  adapter: DataAdapter,
  from: string,
  to: string,
): Promise<void> {
  const copy = (adapter as { copy?: (a: string, b: string) => Promise<void> })
    .copy;
  if (typeof copy === "function") {
    await copy.call(adapter, from, to);
    return;
  }
  await adapter.rename(from, to);
}

// Helper: parses a path under the vault root and returns the plugin
// ID if and only if the path matches the
// "<configDir>/plugins/<id>/<file>" shape AND <file> is one of the
// files Obsidian re-loads on reloadPlugin (main.js, manifest.json,
// styles.css, data.json). Returns null otherwise. Used by
// Sync2Manager to track which plugin IDs need reloadPlugin after a
// drain.
export function extractAffectedPluginId(
  path: string,
  configDir: string,
): string | null {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const id = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  // Only top-level plugin files trigger reload; subdirectory files
  // (e.g. a plugin's `data/` folder) do not.
  if (file.includes("/")) return null;
  if (
    file === "main.js" ||
    file === "manifest.json" ||
    file === "styles.css" ||
    file === "data.json"
  ) {
    return id;
  }
  return null;
}

// True iff the given path is one of OUR plugin's files that uses the
// bootloader marker protocol on write. Excludes data.json (per-device
// state, never synced from remote). Used by Sync2Manager to route
// remote-driven writes to `applySelfUpdate*` instead of plain
// atomicWriteFile.
export function isOwnPluginRecoverableFile(
  path: string,
  configDir: string,
  selfPluginId: string,
): boolean {
  const prefix = `${configDir}/plugins/${selfPluginId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.includes("/")) return false;
  return SELF_UPDATE_FILES.includes(rest);
}
