// Production VaultFileReader (Phase 5.5 step 2b) — the drain's live
// vault surface (drain.ts VaultFileReader contract). Four operations,
// each mapped onto the battle-tested primitives the old engine used
// for the same job:
//
//   stat   — adapter.stat, the Vault-step's read short-circuit (§5.4
//            precedent: unchanged {mtime,size} vs the stored baseline
//            proves baseline content, no read/hash needed).
//   read   — adapter.readBinary ALWAYS (mobile rule: the text path
//            silently corrupts binary content on iOS) + injected SHA
//            (worker-routed in production).
//   write  — ensureParentDir + atomicWriteFile (crash-safe, preserves
//            an open editor's cursor via the modify-in-place fast
//            path) + the PULL-SIDE CANONICALIZE (text-normalize.ts
//            names three sites that MUST agree — push enqueue, push
//            merge, and this one; a file normalized on one side and
//            passed raw on the other "would re-sync forever").
//            Restored at THE SWITCH gate: the new drain writes remote
//            bytes verbatim, so a CRLF/BOM file authored on the web
//            landed raw and never converged (integration
//            pull-of-{crlf,bom}-from-web). Convergence is the
//            documented one-round-trip shape: the vault holds the
//            canonical bytes while the baseline holds the remote sha
//            → the next findChanges emits the path → the next drain
//            pushes the clean version.
//   remove — best-effort trash capture (R3.4 pull-delete window),
//            then adapter.remove; already-gone = success.

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import { canonicalizeBytes, shouldCanonicalize } from "./text-normalize";
import type { TrashHooks } from "./trash-hooks";
import type { VaultFileReader } from "./drain";
import {
  markerNameFor,
  stagingNameFor,
} from "./plugin-update-bootloader";

export interface VaultFileReaderDeps {
  vault: Vault;
  // Live settings getter (autoCanonicalizeTextFiles). Production
  // default is OFF; when ON, pull-side writes land canonical.
  autoCanonicalize?: () => boolean;
  // Worker-routed in production (WorkerClient.computeSha); the
  // threshold routing lives there, not here.
  computeSha(bytes: ArrayBuffer): Promise<string>;
  // Optional — trash is a safety net, not a hard dependency
  // (trash-hooks.ts contract: failures are logged and swallowed).
  trashHooks?: TrashHooks | null;
  logger?: { warn(message: string, data?: unknown): void };
  // Our own plugin's id — the ONE folder whose loadable files are
  // staged instead of written (see `stageSelfUpdate`).
  selfPluginId: string;
}

async function ensureParentDir(vault: Vault, filePath: string): Promise<void> {
  const slash = filePath.lastIndexOf("/");
  if (slash <= 0) return;
  const parent = filePath.substring(0, slash);
  if (await vault.adapter.exists(parent)) return;
  const parts = parent.split("/");
  let acc = "";
  for (const part of parts) {
    acc = acc === "" ? part : `${acc}/${part}`;
    if (!(await vault.adapter.exists(acc))) {
      await vault.adapter.mkdir(acc);
    }
  }
}

export function makeVaultFileReader(
  deps: VaultFileReaderDeps,
): VaultFileReader {
  // Where the bootloader will look at the top of the next onload.
  const stagedPaths = (path: string): { tmp: string; marker: string } => {
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash);
    const name = path.slice(slash + 1);
    return {
      tmp: `${dir}/${stagingNameFor(name, "ges-tmp")}`,
      marker: `${dir}/${markerNameFor(name)}`,
    };
  };

  return {
    // ⚠️ OUR OWN plugin's loadable files are STAGED, never written.
    //
    // Every other torn write in this vault is repaired at our next
    // onload. This one cannot be: if `main.js` is damaged or missing,
    // Obsidian does not load us, the repair code never runs, and the
    // user is left reinstalling by hand. So the live file is touched at
    // exactly one moment — the top of onload, by the bootloader, while
    // the OLD code is running and healthy.
    //
    // ORDER IS THE INTEGRITY CONTRACT: bytes first, marker second. The
    // marker means "the staging file beside me is COMPLETE"; raised
    // first, it would make the bootloader apply a half-written file
    // over working code (bootloader case C exists for exactly this).
    async stageSelfUpdate(path, bytes) {
      const normalized = normalizePath(path);
      const { tmp, marker } = stagedPaths(normalized);
      await ensureParentDir(deps.vault, tmp);
      await deps.vault.adapter.writeBinary(tmp, bytes);
      // The marker carries the sha the staged file MUST hash to
      // (owner, 2026-10-02). Its presence alone would only prove that
      // the write above RETURNED — and on a phone a write can return
      // before its bytes are durable, leaving a complete marker beside
      // a truncated file that the atomic swap would then install
      // flawlessly. Free here: the bytes are already in hand.
      await deps.vault.adapter.write(marker, await deps.computeSha(bytes));
    },

    // Is THIS content already staged and complete? Asked before the
    // blob is fetched, so an update that lands before the user
    // restarts is not re-downloaded on every sync. `false` for a
    // staging file with no marker — that is a torn write, not an
    // update (the bootloader drops it).
    async isSelfUpdateStaged(path, sha) {
      const normalized = normalizePath(path);
      const { tmp, marker } = stagedPaths(normalized);
      if (!(await deps.vault.adapter.exists(marker))) return false;
      if (!(await deps.vault.adapter.exists(tmp))) return false;
      try {
        const bytes = await deps.vault.adapter.readBinary(tmp);
        return (await deps.computeSha(bytes)) === sha;
      } catch {
        return false;
      }
    },

    async stat(path) {
      const s = await deps.vault.adapter.stat(normalizePath(path));
      if (s === null || s.type !== "file") return null;
      return { size: s.size, mtime: s.mtime };
    },

    async read(path) {
      const normalized = normalizePath(path);
      const s = await deps.vault.adapter.stat(normalized);
      if (s === null || s.type !== "file") return null;
      const blob = await deps.vault.adapter.readBinary(normalized);
      return {
        // Sizes from the bytes actually read (the truth), mtime from
        // the stat — a bump BETWEEN the two calls only makes the next
        // detection re-check, never corrupts content.
        size: blob.byteLength,
        mtime: s.mtime,
        sha: await deps.computeSha(blob),
        blob,
      };
    },

    async write(path, bytes) {
      const normalized = normalizePath(path);
      await ensureParentDir(deps.vault, normalized);
      // The SAME canonical form the commit side records
      // (canonicalizeBytes — round-trip PROOF first, the §II.15 rule:
      // invalid UTF-8 under a text extension passes through untouched,
      // never through a lossy decode). One function for both sides is
      // what keeps them agreeing; a file normalized on one side and
      // passed raw on the other would re-sync forever.
      const { bytes: out } = canonicalizeBytes(
        bytes,
        deps.autoCanonicalize?.() === true &&
          shouldCanonicalize(normalized, deps.vault.configDir),
      );
      await atomicWriteFile(deps.vault, normalized, out);
    },

    async remove(path) {
      const normalized = normalizePath(path);
      if (!(await deps.vault.adapter.exists(normalized))) return;
      // Owner, 2026-10-05: a deletion that ARRIVES FROM THE SERVER never
      // removes our own plugin. A clean-up of the repo on GitHub deleted
      // main.js/manifest.json/styles.css here and the running sync plugin
      // uninstalled itself — on a device nobody is looking at, sync just
      // stops. Uninstalling is the user's conscious act (Obsidian's own
      // UI, or the file system), never a sync side effect. The files stay,
      // and the next commit sends them back to the repo (owner's option a).
      // Same for a .gitignore at any level (owner, 2026-10-05): one
      // "cannot not exist", so its deletion arriving from the server is
      // suspicious — and in the field it was exactly what exposed
      // formerly ignored, private files to the next commit. Kept with
      // its rules; the next commit sends it back. A .gitignore is
      // supported — and synced — only at the root, in <configDir>/, in
      // <configDir>/plugins/ and in <configDir>/plugins/<id>/ (DOT-FILES
      // D5), so those are the only ones a pull could ever delete; the
      // check is by name.
      const base = normalized.slice(normalized.lastIndexOf("/") + 1);
      if (base === ".gitignore") {
        deps.logger?.warn(
          "VaultFileReader: remote deletion of a .gitignore NOT applied (kept with its rules; the next commit restores it on the server)",
          { path: normalized },
        );
        return;
      }
      const ownDir = `${deps.vault.configDir}/plugins/${deps.selfPluginId}/`;
      if (normalized.startsWith(ownDir)) {
        deps.logger?.warn(
          "VaultFileReader: remote deletion of our own plugin file NOT applied (kept; the next commit restores it on the server)",
          { path: normalized },
        );
        return;
      }
      if (deps.trashHooks) {
        try {
          await deps.trashHooks.captureForDelete(normalized);
        } catch (err) {
          deps.logger?.warn("VaultFileReader: trash capture failed", {
            path: normalized,
            err: `${err}`,
          });
        }
      }
      await deps.vault.adapter.remove(normalized);
    },
  };
}
