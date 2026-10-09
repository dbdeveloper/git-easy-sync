// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { TFile, Vault } from "obsidian";
import { isHeldPath } from "./held-plugins";
import GI, { isWhitelistedGitignoreDir } from "../gi";
import {
  OptInSet,
  readRootGitignore,
  underWalkTarget,
  walkDotDir,
} from "./dot-space";
import { calculateGitBlobSHA } from "../utils";
import HotMetadataStore from "./hot-metadata";
import FileBaselinesStore, {
  FileBaseline,
  bucketIdForPath,
} from "./file-baselines";
import { FileChange } from "./types";
import { canonicalizeBytes, shouldCanonicalize } from "./text-normalize";
import { PIN_OWNER_COMMIT } from "./sync-store";
import WorkerClient from "../worker/worker-client";

// isSyncable for sync2: hardcoded deny list + per-device configDir
// gate + gi.ignoredAsync. The configDir gate (`syncConfigDir`) is
// per-device by design — see settings.ts where it lives. When OFF,
// every path under `<configDir>/` is gated — symmetrically, so neither
// push nor pull touches configDir. Invariant gitignore content stays
// canonical on each device via GitignoreInvariants.enforce(), which
// rewrites the two managed files locally on plugin load; nothing
// about that mechanism depends on cross-device propagation.
// What of OUR plugin's own folder may ever sync (owner, 2026-10-05):
// the plugin itself and the managed .gitignore that describes it for
// foreign git clients. Never data.json (token, settings), never
// .runtime/ (queue, conflicts), never anything else.
const OWN_PLUGIN_SYNCED_FILES = new Set([
  "main.js",
  "manifest.json",
  "styles.css",
  ".gitignore",
]);

// `<configDir>/plugins/<id>/data.json` — a plugin's settings file.
function isPluginDataJson(path: string, configDir: string): boolean {
  const prefix = `${configDir}/plugins/`;
  if (!path.startsWith(prefix) || !path.endsWith("/data.json")) return false;
  const id = path.slice(prefix.length, path.length - "/data.json".length);
  return id.length > 0 && !id.includes("/");
}

export async function isSyncable(
  path: string,
  configDir: string,
  selfPluginId: string,
  syncConfigDir: boolean,
  gi: GI,
  asyncReader: (
    abs: string,
  ) => Promise<{ content: string; mtime: number } | null>,
  // The opt-in set for THIS scan (DOT-FILES §3.2 step 5 / §5). `null`
  // means nobody computed it, which is a lifecycle bug, not a state —
  // see the throw below.
  optIn: OptInSet | null,
  // "Push plugins data.json". Defaults to the SAFE answer: off.
  pushPluginsDataJson = false,
): Promise<boolean> {
  // ── THE UNCONDITIONAL RULES (owner, 2026-10-05) ──────────────────
  // They hold whether or not any .gitignore exists: the managed
  // .gitignore blocks are written for FOREIGN git clients, and a remote
  // clean-up that deletes every .gitignore must not widen what this
  // device sends or accepts. The .gitignore rules at the end may only
  // NARROW what these allow. Both directions — a path refused here is
  // neither pushed nor pulled.
  //   1. "Sync .obsidian/" off → nothing under the config dir (below);
  //   2. "Push plugins data.json" off → no plugin's data.json;
  //   3. OUR folder → only OWN_PLUGIN_SYNCED_FILES (any subfolder too).
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
  // Rule 3. The managed `<self>/.gitignore` above says the same thing to
  // foreign git clients; this is what makes it hold without the file.
  const ownDir = `${configDir}/plugins/${selfPluginId}/`;
  if (path.startsWith(ownDir) && !OWN_PLUGIN_SYNCED_FILES.has(path.slice(ownDir.length))) {
    return false;
  }
  // Rule 2. Until 2026-10-05 this lived ONLY in the managed
  // .obsidian/plugins/.gitignore (re-written by enforce() before each
  // operation) — gone with that file, gone with the rule.
  if (!pushPluginsDataJson && isPluginDataJson(path, configDir)) return false;
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
  // D6 (DOT-FILES §3.2 step 4): a `.gitignore` is syncable only where it
  // is HONOURED. `gi` consults exactly three locations — root,
  // `<configDir>`, `<configDir>/plugins/*` (D5) — so a `.gitignore`
  // anywhere else is a control file we do not execute. Syncing one would
  // ship a file that looks like it governs something and does not, on
  // every device that receives it.
  //
  // This is a BACKSTOP, not the mechanism: the anchored `!/.gitignore`
  // in the managed sections already hides nested ones through the
  // matcher itself (§10 probe 4-A). It earns its place in the window
  // where the root file is missing or hand-edited, since it does not
  // depend on any file's contents to be true.
  if (isUnhonouredGitignore(path, configDir)) return false;
  // D7 (DOT-FILES §3.2 step 5) — THE load-bearing one. A dot-path may
  // be permitted only if push-discovery can actually reach it.
  //
  // Without this, a rule that grants permission without addressing a
  // concrete path (an unanchored `!.myconfig/`, a glob) would leave the
  // path in the baselines, answering "syncable", while no scan ever
  // visits it. Pass 2 reads that as "deleted" and propagates the delete
  // to every device. Losing the anchor off `!/.myconfig/` — one
  // character — would wipe the directory everywhere. So "permitted" and
  // "discoverable" are ONE set.
  if (isDotPath(path)) {
    if (optIn === null) {
      // FAIL LOUD (§5). Silently answering "false" here would be worse
      // than a crash: the whole dot-space would quietly leave scope,
      // Pass 2 would treat every dot-path as gone, and the cause would
      // be a missing call several layers away. A caller that reaches
      // isSyncable outside a scan is a bug in the caller.
      throw new Error(
        `isSyncable(${path}): the dot-space opt-in set was never computed ` +
          `for this operation — call ChangeDetector.beginScan() first`,
      );
    }
    // `<configDir>/` is answered by step 3 above, which is the real
    // authority for it; keeping the exemption explicit means step 5 does
    // not depend on how the set happened to be built.
    const underConfigDir =
      path === configDir || path.startsWith(`${configDir}/`);
    if (!underConfigDir) {
      const discoverable =
        optIn.dotFiles.has(path) ||
        underWalkTarget(path, optIn.walkTargets);
      if (!discoverable) return false;
    }
  }
  return !(await gi.ignoredAsync(path, asyncReader));
}

// Any segment starting with a dot makes it a dot-path (DOT-FILES §2).
export function isDotPath(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith("."));
}

// True for a `.gitignore` outside the three locations D5 reads.
//
// Derived from `isWhitelistedGitignoreDir`, not restated: that function
// answers about a DIRECTORY level and this one about a FILE path, which
// is the same rule one `dirname` apart. Two encodings of one rule drift,
// and the drift would be silent — a file we sync but never honour, or
// the reverse.
export function isUnhonouredGitignore(
  path: string,
  configDir: string,
): boolean {
  const slash = path.lastIndexOf("/");
  if (path.slice(slash + 1) !== ".gitignore") return false;
  const dir = slash < 0 ? "" : path.slice(0, slash);
  return !isWhitelistedGitignoreDir(dir, configDir);
}

// True for a "file vanished" adapter error — Capacitor surfaces ENOENT with
// message "File does not exist"; Node/desktop uses code "ENOENT". Path-agnostic
// (the error rarely names the path). Used to make a mid-walk read fail-soft.
function isMissingFileError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "ENOENT") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist|no such file|enoent/i.test(msg);
}

// Sibling files written by ConflictStore look like
//   `<base>.conflict-from-<safe-label>-<iso-no-colons>Z<ext>`
// (extension preserved when the original had one, missing otherwise).
//
// ⚠️ The label is NOT restricted to [A-Za-z0-9_-]. An earlier version of
// this comment claimed it was, and the pattern below was written to
// match that claim — but `buildSiblingFilePath` (conflict-siblings.ts)
// only swaps parentheses for brackets and passes everything else
// through, spaces included. The [A-Za-z0-9_-] sanitiser lives in
// conflict-branch.ts and applies to BRANCH names, not to filenames. So
// a device labelled "Home iMac" produced a sibling this belt could not
// see, and only the `*.conflict-from-*` gitignore rule kept it from
// being pushed — two layers, one of them broken. Fixed 2026-09-22.
//
// `[^/]+` is the right width: a label can hold anything the user typed
// except a path separator. It does not widen the false-positive surface
// either — what makes the shape unambiguous is the trailing
// `-<iso-timestamp>Z`, not the label's alphabet.
const CONFLICT_SIBLING_PATTERN =
  /\.conflict-from-[^/]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(\.[^./]+)?$/;
// (The trailing-extension group stays optional — files without a
// dotted extension produce no .ext segment, see buildSiblingPath.)

export interface ChangeDetectorDeps {
  vault: Vault;
  // Watermark source (hot pair): getLastCommitMtime.
  hotMeta: HotMetadataStore;
  // Per-file baselines (cold buckets). All group operations in this
  // file follow METAFILE §2.2.1 — bucket-grouped access.
  baselines: FileBaselinesStore;
  gi: GI;
  configDir: string;
  selfPluginId: string;
  vaultRoot: string;
  // Per-device gate for configDir paths. Read live from settings so
  // toggling the UI checkbox takes effect on the very next syncAll.
  // The getter pattern (vs. a fixed boolean) keeps the manager from
  // re-instantiating the detector on every settings change.
  syncConfigDir: () => boolean;
  // "Push plugins data.json" — the owner's unconditional rule 2 (see
  // isSyncable), read live like syncConfigDir. Absent → off (safe).
  pushPluginsDataJson?: () => boolean;
  // Optional: surfaces the dot-space warnings from readRootGitignore —
  // a `!`-rule that grants nothing is refused by design, and saying so
  // is the difference between a documented limit and a silent feature.
  logger?: { warn(message: string, data?: unknown): void };
  // Optional: when set, findChanges bridges the snapshot store with
  // the live push-queue. A file whose local bytes match what some
  // pending batch already holds is treated as "committed locally"
  // (= waiting for its batch to push) and skipped from re-emission.
  // Without this dep, the detector falls back to snapshot-only
  // behaviour — fine for unit tests that don't build a queue.
  queue?: PeekableQueue;
  // TODO §26 — resolves a path's tracked-conflict base reference: the
  // base's last value on the CONFLICT BRANCH (its "home" while in
  // conflict), or `undefined` when the path is NOT a tracked-conflict
  // base. When present (path is a conflict base), the file is "changed"
  // iff it differs from THIS (or the last queued commit) — NOT from main
  // (snapshot.remoteSha), which only tells us it's a tracked conflict. So
  // an unchanged base never re-commits, and an edited one commits once
  // (routed to the branch). Same source as the split-push router's
  // `hasPending`, so the two can't diverge. Wired from ConflictStore.
  conflictBaseSha?: (path: string) => string | null | undefined;
  // Called when a walk target could not be fully enumerated. Optional
  // because it is diagnostics — the BELT that protects the data does
  // not depend on anyone listening (§3.3).
  logWalkIncomplete?: (target: string) => void;
  // COMMIT-PASS-PERF Крок 1: the git-blob SHA of a candidate's bytes,
  // with the bytes handed back. Production wires the worker orchestra
  // (`WorkerClient.hashGitBlob`), which MOVES the buffer to the worker
  // and back — the digest leaves the UI thread without a second copy of
  // the file. ⚠️ The argument may come back detached: only the RETURNED
  // bytes are usable afterwards. Optional: absent, the main-thread
  // `calculateGitBlobSHA` runs and the same buffer is returned (unit
  // tests). Both compute the byte-identical SHA.
  hashBlob?: (bytes: ArrayBuffer) => Promise<{ sha: string; bytes: ArrayBuffer }>;
  // COMMIT-PASS-PERF Крок 2 — the commit pass's sync_store. When set, a
  // change the detector PROVED (hash differs from its reference) has its
  // bytes stored right there, pinned against the sweep until the pass
  // releases them, and the FileChange carries their sha — BatchWriter
  // then neither re-reads nor re-hashes the file. Unchanged files are
  // never stored: the post-drain self-heal pass re-reads everything and
  // finds nothing, and storing that would write megabytes for the sweep
  // to reap. Absent → today's shape (sha-less changes).
  syncStore?: {
    retain(
      owner: string,
      sha: string,
      produce: () => Promise<ArrayBuffer | null>,
    ): Promise<boolean>;
  };
  // The canonicalize toggle (autoCanonicalizeTextFiles). MUST be the
  // same getter BatchWriter gets: the detector hashes the canonical form
  // the writer records, and a carried sha is trusted as-is. Absent →
  // off: raw bytes, as before.
  autoCanonicalize?: () => boolean;
  // COMMIT-PASS-PERF 3a: per-candidate read and SHA-1 times, and the
  // dot-space enumeration — what step 3's forecast learns from
  // (commit-stats.ts). Optional: cosmetic, never part of a decision here.
  stats?: {
    record(action: "read" | "hash", bytes: number, ms: number): void;
    recordDot(entries: number, ms: number): void;
  };
}

// Where a commit scan's time goes (COMMIT-PASS-PERF, 2026-10-05). Logged
// by the manager after every commit pass, so a measurement on a real
// device says WHICH part is slow instead of one total; the same numbers
// are what step 3's forecast will learn from. All times in ms.
export interface ScanTiming {
  totalMs: number;
  // readRootGitignore — the opt-in set (beginScan).
  beginScanMs: number;
  // getFiles + dot-space files and walks + the bucket sort.
  enumerateMs: number;
  indexFiles: number;
  dotEntries: number;
  // Stage 1's classify loop (stat short-circuits, building the plan).
  pass1Ms: number;
  // Files actually read and hashed, and their bytes.
  candidates: number;
  candidateBytes: number;
  readMs: number;
  hashMs: number;
  // The share of hashing spent on files at or above the worker
  // threshold — the ones that cross to the worker and back.
  hashedLarge: number;
  hashLargeMs: number;
  // Proven changes put into sync_store while hashing (Крок 2).
  stored: number;
  storedBytes: number;
  storeMs: number;
  // Pass 2 over the baseline buckets (finds the deletions; part of
  // stage 1 since 3b).
  pass2Ms: number;
  // Stage 2 — reading, hashing and storing the planned candidates.
  checkMs: number;
}

const emptyTiming = (): ScanTiming => ({
  totalMs: 0,
  beginScanMs: 0,
  enumerateMs: 0,
  indexFiles: 0,
  dotEntries: 0,
  pass1Ms: 0,
  candidates: 0,
  candidateBytes: 0,
  readMs: 0,
  hashMs: 0,
  hashedLarge: 0,
  hashLargeMs: 0,
  stored: 0,
  storedBytes: 0,
  storeMs: 0,
  pass2Ms: 0,
  checkMs: 0,
});

const now = (): number => performance.now();

// Stage 1's verdict for one file that stage 2 must look at (§3.1).
type PlanItem =
  | {
      kind: "added-check";
      file: FileLike;
      addConflictRef: string | null | undefined;
    }
  | { kind: "added-direct"; file: FileLike }
  | { kind: "modified-check"; file: FileLike; snap: FileBaseline };

// What stage 1 knows before a single file is read — the forecast and
// the "Checking N of M files" denominator (§3.1). Deletions count toward
// the commit too; they need no reads.
export interface ScanPlan {
  // Files stage 2 will read + hash, and their bytes (from the stat).
  checks: number;
  checkBytes: number;
  // New files emitted without a hash (only without a queue).
  unhashedAdds: number;
  deletions: number;
}

export interface ScanHooks {
  // After stage 1, before any read.
  onPlan?(plan: ScanPlan): void;
  // After each stage-2 check, whatever its outcome (unchanged, stored,
  // vanished): `done` of `total` checks.
  onChecked?(done: number, total: number): void;
}

// One candidate's bytes in the form a commit records, and their sha.
// `needsWriteBack`: the live file is not canonical yet.
type HashedCandidate = {
  sha: string;
  bytes: ArrayBuffer;
  needsWriteBack: boolean;
};

// Minimal surface ChangeDetector consumes from PushQueue. Lets
// tests inject a stub without dragging the full queue (which would
// also drag its disk layout).
export interface PeekableQueue {
  // SHA of `path` as it sits in the LATEST queued batch containing it
  // (its "last commit"). Newest-first is load-bearing — see
  // PushQueue.peekLatestPathSha (TODO §40).
  peekLatestPathSha(path: string): Promise<string | null>;
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
  private readonly hotMeta: HotMetadataStore;
  private readonly baselines: FileBaselinesStore;
  private readonly gi: GI;
  private readonly configDir: string;
  private readonly selfPluginId: string;
  private readonly vaultRoot: string;
  private readonly syncConfigDir: () => boolean;
  private readonly pushPluginsDataJson: () => boolean;
  private readonly logger?: { warn(message: string, data?: unknown): void };
  private readonly queue: PeekableQueue | undefined;
  private readonly conflictBaseSha:
    | ((path: string) => string | null | undefined)
    | undefined;
  private readonly logWalkIncomplete:
    | ((target: string) => void)
    | undefined;
  private readonly hashBlob: (
    bytes: ArrayBuffer,
  ) => Promise<{ sha: string; bytes: ArrayBuffer }>;
  private readonly syncStore: ChangeDetectorDeps["syncStore"];
  private readonly autoCanonicalize: () => boolean;
  private readonly stats: ChangeDetectorDeps["stats"];
  // The opt-in set for the CURRENT operation (DOT-FILES §5). Null until
  // beginScan() runs, and deliberately not lazily filled: "not computed
  // yet" and "lifecycle bug" have to stay distinguishable, or the
  // fail-loud in isSyncable means nothing. It is also why scope is
  // fixed for the whole pass (§3.3) — a mid-scan recompute could read a
  // .gitignore this very drain just pulled.
  private optIn: OptInSet | null = null;
  // Operations with a scope open right now (beginScan/endScan pairs).
  private scanDepth = 0;
  // The last findChanges' breakdown (null before the first one). The
  // in-progress one accumulates in `timing`; a single-path
  // findChangeForPath does not touch either.
  lastScanTiming: ScanTiming | null = null;
  private timing: ScanTiming | null = null;

  constructor(deps: ChangeDetectorDeps) {
    this.vault = deps.vault;
    this.hotMeta = deps.hotMeta;
    this.baselines = deps.baselines;
    this.gi = deps.gi;
    this.configDir = deps.configDir;
    this.selfPluginId = deps.selfPluginId;
    this.vaultRoot = deps.vaultRoot;
    this.syncConfigDir = deps.syncConfigDir;
    this.pushPluginsDataJson = deps.pushPluginsDataJson ?? (() => false);
    this.logger = deps.logger;
    this.queue = deps.queue;
    this.conflictBaseSha = deps.conflictBaseSha;
    this.logWalkIncomplete = deps.logWalkIncomplete;
    this.hashBlob =
      deps.hashBlob ??
      (async (bytes) => ({ sha: await calculateGitBlobSHA(bytes), bytes }));
    this.syncStore = deps.syncStore;
    this.autoCanonicalize = deps.autoCanonicalize ?? (() => false);
    this.stats = deps.stats;
  }

  // Compute the dot-space opt-in set for the operation about to run.
  //
  // Called at the start of EVERY sync operation, not just commit: pull
  // and bootstrap ask isSyncable too, and a pull whose set was never
  // built would silently fail to fetch opted-in dot-content — a
  // one-sided break that only shows up on the second device (§5).
  // findChanges/findChangeForPath call it themselves; the manager calls
  // it for the paths it owns (drain, bootstrap).
  async beginScan(): Promise<void> {
    // COUNTED, before the await (owner's field report, 2026-10-09): a
    // drain and a commit pass may run at the same time (R3b), each with
    // its own scope on this ONE object. An operation ending must not drop
    // the scope under another still scanning — the last one out does.
    this.scanDepth++;
    // §5: drop the matcher's parse of the ROOT level first. The set is
    // read from that file directly (so it is always fresh), but `gi`
    // holds a level by mtime for up to 500 ms, and step 6 asks `gi`.
    // Without this the set and the matcher could answer from different
    // generations of the same file for the first half-second of an
    // operation the user started BECAUSE they just edited it.
    this.gi.invalidate("");
    // readRootGitignore never throws (a failed read is "no file"), so the
    // count cannot be left raised by a failing beginScan.
    this.optIn = await readRootGitignore({
      vault: this.vault,
      configDir: this.configDir,
      syncConfigDir: this.syncConfigDir,
      logger: this.logger,
    });
  }

  // Drop this operation's scope. Load-bearing for the fail-loud: left
  // set, the guard would fire exactly ONCE per process — after the
  // first successful scan every later lifecycle bug would silently
  // reuse the PREVIOUS operation's scope, which is the stale-set state
  // TD7.5 exists to make loud. Always called from a `finally`.
  endScan(): void {
    this.scanDepth = Math.max(0, this.scanDepth - 1);
    if (this.scanDepth === 0) this.optIn = null;
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
  async findChanges(hooks?: ScanHooks): Promise<FileChange[]> {
    const t = emptyTiming();
    this.timing = t;
    const t0 = now();
    await this.beginScan();
    t.beginScanMs = now() - t0;
    try {
      return await this.scan(hooks);
    } finally {
      this.endScan();
      t.totalMs = now() - t0;
      this.lastScanTiming = t;
      this.timing = null;
    }
  }

  private async scan(hooks?: ScanHooks): Promise<FileChange[]> {
    const out: FileChange[] = [];
    const t = this.timing ?? emptyTiming();
    const tEnum = now();
    const watermark = this.hotMeta.getLastCommitMtime();
    const allFiles: FileLike[] = this.vault.getFiles().map((f) => ({
      path: f.path,
      stat: { mtime: f.stat.mtime, size: f.stat.size },
    }));
    t.indexFiles = allFiles.length;
    // Obsidian's file index excludes anything whose name starts with a
    // dot, so `vault.getFiles()` never returns `<vault>/.gitignore` or
    // anything under `<configDir>/`. Dot-space therefore needs its own
    // enumeration — and per D1 that enumeration covers exactly what the
    // opt-in set permits, nothing more:
    //
    //   pass 2 — the named dot-FILES, stat'd by exact path;
    //   pass 3 — the walk TARGETS, listed recursively.
    //
    // This is the other half of D7. Permission and reach are the same
    // set, so there is no way to be permitted here and unreachable.
    const optIn = this.optIn as OptInSet;
    const tDot = now();
    allFiles.push(...(await this.statOptInDotFiles(optIn.dotFiles)));
    // Targets whose walk did NOT finish. Tracked PER TARGET, never as
    // one flag: if `.myconfig` walked cleanly and `<configDir>` threw,
    // a single boolean would protect both — masking real deletions
    // under the target that was fine (§3.3).
    const incompleteTargets = new Set<string>();
    for (const target of optIn.walkTargets) {
      const walked = await walkDotDir(this.vault, target);
      allFiles.push(...walked.files);
      if (!walked.completed) {
        incompleteTargets.add(target);
        this.logWalkIncomplete?.(target);
      }
    }
    const tDotEnd = now();
    // §2.2.1 — Pass 1 walks the files GROUPED BY BASELINE BUCKET, so
    // every bucket is opened exactly once per scan. An unordered walk
    // would page buckets through the 6-slot MRU pathologically (a 20k
    // vault ≈ thousands of bucket re-reads per Commit click). Stable
    // sort (ES2019): bucket id first, original enumeration order
    // within a bucket. Visible form change, same emitted SET: the
    // changes list is now bucket-ordered instead of vault-ordered.
    allFiles.sort((a, b) => {
      const ba = bucketIdForPath(a.path);
      const bb = bucketIdForPath(b.path);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    });
    t.dotEntries = allFiles.length - t.indexFiles;
    // The dot-space part of the enumeration (named files + walks), for
    // the "Committing…" forecast. The sort is not in it.
    this.stats?.recordDot(t.dotEntries, tDotEnd - tDot);
    t.enumerateMs = now() - tEnum;

    // ── STAGE 1 — classify, NO reads (COMMIT-PASS-PERF §3.1) ─────────
    // The same decisions the single read-as-you-go loop used to make,
    // in the same order — but every file that has to be READ goes into
    // `plan` instead of being read on the spot. That is what makes the
    // number of candidates and their bytes known BEFORE the expensive
    // part starts: the commit's forecast and "Checking N of M files"
    // need them up front. Nothing below the line changes WHAT is
    // emitted; only WHEN the reads happen.
    const tPass1 = now();
    // Track syncable paths we examined this pass so Pass 2 can tell
    // apart "snapshot points at a path that's still tracked but
    // unchanged" from "snapshot points at a path that's gone or
    // newly-ignored". Files that exist on disk but are ignored go
    // here too (as ignored entries) so Pass 2 knows to drop their
    // stale snapshot rows silently rather than emit `deleted`.
    const seenSyncable = new Set<string>();
    const seenIgnored = new Set<string>();
    // Stat-cache refreshes discovered during the check — flushed as one
    // grouped setMany after the scan (§2.2.1).
    const statRefreshes: Array<{ path: string } & FileBaseline> = [];
    const plan: PlanItem[] = [];

    // Candidates whose stat.mtime exceeds the watermark.
    // First-ever sync (watermark === null) treats every file as a
    // candidate so the initial bootstrap walks the whole vault once.
    for (const file of allFiles) {
      if (watermark !== null && file.stat.mtime <= watermark) {
        const snap = await this.baselines.get(file.path);
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

      const snap = await this.baselines.get(file.path);
      if (!snap) {
        // Candidate "added". Before emitting, check whether the file
        // is already represented in any pending queue batch with the
        // exact same bytes — if so, it's "committed locally" (waiting
        // for its batch to push) and re-emitting would duplicate work
        // on the very next enqueue. Reading + hashing the bytes is
        // the same cost the upcoming push would pay; we just bring
        // it forward.
        const addConflictRef = this.conflictBaseSha
          ? this.conflictBaseSha(file.path)
          : undefined;
        plan.push(
          this.queue || addConflictRef !== undefined
            ? { kind: "added-check", file, addConflictRef }
            : // No reference to compare against: emitted unhashed, the
              // writer reads it (only without a queue — unit tests).
              { kind: "added-direct", file },
        );
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

      // Stat moved; the check below verifies it's a real content change.
      plan.push({ kind: "modified-check", file, snap });
    }
    t.pass1Ms = now() - tPass1;

    // Pass 2 (still stage 1 — no file reads): baseline paths stage 1
    // didn't claim as still-syncable. It needs only seenSyncable /
    // seenIgnored, so it runs BEFORE the check: the deletions are part
    // of the commit's M. Its emits are still appended AFTER the check's,
    // so the changes list keeps its old order.
    //   - seenIgnored: file exists on disk but is now ignored → silent
    //     cleanup (gitignore is a two-way mute).
    //   - neither seen: file is genuinely gone from disk → emit `deleted`.
    //   - seenSyncable: nothing to do here.
    // §2.2.1 full scan: forEachBucket reads every bucket exactly once
    // (cached buckets served from cache, disk-only ones NOT inserted),
    // removals are collected and flushed as one grouped removeMany.
    const tPass2 = now();
    const deletions: FileChange[] = [];
    const removals: string[] = [];
    await this.baselines.forEachBucket(async (files) => {
      for (const [path, snap] of files) {
        if (seenSyncable.has(path)) continue;
        if (seenIgnored.has(path)) {
          removals.push(path);
          continue;
        }
        // BELT (§3.3), separate from D7 and doing a different job. D7
        // answers "is this path reachable in principle"; this answers
        // "did we actually manage to look, THIS pass". A configured
        // walk target whose walk died half-way leaves its subtree
        // unvisited, and unvisited is indistinguishable from deleted
        // from here — so we conclude NOTHING: no delete, and no
        // baseline removal either, because the row is still true as far
        // as we know. The next pass looks again.
        if (underWalkTarget(path, incompleteTargets)) continue;
        // Path not in vault at all. Could be deleted, or could have
        // become ignored at a path that no longer exists. Re-check
        // syncability one more time: if ignored, drop silently;
        // otherwise emit deleted.
        if (!(await this.checkSyncable(path))) {
          removals.push(path);
          continue;
        }
        deletions.push({
          kind: "deleted",
          path,
          previousRemoteSha: snap.baselineSha,
        });
      }
    });
    if (removals.length > 0) await this.baselines.removeMany(removals);
    t.pass2Ms = now() - tPass2;

    const checks = plan.filter((p) => p.kind !== "added-direct");
    hooks?.onPlan?.({
      checks: checks.length,
      checkBytes: checks.reduce((n, p) => n + p.file.stat.size, 0),
      unhashedAdds: plan.length - checks.length,
      deletions: deletions.length,
    });

    // ── STAGE 2 — check: read + SHA-1 + store the proven changes ──────
    const tCheck = now();
    let checked = 0;
    for (const item of plan) {
      const file = item.file;
      if (item.kind === "added-direct") {
        out.push({
          kind: "added",
          path: file.path,
          size: file.stat.size,
          mtime: file.stat.mtime,
        });
        continue;
      }
      const emitted = await this.checkOne(item, statRefreshes);
      checked += 1;
      hooks?.onChecked?.(checked, checks.length);
      if (emitted !== null) out.push(emitted);
    }
    t.checkMs = now() - tCheck;

    out.push(...deletions);
    if (statRefreshes.length > 0) await this.baselines.setMany(statRefreshes);
    return out;
  }

  // Stage 2 for ONE planned candidate: read, hash, compare against the
  // file's last committed state, store a proven change. Returns the
  // change to emit, or null (unchanged, or vanished mid-walk). The
  // logic is exactly the old in-loop body.
  private async checkOne(
    item: Exclude<PlanItem, { kind: "added-direct" }>,
    statRefreshes: Array<{ path: string } & FileBaseline>,
  ): Promise<FileChange | null> {
    const file = item.file;
    if (item.kind === "added-check") {
      const addConflictRef = item.addConflictRef;
      const h = await this.hashCandidate(file.path);
      if (h === null) return null; // SYNC2 §6 skip-class — vanished mid-walk
      const inQueueSha = this.queue
        ? await this.queue.peekLatestPathSha(file.path)
        : null;
      // Conflict base (§26): unchanged iff it matches its branch value
      // or the last queued commit — never main. Else: plain dedup.
      // A pending canonical write-back is a change either way.
      const ref =
        addConflictRef !== undefined
          ? (inQueueSha ?? addConflictRef)
          : inQueueSha;
      if (h.sha === ref && !h.needsWriteBack) return null;
      return {
        kind: "added",
        path: file.path,
        size: file.stat.size,
        mtime: file.stat.mtime,
        ...(await this.storeProven(h)),
      };
    }

    const snap = item.snap;
    // Stat moved; verify it's a real content change.
    const h = await this.hashCandidate(file.path);
    if (h === null) return null; // SYNC2 §6 skip-class — vanished mid-walk
    const sha = h.sha;

    // The file's LAST COMMITTED state is the newest queued batch that
    // holds it (a pending local commit), falling back to the last
    // PUSHED sha (snapshot.remoteSha) only when nothing is queued.
    // "Changed" = differs from that reference. Comparing against the
    // queue-latest (not just the snapshot) is what makes a REVERT to
    // the last-pushed bytes correctly count as a change when a newer,
    // different version is already queued but hasn't pushed (TODO §40:
    // add char → commit → remove char → must commit the revert, even
    // though it matches the last push). It ALSO subsumes the plain
    // dedup (unchanged since the last commit → skip).
    const queuedSha = this.queue
      ? await this.queue.peekLatestPathSha(file.path)
      : null;

    // TODO §26 — a tracked-conflict base lives on the CONFLICT BRANCH,
    // not main. Its "changed?" reference is the last value pushed there
    // (conflictBaseSha), or the last queued commit if one is pending.
    // snap.remoteSha (main) is NOT a valid unchanged-reference here —
    // the base differs from main by nature, so comparing against it
    // re-committed the unchanged base to the branch on EVERY sync. An
    // edited base differs from its branch value → committed once (then
    // pushConflictPathsToBranch advances branchBaseSha).
    const conflictRef = this.conflictBaseSha
      ? this.conflictBaseSha(file.path)
      : undefined;
    if (conflictRef !== undefined) {
      // unchanged vs branch (and already canonical on disk)
      if (sha === (queuedSha ?? conflictRef) && !h.needsWriteBack) return null;
      return {
        kind: "modified",
        path: file.path,
        size: file.stat.size,
        mtime: file.stat.mtime,
        previousRemoteSha: snap.baselineSha,
        ...(await this.storeProven(h)),
      };
    }

    const lastCommittedSha = queuedSha ?? snap.baselineSha;
    // A pending canonical write-back keeps the file a change even when
    // its canonical sha matches — the same verdict the raw-byte hash
    // gave before the detector canonicalized (COMMIT-PASS-PERF Крок 2).
    if (sha === lastCommittedSha && !h.needsWriteBack) {
      // Unchanged since the last commit. When it also matches the
      // pushed remote (nothing pending, or the pending IS the remote),
      // refresh the stat-cache so later walks short-circuit cheaply.
      // Collected and flushed as ONE grouped setMany after the scan
      // (§2.2.1) — a per-file write-through here would re-write the
      // same bucket once per touched file.
      if (sha === snap.baselineSha) {
        statRefreshes.push({
          path: file.path,
          ...snap,
          mtime: file.stat.mtime,
          size: file.stat.size,
        });
      }
      return null;
    }

    return {
      kind: "modified",
      path: file.path,
      size: file.stat.size,
      mtime: file.stat.mtime,
      previousRemoteSha: snap.baselineSha,
      ...(await this.storeProven(h)),
    };
  }

  // Classify a single path the same way findChanges() would, but
  // without scanning the whole vault. Used by Sync2Manager.syncFile
  // (Action 2/3) to build a one-file batch for the active note.
  // Returns null when the path has no work to push: identical to
  // snapshot, missing on both sides, ignored, or hardcoded-blocked.
  async findChangeForPath(path: string): Promise<FileChange | null> {
    // syncFile (the one-file ribbon action) is its own operation, so it
    // establishes its own scope — otherwise it would be the fail-loud's
    // first victim rather than its beneficiary.
    await this.beginScan();
    try {
      return await this.changeForPath(path);
    } finally {
      this.endScan();
    }
  }

  private async changeForPath(path: string): Promise<FileChange | null> {
    if (!(await this.checkSyncable(path))) return null;

    const stat = await this.vault.adapter.stat(path);
    const snap = await this.baselines.get(path);

    if (!stat) {
      if (!snap) return null;
      return {
        kind: "deleted",
        path,
        previousRemoteSha: snap.baselineSha,
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

    const h = await this.hashCandidate(path);
    if (h === null) return null; // SYNC2 §6 skip-class — vanished mid-detect
    if (h.sha === snap.baselineSha && !h.needsWriteBack) {
      // Touched but unchanged — refresh stat so future calls
      // short-circuit (write-through persists it), then report
      // "nothing to do".
      await this.baselines.set(path, {
        ...snap,
        mtime: stat.mtime,
        size: stat.size,
      });
      return null;
    }

    return {
      kind: "modified",
      path,
      size: stat.size,
      mtime: stat.mtime,
      previousRemoteSha: snap.baselineSha,
      ...(await this.storeProven(h)),
    };
  }

  // Called by Sync2Manager after a successful upload of `path` with the
  // new GitHub blob SHA. Re-stats the file so subsequent findChanges()
  // short-circuits via the baseline stat-cache. Single-path variant for
  // call sites with network round-trips between paths (adoption); batch
  // epilogues MUST use recordSyncMany (§2.2.1).
  async recordSync(path: string, newBaselineSha: string): Promise<void> {
    await this.recordSyncMany([{ path, sha: newBaselineSha }]);
  }

  // Grouped variant (§2.2.1): re-stats every path, then lands all
  // baselines with ONE bucket-grouped setMany (and one removeMany for
  // paths that vanished between push and record).
  async recordSyncMany(
    entries: Array<{ path: string; sha: string }>,
  ): Promise<void> {
    const sets: Array<{ path: string } & FileBaseline> = [];
    const gone: string[] = [];
    for (const { path, sha } of entries) {
      const stat = await this.vault.adapter.stat(path);
      if (!stat) {
        gone.push(path);
        continue;
      }
      sets.push({
        path,
        baselineSha: sha,
        mtime: stat.mtime,
        size: stat.size,
      });
    }
    if (sets.length > 0) await this.baselines.setMany(sets);
    if (gone.length > 0) await this.baselines.removeMany(gone);
  }

  // Called after remote-driven deletions are applied locally. Grouped
  // (§2.2.1) — the batch epilogue passes all of a batch's deletions at
  // once.
  async recordDeletions(paths: string[]): Promise<void> {
    if (paths.length > 0) await this.baselines.removeMany(paths);
  }

  // Public so Sync2Manager.pullIfNeeded can ask the same question for
  // remote-driven paths arriving via compare(). Same predicate that
  // findChanges/findChangeForPath consult internally.
  async checkSyncable(path: string): Promise<boolean> {
    // PLUGIN-UPDATE-COMPAT §5.3 — a plugin update held back for this
    // Obsidian is invisible to sync in BOTH directions, and this one
    // insertion is the whole mechanism: every caller reaches the
    // predicate through here (Pass 1, Pass 2, findChangeForPath, and
    // the drain via main.ts's `isSyncable` dep), so pull discovery and
    // the push scan go blind together.
    //
    // ⚠️ The symmetry is a REQUIREMENT, not a convenience. Under a hold
    // the only version a user can install by hand is a compatible one —
    // i.e. an OLDER one — and a pull-side-only filter would let it
    // travel to the repo and roll the update back on every device that
    // was fine.
    if (isHeldPath(path, this.configDir, this.hotMeta.getHeldPluginUpdates())) {
      return false;
    }
    return isSyncable(
      path,
      this.configDir,
      this.selfPluginId,
      this.syncConfigDir(),
      this.gi,
      this.giReader,
      this.optIn,
      this.pushPluginsDataJson(),
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
  // Read one candidate, bring it to the form a commit records
  // (canonicalizeBytes — the SAME transform BatchWriter applies) and
  // hash that. null = vanished mid-walk (readBinaryOrSkip).
  private async hashCandidate(path: string): Promise<HashedCandidate | null> {
    const t = this.timing;
    const tRead = now();
    const raw = await this.readBinaryOrSkip(path);
    const readMs = now() - tRead;
    if (t) t.readMs += readMs;
    if (raw === null) return null;
    this.stats?.record("read", raw.byteLength, readMs);
    const canon = canonicalizeBytes(
      raw,
      shouldCanonicalize(path, this.configDir) && this.autoCanonicalize(),
    );
    // Only the RETURNED buffer is live: hashBlob may have moved
    // canon.bytes (and `raw`, the same object when nothing was
    // canonicalized) to the worker.
    const size = canon.bytes.byteLength; // before hashBlob may move it
    const tHash = now();
    const { sha, bytes } = await this.hashBlob(canon.bytes);
    const hashMs = now() - tHash;
    this.stats?.record("hash", size, hashMs);
    if (t) {
      const ms = hashMs;
      t.candidates += 1;
      t.candidateBytes += size;
      t.hashMs += ms;
      if (size >= WorkerClient.SHA_WORKER_THRESHOLD) {
        t.hashedLarge += 1;
        t.hashLargeMs += ms;
      }
    }
    return { sha, bytes, needsWriteBack: canon.changed };
  }

  // COMMIT-PASS-PERF Крок 2 — store the bytes of a PROVEN change while
  // we still hold them, and hand their sha + length to the FileChange.
  // Returns nothing (the writer reads the file itself, as before) when
  // no store is wired, or when the live file still needs its canonical
  // write-back: the scan never writes to the vault, the writer does.
  //
  // This is what closes the hash→store TOCTOU: the bytes stored are the
  // bytes hashed, so there is no second read for the file to change
  // under.
  private async storeProven(
    h: HashedCandidate,
  ): Promise<{ sha?: string; size?: number }> {
    if (!this.syncStore || h.needsWriteBack) return {};
    // retain, not a plain write: the bytes may ALREADY be in the store
    // (a revert to pushed content) and a sweep may be about to reap them
    // — COMMIT-PASS-PERF §6.1, case D. Pinned as the commit pass's; the
    // pass releases its pins once its metafiles are written.
    const tStore = now();
    await this.syncStore.retain(PIN_OWNER_COMMIT, h.sha, async () => h.bytes);
    const t = this.timing;
    if (t) {
      t.storeMs += now() - tStore;
      t.stored += 1;
      t.storedBytes += h.bytes.byteLength;
    }
    return { sha: h.sha, size: h.bytes.byteLength };
  }

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

  // Pass 2: the opt-in set's dot-FILES, stat'd by their exact path.
  //
  // This replaced `walkRootDotfiles`, which listed the vault root and
  // took EVERY dotfile it found. That made dot-space default-VISIBLE at
  // the root — the opposite of D1 — and it is why `.editorconfig` or
  // `.gitattributes` used to travel without anyone asking. Now a root
  // dotfile syncs when a `!`-rule names it, and not before.
  //
  // A missing file is not an error: the user may have written the rule
  // before creating the file.
  private async statOptInDotFiles(paths: Iterable<string>): Promise<FileLike[]> {
    const out: FileLike[] = [];
    for (const p of paths) {
      const stat = await this.vault.adapter.stat(p);
      if (!stat || stat.type !== "file") continue;
      out.push({ path: p, stat: { mtime: stat.mtime, size: stat.size } });
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
