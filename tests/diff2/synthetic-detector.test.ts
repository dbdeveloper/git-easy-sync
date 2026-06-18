import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import ConflictStore, {
  buildSiblingPath,
} from "../../src/sync2/conflict-store";
import {
  findAllConflicts,
  groupByBasePath,
  type ConflictEntry,
} from "../../src/diff2/synthetic-detector";

// Phase 1 — Conflicts list detection module.
// Tests the pure detection logic: tracked vs synthetic categorisation,
// absent-base listing (delete-vs-modify), multi-sibling grouping, ordering.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `synthetic-detector-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);

  let nowMs = Date.UTC(2026, 4, 26, 10, 30, 0, 0);
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => {
      const t = nowMs;
      nowMs += 1000;
      return t;
    },
    idFactory: () => crypto.randomUUID(),
  });

  return { root, vault, store };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// Helper: write a sibling file at a deterministic path so the regex
// parser sees the canonical iso shape buildSiblingPath produces.
function siblingPathFor(
  vaultPath: string,
  device: string,
  whenMs: number,
): string {
  return buildSiblingPath(vaultPath, device, whenMs, "modify-vs-modify");
}

function writeFile(root: string, rel: string, content = "x"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
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

    const { entries, byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries).toEqual([]);
    expect(byBasePath.size).toBe(0);
  });

  it("classifies a sibling with a matching ConflictStore record as tracked", async () => {
    // Set up: base file in vault + sibling registered via conflictStore.
    // store.create() writes the sibling itself (Path B protocol);
    // pre-writing it here would create a duplicate at the test
    // fixture's clock timestamp (the store ignores ts in args).
    writeFile(fx.root, "note.md", "ours bytes");

    const record = await fx.store.create({
      vaultPath: "note.md",
      kind: "modify-vs-modify",
      oursBlobSha: "deadbeef0000000000000000000000000000beef",
      theirsBlobSha: "cafe00000000000000000000000000000000babe",
      theirsContent: new TextEncoder().encode("theirs bytes").buffer as ArrayBuffer,
      remoteDevice: "Phone",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
    });

    const { entries, byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("tracked");
    expect(entries[0].basePath).toBe("note.md");
    expect(entries[0].siblingPath).toBe(record.siblingPath);
    expect(entries[0].deviceLabel).toBe("Phone");
    expect(entries[0].isoTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    expect(entries[0].record).toBeDefined();
    expect(byBasePath.get("note.md")).toHaveLength(1);
  });

  it("classifies a sibling WITHOUT a record but WITH base in vault as synthetic", () => {
    // Synthetic conflict per R3.3 rule 3: base + sibling co-exist in
    // vault, but no ConflictStore record.
    writeFile(fx.root, "note.md", "ours bytes");
    const sibPath = siblingPathFor("note.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "theirs bytes");

    const { entries } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("synthetic");
    expect(entries[0].record).toBeUndefined();
    expect(entries[0].basePath).toBe("note.md");
  });

  it("LISTS an absent-base sibling as a synthetic delete-vs-modify conflict (2026-06-18)", () => {
    // A sibling whose base file is absent is a delete-vs-modify conflict (base
    // deleted, sibling holds the other side) — now LISTED (reverses the old R3.3
    // rule-3 "orphan without base → skip") so it's resolvable via the panel; the
    // diff editor renders the ours side empty (mountDiffPane reads "" for an absent
    // base). Applies to synthetic (no record) AND tracked (R2.5) alike.
    const sibPath = siblingPathFor("missing.md", "Phone", Date.UTC(2026, 4, 26));
    writeFile(fx.root, sibPath, "orphan");

    const { entries, byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries.map((e) => `${e.basePath}:${e.kind}`)).toEqual(["missing.md:synthetic"]);
    expect(byBasePath.size).toBe(1);
  });

  it("returns mixed tracked + synthetic + absent-base-orphan in one pass", async () => {
    // Set up three siblings:
    //   1. tracked   — base+sibling+record
    //   2. synthetic — base+sibling without record
    //   3. orphan    — sibling without base → now LISTED as synthetic (2026-06-18)
    // Plus a regular non-sibling file (must be ignored).
    writeFile(fx.root, "regular.md", "ignore me");

    writeFile(fx.root, "tracked.md", "ours");
    // No pre-write — store.create() writes the sibling per Path B.
    await fx.store.create({
      vaultPath: "tracked.md",
      kind: "modify-vs-modify",
      oursBlobSha: "1111111111111111111111111111111111111111",
      theirsBlobSha: "2222222222222222222222222222222222222222",
      theirsContent: new TextEncoder().encode("theirs1").buffer as ArrayBuffer,
      remoteDevice: "Phone",
      baseMtime: null,
      baseSize: null,
      baseSha: null,
    });

    writeFile(fx.root, "synthetic.md", "ours");
    writeFile(
      fx.root,
      siblingPathFor(
        "synthetic.md",
        "Laptop",
        Date.UTC(2026, 4, 26, 11, 0, 0),
      ),
      "theirs2",
    );

    writeFile(
      fx.root,
      siblingPathFor("orphan.md", "Phone", Date.UTC(2026, 4, 26, 12, 0, 0)),
      "theirs3",
    );

    const { entries, byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries.map((e) => `${e.basePath}:${e.kind}`).sort()).toEqual([
      "orphan.md:synthetic", // absent base → now listed (was skipped)
      "synthetic.md:synthetic",
      "tracked.md:tracked",
    ]);
    expect(byBasePath.size).toBe(3);
  });

  it("groups multi-sibling-per-path into one bucket each", async () => {
    // Two siblings on one base (PSEUDO-MERGE-MODE §10 Scenario C).
    writeFile(fx.root, "note.md", "ours");
    const sib1 = siblingPathFor(
      "note.md",
      "Phone",
      Date.UTC(2026, 4, 26, 10, 0, 0),
    );
    const sib2 = siblingPathFor(
      "note.md",
      "Laptop",
      Date.UTC(2026, 4, 26, 11, 0, 0),
    );
    writeFile(fx.root, sib1, "from phone");
    writeFile(fx.root, sib2, "from laptop");

    const { entries, byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    expect(entries).toHaveLength(2);
    expect(byBasePath.get("note.md")).toHaveLength(2);
    // Both classified as synthetic (no records).
    expect(byBasePath.get("note.md")!.every((e) => e.kind === "synthetic")).toBe(true);
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

    const { entries } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
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

    const { byBasePath } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
    const bucket = byBasePath.get("note.md")!;
    expect(bucket).toHaveLength(2);
    // First in bucket = newer (Laptop @ 11:00).
    expect(bucket[0].deviceLabel).toBe("Laptop");
    expect(bucket[1].deviceLabel).toBe("Phone");
  });

  it("ignores files in nested folders that are not siblings", () => {
    writeFile(fx.root, "Folder/regular.md", "x");
    writeFile(fx.root, "Folder/Sub/other.md", "x");

    const { entries } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
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

    const { entries } = findAllConflicts(fx.vault as unknown as import("obsidian").Vault, fx.store);
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
