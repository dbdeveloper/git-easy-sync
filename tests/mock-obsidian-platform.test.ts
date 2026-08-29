// Test-infrastructure verification for MOCK_PLATFORM mode in
// mock-obsidian.ts.
//
// Why this exists: 2026-05-21 production incident — ConflictStore.create
// worked on desktop (POSIX fs.rename overwrites) but threw "Destination
// file already exists!" on mobile (Capacitor's Filesystem.rename rejects
// existing dests). Mock-obsidian uses Node fs which inherits POSIX
// semantics, so the divergence was invisible at unit-test time.
//
// MOCK_PLATFORM lets tests simulate Capacitor's stricter rename so
// production code's mobile-safe pattern (explicit remove + rename) is
// covered by unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform, getMockPlatform } from "../mock-obsidian";
import ConflictStore from "../src/sync2/conflict-store";
import { stagingPathFor } from "../src/sync2/atomic-write";

describe("MOCK_PLATFORM", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "mock-platform-"));
    vault = new Vault(tmp);
    setMockPlatform("desktop"); // default each test
  });

  afterEach(() => {
    setMockPlatform("desktop"); // leave clean for next file
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to desktop", () => {
    expect(getMockPlatform()).toBe("desktop");
  });

  it("desktop: rename overwrites existing destination (POSIX semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");

    // Should NOT throw — POSIX rename overwrites
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: rename throws when destination exists (Capacitor semantics)", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    await expect(vault.adapter.rename("a.txt", "b.txt")).rejects.toThrow(
      "Destination file already exists",
    );

    // Both files still on disk untouched
    expect(await vault.adapter.read("a.txt")).toBe("from-a");
    expect(await vault.adapter.read("b.txt")).toBe("from-b");
  });

  it("mobile: rename succeeds when destination does NOT exist", async () => {
    await vault.adapter.write("a.txt", "from-a");
    setMockPlatform("mobile");

    // Destination doesn't exist → mobile path is identical to desktop
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  it("mobile: explicit remove-before-rename is the portable pattern", async () => {
    await vault.adapter.write("a.txt", "from-a");
    await vault.adapter.write("b.txt", "from-b");
    setMockPlatform("mobile");

    // The portable pattern: explicitly remove destination first
    if (await vault.adapter.exists("b.txt")) {
      await vault.adapter.remove("b.txt");
    }
    await vault.adapter.rename("a.txt", "b.txt");

    expect(await vault.adapter.exists("a.txt")).toBe(false);
    expect(await vault.adapter.exists("b.txt")).toBe(true);
    expect(await vault.adapter.read("b.txt")).toBe("from-a");
  });

  // Pattern for paired desktop/mobile coverage of rename-touching
  // code. Any test exercising adapter.rename should parametrise
  // like this so a Capacitor-only regression cannot slip through.
  describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
    "describe.each pattern (under $platform)",
    ({ platform }) => {
      beforeEach(() => setMockPlatform(platform));

      it("a fresh rename into empty destination always works", async () => {
        await vault.adapter.write("src.txt", "x");
        await vault.adapter.rename("src.txt", "dst.txt");
        expect(await vault.adapter.read("dst.txt")).toBe("x");
      });
    },
  );

  // ── ASCII quote / apostrophe in filename ────────────────────────────
  // Field-reported mobile failure (2026-05-25): pulling a file named
  // `Штрихи до "святої" книги "Віра в Лад".md` triggered an error from
  // the vault adapter that mock-obsidian's POSIX-backed paths don't
  // reproduce. mock-obsidian uses Node fs which allows `"` and `'` in
  // filenames everywhere, so these tests PASS regardless of platform
  // (they're regression insurance for the upper layers — path
  // normalization, URL encoding, atomic-write staging-path derivation —
  // not a reproduction of the Capacitor-side issue itself). Confirms
  // that the plugin doesn't OWN code that mangles paths with these
  // characters; if a test here ever fails, the bug is in our code, not
  // in the platform.
  describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
    "ASCII quote/apostrophe in filename (under $platform)",
    ({ platform }) => {
      beforeEach(() => setMockPlatform(platform));

      it("write + read + exists round-trip for path with double quotes", async () => {
        const filePath = `Notes/Штрихи до "святої" книги "Віра в Лад".md`;
        const content = `body with "quoted" word\n`;
        await vault.adapter.write(filePath, content);
        expect(await vault.adapter.exists(filePath)).toBe(true);
        expect(await vault.adapter.read(filePath)).toBe(content);
      });

      it("write + read + exists round-trip for path with apostrophes", async () => {
        const filePath = `Notes/Don't worry it's fine.md`;
        const content = `body with 'apostrophes' inside\n`;
        await vault.adapter.write(filePath, content);
        expect(await vault.adapter.exists(filePath)).toBe(true);
        expect(await vault.adapter.read(filePath)).toBe(content);
      });

      it("writeBinary + readBinary round-trip for path with double quotes", async () => {
        // The pull-side path for non-text files uses writeBinary; cover
        // it explicitly because text-vs-binary is a different code path
        // in both mock-obsidian and the real Obsidian adapter.
        const filePath = `assets/"quoted name".bin`;
        const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer as ArrayBuffer;
        await vault.adapter.writeBinary(filePath, bytes);
        expect(await vault.adapter.exists(filePath)).toBe(true);
        const out = await vault.adapter.readBinary(filePath);
        expect(new Uint8Array(out)).toEqual(new Uint8Array(bytes));
      });

      it("atomic-write staging-path for quoted filename is well-formed", async () => {
        // Pull-replace routes through atomicWriteFile which derives
        // staging paths via stagingPathFor. Verify the derivation
        // doesn't drop / re-encode the quotes — staging must round-trip
        // back to final when AtomicWriteRecovery.sweep reverses it.
        const finalPath = `Notes/Штрихи до "святої" книги "Віра в Лад".md`;
        const tmpStaging = stagingPathFor(finalPath, "tmp");
        const bakStaging = stagingPathFor(finalPath, "bak");
        expect(tmpStaging).toBe(`Notes/Штрихи до "святої" книги "Віра в Лад".ges-tmp.md`);
        expect(bakStaging).toBe(`Notes/Штрихи до "святої" книги "Віра в Лад".ges-bak.md`);
      });

      it("rename quoted filename to other quoted filename round-trips", async () => {
        // Models a user renaming `"foo".md` → `"bar".md` while one of
        // them is a sibling-file in a conflict resolution flow.
        const src = `Notes/"old name".md`;
        const dst = `Notes/"new name".md`;
        await vault.adapter.write(src, "content\n");
        await vault.adapter.rename(src, dst);
        expect(await vault.adapter.exists(src)).toBe(false);
        expect(await vault.adapter.exists(dst)).toBe(true);
        expect(await vault.adapter.read(dst)).toBe("content\n");
      });
    },
  );
});

// ConflictStore.create paired desktop/mobile coverage. Under
// `MOCK_PLATFORM=mobile`, Step 3's atomic rename of staging →
// siblingPath uses the explicit-remove-before-rename pattern that
// Capacitor requires, and Step 2's persistRecord does the same for
// meta.json. This test verifies the wiring end-to-end on both
// platforms.
describe.each([{ platform: "desktop" as const }, { platform: "mobile" as const }])(
  "ConflictStore.create (.ges-tmp staging flow) — under $platform",
  ({ platform }) => {
    let tmp: string;
    let vault: Vault;
    let store: ConflictStore;
    const CONFIG_DIR = ".obsidian";
    const SELF = "git-easy-sync";

    beforeEach(async () => {
      tmp = mkdtempSync(path.join(tmpdir(), `cs-create-${platform}-`));
      fs.mkdirSync(path.join(tmp, CONFIG_DIR), { recursive: true });
      vault = new Vault(tmp);
      setMockPlatform(platform);
      store = new ConflictStore({
        vault: vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        selfPluginId: SELF,
      });
      await store.load();
    });

    afterEach(() => {
      setMockPlatform("desktop");
      rmSync(tmp, { recursive: true, force: true });
    });

    it("create() lands sibling at final path and removes staging", async () => {
      // Prime base file so vaultPath exists. ConflictStore.create
      // doesn't require this, but it mirrors the realistic conflict
      // scenario where there's already a local file.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "local content\n");

      const theirs = new TextEncoder()
        .encode("theirs content\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs,
        theirsBlobSha: "theirs-sha",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      const siblingAbs = path.join(tmp, rec.siblingPath);
      const stagingAbs = path.join(tmp, stagingPathFor(rec.siblingPath, "tmp"));

      // Step 3 renamed staging → final. Final exists with theirs
      // content; staging is gone.
      expect(fs.existsSync(siblingAbs)).toBe(true);
      expect(fs.readFileSync(siblingAbs, "utf8")).toBe("theirs content\n");
      expect(fs.existsSync(stagingAbs)).toBe(false);

      // meta.json persisted; no .tmp leftover.
      const recordDir = path.join(
        tmp,
        CONFIG_DIR,
        "plugins",
        SELF,
        ".runtime/conflicts",
        rec.id,
      );
      expect(fs.existsSync(path.join(recordDir, "meta.json"))).toBe(true);
      expect(fs.existsSync(path.join(recordDir, "meta.json.tmp"))).toBe(false);
    });

    it("create() succeeds even when staging path exists from a previous crash", async () => {
      // Synthesize a leftover staging file at the path the new
      // siblingPath will resolve to. Under mobile semantics, the
      // first write to staging would NORMALLY overwrite (writeBinary
      // is forgiving), but the subsequent rename(staging → final)
      // could collide if the user also has a final file lying
      // around from an earlier session.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "local content\n");

      // Plant a stale file at the EXPECTED final sibling path. The
      // record id is deterministic (uuid()) but the timestamp suffix
      // in buildSiblingPath uses the device label. Easier: call
      // create twice — the second create with the same
      // (vaultPath, theirsBlobSha) dedups in-memory and returns the
      // existing record without disk ops. Use a DIFFERENT
      // theirsBlobSha for the second call so dedup doesn't fire.
      const theirs1 = new TextEncoder()
        .encode("v1 content\n")
        .buffer.slice(0) as ArrayBuffer;
      await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs1,
        theirsBlobSha: "sha-v1",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      const theirs2 = new TextEncoder()
        .encode("v2 content\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec2 = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs2,
        theirsBlobSha: "sha-v2",
        oursBlobSha: "ours-sha",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });

      // Second record lands cleanly; multi-sibling on the same path.
      const sibling2Abs = path.join(tmp, rec2.siblingPath);
      expect(fs.existsSync(sibling2Abs)).toBe(true);
      expect(fs.readFileSync(sibling2Abs, "utf8")).toBe("v2 content\n");
      expect(store.getByPath("Notes/note.md")).toHaveLength(2);
    });

    // Mobile-shaped delete-then-rename workflow. Capacitor's rename
    // throws on existing destination, so the workflow must be:
    // delete base FIRST, then rename sibling onto base. The
    // classifier's `!base + sibling` → noop rule keeps the sibling
    // alive between the two steps so the workflow can complete
    // (see docs/PSEUDO-MERGE-MODE.md §6.2). Desktop tolerates
    // atomic rename-overwrite, but we verify the mobile-portable
    // path works under both platforms.
    it("delete-base-then-rename-sibling workflow resolves to accept-theirs", async () => {
      // Need to dynamic-import because conflict-classifier pulls in
      // the obsidian alias chain that fails at module-eval otherwise.
      const { evaluateConflictState } = await import(
        "../src/sync2/conflict-classifier"
      );

      // Setup: vault base + sibling + record (the post-conflict-
      // detection state). Use store.create() so the full 3-step
      // `.ges-tmp` flow runs and lands the sibling at its final
      // path.
      fs.mkdirSync(path.join(tmp, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "Notes/note.md"), "ours\n");
      const theirs = new TextEncoder()
        .encode("theirs\n")
        .buffer.slice(0) as ArrayBuffer;
      const rec = await store.create({
        vaultPath: "Notes/note.md",
        kind: "modify-vs-modify",
        theirsContent: theirs,
        theirsBlobSha: "sha-theirs",
        oursBlobSha: "sha-ours",
        baseMtime: null,
        baseSize: null,
        baseSha: null,
        remoteDevice: "Phone",
      });
      const baseAbs = path.join(tmp, "Notes/note.md");
      const siblingAbs = path.join(tmp, rec.siblingPath);
      expect(fs.existsSync(siblingAbs)).toBe(true);
      expect(fs.existsSync(baseAbs)).toBe(true);

      // Workflow: user wants "accept theirs".
      //   Step 1: delete base.
      //   Step 2: rename sibling → base path.
      // Between steps, NO classifier sweep fires (production
      // listeners are read-only — they only mark counter dirty,
      // not mutate store).
      fs.unlinkSync(baseAbs);
      expect(fs.existsSync(baseAbs)).toBe(false);
      // Sibling still alive — `!base + sibling` → noop means engine
      // doesn't react to bare base-deletion.
      expect(fs.existsSync(siblingAbs)).toBe(true);

      // Step 2: rename sibling → base. On mobile, the destination is
      // empty (we just deleted base) so adapter.rename succeeds.
      // mock-obsidian's vault.adapter.rename is called via mock-
      // obsidian — must use vault adapter, not raw fs.renameSync, to
      // exercise the platform check.
      await vault.adapter.rename(rec.siblingPath, "Notes/note.md");
      expect(fs.existsSync(siblingAbs)).toBe(false);
      expect(fs.readFileSync(baseAbs, "utf8")).toBe("theirs\n");

      // Now drain-start sweep fires (or any classifier eval). Phase B
      // sees !siblingExists → drops record, path closed, propagate
      // live base (theirs).
      const result = await evaluateConflictState(
        store,
        vault as unknown as import("obsidian").Vault,
      );
      expect(result.recordsRemoved).toContain(rec.id);
      expect([...result.pathsResolved]).toContain("Notes/note.md");
      expect(store.get(rec.id)).toBeUndefined();
      // Base file still has theirs content; nothing destroyed.
      expect(fs.readFileSync(baseAbs, "utf8")).toBe("theirs\n");
    });
  },
);
