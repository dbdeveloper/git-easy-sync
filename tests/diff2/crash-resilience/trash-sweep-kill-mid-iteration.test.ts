import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../../mock-obsidian";
import { TrashStore } from "../../../src/diff2/trash-store";
import { sweepOnload } from "../../../src/diff2/trash-recovery";
import type { TrashRecord } from "../../../src/diff2/types";

// R8.1 — sweepOlderThan killed mid-iteration. Some records were
// already rmrf'd, others are still on disk. Next process invokes
// sweep again (e.g., via onload recovery or the next drain's layer
// 2). The contract is idempotency: re-running sweep cleans the rest
// without disturbing anything else.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `sweep-kill-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const trashStore = new TrashStore({
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => new Date(Date.UTC(2026, 4, 26, 10, 30, 0, 0)),
  });
  const trashRoot = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/.runtime/trash`;
  return {
    root,
    trashStore,
    trashRoot,
    deps: {
      vault: vault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      trashStore,
    },
  };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function seedRecord(
  root: string,
  trashRoot: string,
  id: string,
  originalPath: string,
): void {
  const dir = path.join(root, trashRoot, id);
  const vaultDir = path.join(dir, "vault");
  const fileAbs = path.join(vaultDir, originalPath);
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  fs.writeFileSync(fileAbs, originalPath);
  const rec: TrashRecord = {
    id,
    originalPath,
    originalDeletedAt: new Date(Date.UTC(2026, 4, 26, 9, 0, 0)).toISOString(),
    sha: "deadbeef",
    size: 4,
    mtime: 0,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(rec));
}

describe("crash: sweepOlderThan kill mid-iteration", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("simulated mid-sweep kill: rerun finishes the cleanup", async () => {
    // Pre-seed 5 records — all should be swept by a threshold > all ids.
    const ids = [
      "20260526100000000",
      "20260526100000001",
      "20260526100000002",
      "20260526100000003",
      "20260526100000004",
    ];
    for (const id of ids) seedRecord(fx.root, fx.trashRoot, id, `${id}.md`);

    // Simulate "crash after 2 rmrfs" by manually removing the first
    // two bundles and leaving the rest. This mirrors what disk looks
    // like if sweep died after processing 2 of 5.
    fs.rmSync(path.join(fx.root, fx.trashRoot, ids[0]), { recursive: true });
    fs.rmSync(path.join(fx.root, fx.trashRoot, ids[1]), { recursive: true });

    // On next process: onload recovery sweep is a no-op for the
    // remaining records (they're all valid, not-lifted, vault files
    // present). The actual cleanup that "finishes the job" is the
    // next drain's sweepOlderThan call — verified directly here.
    await sweepOnload(fx.deps);
    expect(await fx.trashStore.list()).toHaveLength(3);

    // Layer 2 sweep finishes what the crashed pass started.
    await fx.trashStore.sweepOlderThan("99990101000000000");
    expect(await fx.trashStore.list()).toEqual([]);
  });

  it("ensures recovery is idempotent under repeated invocations", async () => {
    for (let i = 0; i < 3; i++) {
      seedRecord(
        fx.root,
        fx.trashRoot,
        `2026052610000000${i}`,
        `f${i}.md`,
      );
    }
    await sweepOnload(fx.deps);
    await sweepOnload(fx.deps);
    await sweepOnload(fx.deps);

    // All three records still valid, still present. Recovery didn't
    // touch healthy state.
    const records = await fx.trashStore.list();
    expect(records).toHaveLength(3);
  });

  it("best-effort rmrf failure during layer-2 sweep doesn't block other records", async () => {
    // Three records; we'll make rmrf fail for the middle one to verify
    // that the others still get cleaned. sweepBy in trash-store
    // catches per-rmrf errors and continues.
    seedRecord(fx.root, fx.trashRoot, "20260526100000000", "a.md");
    seedRecord(fx.root, fx.trashRoot, "20260526100000001", "b.md");
    seedRecord(fx.root, fx.trashRoot, "20260526100000002", "c.md");

    const vault = fx.trashStore["vault"] as never as {
      adapter: { rmdir: (p: string, r: boolean) => Promise<void> };
    };
    const originalRmdir = vault.adapter.rmdir.bind(vault.adapter);
    vault.adapter.rmdir = vi.fn(async (p: string, r: boolean) => {
      if (p.endsWith("20260526100000001")) {
        throw new Error("simulated rmdir failure on b.md bundle");
      }
      return originalRmdir(p, r);
    });

    await fx.trashStore.sweepOlderThan("99990101000000000");

    // The two surviving records — actually, the rmdir failure leaves
    // its bundle on disk. a.md and c.md should be gone; b.md remains.
    // Note: rmrf has manual-walk fallback that may delete files inside
    // even if rmdir fails for the dir. To assert cleanly we check
    // record visibility (meta.json absence) rather than exact disk
    // shape.
    const remaining = await fx.trashStore.list();
    const remainingIds = remaining.map((r) => r.id).sort();
    // a and c should be cleaned; b's meta.json removed by rmrf's
    // manual walk even if the directory rmdir failed.
    expect(remainingIds).not.toContain("20260526100000000");
    expect(remainingIds).not.toContain("20260526100000002");
  });
});
