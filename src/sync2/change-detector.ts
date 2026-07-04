// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { TFile, Vault } from "obsidian";
import GI from "../gi";
import { calculateGitBlobSHA } from "../utils";
import SnapshotStore, {
  SYNC2_MANIFEST_FILE_NAME,
} from "./snapshot-store";
import { FileChange } from "./types";

// isSyncable for sync2: hardcoded deny list + per-device configDir
// gate + gi.ignoredAsync. The configDir gate (`syncConfigDir`) is
// per-device by design — see settings.ts where it lives. When OFF,
// every path under `<configDir>/` is gated — symmetrically, so neither
// push nor pull touches configDir. Invariant gitignore content stays
// canonical on each device via GitignoreInvariants.enforce(), which
// rewrites the two managed files locally on plugin load; nothing
// about that mechanism depends on cross-device propagation.
export async function isSyncable(
  path: string,
  configDir: string,
  selfPluginId: string,
  syncConfigDir: boolean,
  gi: GI,
  asyncReader: (
    abs: string,
  ) => Promise<{ content: string; mtime: number } | null>,
): Promise<boolean> {
  if (path === `${configDir}/${SYNC2_MANIFEST_FILE_NAME}`) return false;
  if (path === `${configDir}/plugins/${selfPluginId}/data.json`) return false;
  // Per-device configDir gate — symmetric: OFF blocks the whole
  // <configDir>/ subtree on both push and pull.
  if (!syncConfigDir && path.startsWith(`${configDir}/`)) return false;
  // ALL of our plugin's per-device runtime state lives under a SINGLE `.runtime/`
  // subfolder (push-queue snapshots, conflict-store meta + theirs-backups, trash,
  // pending-deletions, autosave sessions, push-inflight / token-expired / layout
  // markers). None of it may ever be uploaded — vault.getFiles() surfaces it as user
  // content, and pushing per-device state feedback-loops onto other devices. The
  // strict-allowlist `<self>/.gitignore` (`* !main.js !manifest.json !styles.css
  // !.gitignore`) already blocks the whole plugin dir, but this ONE hardcoded prefix
  // guards the un-seeded window (tests, partial init) — and by gating the `.runtime/`
  // ROOT it covers every current AND future runtime artifact without a per-item list.
  if (path.startsWith(`${configDir}/plugins/${selfPluginId}/.runtime/`)) return false;
  if (path === ".git" || path.startsWith(".git/")) return false;
  if (path.includes("/.git/")) return false;
  // Conflict sibling files (`<base>.conflict-from-<label>-<ts>.<ext>`,
  // with an optional `.deleted` suffix for modify-vs-delete) are
  // per-device markers — they sit visibly in the vault for the user
  // to reconcile, but pushing them to GitHub via main would
  // propagate one device's pending-conflict state to others. The
  // user's "ours" copy DOES land on the conflict branch via the
  // split-push (sync2-manager.pushConflictPathsToBranch).
  if (CONFLICT_SIBLING_PATTERN.test(path)) return false;
  return !(await gi.ignoredAsync(path, asyncReader));
}

// Sibling files written by ConflictStore look like
//   `<base>.conflict-from-<safe-label>-<iso-no-colons>Z<ext>`
// (extension preserved when the original had one, missing otherwise).
// The label is sanitized to [a-zA-Z0-9_-]+ so no clever Unicode
// trickery here; the date marker `Z` plus the digit-and-dash pattern
// after `-from-` is structurally unambiguous and unlikely to clash
// with a real user filename.
// True for a "file vanished" adapter error — Capacitor surfaces ENOENT with
// message "File does not exist"; Node/desktop uses code "ENOENT". Path-agnostic
// (the error rarely names the path). Used to make a mid-walk read fail-soft.
function isMissingFileError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|no such file|enoent/i.test(msg);
}

const CONFLICT_SIBLING_PATTERN =
  /\.conflict-from-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(\.[^./]+)?$/;
// (The trailing-extension group stays optional — files without a
// dotted extension produce no .ext segment, see buildSiblingPath.)

export interface ChangeDetectorDeps {
  vault: Vault;
  store: SnapshotStore;
  gi: GI;
  configDir: string;
  selfPluginId: string;
  vaultRoot: string;
  // Per-device gate for configDir paths. Read live from settings so
  // toggling the UI checkbox takes effect on the very next syncAll.
  // The getter pattern (vs. a fixed boolean) keeps the manager from
  // re-instantiating the detector on every settings change.
  syncConfigDir: () => boolean;
  // Optional: when set, findChanges bridges the snapshot store with
  // the live push-queue. A file whose local bytes match what some
  // pending batch already holds is treated as "committed locally"
  // (= waiting for its batch to push) and skipped from re-emission.
  // Without this dep, the detector falls back to snapshot-only
  // behaviour — fine for unit tests that don't build a queue.
  queue?: PeekableQueue;
}

// Minimal surface ChangeDetector consumes from PushQueue. Lets
// tests inject a stub without dragging the full queue (which would
// also drag its disk layout).
export interface PeekableQueue {
  peekPathSha(path: string): Promise<string | null>;
}

// Path + stat tuple findChanges' main loop consumes. Identical shape
// for both sources (vault.getFiles() TFiles and adapter.list-derived
// configDir entries). Kept as a private alias so future renames don't
// have to chase TFile types through the loop body.
type FileLike = {
  path: string;
  stat: { mtime: number; size: number };
};

export default class ChangeDetector {
  private readonly vault: Vault;
  private readonly store: SnapshotStore;
  private readonly gi: GI;
  private readonly configDir: string;
  private readonly selfPluginId: string;
  private readonly vaultRoot: string;
  private readonly syncConfigDir: () => boolean;
  private readonly queue: PeekableQueue | undefined;

  constructor(deps: ChangeDetectorDeps) {
    this.vault = deps.vault;
    this.store = deps.store;
    this.gi = deps.gi;
    this.configDir = deps.configDir;
    this.selfPluginId = deps.selfPluginId;
    this.vaultRoot = deps.vaultRoot;
    this.syncConfigDir = deps.syncConfigDir;
    this.queue = deps.queue;
  }

  // Walk the vault, return everything that needs to flow remote-ward,
  // and silently reconcile snapshot entries whose paths are now ignored.
  //
  // Enumeration strategy: vault.getFiles() returns Obsidian's *indexed*
  // file list — fast (in-memory) but excludes everything under
  // <configDir>/ in production. (Confirmed against a real ~/otest5
  // vault: getFiles returned Welcome.md but not .obsidian/.gitignore,
  // even though the file existed on disk. Legacy used adapter.list()
  // recursively for the same reason.)
  //
  // When syncConfigDir is ON, we additionally walk <configDir>/ via
  // adapter.list() so push-side picks up snippets, theme files, etc.
  // When OFF, we skip that walk entirely. The gate is symmetric:
  // OFF means configDir is fully off-limits on BOTH push and pull
  // (the isSyncable gate in pullIfNeeded filters incoming changes
  // the same way). Each device keeps its own invariant gitignores
  // canonical via GitignoreInvariants.enforce(), no cross-device
  // propagation needed for that.
  //
  // Mtime watermark filters candidates from BOTH sources — files
  // unchanged since the last sync stay out of the loop entirely;
  // the narrow candidate set is what actually pays for isSyncable +
  // read+SHA.
  async findChanges(): Promise<FileChange[]> {
    const out: FileChange[] = [];
    const watermark = this.store.getLastCommitMtime();
    const allFiles: FileLike[] = this.vault.getFiles().map((f) => ({
      path: f.path,
      stat: { mtime: f.stat.mtime, size: f.stat.size },
    }));
    // Same indexing gap that hides <configDir>/.gitignore on production
    // Obsidian also hides ROOT-level dotfiles (<vault>/.gitignore,
    // <vault>/.gitattributes, etc.) — Obsidian's file index excludes
    // anything whose name starts with `.`. Without an explicit walk
    // here, edits to <vault>/.gitignore stay device-local forever —
    // a fundamental sync gap. ALWAYS run this walk (unlike
    // walkConfigDir, which is gated on syncConfigDir): root-level
    // dotfiles are USER vault content, not per-device configDir
    // state.
    allFiles.push(...(await this.walkRootDotfiles()));
    if (this.syncConfigDir()) {
      allFiles.push(...(await this.walkConfigDir()));
    }
    // Track syncable paths we examined this pass so Pass 2 can tell
    // apart "snapshot points at a path that's still tracked but
    // unchanged" from "snapshot points at a path that's gone or
    // newly-ignored". Files that exist on disk but are ignored go
    // here too (as ignored entries) so Pass 2 knows to drop their
    // stale snapshot rows silently rather than emit `deleted`.
    const seenSyncable = new Set<string>();
    const seenIgnored = new Set<string>();

    // Pass 1: candidates whose stat.mtime exceeds the watermark.
    // First-ever sync (watermark === null) treats every file as a
    // candidate so the initial bootstrap walks the whole vault once.
    for (const file of allFiles) {
      if (watermark !== null && file.stat.mtime <= watermark) {
        const snap = this.store.get(file.path);
        // Cache-hit short-circuit only when the snapshot's recorded
        // stat matches reality — that's our proof the file actually
        // matched the last sync. Without this proof (no snapshot, or
        // mtime/size drifted) we have to ask isSyncable now, in case
        // a gitignore rule flipped the path's status since then.
        if (
          snap &&
          snap.mtime === file.stat.mtime &&
          snap.size === file.stat.size
        ) {
          if (await this.checkSyncable(file.path)) {
            seenSyncable.add(file.path);
          } else {
            // Path was syncable last sync, now ignored. Pass 2 will
            // drop the snapshot silently (gitignore two-way mute).
            seenIgnored.add(file.path);
          }
          continue;
        }
        // Fall through: snapshot missing or stale — handle below.
      }
      if (!(await this.checkSyncable(file.path))) {
        seenIgnored.add(file.path);
        continue;
      }
      seenSyncable.add(file.path);

      const snap = this.store.get(file.path);
      if (!snap) {
        // Candidate "added". Before emitting, check whether the file
        // is already represented in any pending queue batch with the
        // exact same bytes — if so, it's "committed locally" (waiting
        // for its batch to push) and re-emitting would duplicate work
        // on the very next enqueue. Reading + hashing the bytes is
        // the same cost the upcoming push would pay; we just bring
        // it forward.
        if (this.queue) {
          const buf = await this.readBinaryOrSkip(file.path);
          if (buf === null) continue; // SYNC2 §6 skip-class — vanished mid-walk
          const localSha = await calculateGitBlobSHA(buf);
          const inQueueSha = await this.queue.peekPathSha(file.path);
          if (inQueueSha === localSha) continue;
        }
        out.push({
          kind: "added",
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
        continue;
      }

      if (
        file.stat.mtime === snap.mtime &&
        file.stat.size === snap.size
      ) {
        // Stat-cache hit: cleared the watermark but matches the
        // recorded snapshot exactly. Content guaranteed unchanged.
        // (Can happen when the recorded snapshot mtime > watermark,
        // which is the common case for the file we last pushed.)
        continue;
      }

      // Stat moved; verify it's a real content change.
      const buf = await this.readBinaryOrSkip(file.path);
      if (buf === null) continue; // SYNC2 §6 skip-class — vanished mid-walk
      const sha = await calculateGitBlobSHA(buf);
      if (sha === snap.remoteSha) {
        // Touched (mtime/size moved) but content matches the remote
        // we already know about. Refresh cache so subsequent syncs
        // short-circuit cleanly.
        this.store.set(file.path, {
          ...snap,
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
        continue;
      }

      // Same "in-flight in queue" check as the "added" branch above —
      // covers the case where a previous syncAll enqueued this path
      // (without modifying snapshot yet) and the user did NOT edit it
      // between the failed push and this retry.
      if (this.queue) {
        const inQueueSha = await this.queue.peekPathSha(file.path);
        if (inQueueSha === sha) continue;
      }

      out.push({
        kind: "modified",
        path: file.path,
        size: file.stat.size,
        mtime: file.stat.mtime,
        previousRemoteSha: snap.remoteSha,
      });
    }

    // Pass 2: snapshot paths Pass 1 didn't claim as still-syncable.
    //   - seenIgnored: file exists on disk but is now ignored → silent
    //     cleanup (gitignore is a two-way mute).
    //   - neither seen: file is genuinely gone from disk → emit `deleted`.
    //   - seenSyncable: nothing to do here.
    for (const path of this.store.paths()) {
      if (seenSyncable.has(path)) continue;
      if (seenIgnored.has(path)) {
        this.store.remove(path);
        continue;
      }
      // Path not in vault at all. Could be deleted, or could have
      // become ignored at a path that no longer exists. Re-check
      // syncability one more time: if ignored, drop silently;
      // otherwise emit deleted.
      if (!(await this.checkSyncable(path))) {
        this.store.remove(path);
        continue;
      }
      const snap = this.store.get(path);
      if (!snap) continue;
      out.push({
        kind: "deleted",
        path,
        previousRemoteSha: snap.remoteSha,
      });
    }

    await this.store.save();
    return out;
  }

  // Classify a single path the same way findChanges() would, but
  // without scanning the whole vault. Used by Sync2Manager.syncFile
  // (Action 2/3) to build a one-file batch for the active note.
  // Returns null when the path has no work to push: identical to
  // snapshot, missing on both sides, ignored, or hardcoded-blocked.
  async findChangeForPath(path: string): Promise<FileChange | null> {
    if (!(await this.checkSyncable(path))) return null;

    const stat = await this.vault.adapter.stat(path);
    const snap = this.store.get(path);

    if (!stat) {
      if (!snap) return null;
      return {
        kind: "deleted",
        path,
        previousRemoteSha: snap.remoteSha,
      };
    }

    if (!snap) {
      return {
        kind: "added",
        path,
        size: stat.size,
        mtime: stat.mtime,
      };
    }

    if (stat.mtime === snap.mtime && stat.size === snap.size) {
      return null; // cache hit
    }

    const buf = await this.readBinaryOrSkip(path);
    if (buf === null) return null; // SYNC2 §6 skip-class — vanished mid-detect
    const sha = await calculateGitBlobSHA(buf);
    if (sha === snap.remoteSha) {
      // Touched but unchanged — refresh stat so future calls
      // short-circuit, then report "nothing to do".
      this.store.set(path, {
        ...snap,
        mtime: stat.mtime,
        size: stat.size,
      });
      await this.store.save();
      return null;
    }

    return {
      kind: "modified",
      path,
      size: stat.size,
      mtime: stat.mtime,
      previousRemoteSha: snap.remoteSha,
    };
  }

  // Called by Sync2Manager after a successful upload of `path` with the
  // new GitHub blob SHA. Re-stats the file so subsequent findChanges()
  // short-circuits via the snapshot cache.
  async recordSync(path: string, newRemoteSha: string): Promise<void> {
    const stat = await this.vault.adapter.stat(path);
    if (!stat) {
      this.store.remove(path);
      return;
    }
    this.store.set(path, {
      path,
      remoteSha: newRemoteSha,
      mtime: stat.mtime,
      size: stat.size,
    });
  }

  // Called after a remote-driven deletion is applied locally.
  recordDeletion(path: string): void {
    this.store.remove(path);
  }

  // Public so Sync2Manager.pullIfNeeded can ask the same question for
  // remote-driven paths arriving via compare(). Same predicate that
  // findChanges/findChangeForPath consult internally.
  async checkSyncable(path: string): Promise<boolean> {
    return isSyncable(
      path,
      this.configDir,
      this.selfPluginId,
      this.syncConfigDir(),
      this.gi,
      this.giReader,
    );
  }

  // Enumerate ROOT-level dotfiles via adapter.list(""). Always called
  // (no settings gate) because root dotfiles are user vault content
  // (`.gitignore`, `.gitattributes`, `.editorconfig`, …) that must
  // sync between devices. vault.getFiles() silently skips these in
  // production Obsidian — confirmed by the user with a real desktop
  // ↔ mobile sync where root `.gitignore` was never detected as a
  // change and stayed device-local.
  //
  // Only the vault root is walked, one level deep, dotfiles only:
  // - regular root files are already in vault.getFiles()
  // - dotfiles in subfolders are theoretically also missing from the
  //   index, but that scenario is rarer and would need a deeper
  //   recursive walk; address if it surfaces.
  // SYNC2 §6 skip-class — read a candidate that was just listed in allFiles,
  // tolerating the file VANISHING mid-walk. On Android (Capacitor) an external
  // writer (Obsidian rewriting its own .obsidian/* config at startup, or any
  // app.json/appearance.json/core-plugins.json change) has a brief window where
  // the file is momentarily absent, so a concurrent readBinary throws ENOENT
  // ("File does not exist"). That used to fail the whole syncAll. Treat it as
  // "not a candidate this pass" → null → caller skips; the next sync re-walks
  // and picks up the real state (transient → re-read; truly deleted → next
  // allFiles omits it → Pass-2 emits the delete). Non-missing errors rethrow.
  private async readBinaryOrSkip(path: string): Promise<ArrayBuffer | null> {
    try {
      return await this.vault.adapter.readBinary(path);
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw err;
    }
  }

  private async walkRootDotfiles(): Promise<FileLike[]> {
    const out: FileLike[] = [];
    if (!(await this.vault.adapter.exists(""))) return out;
    const { files } = await this.vault.adapter.list("");
    for (const filePath of files) {
      // Only ROOT dotfiles (no slash → single path segment).
      if (filePath.includes("/")) continue;
      if (!filePath.startsWith(".")) continue;
      const stat = await this.vault.adapter.stat(filePath);
      if (!stat || stat.type !== "file") continue;
      out.push({
        path: filePath,
        stat: { mtime: stat.mtime, size: stat.size },
      });
    }
    return out;
  }

  // Recursively enumerate `<configDir>/` via adapter.list(). Only
  // called when syncConfigDir is ON — covers the gap where
  // vault.getFiles() doesn't index configDir paths in production
  // Obsidian. Returns FileLike entries shaped like vault.getFiles()
  // so the main loop can treat them uniformly.
  //
  // Skips silently if the configDir doesn't exist (fresh vault before
  // Obsidian wrote it; shouldn't happen in practice but cheap to guard).
  private async walkConfigDir(): Promise<FileLike[]> {
    const out: FileLike[] = [];
    const stack: string[] = [this.configDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      if (!(await this.vault.adapter.exists(dir))) continue;
      const { files, folders } = await this.vault.adapter.list(dir);
      for (const filePath of files) {
        const stat = await this.vault.adapter.stat(filePath);
        if (!stat) continue;
        out.push({
          path: filePath,
          stat: { mtime: stat.mtime, size: stat.size },
        });
      }
      stack.push(...folders);
    }
    return out;
  }

  // Reader for GI: resolves a `.gitignore` absolute path to its
  // content + mtime via vault.adapter. The mtime lets GI auto-skip
  // re-parsing when the file hasn't moved on disk — Layer A's
  // self-keeping-fresh contract from DIFF2_IMPLEMENTATION_PLAN.md.
  private giReader = async (
    absPath: string,
  ): Promise<{ content: string; mtime: number } | null> => {
    const prefix = this.vaultRoot.replace(/\\/g, "/") + "/";
    let rel: string;
    if (absPath === this.vaultRoot.replace(/\\/g, "/")) {
      rel = "";
    } else if (absPath.startsWith(prefix)) {
      rel = absPath.slice(prefix.length);
    } else {
      return null;
    }
    const stat = await this.vault.adapter.stat(rel);
    if (!stat) return null;
    const content = await this.vault.adapter.read(rel);
    return { content, mtime: stat.mtime };
  };
}

// Re-export so Sync2Manager can type its TFile-shaped helpers without
// pulling obsidian directly when it just needs a generic shape.
export type { TFile };
