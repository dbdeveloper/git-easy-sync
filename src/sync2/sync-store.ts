// Content-addressed blob store — `.runtime/sync_store/{sha}`
// (SYNC2-FIX §12, NEW-DRAIN §II.9). Phase 2 primitive; the new drain
// (Phase 4) is the main consumer, the batch format (this phase,
// group B) is the first writer.
//
// One store serves ALL THREE merge sides: `ours` (batch content),
// `base` and `theirs` (downloaded from GitHub). The file name IS the
// git blob SHA of its content — but the name proves the content only
// AFTER hash-on-load (§II.9): on mobile, a power-loss without fsync
// can leave a file with the right size and garbage inside, so every
// first read of a SHA hashes the actual bytes.
//
// ⚠️ TWO BREEDS live here (§12.3) and the difference is why this is
// `sync_store`, NOT a "cache": local versions (batch content, diff3
// intermediates) exist ONLY here — losing them makes their commits
// uncompletable; remote blobs (base/theirs) are re-downloadable. If
// space must ever be reclaimed forcibly, only the second breed is
// safe to drop. The sweep below never distinguishes breeds — it
// keeps everything referenced and drops everything else.

import { normalizePath, type Vault } from "obsidian";
import { calculateGitBlobSHA } from "../utils";

// Minimal logging surface — the caller passes the project Logger.
export interface SyncStoreLogger {
  warn(message: string, data?: unknown): void;
}

// Pin owners (COMMIT-PASS-PERF §6.1). Each releases only its own pins.
export const PIN_OWNER_COMMIT = "commit";
export const PIN_OWNER_DELETED_BIN = "deleted-bin";

export default class SyncStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly logger: SyncStoreLogger | undefined;
  // COMMIT-PASS-PERF 3a: the time of each blob write (writeBinary only),
  // for the commit-pass forecast. Every write into the store passes
  // saveBlobToSyncStore — commit, drain downloads, diff3, the bin — so
  // this one point measures them all.
  private readonly onWriteTimed: ((bytes: number, ms: number) => void) | undefined;
  // ── Pins (COMMIT-PASS-PERF §6.1) ────────────────────────────────
  // A pin is a TEMPORARY reference held in memory: "this blob is in use,
  // its durable reference (a batch metafile, a deleted.json record) is
  // on its way". One set per OWNER; the sweep treats their union like
  // any other reference source. In memory on purpose: a crash loses the
  // pins together with the operations that needed them, and the orphan
  // blobs they leave are exactly what the sweep should reap.
  private readonly pins = new Map<string, Set<string>>();
  // Pins released WHILE a sweep runs. That sweep collected its
  // references earlier, possibly before the owner's durable reference
  // existed — so a released pin must keep protecting until the sweep
  // ends (§6.1, the load-bearing piece). Kept apart from `pins` so an
  // owner re-pinning the same sha meanwhile is not undone when these
  // are dropped.
  private readonly retiring = new Set<string>();
  private sweeping = 0;
  // The ONE lock (§6.1 variant B): held for "pin + exists? + write" in
  // retain() and for "pinned? + unlink" of ONE blob in sweep() — never
  // for a whole sweep, so a user's delete waits at most one unlink.
  // NOT reentrant: nothing that runs under it (a `produce`, a sweep
  // source) may call retain().
  private lockTail: Promise<void> = Promise.resolve();

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    logger?: SyncStoreLogger;
    onWriteTimed?: (bytes: number, ms: number) => void;
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.logger = deps.logger;
    this.onWriteTimed = deps.onWriteTimed;
  }

  private storeDir(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/sync_store`,
    );
  }

  private blobPath(sha: string): string {
    return normalizePath(`${this.storeDir()}/${sha}`);
  }

  // Hash-on-load read (§II.9). ⚠️ ONE data argument — no `size`
  // parameter, deliberately (owner decision 2026-08-29): the length
  // already participates in the git SHA (`sha1("blob " + size + "\0"
  // + data)`), so a size check proves nothing the hash doesn't, and
  // the old `(sha, size)` signature produced a real defect (a caller
  // without a known size turned every read into a false "corrupt" →
  // eternal cache miss).
  //
  // `verifiedShas` is OWNED BY THE CALLER and scopes the trust: a SHA
  // that already passed hash-on-load within this scope is re-read
  // without re-hashing (the same blob is read dozens of times per
  // drain — "ours became theirs", §12.2). The new drain passes a
  // per-drain Set; the old engine a per-syncAll one. Deliberately NOT
  // a module global: trust must die with the scope that earned it.
  //
  // Returns null for BOTH "absent" and "present but corrupt" — the
  // §II.9 callers treat them identically (remote/base: refetch from
  // GitHub; local: attempt vault repair or skip the path this round).
  async getBlobFromSyncStore(
    sha: string,
    verifiedShas: Set<string>,
  ): Promise<ArrayBuffer | null> {
    const p = this.blobPath(sha);
    if (verifiedShas.has(sha)) {
      // Content-addressed: bytes under this name never change to
      // OTHER content behind our back within the scope.
      if (!(await this.vault.adapter.exists(p))) return null;
      return this.readBytes(p);
    }
    if (!(await this.vault.adapter.exists(p))) {
      return null; // plain cache miss — not an error
    }
    const bytes = await this.readBytes(p);
    const actual = await calculateGitBlobSHA(bytes);
    if (actual !== sha) {
      // Catches BOTH corruption kinds: a truncated file AND the
      // no-fsync power-loss shape (right length, garbage inside).
      this.logger?.warn(
        "sync_store: SHA mismatch after read — corrupt copy",
        { sha, actual },
      );
      return null;
    }
    verifiedShas.add(sha);
    return bytes;
  }

  // Deliberately the CHEAPEST possible check — bare stat, no size, no
  // hash (§II.9). Called only where the caller ALREADY holds verified
  // bytes (just downloaded or just merged) and decides whether to
  // write them a second time (dedup, saves up to ~50 MB of writes on
  // mobile). A corrupt same-named copy is NOT detected here — on
  // purpose: the next getBlobFromSyncStore of that SHA hash-checks
  // and reports it.
  async existInSyncStore(sha: string): Promise<boolean> {
    return this.vault.adapter.exists(this.blobPath(sha));
  }

  // Byte size of a stored blob, or null when we don't have it. A bare
  // `adapter.stat` — NO read, NO hash (the same cheapest-possible
  // spirit as existInSyncStore above), so callers that only need a
  // SIZE never pay a network round-trip for it ("size is an
  // invitation, SHA is proof" — MASTER-PLAN free-size inventory).
  //
  // ⚠️ Trusts the file NAME, not its content: a corrupt same-named
  // copy would report a wrong size. Every current caller uses the
  // size for a THRESHOLD decision (the rule-4.7 auto-merge gate) or a
  // stat short-circuit hint — never as a correctness invariant — and
  // the bytes themselves are still hash-proven on the next
  // getBlobFromSyncStore.
  async sizeOf(sha: string): Promise<number | null> {
    const st = await this.vault.adapter.stat(this.blobPath(sha));
    return st === null || st.type !== "file" ? null : st.size;
  }

  // Direct write — no temp+rename (§II.9): a content-addressed store
  // never holds DIFFERENT content under the same name, so
  // "last writer wins" is always harmless; a torn write is caught by
  // the next hash-on-load read.
  async saveBlobToSyncStore(sha: string, bytes: ArrayBuffer): Promise<void> {
    await this.ensureDir();
    const size = bytes.byteLength;
    const t0 = performance.now();
    await this.vault.adapter.writeBinary(this.blobPath(sha), bytes);
    this.onWriteTimed?.(size, performance.now() - t0);
  }

  // Start referencing `sha` on behalf of `owner` — the ONLY way, outside
  // the drain, to write a blob or to reuse one already present
  // (COMMIT-PASS-PERF §6.1). Under the lock: pin first, then make sure
  // the bytes are there, asking `produce` only when they are missing.
  // Returns false when they were missing and `produce` had none (the
  // pin is dropped again). The caller writes its durable reference and
  // then unpins / releaseOwner()s.
  //
  // Why reuse needs this: the sweep removes by references it collected
  // BEFORE its removal loop, so "the blob exists, skip the write" is a
  // stale answer for anyone who starts referencing it in between. Under
  // the lock, a pin taken before the sweep reaches the blob stops the
  // unlink; one taken after it finds the blob gone and writes it again.
  async retain(
    owner: string,
    sha: string,
    produce: () => Promise<ArrayBuffer | null>,
  ): Promise<boolean> {
    return this.withLock(async () => {
      this.ownerPins(owner).add(sha);
      if (await this.vault.adapter.exists(this.blobPath(sha))) return true;
      const bytes = await produce();
      if (bytes === null) {
        this.unpin(owner, sha);
        return false;
      }
      await this.saveBlobToSyncStore(sha, bytes);
      return true;
    });
  }

  // Drop one pin — call once the durable reference is written.
  unpin(owner: string, sha: string): void {
    if (!this.pins.get(owner)?.delete(sha)) return;
    if (this.sweeping > 0) this.retiring.add(sha);
  }

  // Drop every pin of `owner` (the commit pass, once all its metafiles
  // are written or it failed).
  releaseOwner(owner: string): void {
    const set = this.pins.get(owner);
    if (set === undefined) return;
    this.pins.delete(owner);
    if (this.sweeping > 0) for (const sha of set) this.retiring.add(sha);
  }

  private ownerPins(owner: string): Set<string> {
    let set = this.pins.get(owner);
    if (set === undefined) {
      set = new Set();
      this.pins.set(owner, set);
    }
    return set;
  }

  private isPinned(sha: string): boolean {
    if (this.retiring.has(sha)) return true;
    for (const set of this.pins.values()) if (set.has(sha)) return true;
    return false;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // Reference sweep (§12.5): drop every blob no source references.
  //
  // The FULL formula has four sources (queue metadata, drain-journal
  // baseSha, blobs the drain currently holds in flight, conflictBase
  // of unresolved manual conflicts). Two of them don't exist until
  // Phases 4-5, so the sources are INJECTED: each is an async
  // producer of a SHA set, and the caller wires whichever exist at
  // its phase. When every source is empty ("queue empty AND conflicts
  // empty"), the sweep naturally clears the whole store — the
  // unconditional-cleanup case needs no separate rule.
  //
  // Order-of-write contract that makes this safe: batch metadata is
  // written BEFORE its blobs (§12.4), so a reference always exists by
  // the time its blob appears — the snapshot-then-delete below can
  // never reap a just-written blob. That covers only NEWLY written
  // blobs: one that already sat here and is REUSED after collection is
  // covered by pins + the per-blob lock below (COMMIT-PASS-PERF §6.1).
  async sweep(
    referencedSources: Array<() => Promise<Set<string>>>,
  ): Promise<{ removed: number; kept: number }> {
    // Marked BEFORE the listing: an unpin from here on is deferred to
    // the end (retiring), and one that came earlier happened after its
    // durable reference was written — which the collection below sees.
    this.sweeping += 1;
    try {
      const dir = this.storeDir();
      if (!(await this.vault.adapter.exists(dir))) {
        return { removed: 0, kept: 0 };
      }
      // Snapshot of what exists NOW (§12.5 step 1) — taken before the
      // reference collection, so anything written concurrently is
      // outside `candidates` and safe by construction.
      const listing = await this.vault.adapter.list(dir);
      const candidates = listing.files.map((f) => {
        const slash = f.lastIndexOf("/");
        return slash >= 0 ? f.slice(slash + 1) : f;
      });
      const referenced = new Set<string>();
      for (const source of referencedSources) {
        for (const sha of await source()) referenced.add(sha);
      }
      let removed = 0;
      for (const sha of candidates) {
        // `referenced` is a snapshot that only ever protects — no lock
        // needed to skip on it.
        if (referenced.has(sha)) continue;
        // Pins are asked NOW, not at collection, and the unlink happens
        // under the same lock retain() pins under.
        const gone = await this.withLock(async () => {
          if (this.isPinned(sha)) return false;
          await this.vault.adapter.remove(this.blobPath(sha));
          return true;
        });
        if (gone) removed += 1;
      }
      return { removed, kept: candidates.length - removed };
    } finally {
      this.sweeping -= 1;
      if (this.sweeping === 0) this.retiring.clear();
    }
  }

  // Byte TRANSPORT only — validation stays with hash-on-load above.
  // Primary path: `adapter.getResourcePath(p)` + WebView fetch — the
  // pattern field-proven in PushQueue.readFile, chosen there because
  // the plain `readBinary` JS↔native bridge empirically BLOCKED the
  // mobile sync flow on files >1 MB (Capacitor serves
  // `http://localhost/_capacitor_file_/…` without a bridge
  // round-trip; desktop gets an `app://` URL). Fallback: `readBinary`
  // — mock-obsidian has no getResourcePath, and any fetch hiccup
  // (racing delete, future platform change) degrades to the slow
  // correct path instead of failing the read outright; a wrong byte
  // outcome is impossible either way because the caller hashes.
  private async readBytes(p: string): Promise<ArrayBuffer> {
    const getResourcePath = (
      this.vault.adapter as { getResourcePath?: (q: string) => string }
    ).getResourcePath;
    if (typeof getResourcePath === "function") {
      try {
        const url = getResourcePath.call(this.vault.adapter, p);
        const resp = await fetch(url);
        if (resp.ok) return await resp.arrayBuffer();
      } catch {
        // fall through to readBinary
      }
    }
    return this.vault.adapter.readBinary(p);
  }

  private async ensureDir(): Promise<void> {
    const dir = this.storeDir();
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
