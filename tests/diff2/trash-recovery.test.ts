import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { TrashStore } from "../../src/diff2/trash-store";
import { sweepOnload } from "../../src/diff2/trash-recovery";
import type { TrashRecord } from "../../src/diff2/types";

// Happy-path coverage for sweepOnload's three recovery cases plus
// orphan .tmp cleanup. Crash-resilience tests live in the
// crash-resilience/ subdir (one file per kill point).

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `trash-recovery-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);

  // Recovery uses now() for the collision-rename timestamp; pin it for
  // determinism so the expected filename is predictable.
  const FIXED_NOW = new Date(Date.UTC(2026, 4, 26, 10, 30, 0, 0));
  const now = () => FIXED_NOW;
  // The exact form recovery emits — matches the ISO-strip helper in
  // trash-recovery.ts::recoverOrphanDir.
  const fixedSuffix = "2026-05-26T10-30-00Z";

  const trashStore = new TrashStore({
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now,
  });

  const trashRoot = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/.runtime/trash`;
  const deps = {
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    trashStore,
    now,
  };
  return { root, vault, trashStore, trashRoot, deps, fixedSuffix };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function seedRecord(
  root: string,
  trashRoot: string,
  rec: TrashRecord,
  content = "seed",
): void {
  const dir = path.join(root, trashRoot, rec.id);
  const vaultDir = path.join(dir, "vault");
  const fileAbs = path.join(vaultDir, rec.originalPath);
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  fs.writeFileSync(fileAbs, content);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(rec));
}

function baseRecord(id: string, originalPath: string): TrashRecord {
  return {
    id,
    originalPath,
    originalDeletedAt: new Date(Date.UTC(2026, 4, 26, 9, 0, 0)).toISOString(),
    sha: "deadbeef",
    size: 4,
    mtime: 0,
  };
}

describe("sweepOnload (R8.1 trash recovery)", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  describe("Case A — orphan dir (intercept kill before meta written)", () => {
    it("restores file back to vault root when path is free", async () => {
      // Pre-seed an orphan: vault/<path> bytes exist but no meta.json.
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(orphanDir, "vault"), { recursive: true });
      fs.writeFileSync(
        path.join(orphanDir, "vault", "note.md"),
        "orphan content",
      );

      await sweepOnload(fx.deps);

      // File restored at vault root with original name.
      const restored = path.join(fx.root, "note.md");
      expect(fs.existsSync(restored)).toBe(true);
      expect(fs.readFileSync(restored, "utf8")).toBe("orphan content");
      // Orphan bundle wiped.
      expect(fs.existsSync(orphanDir)).toBe(false);
    });

    it("collision-renames when vault root already has the path", async () => {
      // Pre-seed orphan with note.md.
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(orphanDir, "vault"), { recursive: true });
      fs.writeFileSync(
        path.join(orphanDir, "vault", "note.md"),
        "orphan content",
      );
      // User has since created a fresh note.md.
      fs.writeFileSync(path.join(fx.root, "note.md"), "user-created");

      await sweepOnload(fx.deps);

      // User's file untouched.
      expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe(
        "user-created",
      );
      // Orphan recovered under the .recovered-<ts> name.
      const recovered = path.join(fx.root, `note.recovered-${fx.fixedSuffix}.md`);
      expect(fs.existsSync(recovered)).toBe(true);
      expect(fs.readFileSync(recovered, "utf8")).toBe("orphan content");
      expect(fs.existsSync(orphanDir)).toBe(false);
    });

    it("preserves nested directory structure when restoring", async () => {
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(orphanDir, "vault", "Folder", "Sub"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(orphanDir, "vault", "Folder", "Sub", "note.md"),
        "deep content",
      );

      await sweepOnload(fx.deps);

      const restored = path.join(fx.root, "Folder", "Sub", "note.md");
      expect(fs.existsSync(restored)).toBe(true);
      expect(fs.readFileSync(restored, "utf8")).toBe("deep content");
    });

    it("collision-renames an ext-less file as <stem>.recovered-<ts>", async () => {
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(orphanDir, "vault"), { recursive: true });
      fs.writeFileSync(path.join(orphanDir, "vault", "README"), "orphan");
      fs.writeFileSync(path.join(fx.root, "README"), "user-created");

      await sweepOnload(fx.deps);

      const recovered = path.join(fx.root, `README.recovered-${fx.fixedSuffix}`);
      expect(fs.existsSync(recovered)).toBe(true);
      expect(fs.readFileSync(recovered, "utf8")).toBe("orphan");
    });

    it("handles multiple orphan files in one bundle", async () => {
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(orphanDir, "vault", "Notes"), { recursive: true });
      fs.writeFileSync(path.join(orphanDir, "vault", "a.md"), "AAA");
      fs.writeFileSync(path.join(orphanDir, "vault", "Notes", "b.md"), "BBB");

      await sweepOnload(fx.deps);

      expect(fs.readFileSync(path.join(fx.root, "a.md"), "utf8")).toBe("AAA");
      expect(
        fs.readFileSync(path.join(fx.root, "Notes", "b.md"), "utf8"),
      ).toBe("BBB");
      expect(fs.existsSync(orphanDir)).toBe(false);
    });

    it("wipes the orphan dir even when vault/ is absent (lost bytes)", async () => {
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(orphanDir, { recursive: true });
      // No vault/ subdir, no meta.json. Just the empty <id> directory.

      await sweepOnload(fx.deps);
      expect(fs.existsSync(orphanDir)).toBe(false);
    });
  });

  describe("Case B — stale lift marker", () => {
    it("clears liftedAsSessionId and leaves vault file untouched", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        {
          ...baseRecord("20260526100000000", "note.md"),
          liftedAsSessionId: "stale-from-crashed-session",
        },
        "preserved content",
      );

      await sweepOnload(fx.deps);

      // Marker cleared.
      const meta = JSON.parse(
        fs.readFileSync(
          path.join(fx.root, fx.trashRoot, "20260526100000000", "meta.json"),
          "utf8",
        ),
      );
      expect(meta.liftedAsSessionId).toBeUndefined();
      expect(meta.id).toBe("20260526100000000");

      // Vault file inside trash untouched.
      const vaultFile = path.join(
        fx.root,
        fx.trashRoot,
        "20260526100000000",
        "vault",
        "note.md",
      );
      expect(fs.readFileSync(vaultFile, "utf8")).toBe("preserved content");
    });

    it("the cleared record participates in cleanup hooks on next call", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000000", "note.md"),
        liftedAsSessionId: "stale",
      });

      await sweepOnload(fx.deps);

      // Layer 2 sweep can now claim it (marker shield gone).
      await fx.trashStore.sweepOlderThan("99990101000000000");
      expect(await fx.trashStore.list()).toEqual([]);
    });
  });

  describe("Case C — meta valid but vault file missing", () => {
    it("wipes the orphan bundle entirely", async () => {
      const dir = path.join(fx.root, fx.trashRoot, "20260526100000000");
      fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
      // Meta says originalPath is "note.md" but no such file exists.
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify(baseRecord("20260526100000000", "note.md")),
      );

      await sweepOnload(fx.deps);
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  describe("orphan .tmp cleanup", () => {
    it("removes meta.json.tmp leftovers from interrupted atomicWriteJson", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      // Simulate an interrupted atomicWriteJson — the .tmp file got
      // written but safeRename to meta.json didn't run.
      const tmpPath = path.join(
        fx.root,
        fx.trashRoot,
        "20260526100000000",
        "meta.json.tmp",
      );
      fs.writeFileSync(tmpPath, "{}");
      expect(fs.existsSync(tmpPath)).toBe(true);

      await sweepOnload(fx.deps);

      expect(fs.existsSync(tmpPath)).toBe(false);
      // Healthy meta.json + bundle untouched.
      expect(
        fs.existsSync(
          path.join(fx.root, fx.trashRoot, "20260526100000000", "meta.json"),
        ),
      ).toBe(true);
    });
  });

  describe("healthy entries", () => {
    it("leaves valid records intact (no notify, no disk change)", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      let fired = 0;
      fx.trashStore.subscribe(() => { fired++; });

      await sweepOnload(fx.deps);

      expect(fired).toBe(0); // anyChange stayed false
      const records = await fx.trashStore.list();
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("20260526100000000");
    });

    it("ignores directories with non-id names", async () => {
      // Stray dir that doesn't match \d{17} — recovery skips it.
      const strayDir = path.join(fx.root, fx.trashRoot, "not-a-trash-id");
      fs.mkdirSync(strayDir, { recursive: true });
      fs.writeFileSync(path.join(strayDir, "hello.txt"), "stray");

      await sweepOnload(fx.deps);

      // Stray dir untouched.
      expect(fs.existsSync(strayDir)).toBe(true);
      expect(
        fs.readFileSync(path.join(strayDir, "hello.txt"), "utf8"),
      ).toBe("stray");
    });
  });

  describe("idempotency + mixed-bag", () => {
    it("is idempotent — repeat sweep is no-op", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000000", "note.md"),
        liftedAsSessionId: "stale",
      });

      await sweepOnload(fx.deps);
      let fired = 0;
      fx.trashStore.subscribe(() => { fired++; });
      await sweepOnload(fx.deps);
      await sweepOnload(fx.deps);
      expect(fired).toBe(0); // already recovered; no further changes
    });

    it("handles a mixed bag in one pass", async () => {
      // (1) Valid entry.
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "valid.md"));
      // (2) Stale lift marker.
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000001", "lifted.md"),
        liftedAsSessionId: "stale",
      });
      // (3) Orphan (no meta).
      const orphanDir = path.join(fx.root, fx.trashRoot, "20260526100000002");
      fs.mkdirSync(path.join(orphanDir, "vault"), { recursive: true });
      fs.writeFileSync(path.join(orphanDir, "vault", "orphan.md"), "recover-me");
      // (4) Meta-valid but vault file missing.
      const missingDir = path.join(fx.root, fx.trashRoot, "20260526100000003");
      fs.mkdirSync(path.join(missingDir, "vault"), { recursive: true });
      fs.writeFileSync(
        path.join(missingDir, "meta.json"),
        JSON.stringify(baseRecord("20260526100000003", "ghost.md")),
      );

      let fired = 0;
      fx.trashStore.subscribe(() => { fired++; });

      await sweepOnload(fx.deps);

      // 1 valid remains; 2 had marker cleared; 3 wiped + file restored;
      // 4 wiped entirely.
      const remaining = await fx.trashStore.list();
      const remainingIds = remaining.map((r) => r.id).sort();
      expect(remainingIds).toEqual([
        "20260526100000000",
        "20260526100000001",
      ]);
      // (2)'s marker cleared.
      const lifted = remaining.find((r) => r.id === "20260526100000001");
      expect(lifted?.liftedAsSessionId).toBeUndefined();
      // (3)'s file restored to vault root.
      expect(fs.readFileSync(path.join(fx.root, "orphan.md"), "utf8")).toBe(
        "recover-me",
      );
      // (4) gone.
      expect(fs.existsSync(missingDir)).toBe(false);

      // Single batched notify.
      expect(fired).toBe(1);
    });
  });

  describe("init + empty cases", () => {
    it("creates .trash root if absent (idempotent init via TrashStore.init)", async () => {
      // Fresh tempdir without prior init.
      const fresh = fixture();
      try {
        const absRoot = path.join(fresh.root, fresh.trashRoot);
        // Note: not calling trashStore.init() up-front this time —
        // sweepOnload should create the dir.
        expect(fs.existsSync(absRoot)).toBe(false);
        await sweepOnload(fresh.deps);
        expect(fs.existsSync(absRoot)).toBe(true);
      } finally {
        cleanup(fresh.root);
      }
    });

    it("no-op when .trash is empty", async () => {
      let fired = 0;
      fx.trashStore.subscribe(() => { fired++; });
      await sweepOnload(fx.deps);
      expect(fired).toBe(0);
      expect(await fx.trashStore.list()).toEqual([]);
    });
  });
});
