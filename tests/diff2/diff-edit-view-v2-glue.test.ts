// @vitest-environment happy-dom
//
// P6.3 — pins the DECISIONS DiffEditView.mountDiffPane / exitDetailView make on
// the V2 path, which the §1 diff-edit-view-commit.test.ts / reopen-empty-history.
// test.ts no longer exercise (they still drive the dead §1 DiffPane). mountDiffPane
// + exitDetailView are private ItemView glue with no mount harness, so — like
// reopen-empty-history.test.ts — this replays the glue against a real fs-backed
// vault + the REAL DiffPaneOwner:
//   (a) the skip-modal gate: assessHistoryV2(sess.jsonl).empty
//   (b) the exit recordCount: assessHistoryV2(readHistory after drain).edits
//       drives commitOrDiscardExit → discarded (net 0) vs committed (net > 0).
// These are net-count + disk-read decisions, behaviorally different from §1's
// in-memory liveBlockCount(), so they need V2 coverage before P6.4 deletes the
// §1 tests.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { undo } from "@codemirror/commands";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { DiffPaneOwner } from "../../src/diff2/diff-pane-owner";
import {
  autosaveDir,
  readResumeSession,
  startSession,
} from "../../src/diff2/autosave-store";
import {
  autosaveIdForEntry,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";
import { assessHistoryV2 } from "../../src/diff2/history-replay-v2";
import { commitOrDiscardExit } from "../../src/diff2/exit-commit";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

function fixture() {
  const root = path.join(os.tmpdir(), `view-glue-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

function entryFor(basePath: string, siblingPath: string): ConflictEntry {
  return { basePath, siblingPath, deviceLabel: "Phone", isoTimestamp: "2026-06-03T10-30-00Z", kind: "synthetic" };
}

// The exact string exitDetailView reads to compute recordCount (its
// readHistoryJsonl is module-private — replicated here, the glue under test).
const readHistory = async (vault: Vault, id: string): Promise<string> => {
  const p = `${autosaveDir(id)}/history.jsonl`;
  return (await vault.adapter.exists(p)) ? vault.adapter.read(p) : "";
};

describe("DiffEditView V2 glue (P6.3 decisions)", () => {
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

  async function setup(base: string, sibling: string) {
    const basePath = "Notes/g.md";
    const siblingPath = "Notes/g.conflict-from-Phone-2026-06-03T10-30-00Z.md";
    await fx.vault.adapter.writeBinary(basePath, enc(base));
    await fx.vault.adapter.writeBinary(siblingPath, enc(sibling));
    const entry = entryFor(basePath, siblingPath);
    const conflictId = autosaveIdForEntry(entry);
    const meta = await startSession(fx.vault, conflictId, basePath, siblingPath);
    return { basePath, siblingPath, conflictId, meta };
  }

  it("(a) skip-modal gate: fresh session is empty; after a recorded edit it is not", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { conflictId } = await setup(base, sibling);

    // Fresh, unedited → the mountDiffPane resume/restore branches skip the modal.
    expect(assessHistoryV2((await readResumeSession(fx.vault, conflictId)).jsonl).empty).toBe(true);

    // One recorded resolution → no longer empty → the modal WOULD show.
    const owner = new DiffPaneOwner(fx.vault, conflictId, container, base, sibling, {}, 0);
    owner.applyResolveAll("keep1");
    await owner.drainHistory();
    owner.dispose();
    expect(assessHistoryV2((await readResumeSession(fx.vault, conflictId)).jsonl).empty).toBe(false);
  });

  it("(b) exit net-zero (type→undo) → recordCount 0 → discarded, inputs untouched", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { basePath, siblingPath, conflictId, meta } = await setup(base, sibling);

    const owner = new DiffPaneOwner(fx.vault, conflictId, container, base, sibling, {}, 0);
    const view = owner.getView();
    // Type a char, then undo it → feed records edit + undo → net 0.
    view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    undo(view);
    await owner.drainHistory();

    const recordCount = assessHistoryV2(await readHistory(fx.vault, conflictId)).edits;
    expect(recordCount).toBe(0);

    const resolved = owner.getResolved();
    const outcome = await commitOrDiscardExit(fx.vault, conflictId, meta, resolved, recordCount);
    owner.dispose();

    expect(outcome.kind).toBe("discarded");
    // The dir is wiped and BOTH inputs are byte-untouched.
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(base);
    expect(dec(await fx.vault.adapter.readBinary(siblingPath))).toBe(sibling);
  });

  it("(b) exit net>0 (resolution) → recordCount>0 → committed", async () => {
    const base = "a\nMINE\nc\n";
    const sibling = "a\nTHEIRS\nc\n";
    const { basePath, conflictId, meta } = await setup(base, sibling);

    const owner = new DiffPaneOwner(fx.vault, conflictId, container, base, sibling, {}, 0);
    owner.applyResolveAll("keep1"); // converge on ours
    await owner.drainHistory();

    const recordCount = assessHistoryV2(await readHistory(fx.vault, conflictId)).edits;
    expect(recordCount).toBeGreaterThan(0);

    const resolved = owner.getResolved();
    const outcome = await commitOrDiscardExit(fx.vault, conflictId, meta, resolved, recordCount);
    owner.dispose();

    expect(outcome.kind).toBe("committed");
    expect(dec(await fx.vault.adapter.readBinary(basePath))).toBe(resolved.base);
    expect(await fx.vault.adapter.exists(autosaveDir(conflictId))).toBe(false);
  });
});
