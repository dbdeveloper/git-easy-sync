// @vitest-environment happy-dom
//
// bug-56 regression — a REAL captured session (114 blocks) whose replay DIVERGES partway
// (a block recorded against the old, un-guarded autoResolveFilter that re-cascaded on
// replay/undo). The fix is two-fold:
//   1. autoResolveFilter skips replayDispatch + undo/redo (no double-cascade) — moves the
//      divergence far later, and makes live undo/redo balance (debit=credit).
//   2. replayHistoryV2 STOPS at the first un-appliable block instead of throwing — so a
//      diverged/corrupt tail can NEVER brick the resume (base+sibling are the ground truth;
//      the user re-resolves the rest). This test pins #2: the fixture replays WITHOUT
//      throwing and leaves a usable doc.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";
import { replayHistoryV2 } from "../../src/diff2/history-replay-v2";
import { ReplayFlag, replayWithGuard } from "../../src/diff2/history-feed";

const fx = (n: string) => readFileSync(join(process.cwd(), "tests/diff2/fixtures/bug56", n), "utf8");
const mount = (b: string, s: string) => {
  const p = document.createElement("div");
  document.body.appendChild(p);
  return mountDiffPaneV2(p, b, s);
};

describe("bug56 — diverging replay stops safely, never throws", () => {
  it("replays the captured session without throwing + leaves a usable doc", () => {
    const view = mount(fx("base.snapshot"), fx("sibling.snapshot"));
    const res = replayHistoryV2(view, fx("history.jsonl")); // must NOT throw
    // this specific fixture diverges, so replay stops early (the safety net engaged)…
    expect(res.stoppedAtError).not.toBeNull();
    // …but the editor is still usable: the safe prefix applied + conflicts remain to resolve.
    expect(res.replayed).toBeGreaterThan(0);
    expect(readStructure(view.state).length).toBeGreaterThan(0);
  });

  // the pre-flight invariant: the dry-run (replayHistoryV2, sink-less) the modal counts from
  // produces the SAME outcome as the real recovery (replayWithGuard) — so "NNN edits saved"
  // equals what Continue actually restores.
  it("dry-run replay == guarded replay (same stop-point + same doc)", () => {
    const base = fx("base.snapshot");
    const sibling = fx("sibling.snapshot");
    const jsonl = fx("history.jsonl");
    const dry = mount(base, sibling);
    const dryRes = replayHistoryV2(dry, jsonl);
    const real = mount(base, sibling);
    const realRes = replayWithGuard(real, jsonl, new ReplayFlag());
    expect(realRes.stoppedAtError?.block).toBe(dryRes.stoppedAtError?.block);
    expect(realRes.replayed).toBe(dryRes.replayed);
    expect(real.state.doc.toString()).toBe(dry.state.doc.toString());
  });
});
