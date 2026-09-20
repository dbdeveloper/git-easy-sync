// User-driven-delete interception via monkey-patch of Vault.delete and
// Vault.trash. On plugin onload we wrap both methods so they call
// TrashStore.intercept(file.path) BEFORE invoking the original (file
// bytes are still on disk at that point — adapter.readBinary works).
// On plugin unload we restore the originals so the plugin leaves the
// vault in the state it found it.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.2, §R3.4
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.10 (intercept algorithm)
//
// Pattern, blast radius, and limitations:
//
//   - We only patch the high-level Vault methods (vault.delete /
//     vault.trash). Calls that bypass these by going directly to
//     adapter.remove(path) — including sync2's own applyRemoteDeletion
//     — do NOT trigger this watcher. sync2's pull-delete path
//     captures via the constructor-injected trashHooks.captureForDelete
//     hook instead (R3.4). Third-party plugins that delete via the
//     adapter are NOT captured by design (see DIFF2_IMPLEMENTATION_PLAN.md
//     R3.4 "Design boundary").
//
//   - Multiple plugins can patch the same method (each captures the
//     previous wrapped version as its "original"). On uninstall we
//     restore the reference we captured at install time, leaving any
//     plugin-stack above us intact. LIFO-style unwrap.
//
//   - Folder deletion is NOT captured in v1. When the user deletes a
//     folder, Obsidian's `vault.delete(folder)` proceeds without
//     iterating children one-by-one through our patched method. The
//     children disappear without trash entries. This is a known
//     limitation; if it becomes a meaningful UX pain we can revisit by
//     pre-walking the folder before delegating to the original. Files
//     deleted individually via the file menu / command palette ARE
//     captured.
//
//   - Capture is best-effort. If intercept throws (disk full, permission
//     error, ...) we log and proceed with the original delete anyway.
//     TrashStore is a safety net for the common case, not a hard
//     dependency for delete itself.

import { TAbstractFile, TFile, Vault } from "obsidian";
import Logger from "../logger";
import { TrashStore } from "./trash-store";

// The shape of vault.delete / vault.trash we monkey-patch. Real
// Obsidian's signature is (file, force?: boolean) / (file, system?:
// boolean) — keep the second param generic via rest args so we forward
// whatever the user passed.
type DeleteLike = (file: TAbstractFile, ...rest: unknown[]) => Promise<void>;

export class TrashWatcher {
  private originalDelete: DeleteLike | null = null;
  private originalTrash: DeleteLike | null = null;
  private installed = false;

  // §5.2.1: the watcher only needs "capture this path before it goes".
  // Narrowed from TrashStore to that one method so the bin's storage
  // can be re-platformed under it without touching the monkey-patch.
  constructor(
    private readonly vault: Vault,
    private readonly capture: { captureForDelete(path: string): Promise<unknown> },
    private readonly logger?: Logger,
  ) {}

  // Wrap vault.delete and vault.trash. Safe to call exactly once per
  // TrashWatcher instance; subsequent calls are a programmer error and
  // throw so the wire-up bug surfaces loudly rather than silently
  // double-wrapping (which would invoke intercept twice and route the
  // delete through two wrappers, breaking unwind on uninstall).
  install(): void {
    if (this.installed) {
      throw new Error(
        "TrashWatcher.install called twice without intervening uninstall",
      );
    }
    const vault = this.vault as Vault & {
      delete: DeleteLike;
      trash: DeleteLike;
    };

    // Capture raw references (no .bind) so uninstall can restore the
    // exact same function objects. `this` context is preserved at call
    // time via .call(vault, ...) below.
    this.originalDelete = vault.delete as DeleteLike;
    this.originalTrash = vault.trash as DeleteLike;

    vault.delete = async (file: TAbstractFile, ...rest: unknown[]) => {
      await this.captureBeforeDelete(file);
      return this.originalDelete!.call(vault, file, ...rest);
    };
    vault.trash = async (file: TAbstractFile, ...rest: unknown[]) => {
      await this.captureBeforeDelete(file);
      return this.originalTrash!.call(vault, file, ...rest);
    };

    this.installed = true;
  }

  // Restore the original methods captured at install time. If another
  // plugin patched on top of us between install and uninstall, that
  // upper layer is preserved — we only touch the slot we own. Calling
  // uninstall without a prior install is a no-op (idempotent on the
  // un-installed direction).
  uninstall(): void {
    if (!this.installed) return;
    const vault = this.vault as Vault & {
      delete: DeleteLike;
      trash: DeleteLike;
    };
    if (this.originalDelete) vault.delete = this.originalDelete;
    if (this.originalTrash) vault.trash = this.originalTrash;
    this.originalDelete = null;
    this.originalTrash = null;
    this.installed = false;
  }

  // Best-effort capture: read the file's bytes through TrashStore.
  // We only intercept TFile (not TFolder) — see the file-level comment
  // on folder-deletion semantics. Failure is logged and swallowed so
  // the underlying delete proceeds either way.
  private async captureBeforeDelete(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile)) return;
    try {
      await this.capture.captureForDelete(file.path);
    } catch (e) {
      this.logger?.warn(
        "[diff2/trash-watcher] capture failed; proceeding with delete",
        { path: file.path, err: e },
      );
    }
  }
}
