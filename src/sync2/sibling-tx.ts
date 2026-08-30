// STEP3 "replace" mark-transaction (NEW-DRAIN §II.11, Phase 5 step 4).
//
// Why this exists: the replace branch of STEP3 is the ONLY place that
// DESTROYS evidence (deletes the previous sibling file) before the
// durable conflict record knows about it. On a platform with no fsync
// (verified against @capacitor/filesystem's real code — a plugin
// cannot reach below that API), reliability is DETECTION on the next
// read + deterministic redo, never prevention. The append and
// first-sibling branches deliberately have NO transaction — they
// destroy nothing and self-heal by redo (deterministic file names).
//
// The mark is an inverted delta: it carries BOTH FileInfos
// (oldSibling / newSibling), so recovery can reconstruct movement in
// EITHER direction. The direction is decided by ONE discriminator —
// the INTEGRITY of the new sibling file (owner's second revision,
// 2026-08-26). guid-vs-store comparison only says which step to
// resume from, never which direction to go. The 2026-08-29 fix rides
// here too: on rollback the old sibling must ALSO pass integrity —
// a present-but-corrupt old file would otherwise feed garbage bytes
// straight into the next _diff3; when both candidates are unusable
// the record degrades to dropLast(siblings) (NOT []), keeping older
// intact siblings tracked and FINALIZE blocked (C.19/19a/19b).
//
// File name: `sibling-tx-mark.json` — carries a payload (two
// FileInfos), so it is a DATA file per the §2.2 п.4 naming rule; the
// dot-prefixed pure flags (.attempted…) stay the empty markers.
//
// Recovery runs ONCE, as the FIRST line of drain(), under the running
// lock (owner, third revision) — process_conflicts() knows nothing
// about the mark, and no 422-restart can ever see a live mark within
// one drain (STEP3 runs once, after the batch loop).

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import {
  buildSiblingFilePath,
  saveConflictSiblingFile,
} from "./conflict-siblings";
import ConflictStoreV2, { ConflictsState } from "./conflict-store-v2";
import { FileInfo } from "./diff3";
import { fileInfoFromJson, fileInfoToJson } from "./drain-journal";

export const SIBLING_TX_MARK_FILE = "sibling-tx-mark.json";

export interface SiblingTxMark {
  guid: string;
  path: string;
  oldSibling: FileInfo; // blob always null in the mark
  newSibling: FileInfo;
}

export interface SiblingTxDeps {
  vault: Vault;
  selfPluginId: string;
  store: ConflictStoreV2;
  computeSha(bytes: ArrayBuffer): Promise<string>;
  // crypto.randomUUID — NOT Math.random()/Date.now() (banned as
  // uniqueness sources project-wide; same principle as the monotonic
  // seq). Injectable for deterministic tests.
  generateGuid?: () => string;
  logger?: { warn(message: string, data?: unknown): void };
}

export default class SiblingTx {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private readonly store: ConflictStoreV2;
  private readonly computeSha: (bytes: ArrayBuffer) => Promise<string>;
  private readonly generateGuid: () => string;
  private readonly logger:
    | { warn(message: string, data?: unknown): void }
    | undefined;

  constructor(deps: SiblingTxDeps) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
    this.store = deps.store;
    this.computeSha = deps.computeSha;
    this.generateGuid = deps.generateGuid ?? (() => crypto.randomUUID());
    this.logger = deps.logger;
  }

  private markPath(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${SIBLING_TX_MARK_FILE}`,
    );
  }

  // §II.9-style triple check against the VAULT (no network fallback —
  // sibling content is unrecoverable from the network, §II.6; no
  // verified-cache — this runs at most once per crash). Size first:
  // a size mismatch fails WITHOUT reading or hashing (C.22).
  async verifySiblingFileIntegrity(f: FileInfo): Promise<boolean> {
    const siblingPath = normalizePath(
      buildSiblingFilePath(f.path ?? "", f.mtime ?? 0, f.deviceLabel),
    );
    const stat = await this.vault.adapter.stat(siblingPath);
    if (!stat) return false;
    if (f.size !== null && stat.size !== f.size) return false;
    const bytes = await this.vault.adapter.readBinary(siblingPath);
    return (await this.computeSha(bytes)) === f.sha;
  }

  private async writeMark(mark: SiblingTxMark): Promise<void> {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        guid: mark.guid,
        path: mark.path,
        oldSibling: fileInfoToJson(mark.oldSibling),
        newSibling: fileInfoToJson(mark.newSibling),
      }),
    );
    await atomicWriteFile(
      this.vault,
      this.markPath(),
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
  }

  async readMark(): Promise<SiblingTxMark | null> {
    const p = this.markPath();
    if (!(await this.vault.adapter.exists(p))) return null;
    try {
      const raw = JSON.parse(await this.vault.adapter.read(p)) as Record<
        string,
        unknown
      >;
      if (typeof raw.guid !== "string" || typeof raw.path !== "string") {
        return null;
      }
      return {
        guid: raw.guid,
        path: raw.path,
        oldSibling: fileInfoFromJson(raw.oldSibling),
        newSibling: fileInfoFromJson(raw.newSibling),
      };
    } catch {
      return null; // torn mark — atomicWrite makes this near-impossible
    }
  }

  private async deleteMark(): Promise<void> {
    const p = this.markPath();
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }

  private async removeSiblingFileIfExists(f: FileInfo): Promise<void> {
    const p = normalizePath(
      buildSiblingFilePath(f.path ?? "", f.mtime ?? 0, f.deviceLabel),
    );
    if (await this.vault.adapter.exists(p)) {
      await this.vault.adapter.remove(p);
    }
  }

  // The replace branch of STEP3, steps 1-5 (§II.11). `newSibling`
  // must carry the merged bytes in `.blob`; the FileInfos stored in
  // the mark and the conflicts list are blob-stripped automatically
  // (blobs never serialize). `conflicts` is the ambient state — the
  // durable commit (step 3) happens HERE, not in the epilogue; that
  // ordering IS the fix this transaction exists for.
  async runReplaceTransaction(
    conflicts: ConflictsState,
    path: string,
    oldSibling: FileInfo,
    newSibling: FileInfo,
  ): Promise<void> {
    const current = conflicts.entries.get(path);
    if (current === undefined || current.siblings.length === 0) {
      throw new Error(
        `sibling-tx: replace for ${path} without a tracked sibling — caller bug`,
      );
    }
    const guid = this.generateGuid();
    const oldNoBlob: FileInfo = { ...oldSibling, blob: null };
    const newNoBlob: FileInfo = { ...newSibling, blob: null };

    // 1 — the mark, BEFORE any sibling-file write.
    await this.writeMark({
      guid,
      path,
      oldSibling: oldNoBlob,
      newSibling: newNoBlob,
    });
    // 2 — the new sibling file (atomicWrite inside).
    await saveConflictSiblingFile(this.vault, {
      path,
      mtime: newSibling.mtime ?? 0,
      deviceLabel: newSibling.deviceLabel,
      blob: newSibling.blob,
    });
    // 3 — the DURABLE commit: replaceLast + guid, saved NOW.
    conflicts.entries.set(path, {
      conflictBase: current.conflictBase,
      siblings: [...current.siblings.slice(0, -1), newNoBlob],
    });
    conflicts.lastSiblingTxGuid = guid;
    await this.store.save(conflicts);
    // 4 — only NOW the old evidence goes away (404-tolerant). Guard:
    // when old and new derive the SAME name (same mtime+label —
    // callers shouldn't get here for a no-op fold, but belt and
    // braces), deleting "the old" would destroy the file step 2 just
    // wrote.
    const oldName = buildSiblingFilePath(
      oldNoBlob.path ?? "",
      oldNoBlob.mtime ?? 0,
      oldNoBlob.deviceLabel,
    );
    const newName = buildSiblingFilePath(
      newNoBlob.path ?? "",
      newNoBlob.mtime ?? 0,
      newNoBlob.deviceLabel,
    );
    if (oldName !== newName) {
      await this.removeSiblingFileIfExists(oldNoBlob);
    }
    // 5 — unmark (404-tolerant).
    await this.deleteMark();
  }

  // First line of drain(), once per run, under the running lock.
  async recoverIfNeeded(): Promise<void> {
    const mark = await this.readMark();
    if (mark === null) return;

    // Fresh durable scan — loaded only when a mark actually exists
    // (the rare, crash-related case), never on every drain start.
    const conflicts = await this.store.load();
    const guidMatches = conflicts.lastSiblingTxGuid === mark.guid;
    const newFileOk = await this.verifySiblingFileIntegrity(mark.newSibling);
    const current = conflicts.entries.get(mark.path) ?? null;

    if (current === null) {
      // The record was pruned before recovery ran (user resolved the
      // conflict manually between an in-session failure and this
      // drain). Nothing to roll either way; clean the semantics.
      if (guidMatches) {
        // The guid claims "this transaction committed" while its
        // record is gone — it would lie forever.
        conflicts.lastSiblingTxGuid = null;
        await this.store.save(conflicts);
      }
      // The new file is unconditionally OUR transaction artifact.
      await this.removeSiblingFileIfExists(mark.newSibling);
      // mark.oldSibling deliberately untouched: if still on disk it is
      // an ordinary synthetic now — the next process_conflicts scan
      // owns its fate (C.4/C.6), not this transaction.
      await this.deleteMark();
      this.logger?.warn(
        "sibling-tx recovery: record already pruned — artifact cleaned",
        { path: mark.path },
      );
      return;
    }

    if (newFileOk) {
      // FORWARD — resume from the first unfinished step, regardless
      // of where the metadata stands. No Vault-step redo needed.
      if (!guidMatches) {
        conflicts.entries.set(mark.path, {
          conflictBase: current.conflictBase,
          siblings: [
            ...current.siblings.slice(0, -1),
            { ...mark.newSibling, blob: null },
          ],
        });
        conflicts.lastSiblingTxGuid = mark.guid;
        await this.store.save(conflicts); // completes step 3
      }
      await this.removeSiblingFileIfExists(mark.oldSibling); // step 4
    } else {
      // BACKWARD — the new file is torn/absent: roll to the
      // pre-transaction state.
      if (guidMatches) {
        if (!(await this.verifySiblingFileIntegrity(mark.oldSibling))) {
          // Both candidates for the LAST element are unusable —
          // drop exactly it; older intact siblings stay tracked
          // (dropLast, NOT [] — the 2026-08-29 fix). For the typical
          // len==1 this yields [], a legal state identical to a fresh
          // STEP1 record: the entry survives, FINALIZE stays blocked,
          // and STEP3 rebuilds the first sibling THIS very drain.
          conflicts.entries.set(mark.path, {
            conflictBase: current.conflictBase,
            siblings: current.siblings.slice(0, -1),
          });
          this.logger?.warn(
            "sibling-tx recovery: both sibling candidates unusable — dropLast degradation (one intermediate fold lost, no corruption)",
            { path: mark.path },
          );
        } else {
          conflicts.entries.set(mark.path, {
            conflictBase: current.conflictBase,
            siblings: [
              ...current.siblings.slice(0, -1),
              { ...mark.oldSibling, blob: null },
            ],
          });
        }
        // MANDATORY: without this, a crash mid-recovery would replay
        // against a guid that claims "committed" — the field's honest
        // semantics is "guid of the last SUCCESSFULLY committed tx".
        conflicts.lastSiblingTxGuid = null;
        await this.store.save(conflicts); // reverses step 3
      }
      // Remove the new file whether it appeared or not, torn or not —
      // it is untrusted either way.
      await this.removeSiblingFileIfExists(mark.newSibling);
      // The old sibling FILE is deliberately untouched here (§II.11
      // closing note): intact → the live journal re-folds next
      // Vault-step; unusable → the record already degraded above.
    }
    await this.deleteMark();
  }
}
