// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Push-in-flight crash marker (SYNC2 §7.9 / crash-recovery).
//
// The push flow advances the tracked branch and THEN records the snapshot:
//   updateBranchHead(commitSha)   ← REMOTE HEAD ADVANCES (point of no return)
//   ...
//   setLastSync(commitSha, tree)  ← snapshot updated in memory
//   store.save()                  ← snapshot PERSISTED to disk
// A crash (kill Obsidian) BETWEEN the ref-advance and the persist leaves the
// remote advanced but the on-disk snapshot frozen at the OLD head. On a
// single-writer vault that stale base is the ONLY way a modify-vs-modify
// "conflict with yourself" can arise: after a post-crash edit, the reconcile
// 3-ways the local file against a base that no longer matches the remote.
//
// This marker closes that window. Written (durably) BEFORE the ref-advance,
// removed AFTER the persist. On the next sync, recoverPushInflight() (in
// Sync2Manager, BEFORE findChanges) reads it, checks the real remote head, and
// — if our push actually landed — records the snapshot at that head so the base
// is correct before anything measures against it.
//
// Per-device state: lives in the plugin's own folder
// (`<configDir>/plugins/<id>/.push-inflight.json`), alongside `.push-queue`,
// `.conflicts`, etc. Everything there except main.js/manifest.json/styles.css is
// already gitignored (the `plugins/*/*` recommended default), so it never
// propagates between machines — no invariant-block entry needed. Mobile-safe:
// only `vault.adapter` (no Node fs).

import { normalizePath, type Vault } from "obsidian";

export const PUSH_INFLIGHT_FILE_NAME = ".push-inflight.json";

export interface PushInflightMarker {
  // The commit the tracked branch was advanced to (updateBranchHead's sha).
  newHead: string;
  // Its tree sha — recorded into the snapshot on heal so a later reconcile
  // targets the right base_tree.
  newTreeSha: string;
  // The queued batch whose push this ref-advance completed. Deleted on heal
  // (its content already landed on the remote), so it doesn't re-push.
  batchId?: string;
}

const markerPath = (vault: Vault, selfPluginId: string): string =>
  normalizePath(
    `${vault.configDir}/plugins/${selfPluginId}/${PUSH_INFLIGHT_FILE_NAME}`,
  );

// Record "about to advance the tracked branch to newHead". MANDATORY, and MUST
// resolve (bytes durably on disk) BEFORE the caller issues updateBranchHead. If
// this THROWS the caller must NOT advance the remote — that is what makes "remote
// advanced without a recoverable marker" UNREACHABLE, so the §7.9 false conflict
// is eliminated, not merely mitigated. It rests on the same write-durability
// `store.save()` already relies on (no weaker); a failure here fails the sync as a
// normal retryable error (the batch stays queued) — correct for a correctness-first
// stance, and the failure modes overlap anyway (if we can't write a tiny file to
// the plugin's own folder, we can't push either).
//
// The plugin's own folder always exists in production; the segment-by-segment
// ensureDir covers tests / an unexpectedly-missing dir (adapter.mkdir is
// non-recursive on some platforms). NO try/catch: a failure MUST propagate.
export async function writePushInflight(
  vault: Vault,
  selfPluginId: string,
  marker: PushInflightMarker,
): Promise<void> {
  const dir = normalizePath(`${vault.configDir}/plugins/${selfPluginId}`);
  if (!(await vault.adapter.exists(dir))) {
    let acc = "";
    for (const part of dir.split("/")) {
      acc = acc === "" ? part : `${acc}/${part}`;
      if (!(await vault.adapter.exists(acc))) await vault.adapter.mkdir(acc);
    }
  }
  await vault.adapter.write(markerPath(vault, selfPluginId), JSON.stringify(marker));
}

// null when absent or unparseable (a corrupt marker degrades to "no marker" =
// today's self-heal-or-conflict behaviour — never worse).
export async function readPushInflight(
  vault: Vault,
  selfPluginId: string,
): Promise<PushInflightMarker | null> {
  const path = markerPath(vault, selfPluginId);
  if (!(await vault.adapter.exists(path))) return null;
  try {
    const parsed = JSON.parse(await vault.adapter.read(path)) as PushInflightMarker;
    if (typeof parsed?.newHead === "string" && typeof parsed?.newTreeSha === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// Idempotent remove (called after a successful persist, and on recovery).
export async function clearPushInflight(
  vault: Vault,
  selfPluginId: string,
): Promise<void> {
  const path = markerPath(vault, selfPluginId);
  if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
}
