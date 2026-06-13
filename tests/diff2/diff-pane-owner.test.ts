// @vitest-environment happy-dom
//
// P6.3 — the V2 DiffPaneOwner (diff-pane-owner.ts), the V2-native replacement for
// the §1 DiffPane in DiffEditView. Exercises the real regression surface of the
// view-swap against a real happy-dom CM6 view + fs-backed vault:
//   - getResolved() = splitModel + empty→"\n" guard (what [←] commits)
//   - the commit chain (startSession → resolve → getResolved → commit7Step)
//   - replay round-trip + NO double-record (history-feed trap-2: ONE shared flag)
//   - inMemoryNetEdits (the fresh-session abandon-wipe signal)
//   - setCursor clamp

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPaneOwner } from "../../src/diff2/diff-pane-owner";
import {
  autosaveIdForEntry,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { classifyToctou, commit7Step } from "../../src/diff2/exit-commit";
import { scanHistoryV2 } from "../../src/diff2/history-replay-v2";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `owner-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

function entryFor(basePath: string, siblingPath: string): ConflictEntry {
  return {
    basePath,
    siblingPath,
    deviceLabel: "Phone",
    isoTimestamp: "2026-06-03T10-30-00Z",
    kind: "synthetic",
  };
}

const readHistory = (vault: Vault, id: string) =>
  vault.adapter.read(`${autosaveDir(id)}/history.jsonl`);

describe("DiffPaneOwner (P6.3 view-swap core)", () => {
  let fx: ReturnType<typeof fixture>;
  let container: HTMLElement;

  beforeEach(() => {
    fx = fixture();
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("resolve-all converges → commit writes base, removes redundant sibling, tears down dir", async () => {
    const basePath = "Notes/x.md";
    const siblingPath = "Notes/x.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nMINE\nc\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nTHEIRS\nc\n"));

    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    const meta = await startSession(fx.vault, conflictId, basePath, siblingPath);

    const owner = new DiffPaneOwner(
      fx.vault,
      conflictId,
      container,
      "a\nMINE\nc\n",
      "a\nTHEIRS\nc\n",
      { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true },
      0,
    );
    expect(owner.applyResolveAll("keep1")).toBe(true); // keep ours both sides
    const resolved = owner.getResolved();
    expect(resolved.base).toBe(resolved.sibling); // converged
    expect(owner.inMemoryNetEdits()).toBe(1); // one resolution recorded

    const toctou = await classifyToctou(fx.vault, meta);
    expect(toctou.kind).toBe("ok");

    const result = await commit7Step(fx.vault, conflictId, meta, resolved);
    owner.dispose();

    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(resolved.base);
    expect(result.siblingRemoved).toBe(true);
    expect(await fx.vault.adapter.exists(siblingPath)).toBe(false);
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
  });

  it("unresolved → getResolved keeps both sides distinct → commit writes both", async () => {
    const basePath = "Notes/y.md";
    const siblingPath = "Notes/y.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nMINE\nc\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nTHEIRS\nc\n"));

    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    const meta = await startSession(fx.vault, conflictId, basePath, siblingPath);

    const owner = new DiffPaneOwner(
      fx.vault,
      conflictId,
      container,
      "a\nMINE\nc\n",
      "a\nTHEIRS\nc\n",
      { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true },
      0,
    );
    const resolved = owner.getResolved();
    expect(resolved.base).not.toBe(resolved.sibling);
    expect(owner.inMemoryNetEdits()).toBe(0); // nothing recorded

    const result = await commit7Step(fx.vault, conflictId, meta, resolved);
    owner.dispose();

    expect(result.siblingRemoved).toBe(false);
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(resolved.base);
    expect(dec(await fx.vault.adapter.readBinary(siblingPath))).toBe(resolved.sibling);
  });

  it("replay round-trip reproduces the resolution AND records nothing new (trap-2)", async () => {
    const basePath = "Notes/z.md";
    const siblingPath = "Notes/z.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    await fx.vault.adapter.writeBinary(basePath, enc(base));
    await fx.vault.adapter.writeBinary(siblingPath, enc(sibling));

    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    await startSession(fx.vault, conflictId, basePath, siblingPath);

    // Live session: resolve, drain the feed to disk, capture the result.
    const live = new DiffPaneOwner(fx.vault, conflictId, container, base, sibling, { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true }, 0);
    live.applyResolveAll("keep2"); // apply theirs
    const liveResolved = live.getResolved();
    await live.drainHistory();
    live.dispose();

    const jsonl = await readHistory(fx.vault, conflictId);
    expect(scanHistoryV2(jsonl).blocks.length).toBe(1);

    // Recovery: a fresh owner replays the SAME log under guard, continuing the seq.
    const replayParent = document.createElement("div");
    document.body.appendChild(replayParent);
    const replayed = new DiffPaneOwner(
      fx.vault,
      conflictId,
      replayParent,
      base,
      sibling,
      { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true },
      scanHistoryV2(jsonl).blocks.length,
    );
    replayed.replayWithGuard(jsonl);
    const replayedResolved = replayed.getResolved();
    await replayed.drainHistory();
    replayed.dispose();
    replayParent.remove();

    // Replay reproduces the doc exactly…
    expect(replayedResolved).toEqual(liveResolved);
    // …and the guard kept the replay out of the log (no double-record).
    expect(await readHistory(fx.vault, conflictId)).toBe(jsonl);
  });

  it("setCursor clamps an out-of-range offset to the doc length", async () => {
    const basePath = "Notes/q.md";
    const siblingPath = "Notes/q.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc("a\nb\n"));
    await fx.vault.adapter.writeBinary(siblingPath, enc("a\nb\n"));
    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    await startSession(fx.vault, conflictId, basePath, siblingPath);

    const owner = new DiffPaneOwner(fx.vault, conflictId, container, "a\nb\n", "a\nb\n", { localLabel: "local", remoteLabel: "Phone", date: "", isMarkdown: true }, 0);
    const len = owner.getView().state.doc.length;
    owner.setCursor(9999, 9999);
    expect(owner.getView().state.selection.main.head).toBe(len);
    owner.dispose();
  });
});
