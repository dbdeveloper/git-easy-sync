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
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-1", mtime: 200 },
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-2", mtime: 300 },
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
});
