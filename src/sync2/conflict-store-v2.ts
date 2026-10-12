// Conflict store v2 — the DURABLE home of manual conflicts
// (NEW-DRAIN §II.6/§III; MASTER-PLAN Фаза 5 крок 1). One file,
// `.runtime/conflicts.json` (a DATA file — no dot prefix, §2.2 п.4):
//
//   {
//     lastSiblingTxGuid: string | null,   // §II.11 — guid of the LAST
//                                          // SUCCESSFULLY COMMITTED
//                                          // STEP3 replace-transaction
//     conflicts: { "<base path>": { conflictBase, siblings: [...] } }
//   }
//
// This is NOT the old conflict-store.ts (773 lines, ConflictRecord
// shape) — that one keeps serving the live engine until the Phase 5.5
// cutover, when src/diff2/ ports here and v1 dies with the old drain.
//
// Semantics carried by the shape (§III process_conflicts contract):
// - `conflictBase` is the conflict-branch half — recoverable only
//   from the network, NEVER re-derived from an FS scan; whoever
//   rewrites an entry must carry it through verbatim.
// - `siblings` is an APPEND-ORDERED list (never a set, never
//   re-sorted): `last(siblings)` is what STEP3 works with, precisely
//   because it was appended last. An empty list is a LEGAL state
//   distinct from "no record" (a fresh STEP1 record whose STEP3
//   hasn't run yet) — it must keep blocking FINALIZE.
// - Blobs are never serialized (same codec as the drain journal —
//   shared, so the two formats can't fork).
//
// Load semantics: missing file → empty state (first run). A corrupt
// file also reads as empty — LOUDLY: the siblings half re-derives
// from the FS scan (process_conflicts), but conflictBase does not,
// so this is a real degradation the log must witness, not hide.
// atomicWriteFile's temp+rename makes the window rare (no torn JSON),
// not impossible (§II.11 — no fsync exists on this platform).

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import {
  ConflictEntry,
  fileInfoFromJson,
  fileInfoToJson,
} from "./drain-journal";
import type { FileInfo } from "./diff3";
import { buildSiblingFilePath, parseSiblingFilename } from "./conflict-siblings";

export const CONFLICTS_FILE = "conflicts.json";

export interface ConflictsState {
  entries: Map<string, ConflictEntry>;
  // §II.11: participates in the STEP3 replace-transaction recovery —
  // compared against the tx mark's guid to tell "did step 3 commit?".
  lastSiblingTxGuid: string | null;
}

export function emptyConflictsState(): ConflictsState {
  return { entries: new Map(), lastSiblingTxGuid: null };
}

export default class ConflictStoreV2 {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly logger:
    | { warn(message: string, data?: unknown): void }
    | undefined;

  // ── cached view (Phase 5.5 step 3a — the diff2 port's SYNC read
  // surface). `cachedState` is the SAME object the last load()
  // returned / save() received — the drain mutates its Map in place,
  // so `hasBase` tracks live mutations for free. The derived-name
  // sibling index, by contrast, is rebuilt only on load()/save(); a
  // mid-drain staleness window is deliberate and harmless for the one
  // hot consumer (ConflictWatcher.isRelevant): its
  // `.conflict-from-` substring fallback catches any sibling path
  // regardless of store state — do NOT "fix" that fallback away.
  private cachedState: ConflictsState = emptyConflictsState();
  private siblingPathIndex = new Map<
    string,
    { basePath: string; sibling: FileInfo }
  >();

  constructor(deps: {
    vault: Vault;
    selfPluginId: string;
    logger?: { warn(message: string, data?: unknown): void };
  }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.logger = deps.logger;
  }

  // Copies the drain has ANNOUNCED — about to write, or written and not yet
  // saved (owner + advisor, 2026-10-12). The synthetic-copy cleanup runs
  // alongside the drain; conflicts.json is saved only at the drain's end, so
  // without this a fresh tracked copy looked synthetic for the rest of the
  // drain. Memory only: an announcement ends once its copy is recorded and
  // saved; one whose write failed lingers until the plugin restarts, which
  // only means the cleanup leaves that name alone.
  private announced = new Set<string>();
  // Removals of untracked copies in flight, by name: a drain announcing the
  // same name waits for the removal before it writes (see removeIfUntracked).
  private removals = new Map<string, Promise<void>>();

  private rebuildCache(state: ConflictsState): void {
    this.cachedState = state;
    this.siblingPathIndex = new Map();
    for (const [basePath, entry] of state.entries) {
      for (const sibling of entry.siblings) {
        this.siblingPathIndex.set(
          copyKey(buildSiblingFilePath(basePath, sibling.timeLabel ?? 0, sibling.deviceLabel)),
          { basePath, sibling },
        );
      }
    }
    for (const k of [...this.announced]) {
      if (this.siblingPathIndex.has(k)) this.announced.delete(k);
    }
  }

  // THE question every deletion of a "synthetic" copy asks: does the ledger
  // track this name? Saved records, the drain's records in memory (the drain
  // mutates the cached state in place) and announced copies all count.
  isTrackedCopy(copyPath: string): boolean {
    const k = copyKey(copyPath);
    if (this.siblingPathIndex.has(k) || this.announced.has(k)) return true;
    const parsed = parseSiblingFilename(k);
    if (parsed === null) return false;
    const entry = this.cachedState.entries.get(parsed.basePath);
    return (
      entry?.siblings.some(
        (s) => copyKey(buildSiblingFilePath(parsed.basePath, s.timeLabel ?? 0, s.deviceLabel)) === k,
      ) ?? false
    );
  }

  // The drain, BEFORE it writes a copy file: from here on the name is tracked.
  // If an untracked copy at that very name is being removed right now, wait
  // for the removal — otherwise it could land after the drain's write and
  // delete the new tracked copy.
  async announceCopy(copyPath: string): Promise<void> {
    const k = copyKey(copyPath);
    this.announced.add(k);
    const removal = this.removals.get(k);
    if (removal !== undefined) await removal.catch(() => undefined);
  }

  // The cleanup's removal of an untracked copy: the tracked check and the
  // claim on the name are ONE synchronous step, so a drain either announced
  // first (nothing removed) or waits for this removal before writing.
  async removeIfUntracked(copyPath: string, remove: () => Promise<void>): Promise<boolean> {
    if (this.isTrackedCopy(copyPath)) return false;
    const k = copyKey(copyPath);
    const removal = remove();
    this.removals.set(k, removal);
    try {
      await removal;
    } finally {
      if (this.removals.get(k) === removal) this.removals.delete(k);
    }
    return true;
  }

  // The last loaded/saved state. UI readers (counter default formula,
  // panel refresh paths) treat it as read-only; all mutations flow
  // through the drain / process_conflicts, which save().
  getCachedState(): ConflictsState {
    return this.cachedState;
  }

  // O(1): does this base path carry a live conflict entry? (An entry
  // with siblings==[] is STILL a conflict — I.7.)
  hasBase(path: string): boolean {
    return this.cachedState.entries.has(path);
  }

  // O(1): is this vault path a TRACKED sibling's derived disk name?
  hasSiblingPath(path: string): boolean {
    return this.siblingPathIndex.has(copyKey(path));
  }

  // Tracked-sibling lookup by disk name — the synthetic-detector's
  // tracked/synthetic discriminator. null = not tracked (synthetic).
  getBySiblingPath(
    siblingPath: string,
  ): { basePath: string; sibling: FileInfo } | null {
    return this.siblingPathIndex.get(copyKey(siblingPath)) ?? null;
  }

  private filePath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${CONFLICTS_FILE}`,
    );
  }

  async load(): Promise<ConflictsState> {
    const p = this.filePath();
    if (!(await this.vault.adapter.exists(p))) {
      const state = emptyConflictsState();
      this.rebuildCache(state);
      return state;
    }
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as Record<
        string,
        unknown
      >;
      if (typeof raw !== "object" || raw === null) {
        throw new Error("not an object");
      }
      const state = emptyConflictsState();
      if (typeof raw.lastSiblingTxGuid === "string") {
        state.lastSiblingTxGuid = raw.lastSiblingTxGuid;
      }
      if (raw.conflicts && typeof raw.conflicts === "object") {
        for (const [path, rec] of Object.entries(
          raw.conflicts as Record<string, unknown>,
        )) {
          if (typeof rec !== "object" || rec === null) continue;
          const r = rec as Record<string, unknown>;
          state.entries.set(path, {
            conflictBase: fileInfoFromJson(r.conflictBase),
            siblings: Array.isArray(r.siblings)
              ? r.siblings.map(fileInfoFromJson)
              : [],
          });
        }
      }
      this.rebuildCache(state);
      return state;
    } catch (e) {
      // conflictBase is network-borne and NOT re-derivable from disk —
      // losing it is a real degradation, so it never passes silently.
      this.logger?.warn(
        "conflict-store-v2: corrupt conflicts.json — starting empty; " +
          "sibling files on disk will re-enter as synthetic via the scan",
        { error: String(e) },
      );
      const state = emptyConflictsState();
      this.rebuildCache(state);
      return state;
    }
  }

  async save(state: ConflictsState): Promise<void> {
    this.rebuildCache(state); // save is the in-drain rebuild point
    const conflicts: Record<string, unknown> = {};
    for (const [path, c] of state.entries) {
      conflicts[path] = {
        conflictBase: fileInfoToJson(c.conflictBase),
        siblings: c.siblings.map(fileInfoToJson),
      };
    }
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        lastSiblingTxGuid: state.lastSiblingTxGuid,
        conflicts,
      }),
    );
    const payload = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    // ⚠️ SERIALISED, and this is where it belongs: the store is the single
    // mutation point for conflicts, so the "one writer at a time" rule has
    // to be enforced HERE rather than trusted to every caller. It was
    // trusted, and the trust failed 15 times in the field log since
    // 2026-09-26 — `reconcileConflictsV2` is fired un-awaited at onload
    // while the restored diff2 panel calls it too, and the two passes
    // raced. atomicWriteFile is not safe for two writers on one path: they
    // share the same `.ges-tmp` staging name, so one renames it away and
    // the other finds it gone ("ENOENT … rename conflicts.ges-tmp.json")
    // or finds the destination already taken ("Destination file already
    // exists!").
    //
    // QUEUED, not coalesced — the opposite choice to the reconcile caller,
    // and deliberately: each save carries a DIFFERENT state, so dropping
    // one would silently lose a conflict record. Order decides the winner.
    //
    // The cache rebuild above stays synchronous so a caller that reads
    // getCachedState() right after save() still sees its own write; the
    // chain preserves call order, so cache and disk agree either way.
    const run = this.saveChain.then(() => this.writeNow(payload));
    // ⚠️ The `.catch` is what keeps a failure from poisoning the queue:
    // the NEXT caller waits on a chain that always settles, while THIS
    // caller still receives its own error through `run`. A transient
    // failure must not freeze conflicts.json for the rest of the session.
    //
    // (An earlier version also passed a rejection handler to `.then`. A
    // probe showed removing it changed nothing, and it could not have:
    // `saveChain` is already the caught promise, so that handler was
    // unreachable. Dead code removed rather than given a test it could
    // never fail.)
    this.saveChain = run.catch(() => {});
    return run;
  }

  private saveChain: Promise<void> = Promise.resolve();

  private async writeNow(payload: ArrayBuffer): Promise<void> {
    await this.ensureRuntimeDir();
    await atomicWriteFile(this.vault, this.filePath(), payload);
  }

  // Sweep source №4 (§12.5.D): while a conflict lives, its
  // conflictBase blob must NEVER be reaped — it is only refetchable while
  // the conflict branch still exists — and neither may each copy's
  // ORIGIN, the ancestor of its next STEP3 fold. Not the copy's own sha:
  // that is the content cache of the file on disk (owner, 2026-10-11),
  // possibly the user's edits, never a stored blob.
  async collectReferencedShas(): Promise<Set<string>> {
    const state = await this.load();
    const out = new Set<string>();
    for (const c of state.entries.values()) {
      if (c.conflictBase.sha !== null) out.add(c.conflictBase.sha);
      for (const s of c.siblings) {
        if (s.originSha) out.add(s.originSha);
      }
    }
    return out;
  }

  private async ensureRuntimeDir(): Promise<void> {
    const dir = normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime`,
    );
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

// A copy's name as a lookup key: Obsidian's normalizePath (which also makes
// it NFC — checked in obsidian.asar, 2026-10-12), so a label typed in another
// Unicode form still names the same copy. NFC applied here too, because the
// test double's normalizePath does not.
function copyKey(p: string): string {
  return normalizePath(p).normalize("NFC");
}
