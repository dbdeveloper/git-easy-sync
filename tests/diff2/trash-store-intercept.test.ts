import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { TrashStore } from "../../src/diff2/trash-store";
import { calculateGitBlobSHA } from "../../src/utils";

// TrashStore.intercept happy-path tests (PR-3 scope).
//
// Crash-resilience tests (kill-mid-write, kill-mid-meta) land alongside
// the recovery sweep in PR-7 — they verify the state recovery produces
// after a partial intercept. The basic-correctness behaviours below are
// enough to ship intercept on its own.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `trash-store-intercept-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);

  // Deterministic clock — each call to now() advances 1 ms so successive
  // intercepts get distinct ids without falling through allocateUniqueId's
  // collision-bump branch (covered separately).
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

  return { root, vault, store, trashRoot, setClock: (ms: number) => { currentMs = ms; } };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("TrashStore.intercept", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(() => {
    fx = fixture();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  describe("init()", () => {
    it("creates .trash/ root dir if absent", async () => {
      const absRoot = path.join(fx.root, fx.trashRoot);
      expect(fs.existsSync(absRoot)).toBe(false);
      await fx.store.init();
      expect(fs.existsSync(absRoot)).toBe(true);
    });

    it("is idempotent — repeat init() is no-op", async () => {
      await fx.store.init();
      await fx.store.init();
      await fx.store.init();
      const absRoot = path.join(fx.root, fx.trashRoot);
      expect(fs.existsSync(absRoot)).toBe(true);
    });
  });

  describe("intercept(path) happy path", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("copies a root-level file into .trash/<id>/vault/<path>", async () => {
      // Pre-seed a vault file.
      const filePath = "note.md";
      const content = "# hello\n\nbody";
      fs.writeFileSync(path.join(fx.root, filePath), content);

      const record = await fx.store.intercept(filePath);

      // Bytes in trash match original.
      const trashCopyAbs = path.join(
        fx.root,
        fx.trashRoot,
        record.id,
        "vault",
        filePath,
      );
      expect(fs.existsSync(trashCopyAbs)).toBe(true);
      expect(fs.readFileSync(trashCopyAbs, "utf8")).toBe(content);

      // Meta.json shape.
      const metaAbs = path.join(
        fx.root,
        fx.trashRoot,
        record.id,
        "meta.json",
      );
      const meta = JSON.parse(fs.readFileSync(metaAbs, "utf8"));
      expect(meta).toMatchObject({
        id: record.id,
        originalPath: filePath,
        sha: await calculateGitBlobSHA(new TextEncoder().encode(content).buffer),
        size: Buffer.byteLength(content),
      });
      expect(typeof meta.originalDeletedAt).toBe("string");
      expect(meta.originalDeletedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
      expect(typeof meta.mtime).toBe("number");
      expect(meta.liftedAsSessionId).toBeUndefined();
    });

    it("copies a nested file preserving the full vault path", async () => {
      const filePath = "Folder/Sub/note.md";
      const content = "nested content";
      fs.mkdirSync(path.join(fx.root, "Folder/Sub"), { recursive: true });
      fs.writeFileSync(path.join(fx.root, filePath), content);

      const record = await fx.store.intercept(filePath);

      const trashCopyAbs = path.join(
        fx.root,
        fx.trashRoot,
        record.id,
        "vault",
        "Folder/Sub/note.md",
      );
      expect(fs.existsSync(trashCopyAbs)).toBe(true);
      expect(fs.readFileSync(trashCopyAbs, "utf8")).toBe(content);
      expect(record.originalPath).toBe(filePath);
    });

    it("handles binary files (e.g. .png) via readBinary path", async () => {
      const filePath = "img.png";
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(path.join(fx.root, filePath), bytes);

      const record = await fx.store.intercept(filePath);

      const trashCopyAbs = path.join(
        fx.root,
        fx.trashRoot,
        record.id,
        "vault",
        filePath,
      );
      const readBack = fs.readFileSync(trashCopyAbs);
      expect(Buffer.compare(readBack, bytes)).toBe(0);
      expect(record.size).toBe(bytes.length);
    });

    it("two consecutive intercepts create two separate trash entries", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "first");
      fs.writeFileSync(path.join(fx.root, "b.md"), "second");

      const recordA = await fx.store.intercept("a.md");
      const recordB = await fx.store.intercept("b.md");

      expect(recordA.id).not.toBe(recordB.id);
      // Both records on disk.
      expect(
        fs.existsSync(path.join(fx.root, fx.trashRoot, recordA.id, "vault/a.md")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fx.root, fx.trashRoot, recordB.id, "vault/b.md")),
      ).toBe(true);
    });

    it("two intercepts of the SAME path create two separate entries with different ids", async () => {
      // Simulates the "delete, recreate, delete again" sequence — both
      // entries must coexist in trash until cleanup. id-uniqueness comes
      // from the timestamp; this clock advances 1 ms per now() call.
      fs.writeFileSync(path.join(fx.root, "note.md"), "v1");
      const r1 = await fx.store.intercept("note.md");

      // Recreate (simulates user creating new file with same name)
      fs.writeFileSync(path.join(fx.root, "note.md"), "v2");
      const r2 = await fx.store.intercept("note.md");

      expect(r1.id).not.toBe(r2.id);
      expect(r1.originalPath).toBe("note.md");
      expect(r2.originalPath).toBe("note.md");

      // Both directories on disk, with their respective content.
      expect(
        fs.readFileSync(
          path.join(fx.root, fx.trashRoot, r1.id, "vault/note.md"),
          "utf8",
        ),
      ).toBe("v1");
      expect(
        fs.readFileSync(
          path.join(fx.root, fx.trashRoot, r2.id, "vault/note.md"),
          "utf8",
        ),
      ).toBe("v2");
    });

    it("id-collision bumps when two intercepts hit the same millisecond", async () => {
      // Pin the clock so successive now() calls return identical values.
      const fixed = Date.UTC(2026, 4, 26, 10, 30, 0, 0);
      fx.setClock(fixed);

      // Reset to literally-same: override now() to always return `fixed`.
      const vault = fx.vault;
      const store2 = new TrashStore({
        vault: vault as never,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
        now: () => new Date(fixed),
      });
      await store2.init();

      fs.writeFileSync(path.join(fx.root, "x.md"), "x1");
      const r1 = await store2.intercept("x.md");

      fs.writeFileSync(path.join(fx.root, "x.md"), "x2");
      const r2 = await store2.intercept("x.md");

      expect(r1.id).not.toBe(r2.id);
      // r2.id should be lex-greater (collision-bump advances by 1 ms).
      expect(r2.id.localeCompare(r1.id)).toBeGreaterThan(0);
    });
  });

  describe("subscribe", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("listener fires after each successful intercept", async () => {
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      await fx.store.intercept("a.md");
      expect(fired).toBe(1);

      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      await fx.store.intercept("b.md");
      expect(fired).toBe(2);
    });

    it("unsubscribe stops notifications", async () => {
      let fired = 0;
      const unsubscribe = fx.store.subscribe(() => { fired++; });

      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      await fx.store.intercept("a.md");
      expect(fired).toBe(1);

      unsubscribe();
      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      await fx.store.intercept("b.md");
      expect(fired).toBe(1); // unchanged
    });

    it("a throwing listener doesn't block other listeners or the operation", async () => {
      let goodCount = 0;
      fx.store.subscribe(() => {
        throw new Error("misbehaving listener");
      });
      fx.store.subscribe(() => { goodCount++; });

      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      // Should not throw despite the bad listener.
      await expect(fx.store.intercept("a.md")).resolves.toBeDefined();
      expect(goodCount).toBe(1);
    });
  });

  describe("list() + get()", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("returns empty array when no trash entries exist", async () => {
      const records = await fx.store.list();
      expect(records).toEqual([]);
    });

    it("returns all valid records sorted newest-first", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      const ra = await fx.store.intercept("a.md");
      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      const rb = await fx.store.intercept("b.md");
      fs.writeFileSync(path.join(fx.root, "c.md"), "c");
      const rc = await fx.store.intercept("c.md");

      const records = await fx.store.list();
      expect(records.map((r) => r.id)).toEqual([rc.id, rb.id, ra.id]);
    });

    it("get(id) returns the record with matching id", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      const r = await fx.store.intercept("a.md");

      const fetched = await fx.store.get(r.id);
      expect(fetched).toMatchObject({ id: r.id, originalPath: "a.md" });
    });

    it("get(id) returns undefined for missing id", async () => {
      const fetched = await fx.store.get("20260101000000000");
      expect(fetched).toBeUndefined();
    });

    it("skips orphan dirs without valid meta.json", async () => {
      // Hand-create an orphan dir to simulate intercept-kill state.
      const orphanId = "20260101120000000";
      fs.mkdirSync(
        path.join(fx.root, fx.trashRoot, orphanId, "vault"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(fx.root, fx.trashRoot, orphanId, "vault/note.md"),
        "orphan",
      );
      // No meta.json — recovery sweep would handle, but list() must not include it.

      fs.writeFileSync(path.join(fx.root, "valid.md"), "valid");
      const valid = await fx.store.intercept("valid.md");

      const records = await fx.store.list();
      expect(records.map((r) => r.id)).toEqual([valid.id]);
    });
  });

  describe("asHooks() — PR-3 partial wiring", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("captureForDelete maps to intercept", async () => {
      const hooks = fx.store.asHooks();
      fs.writeFileSync(path.join(fx.root, "a.md"), "via hook");
      await hooks.captureForDelete("a.md");

      const records = await fx.store.list();
      expect(records).toHaveLength(1);
      expect(records[0].originalPath).toBe("a.md");
    });

    it("all hooks are wired to TrashStore methods (no stubs)", async () => {
      const hooks = fx.store.asHooks();
      // Smoke check: calling each hook on a fresh store should resolve
      // without throwing. Full behavior of confirmDeleted /
      // confirmResolved / sweepOlderThan is covered in
      // trash-store-cleanup.test.ts (PR-5).
      await expect(hooks.confirmDeleted([])).resolves.toBeUndefined();
      await expect(hooks.confirmResolved("nonexistent.md")).resolves.toBeUndefined();
      await expect(hooks.sweepOlderThan("0")).resolves.toBeUndefined();
    });
  });

  describe("clearAll() — Reset panic button", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("wipes every entry and re-creates an empty .trash root", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      await fx.store.intercept("a.md");
      await fx.store.intercept("b.md");
      expect((await fx.store.list()).length).toBe(2);

      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.clearAll();

      expect(await fx.store.list()).toEqual([]);
      // Root dir still exists (re-created), so the store remains
      // usable post-Reset without a separate init() call.
      const absRoot = path.join(fx.root, fx.trashRoot);
      expect(fs.existsSync(absRoot)).toBe(true);
      expect(fired).toBe(1);
    });

    it("is idempotent on an already-empty trash", async () => {
      let fired = 0;
      fx.store.subscribe(() => { fired++; });
      await fx.store.clearAll();
      await fx.store.clearAll();
      // Each call notifies (cheap — UI just re-renders an empty list).
      expect(fired).toBeGreaterThanOrEqual(1);
    });

    it("intercept still works after clearAll (store remains live)", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      await fx.store.intercept("a.md");
      await fx.store.clearAll();

      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      const rec = await fx.store.intercept("b.md");
      expect(rec.originalPath).toBe("b.md");
      expect((await fx.store.list()).length).toBe(1);
    });
  });

  describe("serialize() ordering", () => {
    beforeEach(async () => {
      await fx.store.init();
    });

    it("concurrent intercepts execute sequentially", async () => {
      fs.writeFileSync(path.join(fx.root, "a.md"), "a");
      fs.writeFileSync(path.join(fx.root, "b.md"), "b");
      fs.writeFileSync(path.join(fx.root, "c.md"), "c");

      // Fire all three without awaiting — serialize() must chain them.
      const [ra, rb, rc] = await Promise.all([
        fx.store.intercept("a.md"),
        fx.store.intercept("b.md"),
        fx.store.intercept("c.md"),
      ]);

      // All three landed.
      const records = await fx.store.list();
      expect(records).toHaveLength(3);
      // IDs are monotonic across the chain.
      const ids = [ra.id, rb.id, rc.id];
      expect([...ids].sort()).toEqual(ids); // already in order
    });
  });
});
