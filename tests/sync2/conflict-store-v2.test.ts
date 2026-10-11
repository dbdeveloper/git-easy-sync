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
        // so sub-second timeLabels would collide into one derived name.
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-1", timeLabel: 200_000 },
        { ...emptyFileInfo(), path: "clash.md", sha: "sib-2", timeLabel: 300_000 },
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

  // What a live conflict still NEEDS from sync_store: conflictBase (the
  // branch half) and each copy's ORIGIN — the ancestor of the next fold.
  // Not the copy's own sha: since the content cache (owner, 2026-10-11) it
  // describes the file on disk, which may hold the user's edits and never
  // was a blob. After a no-op fold the origin moves on while the content
  // stays — pinning `sha` there left the fold's ancestor unprotected.
  it("collectReferencedShas (§12.5 source 4): conflictBase + each copy's ORIGIN, nulls excluded", async () => {
    const state = sample();
    const c = state.entries.get("clash.md")!;
    c.siblings[0].originSha = "origin-1";
    c.siblings[1].originSha = "origin-2";
    state.entries.set("null-sha.md", {
      conflictBase: { ...emptyFileInfo(), path: "null-sha.md" }, // sha null
      siblings: [],
    });
    await store.save(state);
    const shas = await store.collectReferencedShas();
    expect([...shas].sort()).toEqual(["cb-sha", "origin-1", "origin-2"]);
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

  // The copy's identity and its content cache survive conflicts.json
  // (owner, 2026-10-11): without timeLabel the copy cannot be found; without
  // mtime/size the next pass re-reads every copy; without originSha the next
  // fold has no ancestor.
  it("a copy's timeLabel, originSha and content cache {sha,size,mtime} round-trip through the file", async () => {
    const state = emptyConflictsState();
    state.entries.set("n.md", {
      conflictBase: { ...emptyFileInfo(), path: "n.md", sha: "cb" },
      siblings: [
        {
          ...emptyFileInfo(),
          path: "n.md",
          deviceLabel: "phone",
          timeLabel: 1_791_750_353_000,
          originSha: "origin",
          sha: "edited-content",
          size: 42,
          mtime: 1_791_760_000_123,
        },
      ],
    });
    await store.save(state);
    const fresh = new ConflictStoreV2({ vault: vault as never, selfPluginId: PLUGIN_ID });
    const s0 = (await fresh.load()).entries.get("n.md")!.siblings[0];
    expect(s0).toMatchObject({
      timeLabel: 1_791_750_353_000,
      originSha: "origin",
      sha: "edited-content",
      size: 42,
      mtime: 1_791_760_000_123,
      deviceLabel: "phone",
    });
  });

  describe("cached view", () => {
    // The commit pass's "unchanged?" reference for a conflicted base
    // (owner, 2026-10-11): what sits on the CONFLICT BRANCH, not main.
    // undefined = not in conflict (compare as usual); null = the branch
    // records a DELETION; a sha = the branch's version.
    it("conflictBaseShaFor: the branch's version, null for a recorded deletion, undefined when not in conflict", async () => {
      const state = sample();
      state.entries.set("gone.md", {
        conflictBase: { ...emptyFileInfo(), path: "gone.md", sha: null },
        siblings: [],
      });
      await store.save(state);
      expect(store.conflictBaseShaFor("clash.md")).toBe("cb-sha");
      expect(store.conflictBaseShaFor("gone.md")).toBeNull();
      expect(store.conflictBaseShaFor("calm.md")).toBeUndefined();
    });

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
            timeLabel: 500,
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
