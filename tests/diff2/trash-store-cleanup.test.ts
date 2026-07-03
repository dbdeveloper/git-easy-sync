import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { TrashStore } from "../../src/diff2/trash-store";
import type { TrashRecord } from "../../src/diff2/types";

// Tests for the R3.5 three-layer cleanup hooks:
//   - confirmDeleted (layer 1a) — base-file deletes after push-confirm
//   - confirmResolved (layer 1b) — sibling-trash after resolve-confirm
//   - sweepOlderThan (layer 2) — drain-end backstop
//
// Each layer's contract:
//   - Skip records with liftedAsSessionId set (R3.7 shield).
//   - Best-effort: a failed rmrf doesn't stop the loop (verified by
//     manual disk state; we don't inject rmrf failures here — the
//     happy-path coverage is what catches the most regressions).
//   - notify() fires exactly once per call if anything changed; not at
//     all if nothing matched.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `trash-cleanup-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);

  let currentMs = Date.UTC(2026, 4, 26, 10, 30, 0, 0);
  const now = () => {
    const t = new Date(currentMs);
    currentMs += 1;
    return t;
  };

  const store = new TrashStore({
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now,
  });

  const trashRoot = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/.runtime/trash`;
  return { root, vault, store, trashRoot };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// Write a TrashRecord directly to disk — bypasses intercept so tests
// can set up arbitrary states (lifted markers, mismatched ids, etc.)
// without going through the full intercept path. Mirrors what
// intercept produces on disk (.trash/<id>/vault/<path> + meta.json).
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
    originalDeletedAt: new Date(Date.UTC(2026, 4, 26, 10, 0, 0)).toISOString(),
    sha: "deadbeef",
    size: 4,
    mtime: 0,
  };
}

describe("TrashStore cleanup hooks (R3.5 three-layer)", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  // ── confirmDeleted (layer 1a) ─────────────────────────────────────

  describe("confirmDeleted (layer 1a)", () => {
    it("empty paths array is a no-op (no notify)", async () => {
      let fired = 0;
      fx.store.subscribe(() => { fired++; });
      await fx.store.confirmDeleted([]);
      expect(fired).toBe(0);
    });

    it("wipes a single matching record and fires notify once", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord("20260526100000000", "note.md"),
      );
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmDeleted(["note.md"]);

      expect(await fx.store.list()).toEqual([]);
      expect(fs.existsSync(path.join(fx.root, fx.trashRoot, "20260526100000000"))).toBe(false);
      expect(fired).toBe(1);
    });

    it("wipes multiple matching records and fires notify exactly once", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "b.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000002", "c.md"));

      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmDeleted(["a.md", "c.md"]);

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.originalPath)).toEqual(["b.md"]);
      expect(fired).toBe(1);
    });

    it("skips records with liftedAsSessionId set (R3.7 shield)", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000000", "note.md"),
        liftedAsSessionId: "active-compare-session",
      });

      await fx.store.confirmDeleted(["note.md"]);

      // Record is still present — lifted shield held.
      const records = await fx.store.list();
      expect(records).toHaveLength(1);
      expect(records[0].originalPath).toBe("note.md");
    });

    it("no-op when paths array has no matches", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmDeleted(["different.md"]);

      expect(await fx.store.list()).toHaveLength(1);
      expect(fired).toBe(0);
    });

    it("is idempotent — repeat call after first cleanup is no-op", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmDeleted(["note.md"]);
      await fx.store.confirmDeleted(["note.md"]);
      await fx.store.confirmDeleted(["note.md"]);

      expect(await fx.store.list()).toEqual([]);
      expect(fired).toBe(1); // only the first call did real work
    });

    it("matches multiple records that share the same originalPath", async () => {
      // Two deletes of the same path produce two distinct records (R3.5
      // doesn't dedupe by path — the timestamp ids are different).
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "note.md"));

      await fx.store.confirmDeleted(["note.md"]);
      expect(await fx.store.list()).toEqual([]);
    });
  });

  // ── confirmResolved (layer 1b) ────────────────────────────────────

  describe("confirmResolved (layer 1b)", () => {
    it("wipes a single sibling-trash entry for the matching base path", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000000",
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmResolved("note.md");

      expect(await fx.store.list()).toEqual([]);
      expect(fired).toBe(1);
    });

    it("wipes ALL sibling-trash entries belonging to the same base path", async () => {
      // Scenario C from PSEUDO-MERGE-MODE.md: multi-sibling resolve.
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000000",
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000001",
          "note.conflict-from-Laptop-2026-05-26T11-00-00Z.md",
        ),
      );
      // A sibling for a different base — must NOT be touched.
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000002",
          "other.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );

      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmResolved("note.md");

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.originalPath)).toEqual([
        "other.conflict-from-Phone-2026-05-26T10-30-00Z.md",
      ]);
      expect(fired).toBe(1);
    });

    it("does NOT touch the base-file trash entry itself (only siblings)", async () => {
      // If user deleted base-file separately (it landed in trash via
      // some flow), confirmResolved must not wipe it — that's
      // confirmDeleted's job. stripConflictSuffix returns null on
      // "note.md" so it never matches the basePath predicate.
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000001",
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );

      await fx.store.confirmResolved("note.md");

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.originalPath)).toEqual(["note.md"]);
    });

    it("skips lifted sibling records (R3.7 shield)", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord(
          "20260526100000000",
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
        liftedAsSessionId: "active-compare",
      });

      await fx.store.confirmResolved("note.md");

      expect(await fx.store.list()).toHaveLength(1);
    });

    it("no-op when basePath has no sibling-trash entries", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.confirmResolved("nonexistent.md");

      expect(await fx.store.list()).toHaveLength(1);
      expect(fired).toBe(0);
    });

    it("handles nested-path siblings", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000000",
          "Folder/Sub/note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );

      await fx.store.confirmResolved("Folder/Sub/note.md");

      expect(await fx.store.list()).toEqual([]);
    });
  });

  // ── sweepOlderThan (layer 2) ──────────────────────────────────────

  describe("sweepOlderThan (layer 2)", () => {
    it("wipes records with id < threshold", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "b.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000002", "c.md"));

      // Threshold matches the third record's id exactly — only earlier
      // ones are swept (strict less-than).
      await fx.store.sweepOlderThan("20260526100000002");

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.originalPath)).toEqual(["c.md"]);
    });

    it("no-op when threshold is older than all records", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000005", "a.md"));
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.sweepOlderThan("20260101000000000");

      expect(await fx.store.list()).toHaveLength(1);
      expect(fired).toBe(0);
    });

    it("wipes all records when threshold is newer than all", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "b.md"));

      await fx.store.sweepOlderThan("99990101000000000");

      expect(await fx.store.list()).toEqual([]);
    });

    it("skips lifted records even when older than threshold", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000000", "active.md"),
        liftedAsSessionId: "active-compare",
      });
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "regular.md"));

      await fx.store.sweepOlderThan("99990101000000000");

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.originalPath)).toEqual(["active.md"]);
    });

    it("fires notify exactly once even when wiping many records", async () => {
      for (let i = 0; i < 5; i++) {
        seedRecord(
          fx.root,
          fx.trashRoot,
          baseRecord(`2026052610000000${i}`, `f${i}.md`),
        );
      }
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.sweepOlderThan("99990101000000000");

      expect(fired).toBe(1);
    });

    it("is idempotent on empty trash", async () => {
      let fired = 0;
      fx.store.subscribe(() => { fired++; });
      await fx.store.sweepOlderThan("99990101000000000");
      expect(fired).toBe(0);
    });
  });

  // ── asHooks() integration ─────────────────────────────────────────

  describe("asHooks() — hooks route to real methods", () => {
    it("captureForDelete + confirmDeleted full lifecycle via asHooks", async () => {
      const hooks = fx.store.asHooks();

      fs.writeFileSync(path.join(fx.root, "note.md"), "x");
      await hooks.captureForDelete("note.md");
      expect(await fx.store.list()).toHaveLength(1);

      await hooks.confirmDeleted(["note.md"]);
      expect(await fx.store.list()).toEqual([]);
    });

    it("confirmResolved via asHooks wipes matching siblings", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord(
          "20260526100000000",
          "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
        ),
      );

      await fx.store.asHooks().confirmResolved("note.md");
      expect(await fx.store.list()).toEqual([]);
    });

    it("sweepOlderThan via asHooks wipes pre-threshold records", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "old.md"));

      await fx.store.asHooks().sweepOlderThan("99990101000000000");
      expect(await fx.store.list()).toEqual([]);
    });
  });
});
