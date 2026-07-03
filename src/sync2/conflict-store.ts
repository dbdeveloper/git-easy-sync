// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";
import { stagingPathFor } from "./atomic-write";
import { safeRename } from "./cross-platform";

// ConflictStore — a single source of truth for every active conflict
// on this device. `inConflictFiles` is derived on the fly from the
// records here; callers must NOT keep a parallel persistent set.
// See docs/PSEUDO-MERGE-MODE.md §4.2 for the sibling-file pattern
// and §9.4 for the create() protocol.
//
// On-disk layout (one folder per record):
//
//   <configDir>/plugins/<self>/.conflicts/
//     <recordId>/
//       meta.json          ← ConflictRecord JSON (atomically written)
//
// The sibling file itself lives in the vault next to the original:
//
//   <basename>.conflict-from-<deviceLabel>-<isoTs>.<ext>
//
// During create(), the sibling is staged at vault level as a
// `.sync-tmp` pre-suffix file (e.g., `note.conflict-from-Phone-...sync-tmp.md`)
// and atomically renamed to its final name. Crash-recovery is handled
// by AtomicWriteRecovery.sweep() via ownership dispatch on .sync-tmp.

const CONFLICTS_DIRNAME = ".runtime/conflicts";
const META_FILE = "meta.json";
const META_TMP_FILE = "meta.json.tmp";

// Two kinds: modify-vs-modify (both sides edited) and delete-vs-modify
// (local deleted, remote modified). The third theoretical kind —
// modify-vs-delete (local modified, remote deleted) — is NOT a
// conflict per the plugin's design: the modified side always wins,
// "resurrecting" the file on remote when push reaches it. The user's
// reasoning: they had a reason to modify (rather than delete) the
// file, so their decision overrides the other device's deletion.
export type ConflictKind = "modify-vs-modify" | "delete-vs-modify";

export interface ConflictRecord {
  // crypto.randomUUID() — unique enough that collision is impossible
  // at any reasonable scale (≤10s of active conflicts).
  id: string;
  vaultPath: string;
  kind: ConflictKind;

  // ── Immutable identity (set at creation; never updated) ──────────────
  // Used for dedup at create() — the same (vaultPath, theirsBlobSha)
  // pair returns the existing record instead of spawning a duplicate.
  // `oursBlobSha` is null only for kind=delete-vs-modify (local
  // deleted, so there's no "ours" blob to track). `theirsBlobSha` is
  // always non-null; both remaining kinds carry a remote version.
  oursBlobSha: string | null;
  theirsBlobSha: string;
  remoteDevice: string;
  createdAt: number;

  // ── Sibling location + content cache ───────────────────────────────
  siblingPath: string;
  // mtime + size act as a watermark: when stat() shows them unchanged,
  // siblingSha is trusted as-is and no read+hash happens
  // (findChanges-style cache). On change → re-read + re-hash, then
  // refresh all three fields together.
  siblingMtime: number;
  siblingSize: number;
  siblingSha: string;

  // ── Base location + content cache ──────────────────────────────────
  // All three null when the base file does not exist on disk
  // (kind=delete-vs-modify initial state OR after the user deleted base
  // in any kind). Otherwise, treated identically to sibling cache.
  baseMtime: number | null;
  baseSize: number | null;
  baseSha: string | null;

  lastEvaluated: number;
}

export interface ConflictStoreDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  // Override clock for deterministic tests.
  now?: () => number;
  // Override id generation for deterministic tests.
  idFactory?: () => string;
}

// Arguments for create(). Caller (pull-side or reconcile-side) supplies
// the SHA pair from the source of truth it already has on hand —
// ConflictStore does NOT re-read the vault to compute them.
export interface CreateArgs {
  vaultPath: string;
  kind: ConflictKind;
  // Bytes that should land in the vault sibling. Always non-empty
  // — both remaining kinds (modify-vs-modify, delete-vs-modify)
  // carry remote content the user needs to see.
  theirsContent: ArrayBuffer;
  theirsBlobSha: string;
  // `oursBlobSha` is null only for kind=delete-vs-modify (local was
  // deleted, no "ours" blob to track).
  oursBlobSha: string | null;
  // Current base file's (mtime, size, sha) at create-time; all three
  // null if base does not exist.
  baseMtime: number | null;
  baseSize: number | null;
  baseSha: string | null;
  remoteDevice: string;
}

// Optional partial update for cache fields. Used by classifier
// when stat reveals a user-edited sibling or base. Routed through the
// metaWriteQueue to serialize concurrent updates.
export interface CacheUpdate {
  siblingMtime?: number;
  siblingSize?: number;
  siblingSha?: string;
  baseMtime?: number | null;
  baseSize?: number | null;
  baseSha?: string | null;
  lastEvaluated?: number;
}

export default class ConflictStore {
  private readonly vault: Vault;
  private readonly conflictsRoot: string;
  private readonly nowFn: () => number;
  private readonly idFactory: () => string;
  // Primary index: id → record.
  private records: Map<string, ConflictRecord> = new Map();
  // Secondary index: vaultPath → Set<id>. Lets callers ask
  // "is this path in conflict?" or fetch all siblings for a path in
  // O(1) lookup + O(k) walk, where k = number of siblings on that path.
  private byPath: Map<string, Set<string>> = new Map();
  // Tertiary index: siblingPath → recordId. Drives ConflictWatcher's
  // fast-path event check ("is this vault event touching a sibling?")
  // in O(1). Sibling paths are unique per record by construction
  // (timestamp+ms suffix), so the map is 1-to-1.
  private bySibling: Map<string, string> = new Map();
  // Serializes meta-file rewrites so concurrent updateCache calls
  // (classifier scanning records in parallel) don't clobber
  // each other. Same pattern as push-queue's recordBlobUpload.
  private metaWriteQueue: Promise<void> = Promise.resolve();

  constructor(deps: ConflictStoreDeps) {
    this.vault = deps.vault;
    this.conflictsRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/${CONFLICTS_DIRNAME}`;
    this.nowFn = deps.now ?? (() => Date.now());
    this.idFactory = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // Walk .conflicts/*/meta.json into memory + run the per-crash-window
  // recovery sweep. Idempotent — re-running after vault mutations
  // refreshes the index without leaking stale entries.
  //
  // Recovery semantics for in-progress create() steps that crashed:
  //   - meta.json missing       → step-1 crash, rmdir recordDir
  //   - meta.json corrupt JSON  → skip (don't rmdir; let user notice)
  //   - else                    → index normally
  //
  // load() does NOT touch the vault filesystem (see
  // docs/PSEUDO-MERGE-MODE.md §9.7). Missing vault siblings — including
  // ones the user deleted externally — are NOT resurrected here.
  // The drain-start Phase B sweep sees `!siblingExists` on each
  // affected record and drops it on the next sync; that's the
  // resolution signal.
  async load(): Promise<void> {
    this.records.clear();
    this.byPath.clear();
    this.bySibling.clear();
    if (!(await this.vault.adapter.exists(this.conflictsRoot))) return;
    const { folders } = await this.vault.adapter.list(this.conflictsRoot);
    for (const folder of folders) {
      const metaPath = `${folder}/${META_FILE}`;
      // Recovery window 1: meta.json absent → step-1 crash. The whole
      // dir is orphan staging — drop it. The conflict will be re-detected
      // when pull/reconcile next sees the SHA divergence.
      if (!(await this.vault.adapter.exists(metaPath))) {
        await this.vault.adapter.rmdir(folder, true);
        continue;
      }
      let record: ConflictRecord | null = null;
      try {
        const text = await this.vault.adapter.read(metaPath);
        const raw = JSON.parse(text) as Record<string, unknown>;
        record = coerceRecord(raw);
      } catch {
        // JSON parse failed or coerce rejected. Leave the recordDir in
        // place (it's user-visible state — don't silently delete it),
        // just skip indexing.
        record = null;
      }
      if (record === null) continue;
      // Do NOT consult the vault filesystem here — the record is
      // indexed exactly as persisted. Drain-start Phase B is the
      // authoritative reconciliation point (§9.7 of the spec).
      this.indexRecord(record);
    }
  }

  // Create a new conflict record using the 3-step atomic protocol
  // documented in docs/PSEUDO-MERGE-MODE.md §9.4 (Path B):
  //
  //   1. writeBinary(<sibling>.sync-tmp.<ext>, theirsContent)
  //   2. atomic write of meta.json via .tmp + rename (persistRecord)
  //   3. atomic rename staging → siblingPath
  //
  // Dedup: callers retry on the same (vaultPath, theirsBlobSha) freely.
  // If a record with that pair already exists, this returns it without
  // touching the disk.
  async create(args: CreateArgs): Promise<ConflictRecord> {
    const existing = this.findDuplicate(args.vaultPath, args.theirsBlobSha);
    if (existing) return existing;

    // Filesystem-orphan adoption: scan the parent directory of
    // vaultPath for `<stem>.conflict-from-*<ext>` files whose
    // content SHA matches theirsBlobSha. Match → adopt
    // the orphan: build the record pointing at the existing file and
    // skip the vault writeBinary in step 3 below.
    const orphan = await this.findOrphanSibling(
      args.vaultPath,
      args.theirsBlobSha,
    );

    const id = this.idFactory();
    const ts = this.nowFn();
    const siblingPath =
      orphan?.path ??
      buildSiblingPath(args.vaultPath, args.remoteDevice, ts, args.kind);

    // Sibling SHA is the git-blob hash of the content. Fresh create:
    // hash the incoming bytes (== args.theirsBlobSha per contract).
    // Adoption: reuse the orphan's already-computed SHA (== theirsBlobSha).
    const siblingSha = orphan?.sha ?? (await calculateGitBlobSHA(args.theirsContent));

    const recordDir = `${this.conflictsRoot}/${id}`;
    const stagingPath = stagingPathFor(siblingPath, "tmp");

    // Vault-level `.sync-tmp` staging — `.sync-tmp` carries NEW bytes
    // destined for a not-yet-existing target. (`.sync-bak` is the
    // rollback-target suffix used by atomicWriteFile for backups of
    // files that already existed; sibling registration writes a
    // brand-new file so it uses tmp, not bak. See
    // docs/PSEUDO-MERGE-MODE.md §9.1 for the suffix roles.)
    //
    // Adoption skips Steps 1 + 3: the sibling file already lives at
    // siblingPath, no need to stage or rename.

    // ── Step 1: stage content (skip for adoption) ──────────────────
    await this.ensureDir(this.conflictsRoot);
    await this.ensureDir(recordDir);
    if (!orphan) {
      await this.ensureParentDir(stagingPath);
      await this.vault.adapter.writeBinary(stagingPath, args.theirsContent);
    }

    // ── Step 2: persist meta.json ──────────────────────────────────
    // Build the record. siblingMtime/Size gets final values in step 3
    // after the rename lands; for now we seed with the size of the
    // bytes we just wrote.
    const record: ConflictRecord = {
      id,
      vaultPath: args.vaultPath,
      kind: args.kind,
      oursBlobSha: args.oursBlobSha,
      theirsBlobSha: args.theirsBlobSha,
      remoteDevice: args.remoteDevice,
      createdAt: ts,
      siblingPath,
      siblingMtime: 0,
      siblingSize: args.theirsContent.byteLength,
      siblingSha,
      baseMtime: args.baseMtime,
      baseSize: args.baseSize,
      baseSha: args.baseSha,
      lastEvaluated: ts,
    };
    await this.persistRecord(recordDir, record);

    // ── Step 3: atomic rename staging → siblingPath (skip for adoption)
    if (!orphan) {
      // Capacitor's rename throws on existing destination — clean any
      // stale file (e.g., the orphan-adoption path was checked, but a
      // bytes-identical sibling appeared between then and now) before
      // rename. Cross-platform-safe.
      if (await this.vault.adapter.exists(siblingPath)) {
        await this.vault.adapter.remove(siblingPath);
      }
      await this.vault.adapter.rename(stagingPath, siblingPath);
    }

    // Index the record NOW, before the optional stat refresh. If the
    // refresh throws (it's a best-effort cache hygiene, not a
    // correctness step), the record still lands in the in-memory index
    // so future create() calls with the same identity short-circuit
    // via findDuplicate instead of spawning another orphan record.
    this.indexRecord(record);

    // Best-effort cache refresh: real mtime/size from the just-written
    // vault sibling, persisted to meta.json. Failures here don't break
    // correctness — the classifier's stat-vs-cache check will detect
    // the staleness and re-hash on its next sweep.
    try {
      const stat = await this.vault.adapter.stat(siblingPath);
      if (stat) {
        record.siblingMtime = stat.mtime;
        record.siblingSize = stat.size;
        await this.persistRecord(recordDir, record);
      }
    } catch {
      // Swallowed: the record is already indexed; stat refresh is
      // strictly an optimization.
    }
    return record;
  }

  // Scan the parent directory of vaultPath for orphan sibling files
  // — entries named `<stem>.conflict-from-*<ext>` with no
  // corresponding ConflictStore record pointing at them. Returns the
  // first one whose content SHA matches `theirsBlobSha`, or null.
  //
  // The "no corresponding record" check skips siblings already
  // adopted via a record in this store (`this.bySibling`). That
  // way an in-flight conflict's own sibling can't be re-adopted as
  // its own orphan.
  private async findOrphanSibling(
    vaultPath: string,
    theirsBlobSha: string,
  ): Promise<{ path: string; sha: string } | null> {
    const slash = vaultPath.lastIndexOf("/");
    const parent = slash > 0 ? vaultPath.substring(0, slash) : "";
    const basename = slash > 0 ? vaultPath.substring(slash + 1) : vaultPath;
    const ext = extensionOf(vaultPath);
    const stem =
      ext === "" ? basename : basename.substring(0, basename.length - ext.length);
    const namePrefix = `${stem}.conflict-from-`;

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.vault.adapter.list(parent === "" ? "/" : parent);
    } catch {
      return null;
    }

    for (const filePath of listing.files) {
      const fileName =
        filePath.lastIndexOf("/") >= 0
          ? filePath.substring(filePath.lastIndexOf("/") + 1)
          : filePath;
      if (!fileName.startsWith(namePrefix)) continue;
      if (ext !== "" && !fileName.endsWith(ext)) continue;
      if (this.bySibling.has(filePath)) continue;

      let candidate: ArrayBuffer;
      try {
        candidate = await this.vault.adapter.readBinary(filePath);
      } catch {
        continue;
      }
      const sha = await calculateGitBlobSHA(candidate);
      if (sha === theirsBlobSha) {
        return { path: filePath, sha };
      }
    }
    return null;
  }

  // Patch cache fields and re-persist. Routed through metaWriteQueue
  // so concurrent callers (multiple records evaluated in parallel by
  // the classifier) don't clobber each other's writes. Returns
  // the new record state.
  async updateCache(
    id: string,
    patch: CacheUpdate,
  ): Promise<ConflictRecord | null> {
    const next = this.metaWriteQueue.then(async () => {
      const record = this.records.get(id);
      if (!record) return null;
      Object.assign(record, patch);
      const recordDir = `${this.conflictsRoot}/${id}`;
      await this.persistRecord(recordDir, record);
      return { ...record };
    });
    // Swallow errors on the chained queue value so one bad write
    // doesn't poison every subsequent update. Caller still gets the
    // outcome of its own call.
    this.metaWriteQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Remove a record and its on-disk footprint (recordDir). Does
  // NOT remove the vault sibling — the
  // classifier the classifierdecides whether the sibling should stay
  // (case 4 user copied content over → leave vault sibling for user
  // to clean up; case 1 user already deleted sibling → no-op).
  async delete(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    const dir = `${this.conflictsRoot}/${id}`;
    if (await this.vault.adapter.exists(dir)) {
      await this.vault.adapter.rmdir(dir, true);
    }
    this.unindexRecord(record);
  }

  // Drop every record and every recordDir on disk. Used by the Reset
  // settings button + by Sync2Manager when reconcileRemoteIdentity
  // detects the user pointed the plugin at a different
  // (owner, repo, branch).
  //
  // Does NOT touch vault sibling files — that's the caller's job via
  // renameVaultSiblingsToUnresolved() when the trigger is Reset
  // — siblings get renamed via renameVaultSiblingsToUnresolved()
  // before clearAll() — or no-op when the trigger is repo switch.
  // (Vault siblings stay as live conflicts against the new remote.)
  async clearAll(): Promise<void> {
    this.records.clear();
    this.byPath.clear();
    this.bySibling.clear();
    if (await this.vault.adapter.exists(this.conflictsRoot)) {
      await this.vault.adapter.rmdir(this.conflictsRoot, true);
    }
  }

  // Reset-only: walk the vault for sibling files matching
  // `*.conflict-from-*` and rename each to
  // `<stem>.unresolved-<original-ts>.<ext>`. Decouples the rename
  // from clearAll so the repo-switch path can wipe records without
  // disturbing user-visible files. Returns count renamed.
  //
  // Mobile/Capacitor safety: rename throws if destination exists, so
  // we skip silently when a stale `.unresolved-*` artifact is already
  // there (user's prior reset that didn't get pushed yet).
  async renameVaultSiblingsToUnresolved(): Promise<number> {
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.vault.adapter.list(dir);
      } catch {
        return;
      }
      for (const filePath of listing.files) {
        const slash = filePath.lastIndexOf("/");
        const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
        const renamed = unresolvedNameFor(fileName);
        if (renamed === null) continue;
        const dirPart = slash >= 0 ? filePath.slice(0, slash + 1) : "";
        const newPath = `${dirPart}${renamed}`;
        try {
          if (await this.vault.adapter.exists(newPath)) continue;
          await this.vault.adapter.rename(filePath, newPath);
          count++;
        } catch {
          // Best-effort; a partial reset is acceptable.
        }
      }
      for (const sub of listing.folders) {
        await walk(sub);
      }
    };
    await walk("/");
    return count;
  }

  // ── Quick-access queries ────────────────────────────────────────────

  get(id: string): ConflictRecord | undefined {
    return this.records.get(id);
  }

  getByPath(vaultPath: string): ConflictRecord[] {
    const ids = this.byPath.get(vaultPath);
    if (!ids) return [];
    const out: ConflictRecord[] = [];
    for (const id of ids) {
      const rec = this.records.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  getAll(): ConflictRecord[] {
    return [...this.records.values()];
  }

  hasPending(vaultPath: string): boolean {
    const set = this.byPath.get(vaultPath);
    return set !== undefined && set.size > 0;
  }

  // O(1) sibling lookup — drives ConflictWatcher's fast-path check.
  // Returns the record whose siblingPath equals the argument, or
  // undefined when the path is not a known sibling.
  getBySibling(siblingPath: string): ConflictRecord | undefined {
    const id = this.bySibling.get(siblingPath);
    if (id === undefined) return undefined;
    return this.records.get(id);
  }

  hasSibling(siblingPath: string): boolean {
    return this.bySibling.has(siblingPath);
  }

  // Derived inConflictFiles set, computed on every call. Cheap because
  // it's just the byPath keys. NOT persisted separately — records
  // are the single source of truth.
  pathSet(): Set<string> {
    return new Set(this.byPath.keys());
  }

  // ── Internals ──────────────────────────────────────────────────────

  private findDuplicate(
    vaultPath: string,
    theirsBlobSha: string | null,
  ): ConflictRecord | null {
    const ids = this.byPath.get(vaultPath);
    if (!ids) return null;
    for (const id of ids) {
      const rec = this.records.get(id);
      if (!rec) continue;
      if (rec.theirsBlobSha === theirsBlobSha) return rec;
    }
    return null;
  }

  private indexRecord(record: ConflictRecord): void {
    this.records.set(record.id, record);
    let set = this.byPath.get(record.vaultPath);
    if (!set) {
      set = new Set();
      this.byPath.set(record.vaultPath, set);
    }
    set.add(record.id);
    this.bySibling.set(record.siblingPath, record.id);
  }

  private unindexRecord(record: ConflictRecord): void {
    this.records.delete(record.id);
    const set = this.byPath.get(record.vaultPath);
    if (set) {
      set.delete(record.id);
      if (set.size === 0) this.byPath.delete(record.vaultPath);
    }
    this.bySibling.delete(record.siblingPath);
  }

  // Atomic write to <recordDir>/meta.json via .tmp + rename.
  // Obsidian's adapter.rename is OS-level atomic when both paths
  // share the same filesystem (always true here — both are inside
  // the vault).
  private async persistRecord(
    recordDir: string,
    record: ConflictRecord,
  ): Promise<void> {
    const tmpPath = `${recordDir}/${META_TMP_FILE}`;
    const finalPath = `${recordDir}/${META_FILE}`;
    await this.vault.adapter.write(tmpPath, JSON.stringify(record));
    // Capacitor portability via the centralised helper
    // (cross-platform.ts § safeRename). Historical context: the
    // bug that motivated extracting this helper was the second
    // persistRecord call inside create() — after sibling writing
    // refreshed mtime/size, the rename re-attempt collided with
    // the existing meta.json on mobile and produced phantom
    // duplicate conflict records because indexRecord never ran.
    await safeRename(this.vault.adapter, tmpPath, finalPath);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    if (!(await this.vault.adapter.exists(dirPath))) {
      await this.vault.adapter.mkdir(dirPath);
    }
  }

  private async ensureParentDir(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const parent = filePath.substring(0, slash);
    if (await this.vault.adapter.exists(parent)) return;
    // adapter.mkdir is non-recursive on some platforms; build a step
    // at a time.
    const parts = parent.split("/");
    let acc = "";
    for (const part of parts) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await this.vault.adapter.exists(acc))) {
        await this.vault.adapter.mkdir(acc);
      }
    }
  }
}

// ── Sibling-path helpers (exported for tests + classifier) ────

// Strip the trailing extension (".md", ".png", ...) — empty string when
// the basename has none. Returns the dot too so callers can append
// without conditional logic: `${base}.conflict-...${extensionOf(p)}`.
export function extensionOf(vaultPath: string): string {
  const slash = vaultPath.lastIndexOf("/");
  const basename = slash === -1 ? vaultPath : vaultPath.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return ""; // no extension OR dotfile like ".gitignore"
  return basename.slice(dot);
}

// Build the sibling vault path. Same shape for both remaining
// kinds:
//   "<dir>/<base>.conflict-from-<label>-<isoTs>.<ext>"
//
// The `kind` parameter is accepted (rather than dropped) so that
// future additions to ConflictKind can vary the shape without
// breaking the call sites.
export function buildSiblingPath(
  vaultPath: string,
  remoteDevice: string,
  ts: number,
  _kind: ConflictKind,
): string {
  const slash = vaultPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : vaultPath.slice(0, slash + 1);
  const basename = slash === -1 ? vaultPath : vaultPath.slice(slash + 1);
  const ext = extensionOf(vaultPath);
  const stem = ext === "" ? basename : basename.slice(0, -ext.length);
  // Filesystem-safe label: parens and colons replaced; whitespace OK.
  const safeLabel = remoteDevice.replace(/\(/g, "[").replace(/\)/g, "]");
  const iso = new Date(ts).toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  return `${dir}${stem}.conflict-from-${safeLabel}-${iso}${ext}`;
}

// Reset-time helper: given a sibling filename of the shape
// `<stem>.conflict-from-<label>-<isoTs><ext>` produced by
// buildSiblingPath, return the rewritten "unresolved" form
// `<stem>.unresolved-<isoTs><ext>` — dropping the device label so
// the rename survives across plugin re-enables on different
// devices. The `<isoTs>` segment is anchored on buildSiblingPath's
// exact shape (YYYY-MM-DDTHH-MM-SSZ); names that don't match
// return null so the reset walker leaves unrelated files alone.
export function unresolvedNameFor(filename: string): string | null {
  const m = filename.match(
    /^(.+?)\.conflict-from-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(\..+)?$/,
  );
  if (!m) return null;
  const [, stem, ts, ext = ""] = m;
  return `${stem}.unresolved-${ts}${ext}`;
}

// ── Defensive load coercion ────────────────────────────────────────────

const VALID_KINDS: ReadonlySet<ConflictKind> = new Set<ConflictKind>([
  "modify-vs-modify",
  "delete-vs-modify",
]);

// Sanitize a JSON-parsed record. Returns null when required identity
// fields are missing or malformed; coerces optional fields to safe
// defaults. The strict-vs-lenient line follows SnapshotStore.migrate's
// example: identity (id/vaultPath/kind/siblingPath) is strict, cache
// fields are lenient.
function coerceRecord(raw: Record<string, unknown>): ConflictRecord | null {
  const id = stringOrNull(raw.id);
  const vaultPath = stringOrNull(raw.vaultPath);
  const kindRaw = stringOrNull(raw.kind);
  const siblingPath = stringOrNull(raw.siblingPath);
  if (id === null || vaultPath === null || siblingPath === null) return null;
  if (kindRaw === null || !VALID_KINDS.has(kindRaw as ConflictKind)) return null;
  const kind = kindRaw as ConflictKind;
  return {
    id,
    vaultPath,
    kind,
    oursBlobSha: stringOrNull(raw.oursBlobSha),
    // Both remaining kinds always carry a non-null theirsBlobSha.
    // If the persisted JSON is missing or non-string, reject the
    // record (defensive coerce returns null, caller skips it).
    theirsBlobSha: (() => {
      const v = stringOrNull(raw.theirsBlobSha);
      return v === null ? "" : v;
    })(),
    remoteDevice: stringOrNull(raw.remoteDevice) ?? "unknown",
    createdAt: numberOr(raw.createdAt, 0),
    siblingPath,
    siblingMtime: numberOr(raw.siblingMtime, 0),
    siblingSize: numberOr(raw.siblingSize, 0),
    siblingSha: stringOrNull(raw.siblingSha) ?? "",
    baseMtime: nullableNumber(raw.baseMtime),
    baseSize: nullableNumber(raw.baseSize),
    baseSha: stringOrNull(raw.baseSha),
    lastEvaluated: numberOr(raw.lastEvaluated, 0),
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableNumber(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
