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

// (The v1 ConflictStore.create staging-flow describe died at THE
// SWITCH; the v2 sibling write path goes through the standard
// atomicWriteFile, whose desktop/mobile pairing is covered by
// atomic-write.test.ts and vault-file-reader.test.ts.)
