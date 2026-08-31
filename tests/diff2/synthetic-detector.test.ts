import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import ConflictStoreV2, {
  emptyConflictsState,
  type ConflictsState,
} from "../../src/sync2/conflict-store-v2";
import { buildSiblingFilePath } from "../../src/sync2/conflict-siblings";
import { emptyFileInfo } from "../../src/sync2/diff3";
import {
  entryFromSibling,
  findAllConflicts,
  groupByBasePath,
  pendingConflictSummary,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";

// Phase 1 — Conflicts list detection module, ported to conflict store
// v2 (Phase 5.5 step 3b). Tests the pure detection logic: tracked vs
// synthetic categorisation, absent-base listing (delete-vs-modify),
// multi-sibling grouping, ordering.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `synthetic-detector-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const state: ConflictsState = emptyConflictsState();
  return { root, vault, store, state };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// The derived sibling disk name for a (base, device, moment) triple —
// same canonical iso shape the v2 helpers produce.
function siblingPathFor(
  vaultPath: string,
  device: string,
  whenMs: number,
): string {
  return buildSiblingFilePath(vaultPath, whenMs, device);
}

function writeFile(root: string, rel: string, content = "x"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Register a TRACKED sibling the v2 way: append it to the entry's
// siblings list, write the sibling file at the derived name, save
// (save rebuilds the store's cached indexes). Returns the disk name.
async function track(
  fx: ReturnType<typeof fixture>,
  basePath: string,
  device: string,
  whenMs: number,
  content = "theirs",
): Promise<string> {
  let entry = fx.state.entries.get(basePath);
  if (!entry) {
    entry = {
      conflictBase: { ...emptyFileInfo(), path: basePath, sha: "cb-sha" },
      siblings: [],
    };
    fx.state.entries.set(basePath, entry);
  }
  entry.siblings.push({
    ...emptyFileInfo(),
    path: basePath,
    mtime: whenMs,
    deviceLabel: device,
    sha: `sha-${device}-${whenMs}`,
  });
  const sibPath = siblingPathFor(basePath, device, whenMs);
  writeFile(fx.root, sibPath, content);
  await fx.store.save(fx.state);
  return sibPath;
}

describe("findAllConflicts", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("returns empty result when vault has no sibling files", () => {
    writeFile(fx.root, "note.md", "regular content");

    const { entries, byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toEqual([]);
    expect(byBasePath.size).toBe(0);
  });

  it("classifies a sibling with a matching conflicts.json entry as tracked", async () => {
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = await track(
      fx,
      "note.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 30, 0),
    );

    const { entries, byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tracked");
    expect(entries[0].basePath).toBe("note.md");
    expect(entries[0].siblingPath).toBe(sibPath);
    expect(entries[0].deviceLabel).toBe("Phone");
    expect(entries[0].isoTimestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/,
    );
    expect(byBasePath.get("note.md")).toHaveLength(1);
  });

  it("classifies a sibling WITHOUT an entry but WITH base in vault as synthetic", () => {
    // Synthetic conflict per R3.3 rule 3: base + sibling co-exist in
    // vault, but no conflicts.json entry.
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "theirs bytes");

    const { entries } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("synthetic");
    expect(entries[0].basePath).toBe("note.md");
  });

  it("LISTS an absent-base sibling as a synthetic delete-vs-modify conflict (2026-06-18)", () => {
    // A sibling whose base file is absent is a delete-vs-modify conflict (base
    // deleted, sibling holds the other side) — now LISTED (reverses the old R3.3
    // rule-3 "orphan without base → skip") so it's resolvable via the panel; the
    // diff editor renders the ours side empty (mountDiffPane reads "" for an absent
    // base). Applies to synthetic (no entry) AND tracked (R2.5) alike.
    const sibPath = siblingPathFor("missing.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "orphan");

    const { entries, byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => `${e.basePath}:${e.kind}`)).toEqual([
      "missing.md:synthetic",
    ]);
    expect(byBasePath.size).toBe(1);
  });

  it("returns mixed tracked + synthetic + absent-base-orphan in one pass", async () => {
    writeFile(fx.root, "regular.md", "ignore me");

    writeFile(fx.root, "tracked.md", "ours");
    await track(fx, "tracked.md", "Phone", Date.UTC(2026, 4, 26, 10, 30, 0));

    writeFile(fx.root, "synthetic.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("synthetic.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "theirs2",
    );

    writeFile(
      fx.root,
      siblingPathFor("orphan.md", "Phone", Date.UTC(2026, 4, 26, 12, 0, 0)),
      "theirs3",
    );

    const { entries, byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => `${e.basePath}:${e.kind}`).sort()).toEqual([
      "orphan.md:synthetic", // absent base → now listed (was skipped)
      "synthetic.md:synthetic",
      "tracked.md:tracked",
    ]);
    expect(byBasePath.size).toBe(3);
  });

  it("EXCLUDES a resolved conflict whose sibling was deleted while its conflicts.json entry lingers (pre-sync-gate parity)", async () => {
    // REGRESSION: after the user resolves a conflict in diff2, the sibling file is
    // removed (merge → base rewritten, sibling gone) but the store entry is NOT
    // dropped until the next process_conflicts pass prunes it. The pre-sync gate
    // used to read the raw records, so it re-surfaced this already-resolved
    // conflict in the "you still have conflicts" modal even though the diff-panel
    // no longer showed it. The panel/badge/gate all source from findAllConflicts
    // (live vault siblings) — a record whose sibling is gone must NOT appear,
    // while a genuinely-live conflict still does.
    writeFile(fx.root, "resolved.md", "merged bytes");
    const resolvedSib = await track(
      fx,
      "resolved.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 0, 0),
    );
    writeFile(fx.root, "live.md", "ours");
    await track(fx, "live.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    // Simulate the diff2 resolution: sibling gone from the vault, entry lingers.
    fs.rmSync(path.join(fx.root, resolvedSib));
    // Raw entries (the OLD gate source): BOTH still there — reading them would
    // put the resolved "resolved.md" back into the pre-sync modal (the bug).
    expect([...fx.store.getCachedState().entries.keys()].sort()).toEqual([
      "live.md",
      "resolved.md",
    ]);

    const summary = pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).not.toBeNull();
    expect(summary!.trackedPaths).toEqual(["live.md"]);
  });

  // §24 — the gate/modal is TRACKED-only. A synthetic conflict (a *.conflict-from-*
  // sibling with NO conflicts.json entry — a local leftover) carries no cross-device
  // consequence, so pendingConflictSummary excludes it.
  it("§24 synthetic-only vault → summary is null (gate lets sync proceed, no modal)", () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      "note.conflict-from-Phone-2026-05-26T10-30-00Z.md",
      "theirs",
    );
    const summary = pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).toBeNull();
  });

  it("§24 mixed tracked + synthetic → summary lists ONLY the tracked base", async () => {
    writeFile(fx.root, "leftover.md", "ours");
    writeFile(
      fx.root,
      "leftover.conflict-from-OldPhone-2026-05-26T10-30-00Z.md",
      "theirs",
    );
    writeFile(fx.root, "real.md", "ours");
    await track(fx, "real.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    const summary = pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary).not.toBeNull();
    expect(summary!.trackedPaths).toEqual(["real.md"]); // synthetic excluded
    expect(summary!.trackedConflictCount).toBe(1);
  });

  it("§24 one file with MULTIPLE tracked siblings → one path, trackedConflictCount counts all", async () => {
    writeFile(fx.root, "busy.md", "ours");
    await track(fx, "busy.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0));
    await track(fx, "busy.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0));

    const summary = pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary!.trackedPaths).toEqual(["busy.md"]); // one file
    expect(summary!.trackedConflictCount).toBe(2); // two tracked conflicts
  });

  it("§24 a base with BOTH a tracked and a synthetic sibling counts as tracked", async () => {
    writeFile(fx.root, "mix.md", "ours");
    writeFile(
      fx.root,
      "mix.conflict-from-Ghost-2026-05-20T08-00-00Z.md",
      "ghost",
    );
    await track(fx, "mix.md", "Tablet", Date.UTC(2026, 4, 26, 12, 0, 0));

    const summary = pendingConflictSummary(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(summary!.trackedPaths).toEqual(["mix.md"]); // listed once, as tracked
  });

  it("groups multi-sibling-per-path into one bucket each", async () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "from phone",
    );
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "from laptop",
    );

    const { entries, byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(2);
    expect(byBasePath.get("note.md")).toHaveLength(2);
    expect(
      byBasePath.get("note.md")!.every((e) => e.kind === "synthetic"),
    ).toBe(true);
  });

  it("sorts entries newest-first by isoTimestamp", () => {
    writeFile(fx.root, "a.md", "x");
    writeFile(fx.root, "b.md", "x");
    writeFile(fx.root, "c.md", "x");
    writeFile(
      fx.root,
      siblingPathFor("a.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "t1",
    );
    writeFile(
      fx.root,
      siblingPathFor("b.md", "Phone", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "t2",
    );
    writeFile(
      fx.root,
      siblingPathFor("c.md", "Phone", Date.UTC(2026, 4, 26, 12, 0, 0)),
      "t3",
    );

    const { entries } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries.map((e) => e.basePath)).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("preserves newest-first order within each group", () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26, 10, 0, 0)),
      "older",
    );
    writeFile(
      fx.root,
      siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26, 11, 0, 0)),
      "newer",
    );

    const { byBasePath } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    const bucket = byBasePath.get("note.md")!;
    expect(bucket).toHaveLength(2);
    expect(bucket[0].deviceLabel).toBe("Laptop");
    expect(bucket[1].deviceLabel).toBe("Phone");
  });

  it("ignores files in nested folders that are not siblings", () => {
    writeFile(fx.root, "Folder/regular.md", "x");
    writeFile(fx.root, "Folder/Sub/other.md", "x");

    const { entries } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toEqual([]);
  });

  it("handles nested-folder siblings correctly", () => {
    writeFile(fx.root, "Folder/Sub/note.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor(
        "Folder/Sub/note.md",
        "Phone",
        Date.UTC(2026, 4, 26, 10, 0, 0),
      ),
      "theirs",
    );

    const { entries } = findAllConflicts(
      fx.vault as unknown as import("obsidian").Vault,
      fx.store,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].basePath).toBe("Folder/Sub/note.md");
    expect(entries[0].kind).toBe("synthetic");
  });
});

describe("groupByBasePath", () => {
  it("groups entries by basePath, preserving input order within group", () => {
    const make = (basePath: string, ts: string): ConflictEntry => ({
      basePath,
      siblingPath: `${basePath}.conflict-from-X-${ts}`,
      deviceLabel: "X",
      isoTimestamp: ts,
      kind: "synthetic",
    });

    const a1 = make("a.md", "2026-05-26T10-00-00Z");
    const a2 = make("a.md", "2026-05-26T11-00-00Z");
    const b1 = make("b.md", "2026-05-26T10-30-00Z");

    const grouped = groupByBasePath([a1, a2, b1]);
    expect(grouped.get("a.md")).toEqual([a1, a2]);
    expect(grouped.get("b.md")).toEqual([b1]);
  });

  it("returns empty map on empty input", () => {
    expect(groupByBasePath([]).size).toBe(0);
  });
});

// entryFromSibling — the lifted loop body of findAllConflicts (S1 of the split,
// SPLIT-PANEL-EDITOR-FEASIBILITY.md §12). The findAllConflicts suite above is its
// parity net; these pin the single-entry contract the split's S4 row-click +
// Phase-1B setState restore depend on.
describe("entryFromSibling", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("returns null for a path that is not a *.conflict-from-* sibling", () => {
    expect(entryFromSibling(fx.store, "note.md")).toBeNull();
    expect(entryFromSibling(fx.store, "Folder/regular.md")).toBeNull();
  });

  it("classifies a registered sibling as tracked (fields parsed)", async () => {
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = await track(
      fx,
      "note.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 30, 0),
    );

    const entry = entryFromSibling(fx.store, sibPath);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("tracked");
    expect(entry!.basePath).toBe("note.md");
    expect(entry!.siblingPath).toBe(sibPath);
    expect(entry!.deviceLabel).toBe("Phone");
    expect(entry!.isoTimestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/,
    );
  });

  it("classifies an unregistered sibling as synthetic (no vault walk needed)", () => {
    // No entry + no base file on disk: entryFromSibling only parses the path +
    // checks the store's cached index, so an absent base is irrelevant here
    // (matches the absent-base-is-listed rule).
    const sibPath = siblingPathFor("note.md", "Laptop", Date.UTC(2026, 4, 26));
    const entry = entryFromSibling(fx.store, sibPath);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("synthetic");
    expect(entry!.basePath).toBe("note.md");
    expect(entry!.deviceLabel).toBe("Laptop");
  });
});
