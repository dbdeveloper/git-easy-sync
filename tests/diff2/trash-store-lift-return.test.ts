import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import { TrashStore } from "../../src/diff2/trash-store";
import type { TrashRecord } from "../../src/diff2/types";

// R3.7 compare-lift mechanism: lift / return / resetLifts.
//
// All three operations are metadata-only — they mutate
// .trash/<id>/meta.json (specifically the liftedAsSessionId field)
// and never move the file under vault/. The file's path on disk is
// stable for the entire compare session.
//
// What the marker DOES: cleanup-hook guards
// (confirmDeleted / confirmResolved / sweepOlderThan) skip records
// where liftedAsSessionId is set. That cross-test is covered in
// trash-store-cleanup.test.ts; here we focus on the marker-write
// mechanics themselves.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `trash-lift-return-${crypto.randomBytes(4).toString("hex")}`,
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

describe("TrashStore lift / return / resetLifts (R3.7)", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  // ── liftForCompare ────────────────────────────────────────────────

  describe("liftForCompare(id)", () => {
    it("returns {trashPath, sessionId, record} and sets marker on disk", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      const result = await fx.store.liftForCompare("20260526100000000");

      expect(result.trashPath).toBe(
        `${fx.trashRoot}/20260526100000000/vault/note.md`,
      );
      expect(result.sessionId).toMatch(/^\d{17}$/);
      expect(result.record.liftedAsSessionId).toBe(result.sessionId);

      // Marker persisted to disk.
      const metaAbs = path.join(
        fx.root,
        fx.trashRoot,
        "20260526100000000",
        "meta.json",
      );
      const meta = JSON.parse(fs.readFileSync(metaAbs, "utf8"));
      expect(meta.liftedAsSessionId).toBe(result.sessionId);
    });

    it("preserves originalPath, sha, originalDeletedAt — only marker changes", async () => {
      const original = baseRecord("20260526100000000", "Folder/note.md");
      seedRecord(fx.root, fx.trashRoot, original);

      const result = await fx.store.liftForCompare("20260526100000000");

      expect(result.record.id).toBe(original.id);
      expect(result.record.originalPath).toBe(original.originalPath);
      expect(result.record.sha).toBe(original.sha);
      expect(result.record.originalDeletedAt).toBe(original.originalDeletedAt);
    });

    it("notifies listeners after successful lift", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.liftForCompare("20260526100000000");
      expect(fired).toBe(1);
    });

    it("throws when id doesn't exist", async () => {
      await expect(fx.store.liftForCompare("99990101000000000")).rejects.toThrow(
        /trash entry .* not found/,
      );
    });

    it("throws on double-lift (one session per entry)", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      await fx.store.liftForCompare("20260526100000000");
      await expect(
        fx.store.liftForCompare("20260526100000000"),
      ).rejects.toThrow(/already lifted as session/);
    });

    it("does NOT move the file on disk — vault/<path> stays put", async () => {
      seedRecord(
        fx.root,
        fx.trashRoot,
        baseRecord("20260526100000000", "note.md"),
        "lifted-content",
      );
      const vaultAbs = path.join(
        fx.root,
        fx.trashRoot,
        "20260526100000000",
        "vault",
        "note.md",
      );

      await fx.store.liftForCompare("20260526100000000");
      expect(fs.existsSync(vaultAbs)).toBe(true);
      expect(fs.readFileSync(vaultAbs, "utf8")).toBe("lifted-content");
    });
  });

  // ── returnFromCompare ─────────────────────────────────────────────

  describe("returnFromCompare(sessionId)", () => {
    it("clears the marker on disk", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      const { sessionId } = await fx.store.liftForCompare("20260526100000000");
      await fx.store.returnFromCompare(sessionId);

      const metaAbs = path.join(
        fx.root,
        fx.trashRoot,
        "20260526100000000",
        "meta.json",
      );
      const meta = JSON.parse(fs.readFileSync(metaAbs, "utf8"));
      expect(meta.liftedAsSessionId).toBeUndefined();
    });

    it("preserves original id (record re-enters normal cleanup flow)", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      const { sessionId } = await fx.store.liftForCompare("20260526100000000");
      await fx.store.returnFromCompare(sessionId);

      const recovered = await fx.store.get("20260526100000000");
      expect(recovered?.id).toBe("20260526100000000");
      expect(recovered?.liftedAsSessionId).toBeUndefined();
    });

    it("notifies listeners after successful return", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      let fired = 0;
      const { sessionId } = await fx.store.liftForCompare("20260526100000000");
      fx.store.subscribe(() => { fired++; }); // subscribe AFTER lift

      await fx.store.returnFromCompare(sessionId);
      expect(fired).toBe(1);
    });

    it("throws on unknown sessionId", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      await expect(fx.store.returnFromCompare("99990101000000000")).rejects.toThrow(
        /no record found for session/,
      );
    });

    it("throws when called twice with the same sessionId (idempotency check)", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      const { sessionId } = await fx.store.liftForCompare("20260526100000000");
      await fx.store.returnFromCompare(sessionId);
      // Second call: marker is gone, no record matches — throw.
      await expect(fx.store.returnFromCompare(sessionId)).rejects.toThrow(
        /no record found for session/,
      );
    });

    it("lift → return round-trip lands record back in cleanup-eligible state", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      const { sessionId } = await fx.store.liftForCompare("20260526100000000");
      await fx.store.returnFromCompare(sessionId);

      // Layer 2 sweep should now find and wipe this entry (id < threshold).
      await fx.store.sweepOlderThan("99990101000000000");
      expect(await fx.store.list()).toEqual([]);
    });
  });

  // ── resetLifts ────────────────────────────────────────────────────

  describe("resetLifts()", () => {
    it("clears markers on all lifted records, single notify", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "b.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000002", "c.md"));

      await fx.store.liftForCompare("20260526100000000");
      await fx.store.liftForCompare("20260526100000001");
      // 20260526100000002 stays unlifted

      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.resetLifts();

      const all = await fx.store.list();
      expect(all.every((r) => r.liftedAsSessionId === undefined)).toBe(true);
      // Single notify for the batch — not once per record.
      expect(fired).toBe(1);
    });

    it("is a no-op (no notify) when no records are lifted", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));

      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.resetLifts();
      expect(fired).toBe(0);
    });

    it("is a no-op when trash is empty", async () => {
      let fired = 0;
      fx.store.subscribe(() => { fired++; });

      await fx.store.resetLifts();
      expect(fired).toBe(0);
    });

    it("does not touch records whose liftedAsSessionId is already absent", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000001", "b.md"),
        liftedAsSessionId: "active-session",
      });

      await fx.store.resetLifts();

      const a = await fx.store.get("20260526100000000");
      const b = await fx.store.get("20260526100000001");
      expect(a?.liftedAsSessionId).toBeUndefined();
      expect(b?.liftedAsSessionId).toBeUndefined();
    });

    it("is idempotent — repeat call after first reset is no-op", async () => {
      seedRecord(fx.root, fx.trashRoot, {
        ...baseRecord("20260526100000000", "note.md"),
        liftedAsSessionId: "stale-session",
      });

      await fx.store.resetLifts();
      let fired = 0;
      fx.store.subscribe(() => { fired++; });
      await fx.store.resetLifts();
      await fx.store.resetLifts();
      expect(fired).toBe(0);
    });
  });

  // ── cross-test with cleanup hooks (R3.5 ↔ R3.7 integration) ──────

  describe("lift × cleanup hooks (R3.5 ↔ R3.7 shield)", () => {
    it("lifted record survives confirmDeleted matching its path", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      await fx.store.liftForCompare("20260526100000000");

      await fx.store.confirmDeleted(["note.md"]);

      // Survived — marker shield held.
      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.id)).toEqual(["20260526100000000"]);
    });

    it("lifted record survives sweepOlderThan even when id < threshold", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      await fx.store.liftForCompare("20260526100000000");

      await fx.store.sweepOlderThan("99990101000000000");

      const remaining = await fx.store.list();
      expect(remaining.map((r) => r.id)).toEqual(["20260526100000000"]);
    });

    it("after return, cleanup hooks resume claiming the record", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      const { sessionId } = await fx.store.liftForCompare("20260526100000000");

      // While lifted, confirmDeleted is shielded.
      await fx.store.confirmDeleted(["note.md"]);
      expect(await fx.store.list()).toHaveLength(1);

      // Return → shield removed.
      await fx.store.returnFromCompare(sessionId);

      // Same call now wipes.
      await fx.store.confirmDeleted(["note.md"]);
      expect(await fx.store.list()).toEqual([]);
    });

    it("resetLifts followed by sweep wipes all previously-lifted records", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "a.md"));
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000001", "b.md"));
      await fx.store.liftForCompare("20260526100000000");
      await fx.store.liftForCompare("20260526100000001");

      // Pre-reset, sweep is fully shielded.
      await fx.store.sweepOlderThan("99990101000000000");
      expect(await fx.store.list()).toHaveLength(2);

      // resetLifts clears shields; next sweep wipes.
      await fx.store.resetLifts();
      await fx.store.sweepOlderThan("99990101000000000");
      expect(await fx.store.list()).toEqual([]);
    });
  });

  // ── asHooks() integration spot-check (cleanup hooks still work) ──

  describe("asHooks() spot-check", () => {
    it("lift then asHooks().confirmDeleted respects the marker", async () => {
      seedRecord(fx.root, fx.trashRoot, baseRecord("20260526100000000", "note.md"));
      await fx.store.liftForCompare("20260526100000000");

      // Hook path mirrors what sync2 actually calls.
      await fx.store.asHooks().confirmDeleted(["note.md"]);
      expect(await fx.store.list()).toHaveLength(1);
    });
  });
});
