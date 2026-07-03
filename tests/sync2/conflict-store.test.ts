import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import ConflictStore, {
  buildSiblingPath,
  extensionOf,
  unresolvedNameFor,
  type ConflictRecord,
  type CreateArgs,
} from "../../src/sync2/conflict-store";
import { calculateGitBlobSHA } from "../../src/utils";
import { Vault } from "../../mock-obsidian";

// ConflictStore tests. See src/sync2/conflict-store.ts +
// docs/PSEUDO-MERGE-MODE.md §4.2 + §9.4 for the contract.
//
// Covers:
//   - 3-step atomic create + per-crash-window recovery sweep
//   - Dedup by (vaultPath, theirsBlobSha)
//   - Defensive coercion on load
//   - updateCache through metaWriteQueue
//   - delete + clearAll do NOT touch vault siblings

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";
const DEVICE = "test-device";

function fixture(): {
  root: string;
  vault: Vault;
  store: ConflictStore;
  conflictsRoot: string;
  clock: { tick: () => number; set: (ms: number) => void };
  idSeq: { next: () => string };
} {
  const root = path.join(
    os.tmpdir(),
    `conflict-store-v2-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  let currentMs = Date.UTC(2026, 4, 8, 15, 30, 0, 0);
  const clock = {
    tick: () => {
      const t = currentMs;
      currentMs += 1000;
      return t;
    },
    set: (ms: number) => {
      currentMs = ms;
    },
  };
  let idCounter = 0;
  const idSeq = {
    // Deterministic UUID-like ids so test assertions can pin them.
    next: () => `00000000-0000-0000-0000-${String(++idCounter).padStart(12, "0")}`,
  };
  const store = new ConflictStore({
    vault: vault as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => clock.tick(),
    idFactory: () => idSeq.next(),
  });
  const conflictsRoot = path.join(
    root,
    CONFIG_DIR,
    "plugins",
    SELF_PLUGIN_ID,
    ".runtime/conflicts",
  );
  return { root, vault, store, conflictsRoot, clock, idSeq };
}

function arr(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer.slice(0) as ArrayBuffer;
}

function readVaultText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function writeVaultFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ── helpers covered by their own block first ──────────────────────────

describe("extensionOf", () => {
  it("returns the dot + extension on normal files", () => {
    expect(extensionOf("Notes/note.md")).toBe(".md");
    expect(extensionOf("attachments/photo.PNG")).toBe(".PNG");
    expect(extensionOf("file.tar.gz")).toBe(".gz");
  });

  it("returns empty string when there is no extension", () => {
    expect(extensionOf("Notes/no-ext")).toBe("");
    expect(extensionOf("README")).toBe("");
  });

  it("treats a leading-dot filename as having no extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("subdir/.eslintrc")).toBe("");
  });
});

describe("buildSiblingPath", () => {
  const ts = Date.UTC(2026, 4, 8, 15, 30, 0);

  it("modify-vs-modify: inserts label + iso-timestamp before the extension", () => {
    expect(buildSiblingPath("Notes/note.md", "Phone", ts, "modify-vs-modify"))
      .toBe("Notes/note.conflict-from-Phone-2026-05-08T15-30-00Z.md");
  });

  it("delete-vs-modify: same shape as modify-vs-modify", () => {
    expect(buildSiblingPath("a.md", "Phone", ts, "delete-vs-modify"))
      .toBe("a.conflict-from-Phone-2026-05-08T15-30-00Z.md");
  });

  it("file with no extension: snapshot file has no extension either", () => {
    expect(buildSiblingPath("README", "Phone", ts, "modify-vs-modify"))
      .toBe("README.conflict-from-Phone-2026-05-08T15-30-00Z");
  });

  it("parens in device label become brackets (filesystem-safe)", () => {
    expect(buildSiblingPath("a.md", "Phone (work)", ts, "modify-vs-modify"))
      .toBe("a.conflict-from-Phone [work]-2026-05-08T15-30-00Z.md");
  });

  it("colons are dropped from the ISO timestamp (Windows-safe)", () => {
    const out = buildSiblingPath("a.md", "P", ts, "modify-vs-modify");
    expect(out).not.toContain(":");
  });
});

// ── ConflictStore proper ────────────────────────────────────────────────

describe("ConflictStore", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  function baseArgs(over: Partial<CreateArgs> = {}): CreateArgs {
    return {
      vaultPath: "Notes/note.md",
      kind: "modify-vs-modify",
      theirsContent: arr("theirs content\n"),
      theirsBlobSha: "theirs-sha-1",
      oursBlobSha: "ours-sha-1",
      baseMtime: 100,
      baseSize: 5,
      baseSha: "base-sha-1",
      remoteDevice: "Phone",
      ...over,
    };
  }

  describe("create", () => {
    it("modify-vs-modify: persists meta.json and lands sibling at final path", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local content\n");
      const rec = await f.store.create(baseArgs());

      const dir = path.join(f.conflictsRoot, rec.id);
      // meta.json persisted; tmp atomic-write artifact cleaned.
      expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "meta.json.tmp"))).toBe(false);
      // Sibling staging is renamed from `.sync-tmp` pre-suffix to its
      // final siblingPath atomically (see §9.4).
      expect(fs.existsSync(path.join(f.root, rec.siblingPath))).toBe(true);
      expect(readVaultText(f.root, rec.siblingPath)).toBe("theirs content\n");
    });

    it("delete-vs-modify: oursBlobSha is null on disk", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs({
        kind: "delete-vs-modify",
        oursBlobSha: null,
        baseMtime: null,
        baseSize: null,
        baseSha: null,
      }));
      const meta = JSON.parse(
        fs.readFileSync(path.join(f.conflictsRoot, rec.id, "meta.json"), "utf8"),
      );
      expect(meta.oursBlobSha).toBeNull();
      expect(meta.baseSha).toBeNull();
      expect(meta.baseMtime).toBeNull();
      expect(meta.baseSize).toBeNull();
    });

    it("populates siblingMtime/Size cache from final vault stat", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs());
      expect(rec.siblingSize).toBe("theirs content\n".length);
      expect(rec.siblingMtime).toBeGreaterThan(0);
    });

    it("indexes by vaultPath + by id", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs());
      expect(f.store.get(rec.id)).toBeDefined();
      expect(f.store.hasPending("Notes/note.md")).toBe(true);
      expect(f.store.getByPath("Notes/note.md").map((r) => r.id)).toEqual([rec.id]);
      expect([...f.store.pathSet()]).toEqual(["Notes/note.md"]);
    });

    it("indexes by sibling path (O(1) lookup for ConflictWatcher fast-path)", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs());
      expect(f.store.hasSibling(rec.siblingPath)).toBe(true);
      expect(f.store.getBySibling(rec.siblingPath)?.id).toBe(rec.id);
      expect(f.store.hasSibling("unknown/path.md")).toBe(false);
      expect(f.store.getBySibling("unknown/path.md")).toBeUndefined();

      // Delete drops the sibling index too.
      await f.store.delete(rec.id);
      expect(f.store.hasSibling(rec.siblingPath)).toBe(false);
    });
  });

  describe("dedup", () => {
    it("same (vaultPath, theirsBlobSha) returns the existing record without touching disk", async () => {
      await f.store.load();
      const first = await f.store.create(baseArgs());
      // mtime can change with the second call, so capture the dir
      // list snapshot for comparison.
      const dirsBefore = fs.readdirSync(f.conflictsRoot);
      const second = await f.store.create(baseArgs());
      const dirsAfter = fs.readdirSync(f.conflictsRoot);
      expect(second.id).toBe(first.id);
      expect(dirsAfter).toEqual(dirsBefore);
      expect(f.store.getAll().length).toBe(1);
    });

    it("different theirsBlobSha on same path spawns a new sibling", async () => {
      await f.store.load();
      const a = await f.store.create(baseArgs({ theirsBlobSha: "sha-a" }));
      const b = await f.store.create(baseArgs({ theirsBlobSha: "sha-b" }));
      expect(b.id).not.toBe(a.id);
      expect(f.store.getByPath("Notes/note.md").length).toBe(2);
    });

    it("different vaultPath with same theirsBlobSha does NOT dedup", async () => {
      await f.store.load();
      const a = await f.store.create(baseArgs({ vaultPath: "a.md" }));
      const b = await f.store.create(baseArgs({ vaultPath: "b.md" }));
      expect(b.id).not.toBe(a.id);
      expect(f.store.getAll().length).toBe(2);
    });

    // ─── Filesystem-orphan adoption ────────────────────────────────────
    //
    // create() must de-duplicate against orphan sibling files in
    // the vault (left over from a previous plugin version, manual
    // cleanup of `.conflicts/`, etc.), not only against in-memory
    // records. When create() finds an orphan
    // `<stem>.conflict-from-*<ext>` matching theirsBlobSha, it
    // adopts it: the new record points at the EXISTING file and
    // no new sibling is written. Without this, repeated
    // registrations spawn phantom duplicate siblings.
    it("create() adopts an existing orphan sibling matching theirsBlobSha", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local content\n");

      // Plant an orphan sibling — content matches what create() will
      // be asked to register. Mimics: previous plugin install left a
      // sibling; user wiped `.conflicts/`; same conflict re-detected.
      const orphanPath = "Notes/note.conflict-from-OldDevice-2026-01-01T00-00-00Z.md";
      writeVaultFile(f.root, orphanPath, "theirs content\n");

      // Compute the SHA of the orphan's content. create() hashes
      // each candidate orphan and compares against theirsBlobSha;
      // we precompute the expected match key here.
      const orphanContent = new TextEncoder().encode("theirs content\n");
      const orphanSha = await calculateGitBlobSHA(
        orphanContent.buffer.slice(
          orphanContent.byteOffset,
          orphanContent.byteOffset + orphanContent.byteLength,
        ) as ArrayBuffer,
      );

      // Call create() with the matching theirsBlobSha.
      const rec = await f.store.create(
        baseArgs({
          vaultPath: "Notes/note.md",
          theirsBlobSha: orphanSha,
          theirsContent: orphanContent.buffer.slice(
            orphanContent.byteOffset,
            orphanContent.byteOffset + orphanContent.byteLength,
          ) as ArrayBuffer,
        }),
      );

      // Adoption: the new record points at the EXISTING orphan,
      // not a freshly-timestamped one.
      expect(rec.siblingPath).toBe(orphanPath);

      // No second sibling spawned in the vault.
      const siblings = fs
        .readdirSync(path.join(f.root, "Notes"))
        .filter((name) => name.startsWith("note.conflict-from-"));
      expect(siblings).toHaveLength(1);
      expect(siblings[0]).toBe(
        "note.conflict-from-OldDevice-2026-01-01T00-00-00Z.md",
      );
    });
  });

  describe("crash recovery on load", () => {
    it("recordDir without meta.json → rmdir on load (step-1 crash recovery)", async () => {
      // Synthesize the on-disk state a step-1 crash would have left:
      // recordDir exists but meta.json was never written.
      const orphanId = "11111111-1111-1111-1111-000000000001";
      const orphanDir = path.join(f.conflictsRoot, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });

      await f.store.load();

      expect(fs.existsSync(orphanDir)).toBe(false);
      expect(f.store.getAll().length).toBe(0);
    });

    it("step-3 done then user externally deletes vault sibling → record stays indexed", async () => {
      // load() never resurrects vault content. The record loads from
      // meta.json; the missing sibling becomes a drain Phase B drop
      // signal on the next sync. Vault-level `.sync-tmp` staging is
      // already renamed to the final siblingPath by the time
      // create() returns — there is no backup file to re-emit from.
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const rec = await f.store.create(baseArgs());
      fs.unlinkSync(path.join(f.root, rec.siblingPath));

      const recoveryStore = new ConflictStore({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await recoveryStore.load();

      // Record indexed from meta.json; vault sibling stays gone.
      expect(recoveryStore.get(rec.id)).toBeDefined();
      expect(fs.existsSync(path.join(f.root, rec.siblingPath))).toBe(false);
    });

    // ─── load() does NOT auto-restore deleted siblings ───────────────
    //
    // If load() resurrected a vault sibling the user had
    // intentionally deleted, the user's resolution action would be
    // silently undone on every plugin restart. load() reads
    // meta.json only; missing siblings stay missing and become a
    // drain Phase B drop signal on the next sync (see
    // docs/PSEUDO-MERGE-MODE.md §9.7).
    it("missing vault sibling at load() does NOT restore from backup", async () => {
      // Land a fully created record.
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local content\n");
      const rec = await f.store.create(baseArgs());
      const siblingAbs = path.join(f.root, rec.siblingPath);
      expect(fs.existsSync(siblingAbs)).toBe(true);

      // User deletes the vault sibling externally (file explorer,
      // CLI, another device's sync, etc.).
      fs.unlinkSync(siblingAbs);
      expect(fs.existsSync(siblingAbs)).toBe(false);

      // Fresh load() — the vault sibling MUST stay missing. (Drain
      // Phase B drops the record on the next sync; this test asserts
      // only the critical invariant that load() never resurrects.)
      const recoveryStore = new ConflictStore({
        vault: f.vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF_PLUGIN_ID,
      });
      await recoveryStore.load();

      expect(fs.existsSync(siblingAbs)).toBe(false);
    });
  });

  describe("defensive coercion on load", () => {
    it("corrupt JSON in meta.json → record skipped, recordDir NOT removed", async () => {
      // recordDir-shaped, meta.json present but garbage.
      const orphanId = "22222222-2222-2222-2222-000000000001";
      const orphanDir = path.join(f.conflictsRoot, orphanId);
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, "meta.json"), "not-json{");

      await f.store.load();

      expect(f.store.getAll().length).toBe(0);
      // Recordsir preserved (don't silently delete user-visible state).
      expect(fs.existsSync(orphanDir)).toBe(true);
    });

    it("missing required identity field (no id) → skipped", async () => {
      const orphanDir = path.join(f.conflictsRoot, "no-id-record");
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(
        path.join(orphanDir, "meta.json"),
        JSON.stringify({ vaultPath: "x.md", kind: "modify-vs-modify", siblingPath: "x.conflict.md" }),
      );
      await f.store.load();
      expect(f.store.getAll().length).toBe(0);
    });

    it("invalid kind value → skipped", async () => {
      const orphanDir = path.join(f.conflictsRoot, "bad-kind");
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(
        path.join(orphanDir, "meta.json"),
        JSON.stringify({
          id: "bad-kind",
          vaultPath: "x.md",
          kind: "definitely-not-a-kind",
          siblingPath: "x.conflict.md",
        }),
      );
      await f.store.load();
      expect(f.store.getAll().length).toBe(0);
    });

    it("unknown extra fields → ignored, record loads OK", async () => {
      const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
      const recId = "extra-fields-record";
      const dir = path.join(f.conflictsRoot, recId);
      fs.mkdirSync(dir, { recursive: true });
      const siblingPath = buildSiblingPath("x.md", "Phone", ts, "modify-vs-modify");
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: recId,
          vaultPath: "x.md",
          kind: "modify-vs-modify",
          oursBlobSha: "o",
          theirsBlobSha: "t",
          remoteDevice: "Phone",
          createdAt: ts,
          siblingPath,
          siblingMtime: 0,
          siblingSize: 0,
          siblingSha: "ss",
          baseMtime: null,
          baseSize: null,
          baseSha: null,
          lastEvaluated: ts,
          futureField: "ignore me",
          anotherUnknown: { nested: true },
        }),
      );
      // Vault sibling so step-3 recovery doesn't fire.
      writeVaultFile(f.root, siblingPath, "");

      await f.store.load();

      const rec = f.store.get(recId);
      expect(rec).toBeDefined();
      expect(rec!.vaultPath).toBe("x.md");
      // Unknown fields don't appear in the indexed record.
      expect((rec as unknown as { futureField?: unknown }).futureField).toBeUndefined();
    });

    it("numeric field as a string → coerced to default (0 or null)", async () => {
      const ts = Date.UTC(2026, 4, 8, 15, 30, 0);
      const recId = "bad-numbers";
      const dir = path.join(f.conflictsRoot, recId);
      fs.mkdirSync(dir, { recursive: true });
      const siblingPath = buildSiblingPath("x.md", "Phone", ts, "modify-vs-modify");
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: recId,
          vaultPath: "x.md",
          kind: "modify-vs-modify",
          oursBlobSha: "o",
          theirsBlobSha: "t",
          remoteDevice: "Phone",
          createdAt: "not-a-number",
          siblingPath,
          siblingMtime: "neither",
          siblingSize: "is",
          siblingSha: "ss",
          baseMtime: "this",
          baseSize: "one",
          baseSha: null,
          lastEvaluated: null,
        }),
      );
      writeVaultFile(f.root, siblingPath, "");

      await f.store.load();

      const rec = f.store.get(recId)!;
      expect(rec.createdAt).toBe(0);
      expect(rec.siblingMtime).toBe(0);
      expect(rec.siblingSize).toBe(0);
      expect(rec.baseMtime).toBeNull();
      expect(rec.baseSize).toBeNull();
      expect(rec.lastEvaluated).toBe(0);
    });
  });

  describe("updateCache", () => {
    it("persists patched fields and returns the new record state", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs());
      const updated = await f.store.updateCache(rec.id, {
        siblingMtime: 12345,
        siblingSize: 99,
        siblingSha: "updated-sibling-sha",
        baseMtime: 67890,
        baseSize: 42,
        baseSha: "updated-base-sha",
        lastEvaluated: 555,
      });
      expect(updated).not.toBeNull();
      expect(updated!.siblingMtime).toBe(12345);
      expect(updated!.siblingSha).toBe("updated-sibling-sha");
      // Persisted on disk.
      const disk = JSON.parse(
        fs.readFileSync(path.join(f.conflictsRoot, rec.id, "meta.json"), "utf8"),
      ) as ConflictRecord;
      expect(disk.siblingMtime).toBe(12345);
      expect(disk.lastEvaluated).toBe(555);
    });

    it("concurrent updateCache calls don't clobber each other (metaWriteQueue)", async () => {
      await f.store.load();
      const rec = await f.store.create(baseArgs());
      // Fire 5 updates in parallel.
      const updates = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          f.store.updateCache(rec.id, { lastEvaluated: n }),
        ),
      );
      // All resolved without errors.
      for (const u of updates) expect(u).not.toBeNull();
      // Final on-disk value is whichever update came last in the
      // sequence — at minimum, it's one of 1..5 and the file is
      // valid JSON (not partial).
      const disk = JSON.parse(
        fs.readFileSync(path.join(f.conflictsRoot, rec.id, "meta.json"), "utf8"),
      ) as ConflictRecord;
      expect([1, 2, 3, 4, 5]).toContain(disk.lastEvaluated);
    });

    it("returns null when id does not exist", async () => {
      await f.store.load();
      const result = await f.store.updateCache("nonexistent", {
        lastEvaluated: 1,
      });
      expect(result).toBeNull();
    });
  });

  describe("delete + clearAll", () => {
    it("delete: removes recordDir but NOT the vault sibling", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const rec = await f.store.create(baseArgs());
      const dir = path.join(f.conflictsRoot, rec.id);
      const siblingAbs = path.join(f.root, rec.siblingPath);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(siblingAbs)).toBe(true);

      await f.store.delete(rec.id);

      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(siblingAbs)).toBe(true); // user-visible, not ours to remove
      expect(f.store.get(rec.id)).toBeUndefined();
      expect(f.store.hasPending("Notes/note.md")).toBe(false);
    });

    it("clearAll: rmdirs .conflicts/ but leaves vault siblings on disk", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const r1 = await f.store.create(baseArgs({ theirsBlobSha: "sha-1" }));
      const r2 = await f.store.create(baseArgs({ theirsBlobSha: "sha-2" }));

      await f.store.clearAll();

      expect(fs.existsSync(f.conflictsRoot)).toBe(false);
      // Vault siblings preserved.
      expect(fs.existsSync(path.join(f.root, r1.siblingPath))).toBe(true);
      expect(fs.existsSync(path.join(f.root, r2.siblingPath))).toBe(true);
      expect(f.store.getAll().length).toBe(0);
    });
  });

  describe("multi-sibling on same path", () => {
    it("two creates with different theirs land both siblings on disk and in the index", async () => {
      await f.store.load();
      const a = await f.store.create(baseArgs({
        theirsContent: arr("from-A\n"),
        theirsBlobSha: "sha-A",
        remoteDevice: "Laptop",
      }));
      const b = await f.store.create(baseArgs({
        theirsContent: arr("from-B\n"),
        theirsBlobSha: "sha-B",
        remoteDevice: "Phone",
      }));
      expect(a.siblingPath).not.toBe(b.siblingPath);
      expect(fs.existsSync(path.join(f.root, a.siblingPath))).toBe(true);
      expect(fs.existsSync(path.join(f.root, b.siblingPath))).toBe(true);
      const both = f.store.getByPath("Notes/note.md");
      expect(both.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    });
  });

  describe("load → re-load idempotency", () => {
    it("re-load after vault writes refreshes the in-memory index", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const rec = await f.store.create(baseArgs());
      expect(f.store.getAll().length).toBe(1);

      // External actor wipes the record off disk (e.g. user
      // running rm -rf .conflicts/ on a stuck install).
      fs.rmSync(path.join(f.conflictsRoot, rec.id), {
        recursive: true,
        force: true,
      });

      await f.store.load();
      expect(f.store.getAll().length).toBe(0);
    });
  });

  // Reset → rename vault siblings to *.unresolved-* so a re-enable
  // doesn't collide with leftover `conflict-from-*` artifacts.
  describe("renameVaultSiblingsToUnresolved", () => {
    it("renames a regular file's sibling and leaves the base untouched", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const rec = await f.store.create(baseArgs());
      const oldSibling = rec.siblingPath;
      expect(fs.existsSync(path.join(f.root, oldSibling))).toBe(true);

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(1);
      expect(fs.existsSync(path.join(f.root, oldSibling))).toBe(false);
      // Base file is the user's content — must not move.
      expect(fs.existsSync(path.join(f.root, "Notes/note.md"))).toBe(true);
      // Rewritten filename: unresolved-<isoTs>.<ext>
      expect(
        fs.existsSync(
          path.join(f.root, "Notes/note.unresolved-2026-05-08T15-30-00Z.md"),
        ),
      ).toBe(true);
    });

    it("handles hidden files (.gitignore.conflict-from-... → .gitignore.unresolved-...)", async () => {
      await f.store.load();
      writeVaultFile(f.root, ".gitignore", "*.log\n");
      const rec = await f.store.create(
        baseArgs({ vaultPath: ".gitignore", baseSha: "g-sha" }),
      );
      expect(rec.siblingPath).toBe(
        ".gitignore.conflict-from-Phone-2026-05-08T15-30-00Z",
      );

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(1);
      expect(
        fs.existsSync(
          path.join(f.root, ".gitignore.unresolved-2026-05-08T15-30-00Z"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(f.root, ".gitignore"))).toBe(true);
    });

    it("handles extensionless files (README → README.unresolved-...)", async () => {
      await f.store.load();
      writeVaultFile(f.root, "README", "hello\n");
      await f.store.create(
        baseArgs({ vaultPath: "README", baseSha: "r-sha" }),
      );

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(1);
      expect(
        fs.existsSync(
          path.join(f.root, "README.unresolved-2026-05-08T15-30-00Z"),
        ),
      ).toBe(true);
    });

    it("renames multiple siblings on the same base independently", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      await f.store.create(baseArgs({ remoteDevice: "Phone" }));
      // Advance clock by 1s + use different theirsBlobSha so dedup doesn't merge.
      const rec2 = await f.store.create(
        baseArgs({
          remoteDevice: "Laptop",
          theirsBlobSha: "theirs-sha-2",
          theirsContent: arr("different\n"),
        }),
      );
      expect(rec2.siblingPath).toContain("Laptop");

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(2);
      // Both unresolved variants land in vault.
      const listing = fs
        .readdirSync(path.join(f.root, "Notes"))
        .filter((n) => n.includes("unresolved"));
      expect(listing.length).toBe(2);
    });

    it("ignores files that don't match the conflict-from shape", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "x\n");
      // User has a stray file that LOOKS conflict-ish but doesn't match.
      writeVaultFile(f.root, "Notes/note.draft.md", "draft\n");
      writeVaultFile(f.root, "Notes/random.conflict-elsewhere.md", "junk\n");

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(0);
      expect(fs.existsSync(path.join(f.root, "Notes/note.md"))).toBe(true);
      expect(fs.existsSync(path.join(f.root, "Notes/note.draft.md"))).toBe(true);
      expect(
        fs.existsSync(path.join(f.root, "Notes/random.conflict-elsewhere.md")),
      ).toBe(true);
    });

    it("skips silently when the destination *.unresolved-* already exists (mobile rename-throws safety)", async () => {
      await f.store.load();
      writeVaultFile(f.root, "Notes/note.md", "local\n");
      const rec = await f.store.create(baseArgs());
      const destPath = "Notes/note.unresolved-2026-05-08T15-30-00Z.md";
      // Pre-seed the destination (simulates a prior reset that didn't
      // fully clean up). renameVaultSiblingsToUnresolved must NOT
      // throw and must leave both files intact.
      writeVaultFile(f.root, destPath, "stale unresolved\n");

      const renamed = await f.store.renameVaultSiblingsToUnresolved();

      expect(renamed).toBe(0);
      expect(fs.existsSync(path.join(f.root, rec.siblingPath))).toBe(true);
      expect(readVaultText(f.root, destPath)).toBe("stale unresolved\n");
    });
  });
});

// ── Pure unresolvedNameFor helper ───────────────────────────────────────

describe("unresolvedNameFor", () => {
  it("rewrites a regular-extension sibling, stripping the device label", () => {
    expect(
      unresolvedNameFor("note.conflict-from-Phone-2026-05-08T15-30-00Z.md"),
    ).toBe("note.unresolved-2026-05-08T15-30-00Z.md");
  });

  it("handles labels with embedded dashes (Laptop-2, Phone_2-A)", () => {
    expect(
      unresolvedNameFor(
        "note.conflict-from-Laptop-2-2026-05-08T15-30-00Z.md",
      ),
    ).toBe("note.unresolved-2026-05-08T15-30-00Z.md");
    expect(
      unresolvedNameFor(
        "note.conflict-from-Phone_2-A-2026-05-08T15-30-00Z.md",
      ),
    ).toBe("note.unresolved-2026-05-08T15-30-00Z.md");
  });

  it("handles extensionless siblings (README, hidden .gitignore)", () => {
    expect(
      unresolvedNameFor("README.conflict-from-Phone-2026-05-08T15-30-00Z"),
    ).toBe("README.unresolved-2026-05-08T15-30-00Z");
    expect(
      unresolvedNameFor(".gitignore.conflict-from-Phone-2026-05-08T15-30-00Z"),
    ).toBe(".gitignore.unresolved-2026-05-08T15-30-00Z");
  });

  it("handles multi-dot filenames (archive.tar.gz)", () => {
    expect(
      unresolvedNameFor("archive.tar.conflict-from-Phone-2026-05-08T15-30-00Z.gz"),
    ).toBe("archive.tar.unresolved-2026-05-08T15-30-00Z.gz");
  });

  it("returns null for non-conflict filenames", () => {
    expect(unresolvedNameFor("note.md")).toBeNull();
    expect(unresolvedNameFor("note.draft.md")).toBeNull();
    expect(unresolvedNameFor("README")).toBeNull();
    expect(unresolvedNameFor(".gitignore")).toBeNull();
    // Looks conflict-ish but lacks the timestamp shape.
    expect(unresolvedNameFor("note.conflict-from-Phone-yesterday.md")).toBeNull();
    // Already unresolved — don't double-rewrite.
    expect(
      unresolvedNameFor("note.unresolved-2026-05-08T15-30-00Z.md"),
    ).toBeNull();
  });
});
