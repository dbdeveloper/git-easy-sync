import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault, setMockPlatform } from "../../mock-obsidian";
import {
  FORBIDDEN_TO_CANONICAL,
  sanitizeFilename,
  needsSanitization,
  safeRename,
  freeNameFor,
} from "../../src/sync2/cross-platform";

describe("cross-platform — filename sanitizer", () => {
  describe("FORBIDDEN_TO_CANONICAL mapping", () => {
    it("covers exactly the two forbidden families", () => {
      // Family 1 — Windows FAT/NTFS-forbidden (`< > : " | ? * \`).
      // Family 2 — Obsidian wiki-link-conflict (`# ^ [ ]`).
      // If we ever extend the set, both this test and the
      // FORBIDDEN_REGEX in filename-sanitizer.ts must change together.
      expect(Object.keys(FORBIDDEN_TO_CANONICAL).sort()).toEqual(
        ['"', "#", "*", ":", "<", ">", "?", "[", "\\", "]", "^", "|"],
      );
    });

    it("maps every forbidden char to a non-forbidden replacement", () => {
      // Loop invariant: the canonical form of any sanitized name must
      // itself be forbidden-char-free, otherwise sanitization isn't
      // idempotent and round-trips through sync could keep re-renaming.
      for (const replacement of Object.values(FORBIDDEN_TO_CANONICAL)) {
        expect(needsSanitization(replacement)).toBe(false);
      }
    });

    it("replacements are single Unicode code points (no expansion)", () => {
      // We don't want a forbidden char to expand into a multi-char
      // sequence (e.g. `"` → `''`); that would break the "rename is
      // bijective with current state" invariant and complicate
      // path-length budgeting near GitHub's 255-char tree-entry limit.
      for (const replacement of Object.values(FORBIDDEN_TO_CANONICAL)) {
        expect([...replacement].length).toBe(1);
      }
    });
  });

  describe("needsSanitization", () => {
    it("returns false on a clean path", () => {
      expect(needsSanitization("Notes/idea.md")).toBe(false);
      expect(needsSanitization("Замітки/нотатка.md")).toBe(false);
      expect(needsSanitization("Notes/My Note (draft).md")).toBe(false);
      expect(needsSanitization("")).toBe(false);
    });

    it("returns true on each forbidden ASCII char in basename", () => {
      for (const ch of Object.keys(FORBIDDEN_TO_CANONICAL)) {
        expect(needsSanitization(`Notes/file${ch}.md`)).toBe(true);
      }
    });

    it("returns true when the forbidden char lives in a directory segment", () => {
      // We must sanitize the entire path, not only the basename, so
      // detection has to flag the dir component too.
      expect(needsSanitization(`Folder"name"/note.md`)).toBe(true);
      expect(needsSanitization("Folder<v1>/note.md")).toBe(true);
    });

    it("is short-circuit: first match returns immediately", () => {
      // Tested behaviourally by not throwing on a single-char string
      // with one forbidden char (regex must not require multi-char input).
      expect(needsSanitization(`"`)).toBe(true);
    });
  });

  describe("sanitizeFilename", () => {
    it("returns the same reference (no-op) on a clean path", () => {
      // Performance contract: no allocation when sanitization isn't
      // needed. Identity equality, not just structural.
      const clean = "Notes/idea.md";
      expect(sanitizeFilename(clean)).toBe(clean);
    });

    it("maps each forbidden ASCII char to its canonical replacement", () => {
      // The reference vault-killer from the field bug report. After
      // sanitize, no forbidden char remains.
      const before = `Notes/Штрихи до "святої" книги "Віра в Лад".md`;
      const after = sanitizeFilename(before);
      expect(after).toBe(`Notes/Штрихи до “святої“ книги “Віра в Лад“.md`);
      expect(needsSanitization(after)).toBe(false);
    });

    it("sanitizes directory and basename components together", () => {
      // Real-world cases: `<draft>` or `Notes:Q1` as a folder name.
      const before = "Folder<v1>/Notes:Q1/a|b.md";
      const after = sanitizeFilename(before);
      expect(after).toBe("Folder＜v1＞/Notes꞉Q1/a｜b.md");
      expect(needsSanitization(after)).toBe(false);
    });

    it("sanitizes Obsidian-app-level forbidden chars (`# ^ [ ]`)", () => {
      // These never appear in a local Obsidian vault because the editor
      // refuses to create them, but they can land on GitHub from outside
      // (raw git, web UI, another tool). Pull-side must handle them.
      const before = `Notes/[draft]_topic#sec^block.md`;
      const after = sanitizeFilename(before);
      expect(after).toBe(`Notes/［draft］_topic＃sec＾block.md`);
      expect(needsSanitization(after)).toBe(false);
    });

    it("does NOT touch `/` (path separator stays intact)", () => {
      // Critical safety: `/` must NEVER be sanitized — it's the path
      // separator. Sanitizing it would collapse a multi-folder path
      // into a single basename and break every downstream
      // path-resolution call. The sanitizer operates on the FULL path
      // string but treats `/` as structural, not as a forbidden char.
      const deep = "a/b/c/d/note.md";
      expect(sanitizeFilename(deep)).toBe(deep);
      expect(needsSanitization(deep)).toBe(false);
    });

    it("each forbidden char round-trips through its replacement individually", () => {
      // The mapping must be 1:1 per character — no two forbidden chars
      // produce the same replacement, which would otherwise create
      // ambiguous collision risks during cross-device migration.
      const seen = new Set<string>();
      for (const [bad, good] of Object.entries(FORBIDDEN_TO_CANONICAL)) {
        expect(sanitizeFilename(`prefix${bad}suffix.md`)).toBe(
          `prefix${good}suffix.md`,
        );
        expect(seen.has(good)).toBe(false);
        seen.add(good);
      }
    });

    it("is idempotent — sanitizing a sanitized path yields itself", () => {
      // Critical for sync-loop safety: a pull that writes a canonical
      // path locally and a subsequent push that re-sanitizes that same
      // path must not introduce new mutations.
      const dirty = `Notes/"a" <b> c:d|e?f*g\\h.md`;
      const once = sanitizeFilename(dirty);
      const twice = sanitizeFilename(once);
      expect(twice).toBe(once);
    });

    it("handles multiple instances of the same forbidden char", () => {
      // Mirrors the actual field-bug path which has multiple ASCII quotes.
      // All instances must convert; nothing dropped or merged.
      const before = `"a"-"b"-"c".md`;
      const after = sanitizeFilename(before);
      expect(after).toBe(`“a“-“b“-“c“.md`);
      // Count of replacement char equals count of forbidden char (6 each).
      expect((after.match(/“/g) ?? []).length).toBe(6);
      expect((before.match(/"/g) ?? []).length).toBe(6);
    });

    it("preserves an empty path", () => {
      expect(sanitizeFilename("")).toBe("");
    });

    it("preserves Unicode characters in the input", () => {
      // Cyrillic, CJK, emoji, etc. must not be mangled — only the
      // forbidden ASCII set is touched.
      const before = `замітка_📝_中文_<v1>.md`;
      const after = sanitizeFilename(before);
      expect(after).toBe(`замітка_📝_中文_＜v1＞.md`);
    });
  });
});

describe("cross-platform — safeRename", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "safe-rename-"));
    vault = new Vault(tmp);
    setMockPlatform("desktop");
  });

  afterEach(() => {
    setMockPlatform("desktop");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("renames when destination does not exist (both platforms)", async () => {
    await vault.adapter.write("src.txt", "payload");
    await safeRename(
      vault.adapter as unknown as import("obsidian").DataAdapter,
      "src.txt",
      "dst.txt",
    );
    expect(await vault.adapter.exists("src.txt")).toBe(false);
    expect(await vault.adapter.read("dst.txt")).toBe("payload");
  });

  it("on desktop: overwrites the existing destination (POSIX semantics)", async () => {
    // Desktop adapter.rename is itself overwriting; safeRename just
    // mirrors that so behavior stays uniform across platforms.
    await vault.adapter.write("src.txt", "new");
    await vault.adapter.write("dst.txt", "old");
    await safeRename(
      vault.adapter as unknown as import("obsidian").DataAdapter,
      "src.txt",
      "dst.txt",
    );
    expect(await vault.adapter.exists("src.txt")).toBe(false);
    expect(await vault.adapter.read("dst.txt")).toBe("new");
  });

  it("on mobile: removes the existing destination first (Capacitor semantics)", async () => {
    // The whole point of safeRename — Capacitor adapter.rename
    // would throw "Destination file already exists" on the second
    // step. safeRename inserts the remove() between exists() check
    // and rename() so the rename's destination is always free.
    await vault.adapter.write("src.txt", "new");
    await vault.adapter.write("dst.txt", "old");
    setMockPlatform("mobile");
    await safeRename(
      vault.adapter as unknown as import("obsidian").DataAdapter,
      "src.txt",
      "dst.txt",
    );
    expect(await vault.adapter.exists("src.txt")).toBe(false);
    expect(await vault.adapter.read("dst.txt")).toBe("new");
  });

  it("on mobile: succeeds when destination doesn't exist (the common case)", async () => {
    await vault.adapter.write("src.txt", "data");
    setMockPlatform("mobile");
    await safeRename(
      vault.adapter as unknown as import("obsidian").DataAdapter,
      "src.txt",
      "dst.txt",
    );
    expect(await vault.adapter.read("dst.txt")).toBe("data");
  });
});

// Owner, 2026-10-10: a sanitized name that is already TAKEN is not a reason
// to skip the file (it would then go to the server under the forbidden
// name, or never). Take the first free " (N)" name, N from 2; a name that
// already ends in " (N)" before its extension continues from N+1.
describe("freeNameFor", () => {
  const taken = (...names: string[]) => (p: string) => names.includes(p);

  it("🔑 free → the name itself", async () => {
    expect(await freeNameFor("notes/a꞉b.md", taken())).toBe("notes/a꞉b.md");
  });
  it("🔑 taken → \" (2)\" before the extension, then (3), (4)…", async () => {
    expect(await freeNameFor("notes/file.md", taken("notes/file.md"))).toBe("notes/file (2).md");
    expect(await freeNameFor("notes/file.md", taken("notes/file.md", "notes/file (2).md"))).toBe("notes/file (3).md");
  });
  it("🔑 a name that already ends in \" (N)\" continues from N+1", async () => {
    expect(await freeNameFor("notes/file (2).md", taken("notes/file (2).md"))).toBe("notes/file (3).md");
  });
  it("no extension; a dot only in a folder name", async () => {
    expect(await freeNameFor("notes/README", taken("notes/README"))).toBe("notes/README (2)");
    expect(await freeNameFor("a.b/file", taken("a.b/file"))).toBe("a.b/file (2)");
  });
});
