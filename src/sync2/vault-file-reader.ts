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
//            path).
//   remove — best-effort trash capture (R3.4 pull-delete window),
//            then adapter.remove; already-gone = success.

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import type { TrashHooks } from "./trash-hooks";
import type { VaultFileReader } from "./drain";

export interface VaultFileReaderDeps {
  vault: Vault;
  // Worker-routed in production (WorkerClient.computeSha); the
  // threshold routing lives there, not here.
  computeSha(bytes: ArrayBuffer): Promise<string>;
  // Optional — trash is a safety net, not a hard dependency
  // (trash-hooks.ts contract: failures are logged and swallowed).
  trashHooks?: TrashHooks | null;
  logger?: { warn(message: string, data?: unknown): void };
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
  return {
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
      await atomicWriteFile(deps.vault, normalized, bytes);
    },

    async remove(path) {
      const normalized = normalizePath(path);
      if (!(await deps.vault.adapter.exists(normalized))) return;
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
