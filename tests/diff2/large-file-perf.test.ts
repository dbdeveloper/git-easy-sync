// @vitest-environment happy-dom
//
// Large-file perf repro (user: a ~2 MB history version froze the UI ~1-2 min on [←]).
// Reproduces the recorded-history round-trip in Node so the hotspot is measurable WITHOUT
// a device: a big content change (a "Restore"/"Apply all" on a large file) is recorded to
// history.jsonl, then the [←] commit reads + parses it (assessHistoryV2 → scanHistoryV2 →
// per-block fnv1a32 over the block's full content). Times each phase so a regression in any
// of them is caught. Thresholds are GENEROUS (catch an O(n²)/minute-scale catastrophe, not
// a few-hundred-ms wobble on a slow CI box).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import type { Vault } from "obsidian";
import { Vault as MockVault } from "../../mock-obsidian";
import { DiffPaneOwner } from "../../src/diff2/diff-pane-owner";
import { startSession, autosaveDir } from "../../src/diff2/autosave-store";
import { assessHistoryV2 } from "../../src/diff2/history-replay-v2";

const CONFIG = { localLabel: "Local", remoteLabel: "Phone", date: "", isMarkdown: true };

function fixture() {
  const root = path.join(os.tmpdir(), `lfp-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

describe("large-file history round-trip perf (2 MB)", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => {
    if (fs.existsSync(fx.root)) fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("records + drains + assesses a ~2 MB change without a minute-scale stall", async () => {
    const conflictId = "perf-2mb";
    const basePath = "Notes/big.md";
    const siblingPath = "Notes/big.conflict-from-Phone-2026-07-04T10-00-00Z.md";
    // Two small identical starting sides (fast mount, no big diff) — the COST we're
    // hunting is the recorded CHANGE, not the initial diff.
    await fx.vault.adapter.writeBinary(basePath, new TextEncoder().encode("a\nb\n").buffer as ArrayBuffer);
    await fx.vault.adapter.writeBinary(siblingPath, new TextEncoder().encode("a\nb\n").buffer as ArrayBuffer);
    await startSession(fx.vault, conflictId, basePath, siblingPath);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const owner = new DiffPaneOwner(fx.vault, conflictId, host, "a\nb\n", "a\nb\n", CONFIG, 0);
    const view = owner.getView();

    // Simulate a "Restore/Apply all" that pours ~2 MB of content into the doc: one big
    // insert → one recorded edit block carrying the ~2 MB change.
    const big = "lorem ipsum dolor sit amet ".repeat(80_000); // ~2.1 MB
    const tDispatch = performance.now();
    view.dispatch({ changes: { from: 0, insert: big }, userEvent: "input.type" });
    const dispatchMs = Math.round(performance.now() - tDispatch);

    const tDrain = performance.now();
    await owner.drainHistory();
    const drainMs = Math.round(performance.now() - tDrain);

    const jsonl = await fx.vault.adapter.read(`${autosaveDir(conflictId)}/history.jsonl`);

    const tAssess = performance.now();
    const edits = assessHistoryV2(jsonl).edits;
    const assessMs = Math.round(performance.now() - tAssess);

    // eslint-disable-next-line no-console
    console.log(
      `[large-file-perf] jsonlMB=${(jsonl.length / 1e6).toFixed(2)} ` +
        `dispatchMs=${dispatchMs} drainMs=${drainMs} assessMs=${assessMs} edits=${edits}`,
    );

    owner.dispose();
    host.remove();

    // Sanity: the change was recorded.
    expect(edits).toBeGreaterThan(0);
    // Catastrophe guards (O(n²)/minute-scale). A healthy 2 MB round-trip is well under 1 s
    // per phase; 10 s means something is quadratic on the main thread.
    expect(dispatchMs).toBeLessThan(10_000);
    expect(drainMs).toBeLessThan(10_000);
    expect(assessMs).toBeLessThan(10_000);
  });

  // The user's ACTUAL scenario: a ~2 MB historical version restored onto a small/empty
  // current file. Probe mount (diff), the resolve gesture, getResolved (splitModel), and —
  // the prime remaining suspect — the word-level intra-chunk diff on large conflict content.
  it("mount + resolve + getResolved on 2 MB sides (word-level diff probe)", async () => {
    const conflictId = "perf-2mb-conflict";
    const basePath = "Notes/hist.md";
    const siblingPath = "Notes/hist.conflict-from-Phone-2026-07-04T10-00-00Z.md";

    // Two LARGE, DIFFERING sides → a big conflict group → the decoration layer runs the
    // word-level diff on ~2 MB content. This is what mount-onto-a-real-diff looks like.
    const oursBig = "alpha beta gamma delta ".repeat(90_000); // ~2 MB
    const theirsBig = "alpha BETA gamma DELTA ".repeat(90_000); // ~2 MB, differs every line
    await fx.vault.adapter.writeBinary(basePath, new TextEncoder().encode(oursBig).buffer as ArrayBuffer);
    await fx.vault.adapter.writeBinary(siblingPath, new TextEncoder().encode(theirsBig).buffer as ArrayBuffer);
    await startSession(fx.vault, conflictId, basePath, siblingPath);

    const host = document.createElement("div");
    document.body.appendChild(host);

    const tMount = performance.now();
    const owner = new DiffPaneOwner(fx.vault, conflictId, host, oursBig, theirsBig, CONFIG, 0);
    const mountMs = Math.round(performance.now() - tMount);

    const tResolve = performance.now();
    owner.applyResolveAll("keep2"); // "Apply all" — accept the remote/current side
    const resolveMs = Math.round(performance.now() - tResolve);

    const tGet = performance.now();
    const resolved = owner.getResolved();
    const getMs = Math.round(performance.now() - tGet);

    // eslint-disable-next-line no-console
    console.log(
      `[large-file-perf/conflict] docMB=${((oursBig.length + theirsBig.length) / 1e6).toFixed(2)} ` +
        `mountMs=${mountMs} resolveMs=${resolveMs} getResolvedMs=${getMs} ` +
        `resolvedBaseKB=${Math.round(resolved.base.length / 1024)}`,
    );

    owner.dispose();
    host.remove();

    // With the intra-chunk size cap (word-level-diff.ts), a big conflict group SKIPS the
    // O(n²) char/word diff (line-level tint remains) → mount + resolve stay fast. Pre-cap
    // these were MINUTES (diffWords on ~2 MB differing content). Guards well above the
    // capped cost (~tens of ms) but far under the pre-cap catastrophe.
    expect(mountMs).toBeLessThan(3_000);
    expect(resolveMs).toBeLessThan(3_000);
    expect(getMs).toBeLessThan(1_000);
  });
});
