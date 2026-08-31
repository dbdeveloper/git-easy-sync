import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import ConflictStoreV2, {
  emptyConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { emptyFileInfo } from "../../src/sync2/diff3";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";

// Phase 5 step 1 — the durable conflicts home (§II.6/§III shape:
// Map<path, {conflictBase, siblings[]}> + lastSiblingTxGuid).

const PLUGIN_ID = "git-easy-sync";

describe("ConflictStoreV2", () => {
  let dir: string;
  let vault: Vault;
  let store: ConflictStoreV2;
  let warnings: string[];

  const fileAbs = (): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "conflicts.json",
    );

  const sample = () => {
    const state = emptyConflictsState();
    state.lastSiblingTxGuid = "guid-1";
    state.entries.set("clash.md", {
      conflictBase: {
        ...emptyFileInfo(),
        path: "clash.md",
        sha: "cb-sha",
        size: 9,
        mtime: 123,
        deviceLabel: "phone",
        blob: new TextEncoder().encode("never-on-disk").buffer as ArrayBuffer,
      },
      siblings: [
        // Distinct SECONDS — the filename timestamp drops milliseconds,
        // so sub-second mtimes would collide into one derived name.
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-1", mtime: 200_000 },
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-2", mtime: 300_000 },
      ],
    });
    return state;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conflict-v2-test-"));
    vault = new Vault(dir);
    warnings = [];
    store = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      logger: { warn: (m) => warnings.push(m) },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("first run: no file → empty state, no warning", async () => {
    const s = await store.load();
    expect(s.entries.size).toBe(0);
    expect(s.lastSiblingTxGuid).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("round-trip: entries + guid come back verbatim; siblings keep APPEND ORDER; blobs never touch the disk", async () => {
    await store.save(sample());
    const loaded = await store.load();
    expect(loaded.lastSiblingTxGuid).toBe("guid-1");
    const c = loaded.entries.get("clash.md")!;
    expect(c.conflictBase).toMatchObject({
      sha: "cb-sha",
      size: 9,
      mtime: 123,
      deviceLabel: "phone",
    });
    expect(c.conflictBase.blob).toBeNull();
    // Order is load-bearing (§III: last(siblings) is STEP3's target).
    expect(c.siblings.map((s) => s.sha)).toEqual(["sib-1", "sib-2"]);
    expect(fs.readFileSync(fileAbs(), "utf8")).not.toContain("never-on-disk");
  });

  it("an EMPTY siblings list survives the round-trip as a real record — distinct from 'no record' (blocks FINALIZE)", async () => {
    const state = emptyConflictsState();
    state.entries.set("fresh.md", {
      conflictBase: { ...emptyFileInfo(), path: "fresh.md", sha: "cb" },
      siblings: [],
    });
    await store.save(state);
    const loaded = await store.load();
    expect(loaded.entries.has("fresh.md")).toBe(true);
    expect(loaded.entries.get("fresh.md")!.siblings).toEqual([]);
  });

  it("corrupt file → empty state with a LOUD warning (conflictBase is not re-derivable from disk)", async () => {
    fs.mkdirSync(path.dirname(fileAbs()), { recursive: true });
    fs.writeFileSync(fileAbs(), "{ torn json");
    const s = await store.load();
    expect(s.entries.size).toBe(0);
    expect(warnings.some((w) => w.includes("corrupt"))).toBe(true);
  });

  it("collectReferencedShas (§12.5 source 4): conflictBase + sibling shas, nulls excluded", async () => {
    const state = sample();
    state.entries.set("null-sha.md", {
      conflictBase: { ...emptyFileInfo(), path: "null-sha.md" }, // sha null
      siblings: [],
    });
    await store.save(state);
    const shas = await store.collectReferencedShas();
    expect([...shas].sort()).toEqual(["cb-sha", "sib-1", "sib-2"]);
  });

  it("save is atomic-write-backed: a save over an existing file replaces it wholesale", async () => {
    await store.save(sample());
    const next = emptyConflictsState();
    next.lastSiblingTxGuid = null;
    await store.save(next);
    const loaded = await store.load();
    expect(loaded.entries.size).toBe(0);
    expect(loaded.lastSiblingTxGuid).toBeNull();
  });

  // ── cached view (Phase 5.5 step 3a — the diff2 port's sync surface) ──

  describe("cached view", () => {
    it("load() populates the cache: hasBase / hasSiblingPath / getBySiblingPath answer synchronously", async () => {
      await store.save(sample());
      const fresh = new ConflictStoreV2({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
      });
      // Before any load the cache is EMPTY, not undefined-crashy.
      expect(fresh.hasBase("clash.md")).toBe(false);
      await fresh.load();
      expect(fresh.hasBase("clash.md")).toBe(true);
      expect(fresh.hasBase("other.md")).toBe(false);

      const name = buildSiblingFilePath("clash.md", 200_000, null); // deviceLabel null → "unknown"
      expect(fresh.hasSiblingPath(name)).toBe(true);
      const hit = fresh.getBySiblingPath(name);
      expect(hit!.basePath).toBe("clash.md");
      expect(hit!.sibling.sha).toBe("sib-1");
      expect(fresh.getBySiblingPath("clash.md")).toBeNull(); // a base is not a sibling
    });

    it("save() is the rebuild point: mutating the state and saving refreshes both indexes", async () => {
      const state = sample();
      await store.save(state);
      state.entries.delete("clash.md");
      state.entries.set("new.md", {
        conflictBase: { ...emptyFileInfo(), path: "new.md", sha: "nb" },
        siblings: [
          {
            ...emptyFileInfo(),
            path: "new.md",
            sha: "ns",
            mtime: 500,
            deviceLabel: "tab",
          },
        ],
      });
      await store.save(state);
      expect(store.hasBase("clash.md")).toBe(false);
      expect(store.hasBase("new.md")).toBe(true);
      expect(
        store.hasSiblingPath(buildSiblingFilePath("new.md", 500, "tab")),
      ).toBe(true);
      expect(
        store.hasSiblingPath(buildSiblingFilePath("clash.md", 200_000, null)),
      ).toBe(false);
    });

    it("getCachedState() is the SAME object load() returned — in-place drain mutations are visible to hasBase", async () => {
      await store.save(sample());
      const state = await store.load();
      expect(store.getCachedState()).toBe(state);
      state.entries.delete("clash.md"); // drain-style in-place mutation
      expect(store.hasBase("clash.md")).toBe(false); // shared Map — no save needed
    });

    it("empty and corrupt loads RESET the cache — no stale conflicts survive a wipe", async () => {
      await store.save(sample());
      expect(store.hasBase("clash.md")).toBe(true);
      fs.writeFileSync(fileAbs(), "{broken json");
      await store.load();
      expect(store.hasBase("clash.md")).toBe(false);
      expect(store.getCachedState().entries.size).toBe(0);
    });
  });
});
