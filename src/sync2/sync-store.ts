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

export default class SyncStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly logger: SyncStoreLogger | undefined;

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    logger?: SyncStoreLogger;
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.logger = deps.logger;
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
    await this.vault.adapter.writeBinary(this.blobPath(sha), bytes);
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
  // never reap a just-written blob.
  async sweep(
    referencedSources: Array<() => Promise<Set<string>>>,
  ): Promise<{ removed: number; kept: number }> {
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
      if (referenced.has(sha)) continue;
      await this.vault.adapter.remove(this.blobPath(sha));
      removed += 1;
    }
    return { removed, kept: candidates.length - removed };
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
