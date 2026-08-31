// On-load recovery sweep for .trash/.
//
// Called from main.ts::onload BEFORE Sync2Manager instantiation so the
// recovery state is consistent before the sync engine starts touching
// the vault. Idempotent on repeat invocation.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.11 (recovery sweep algorithm)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R8.1 (TrashStore.create row,
//     plus the lift/return rows that share the same metadata-only
//     recovery shape)
//
// Three classes of post-crash state are reconciled:
//
//   (A) Orphan dir without valid meta.json — intercept crash between
//       writeBinary (bytes landed in .trash/<id>/vault/<originalPath>)
//       and atomicWriteJson (meta missing or torn). We walk the vault/
//       subdir, restore each file back to vault root (collision-rename
//       if the path is now occupied by a freshly-created file), then
//       rmrf the orphan dir.
//
//   (B) Stale liftedAsSessionId marker — UI vanished when Obsidian was
//       killed; the marker has no live session to claim it. Clear the
//       field with atomicWriteJson. The vault/ file is untouched
//       (metadata-only protocol of R3.7).
//
//   (C) Meta valid but vault/<originalPath> missing — rare crash where
//       writeBinary itself failed or the entry was tampered with.
//       Wipe the bundle (no recoverable bytes).
//
// After the per-dir pass, orphan .tmp files left by interrupted
// atomicWriteJson calls are cleaned up — they're inert but accumulate
// otherwise.

import { DataAdapter, Vault } from "obsidian";
import Logger from "../logger";
import { extensionOf } from "../sync2/conflict-siblings";
import { safeRename } from "../sync2/cross-platform";
import { TrashStore } from "./trash-store";
import {
  atomicWriteJson,
  ensureParentDirs,
  rmrf,
  tryReadMetaJson,
} from "./trash-disk-helpers";
import type { TrashRecord } from "./types";

const VAULT_SUBDIR = "vault";
const META_FILE = "meta.json";
const META_TMP_FILE = "meta.json.tmp";

export interface TrashRecoveryDeps {
  vault: Vault;
  configDir: string;
  selfPluginId: string;
  trashStore: TrashStore;
  logger?: Logger;
  now?: () => Date;
}

export async function sweepOnload(deps: TrashRecoveryDeps): Promise<void> {
  const trashRoot = `${deps.configDir}/plugins/${deps.selfPluginId}/.runtime/trash`;
  const adapter = deps.vault.adapter;
  const now = deps.now ?? (() => new Date());

  // Ensure trash root exists so subsequent operations have a target.
  await deps.trashStore.init();

  if (!(await adapter.exists(trashRoot))) return;

  const { folders } = await adapter.list(trashRoot);
  let anyChange = false;

  for (const dir of folders) {
    const dirName = dir.slice(dir.lastIndexOf("/") + 1);
    // Defensive: skip directories that aren't shaped like trash entries.
    // Trash uses 17-digit timestamp IDs (newBatchId format); anything
    // else (e.g., a future .trash-staging/ if R3.7 ever returns) is
    // none of recovery's business.
    if (!/^\d{17}$/.test(dirName)) continue;

    const metaPath = `${dir}/${META_FILE}`;
    const meta = await tryReadMetaJson<TrashRecord>(adapter, metaPath);

    if (!meta || meta.id !== dirName) {
      // Case A: orphan dir without valid meta.
      await recoverOrphanDir(adapter, dir, now, deps.logger);
      anyChange = true;
      continue;
    }

    if (meta.liftedAsSessionId) {
      // Case B: stale lift marker.
      meta.liftedAsSessionId = undefined;
      await atomicWriteJson(adapter, metaPath, meta);
      deps.logger?.info(
        "[diff2/trash-recovery] cleared stale lift marker",
        { id: dirName },
      );
      anyChange = true;
      continue;
    }

    const vaultFile = `${dir}/${VAULT_SUBDIR}/${meta.originalPath}`;
    if (!(await adapter.exists(vaultFile))) {
      // Case C: meta valid, vault file gone.
      await rmrf(adapter, dir);
      deps.logger?.warn(
        "[diff2/trash-recovery] wiped orphan: vault file missing",
        { id: dirName, originalPath: meta.originalPath },
      );
      anyChange = true;
      continue;
    }

    // Otherwise: record is valid, in canonical post-intercept state.
    // Leave it alone — it'll be picked up by the regular cleanup
    // hooks on the next drain.
  }

  // Clean up orphan .tmp leftovers from interrupted atomicWriteJson
  // (write(tmp) succeeded, safeRename(tmp, meta.json) didn't). These
  // would otherwise accumulate forever.
  await cleanupOrphanTmpFiles(adapter, trashRoot);

  if (anyChange) deps.trashStore.notify();
}

async function recoverOrphanDir(
  adapter: DataAdapter,
  dir: string,
  now: () => Date,
  logger: Logger | undefined,
): Promise<void> {
  const vaultDir = `${dir}/${VAULT_SUBDIR}`;
  if (await adapter.exists(vaultDir)) {
    const recoveredAt = now()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/-\d{3}Z$/, "Z");
    const relFiles = await walkFiles(adapter, vaultDir);
    for (const rel of relFiles) {
      const src = `${vaultDir}/${rel}`;
      let dst = rel;
      if (await adapter.exists(dst)) {
        dst = collisionRename(rel, recoveredAt);
      }
      try {
        await ensureParentDirs(adapter, dst);
        await safeRename(adapter, src, dst);
        logger?.warn(
          "[diff2/trash-recovery] recovered interrupted delete",
          { originalPath: rel, restoredAs: dst },
        );
      } catch (err) {
        // A single-file rename failure shouldn't block the rest of the
        // orphan cleanup. Leave the file in place; the next sweep will
        // try again, OR the user can hand-recover from the bundle
        // directly before we rmrf.
        logger?.warn(
          "[diff2/trash-recovery] recovery rename failed; file left in trash dir",
          { src, dst, err: `${err}` },
        );
      }
    }
  }
  // The orphan bundle is wiped regardless of recovery outcome.
  // Any unrecovered file is lost — better than leaving an
  // unindexable .trash/<id>/ behind forever.
  await rmrf(adapter, dir);
}

function collisionRename(rel: string, recoveredAt: string): string {
  const ext = extensionOf(rel);
  const stem = ext ? rel.slice(0, -ext.length) : rel;
  return `${stem}.recovered-${recoveredAt}${ext}`;
}

// Recursive enumeration of vault/<dir>'s file contents as paths
// relative to <dir>. Returns "" if dir doesn't exist (defensive on
// adapters that throw on list of non-existent path).
async function walkFiles(
  adapter: DataAdapter,
  dir: string,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (cur: string, prefix: string): Promise<void> => {
    if (!(await adapter.exists(cur))) return;
    const { files, folders } = await adapter.list(cur);
    for (const f of files) {
      out.push(prefix + f.slice(cur.length + 1));
    }
    for (const sub of folders) {
      const subRel = sub.slice(cur.length + 1);
      await walk(sub, `${prefix}${subRel}/`);
    }
  };
  await walk(dir, "");
  return out;
}

async function cleanupOrphanTmpFiles(
  adapter: DataAdapter,
  trashRoot: string,
): Promise<void> {
  if (!(await adapter.exists(trashRoot))) return;
  const { folders } = await adapter.list(trashRoot);
  for (const dir of folders) {
    const tmpPath = `${dir}/${META_TMP_FILE}`;
    if (await adapter.exists(tmpPath)) {
      try {
        await adapter.remove(tmpPath);
      } catch {
        // Inert leftover; ignore and retry on next sweep.
      }
    }
  }
}
