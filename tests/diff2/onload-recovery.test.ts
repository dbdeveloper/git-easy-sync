// Onload recovery DRIVER orchestration (src/diff2/onload-recovery.ts).
// Verifies that recoverAutosaveDirs (a) GCs §4.2-condemned stale sessions via
// sweepAll, (b) keeps live sessions, and (c) hands `done.json` dirs to
// recoverCommit. The A–K recovery matrix itself is covered by
// exit-commit-recovery-matrix.test.ts; here we assert the ORCHESTRATION:
// which dirs get swept vs recovered vs kept.
//
// Node env (real fs over a tmpdir via mock-obsidian Vault).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { autosaveDir, startSession } from "../../src/diff2/autosave-store";
import { recoverAutosaveDirs } from "../../src/diff2/onload-recovery";
import { buildEditBlock, serializeBlock } from "../../src/diff2/history-log-v2";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const NOW = "2026-06-03T12:00:00.000Z";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `onload-recovery-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return { root, vault: new MockVault(root) as unknown as Vault };
}

// Create a live autosave session for `id` over base/sibling files unique to it.
async function makeSession(
  vault: Vault,
  id: string,
  baseContent = "base content\n",
  sibContent = "sibling content\n",
): Promise<{ basePath: string; siblingPath: string }> {
  const basePath = `${id}-base.md`;
  const siblingPath = `${id}-sibling.md`;
  await vault.adapter.writeBinary(basePath, enc(baseContent));
  await vault.adapter.writeBinary(siblingPath, enc(sibContent));
  await startSession(vault, id, basePath, siblingPath, NOW);
  // Record one edit — a 0-record session is now swept by the §4.1 zero-edit
  // invariant (cond 2b), so a "keep"/"defer" fixture must look like real work.
  await vault.adapter.append(
    `${autosaveDir(id)}/history.jsonl`,
    serializeBlock(buildEditBlock(1, NOW, [10], [], 1)) + "\n",
  );
  return { basePath, siblingPath };
}

describe("recoverAutosaveDirs — onload orchestration", () => {
  let fx: ReturnType<typeof fixture>;
  beforeEach(() => {
    fx = fixture();
  });
  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it("no autosave root → returns zeros, no throw", async () => {
    const r = await recoverAutosaveDirs(fx.vault);
    expect(r).toEqual({ dirs: 0, swept: 0, recovered: 0, results: [] });
  });

  it("keep / sweep / defer dirs are routed correctly in one pass", async () => {
    // keep: a healthy live session (inputs intact, base != sibling).
    await makeSession(fx.vault, "tracked-keep");
    // sweep: §4.2 condemns it — its base input vanished from the vault.
    const s = await makeSession(fx.vault, "tracked-sweep");
    await fx.vault.adapter.remove(s.basePath); // → "input-missing"
    // defer: a commit was in progress (done.json present) → recoverCommit owns it.
    await makeSession(fx.vault, "tracked-defer");
    await fx.vault.adapter.writeBinary(
      `${autosaveDir("tracked-defer")}/done.json`,
      enc(
        JSON.stringify({
          v: 1,
          writtenAt: NOW,
          expectedBaseSha: "deadbeef",
          expectedSiblingSha: "cafebabe",
        }),
      ),
    );

    const r = await recoverAutosaveDirs(fx.vault);

    expect(r.dirs).toBe(3);
    expect(r.swept).toBe(1);
    expect(r.recovered).toBe(1);
    expect(r.results.map((x) => x.conflictId)).toEqual(["tracked-defer"]);

    // keep dir survives; sweep dir is gone; defer dir was handed to recoverCommit.
    expect(await fx.vault.adapter.exists(autosaveDir("tracked-keep"))).toBe(true);
    expect(await fx.vault.adapter.exists(autosaveDir("tracked-sweep"))).toBe(
      false,
    );
  });

  it("a defer dir with no staged bytes rolls back, preserving the session", async () => {
    // done.json present but originals untouched (== start snapshots) and no
    // .ges-tmp/.ges-bak → recoverCommit takes the A–C rollback path and the
    // session dir survives for the user to resume.
    await makeSession(fx.vault, "tracked-rb");
    await fx.vault.adapter.writeBinary(
      `${autosaveDir("tracked-rb")}/done.json`,
      enc(
        JSON.stringify({
          v: 1,
          writtenAt: NOW,
          expectedBaseSha: "deadbeef",
          expectedSiblingSha: "cafebabe",
        }),
      ),
    );

    const r = await recoverAutosaveDirs(fx.vault);

    expect(r.recovered).toBe(1);
    expect(r.results[0].recover.kind).toBe("rolled-back");
    // Session preserved (rollback abandons the commit, not the autosave).
    expect(await fx.vault.adapter.exists(autosaveDir("tracked-rb"))).toBe(true);
    // done.json is cleared by the rollback so a re-run is idempotent.
    expect(
      await fx.vault.adapter.exists(`${autosaveDir("tracked-rb")}/done.json`),
    ).toBe(false);
  });
});
