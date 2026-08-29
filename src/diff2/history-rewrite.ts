// §0.5.5 carousel — atomic rewrite of history.jsonl + crash recovery (vault edge).
//
// compactHistoryV2 (pure) produces a shorter log; this swaps it in crash-safely so
// a crash mid-rewrite can never lose the session. Adapter-level (the autosave dir
// is NOT a vault TFile, so atomic-write.ts's TFile fast-path doesn't apply) — a
// dedicated bak-based swap mirroring its forward-recovery shape.
//
// Protocol (point-of-no-return = step 3, history → bak):
//   1. write   <history>.ges-tmp  = new (compacted) jsonl
//   2. remove  <history>.ges-bak  (clean any stale bak)
//   3. rename  <history> → <history>.ges-bak   (old preserved as bak)
//   4. rename  <history>.ges-tmp → <history>   (new promoted)
//   5. remove  <history>.ges-bak
// Capacitor rename never overwrites → each rename's dst is absent first (step 2
// clears bak; step 3 moves history away before step 4 targets it).
//
// Recovery (recoverHistoryRewrite, run at onload per dir):
//   - bak present  → past the point of no return:
//       history present → step 4 done, crashed before 5 → drop bak (+ stray tmp).
//       history absent  → between 3 and 4 → promote tmp→history (or restore
//                         bak→history if tmp is gone/torn), then drop bak.
//   - bak absent, tmp present → crashed before step 3 → old history is intact →
//                               discard the incomplete tmp (no data loss).

import type { Vault } from "obsidian";
import { autosaveDir } from "./autosave-store";
import { compactHistoryV2, scanHistoryV2 } from "./history-replay-v2";

const historyPathFor = (conflictId: string): string => `${autosaveDir(conflictId)}/history.jsonl`;

const rm = async (vault: Vault, p: string): Promise<void> => {
  if (await vault.adapter.exists(p)) await vault.adapter.remove(p);
};

// Atomically replace conflictId's history.jsonl with `jsonl`. No-op safety: callers
// only invoke when the compacted content actually differs.
export async function rewriteHistoryAtomic(
  vault: Vault,
  conflictId: string,
  jsonl: string,
): Promise<void> {
  const path = historyPathFor(conflictId);
  const tmp = `${path}.ges-tmp`;
  const bak = `${path}.ges-bak`;
  await vault.adapter.write(tmp, jsonl); // 1
  await rm(vault, bak); // 2
  if (await vault.adapter.exists(path)) await vault.adapter.rename(path, bak); // 3
  await vault.adapter.rename(tmp, path); // 4
  await rm(vault, bak); // 5
}

// Finish or roll back an interrupted rewrite for one dir. Idempotent; safe to call
// on every dir at onload (no-op when neither tmp nor bak exists).
export async function recoverHistoryRewrite(
  vault: Vault,
  conflictId: string,
): Promise<void> {
  const path = historyPathFor(conflictId);
  const tmp = `${path}.ges-tmp`;
  const bak = `${path}.ges-bak`;
  const a = vault.adapter;
  if (await a.exists(bak)) {
    if (await a.exists(path)) {
      // step 4 completed, crashed before step 5 → new is authoritative.
      await rm(vault, tmp);
      await rm(vault, bak);
      return;
    }
    // between 3 and 4: promote the new tmp, or roll back to bak if tmp is gone.
    if (await a.exists(tmp)) await a.rename(tmp, path);
    else await a.rename(bak, path);
    await rm(vault, bak);
    return;
  }
  // No bak → never reached the point of no return → discard any incomplete tmp.
  await rm(vault, tmp);
}

// §0.5.5 REOPEN-trigger: compact conflictId's history.jsonl and atomically swap it
// in IF compaction actually changed it. The byte-identity guard (`compacted !==
// original`) makes a clean (no-dead) log a no-op — compact re-seqs from 1 and
// re-sums, and a clean log already serializes identically, so no needless swap /
// rename churn on every reopen. Callers MUST gate on no commit-in-flight (done.json
// absent). Used at reopen (no live writer) AND as the writer's threshold-trigger
// runner (chained on the writer's tail → race-free with appends). Returns the NEW
// on-disk block count when it rewrote (the trigger resets seq to it), null on no-op.
export async function compactSessionLog(
  vault: Vault,
  conflictId: string,
): Promise<number | null> {
  const path = historyPathFor(conflictId);
  if (!(await vault.adapter.exists(path))) return null;
  const original = await vault.adapter.read(path);
  const compacted = compactHistoryV2(original);
  if (compacted === original) return null; // clean log → no-op (no churn)
  await rewriteHistoryAtomic(vault, conflictId, compacted);
  return scanHistoryV2(compacted).blocks.length;
}
