// Hot sync metadata — 2-slot ping-pong pair (METAFILE-REFACTOR §2.1).
//
// The handful of tiny, critical global sync parameters (§1.A):
// lastSyncCommitSha / lastSyncTreeSha / lastCommitMtime / remoteIdentity /
// conflictBranch. Losing them means the plugin "forgets where it is"
// relative to GitHub, so they get the most conservative storage in the
// project: two slots `.runtime/metadata-a.json` / `metadata-b.json`, each
// carrying a monotonic `seq` — the same protocol already battle-tested by
// the diff-editor's cursor persistence (src/diff2/cursor-store.ts).
//
// ⚠ CRASH-SAFETY INVARIANT (§2.1): every write targets the slot that holds
// the SMALLER seq at the moment the target is chosen — the max-seq slot is
// NEVER written. That slot is the recovery fallback; a plain (non-atomic)
// adapter.write is only safe because the fallback stays intact while the
// stale slot is being replaced. A torn write costs one update, never the
// last good state. Do not "optimize" the slot selection or cache it in
// memory — hot-metadata.test.ts asserts the invariant.
//
// Target slot and next seq are derived from DISK on every write, never
// from memory (§2.1): the disk is the only source of truth about which
// slot is currently the fallback — it can change in ways RAM cannot see
// (torn slot after a crash, `.runtime/` wiped by reset, a restored
// backup, a plugin restart between writes).
//
// One blob per write, not per field (§2.1.2): lastSyncCommitSha +
// lastSyncTreeSha + lastCommitMtime are ONE anchor to the merge bases —
// a skew between them points the anchor at the wrong tree. Callers that
// mutate several fields for one logical event MUST pass them in a single
// update() call.
//
// The seq discriminator is a counter, deliberately NOT a clock, and the
// payload carries NO timestamp field (§2.1.1) — the slot file's own mtime
// answers "when was this written" per slot, and an absent field cannot be
// mistaken for a discriminator.

import { normalizePath, type Vault } from "obsidian";

// (owner, repo, branch) the metadata was built against. The manager
// compares this to current settings at the start of every syncAll; a
// mismatch means the user pointed the plugin at a different remote and
// the local baseline is no longer authoritative.
export interface RemoteIdentity {
  owner: string;
  repo: string;
  branch: string;
}

// Per-device conflict branch state (pseudo-merge mode). `name` is the
// bare branch name (no `refs/heads/` prefix), `head` its commit SHA.
// `null` = no active conflict branch on this device.
export interface ConflictBranchState {
  name: string;
  head: string;
}

export interface HotFields {
  lastSyncCommitSha: string | null;
  lastSyncTreeSha: string | null;
  // Watermark for ChangeDetector's mtime short-circuit.
  lastCommitMtime: number | null;
  remoteIdentity: RemoteIdentity | null;
  conflictBranch: ConflictBranchState | null;
}

const DEFAULTS: HotFields = {
  lastSyncCommitSha: null,
  lastSyncTreeSha: null,
  lastCommitMtime: null,
  remoteIdentity: null,
  conflictBranch: null,
};

type Slot = "a" | "b";

// Lenient per-field reads: a malformed field degrades to its default
// instead of poisoning the whole slot (carries snapshot-store's
// "tolerates missing/malformed values in raw JSON" contract). Only a
// missing/invalid `seq` or unparseable JSON disqualifies the slot.
function fieldsFromRaw(raw: Record<string, unknown>): HotFields {
  const out: HotFields = { ...DEFAULTS };
  if (typeof raw.lastSyncCommitSha === "string") {
    out.lastSyncCommitSha = raw.lastSyncCommitSha;
  }
  if (typeof raw.lastSyncTreeSha === "string") {
    out.lastSyncTreeSha = raw.lastSyncTreeSha;
  }
  if (typeof raw.lastCommitMtime === "number") {
    out.lastCommitMtime = raw.lastCommitMtime;
  }
  const ri = raw.remoteIdentity as Partial<RemoteIdentity> | undefined;
  if (
    ri &&
    typeof ri === "object" &&
    typeof ri.owner === "string" &&
    typeof ri.repo === "string" &&
    typeof ri.branch === "string"
  ) {
    out.remoteIdentity = { owner: ri.owner, repo: ri.repo, branch: ri.branch };
  }
  const cb = raw.conflictBranch as Partial<ConflictBranchState> | undefined;
  if (
    cb &&
    typeof cb === "object" &&
    typeof cb.name === "string" &&
    typeof cb.head === "string"
  ) {
    out.conflictBranch = { name: cb.name, head: cb.head };
  }
  return out;
}

export default class HotMetadataStore {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private state: HotFields = { ...DEFAULTS };

  constructor(deps: { vault: Vault; selfPluginId: string }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
  }

  private runtimeDir(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime`,
    );
  }

  private slotPath(slot: Slot): string {
    return normalizePath(`${this.runtimeDir()}/metadata-${slot}.json`);
  }

  // One slot → { seq, fields }, or null on missing / corrupt / wrong
  // shape. A torn ping-pong write lands here and reads as seq −1 at the
  // call sites — which makes the broken slot the next write target, so
  // it heals itself without a dedicated repair path (§2.1).
  private async readSlot(
    slot: Slot,
  ): Promise<{ seq: number; fields: HotFields } | null> {
    const p = this.slotPath(slot);
    if (!(await this.vault.adapter.exists(p))) return null;
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as Record<
        string,
        unknown
      >;
      if (typeof raw !== "object" || raw === null) return null;
      // `typeof === "number"` so a fresh slot's `seq: 0` is accepted
      // (a truthiness check would wrongly reject it).
      if (typeof raw.seq !== "number") return null;
      return { seq: raw.seq, fields: fieldsFromRaw(raw) };
    } catch {
      return null; // corrupt / torn → this slot loses
    }
  }

  // Recovery/startup read: the slot with the highest VALID seq wins.
  async load(): Promise<void> {
    const a = await this.readSlot("a");
    const b = await this.readSlot("b");
    const best =
      a === null ? b : b === null ? a : a.seq >= b.seq ? a : b;
    this.state = best === null ? { ...DEFAULTS } : best.fields;
  }

  getLastSyncCommitSha(): string | null {
    return this.state.lastSyncCommitSha;
  }

  getLastSyncTreeSha(): string | null {
    return this.state.lastSyncTreeSha;
  }

  getLastCommitMtime(): number | null {
    return this.state.lastCommitMtime;
  }

  getRemoteIdentity(): RemoteIdentity | null {
    return this.state.remoteIdentity;
  }

  getConflictBranch(): ConflictBranchState | null {
    return this.state.conflictBranch;
  }

  // Merge `partial` into the current fields and persist the WHOLE blob
  // in one slot write. Memory is assigned only after the write succeeds:
  // on an exception there is nothing to roll back (§2.1 — the max-seq
  // slot is intact, recovery reads it, the caller sees the error), and
  // the next attempt re-reads the disk and picks the same target.
  async update(partial: Partial<HotFields>): Promise<void> {
    const merged: HotFields = { ...this.state, ...partial };

    // Target + next seq from DISK, never from memory (§2.1).
    const a = await this.readSlot("a");
    const b = await this.readSlot("b");
    const seqA = a === null ? -1 : a.seq;
    const seqB = b === null ? -1 : b.seq;
    const nextSeq = Math.max(seqA, seqB) + 1; // both invalid → 0
    // The smaller-seq slot is the stale one — the write target. A tie
    // (possible only when both slots carry identical bytes) goes to `a`
    // (§2.1 table).
    const target: Slot = seqA <= seqB ? "a" : "b";

    await this.ensureRuntimeDir();
    await this.vault.adapter.write(
      this.slotPath(target),
      JSON.stringify({ seq: nextSeq, ...merged }),
    );
    this.state = merged;
  }

  // The plugin folder always exists in production; the segment-by-segment
  // walk covers tests / a missing `.runtime` (adapter.mkdir is
  // non-recursive on some platforms). No try/catch: a failure MUST
  // propagate — see update() for why that is a handled case, not a
  // failure state.
  private async ensureRuntimeDir(): Promise<void> {
    const dir = this.runtimeDir();
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
