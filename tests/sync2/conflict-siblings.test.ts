import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import {
  buildSiblingFilePath,
  siblingGlobPattern,
  saveConflictSiblingFile,
  readSiblingFileFromVault,
  findConflictSiblingFilesInVault,
  formatTimestampForFilename,
  UNKNOWN_DEVICE_LABEL,
  MIGRATION_DEVICE_LABEL,
  deconflictDeviceLabel,
} from "../../src/sync2/conflict-siblings";
import { parseSiblingFilename } from "../../src/diff2/strip-conflict-suffix";
import { FORBIDDEN_TO_CANONICAL } from "../../src/sync2/cross-platform";

// Phase 2 sibling helpers (NEW-DRAIN §III допоміжні; §VIII C.7-family).
// The disk-name format is a pre-existing invariant — the strongest
// pin here is byte-equality with what conflict-store v1 produces
// today for the same inputs.

const PLUGIN_ID = "git-easy-sync";
const TS = Date.UTC(2026, 4, 8, 15, 30, 0); // 2026-05-08T15:30:00Z

const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer): string => new TextDecoder().decode(b);

describe("buildSiblingFilePath (pure)", () => {
  it("produces the canonical shape", () => {
    expect(buildSiblingFilePath("Notes/idea.md", TS, "Phone")).toBe(
      "Notes/idea.conflict-from-Phone-2026-05-08T15-30-00Z.md",
    );
  });

  it("format invariant (was: byte-parity with v1's buildSiblingPath, which died at THE SWITCH) — the literal shapes are pinned", () => {
    const expected: Record<string, string> = {
      "Notes/idea.md":
        "Notes/idea.conflict-from-My [Old] Phone-2026-05-08T15-30-00Z.md",
      "root.md": "root.conflict-from-My [Old] Phone-2026-05-08T15-30-00Z.md",
      README: "README.conflict-from-My [Old] Phone-2026-05-08T15-30-00Z",
      "a/b/c.tar.gz":
        "a/b/c.tar.conflict-from-My [Old] Phone-2026-05-08T15-30-00Z.gz",
      ".hidden": ".hidden.conflict-from-My [Old] Phone-2026-05-08T15-30-00Z",
    };
    for (const [p, want] of Object.entries(expected)) {
      expect(buildSiblingFilePath(p, TS, "My (Old) Phone")).toBe(want);
    }
  });

  it("sanitizes parens in the label; null label falls back to the sentinel", () => {
    expect(buildSiblingFilePath("a.md", TS, "Lap(top)")).toContain(
      "conflict-from-Lap[top]-",
    );
    expect(buildSiblingFilePath("a.md", TS, null)).toContain(
      `conflict-from-${UNKNOWN_DEVICE_LABEL}-`,
    );
  });

  it("no-extension and hidden-dotfile names keep their shape", () => {
    expect(buildSiblingFilePath("README", TS, "D")).toBe(
      "README.conflict-from-D-2026-05-08T15-30-00Z",
    );
    expect(buildSiblingFilePath(".gitignore", TS, "D")).toBe(
      ".gitignore.conflict-from-D-2026-05-08T15-30-00Z",
    );
  });

  it("timestamp format drops milliseconds and colons", () => {
    expect(formatTimestampForFilename(TS + 123)).toBe(
      "2026-05-08T15-30-00Z",
    );
  });
});

describe("siblingGlobPattern (pure)", () => {
  it("same template, any device/timestamp", () => {
    expect(siblingGlobPattern("Notes/idea.md")).toBe(
      "Notes/idea.conflict-from-*.md",
    );
    expect(siblingGlobPattern("README")).toBe("README.conflict-from-*");
  });
});

describe("sibling IO helpers", () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "conflict-siblings-test-"));
    vault = new Vault(dir);
    fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
    void PLUGIN_ID;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save → read round-trip via the same FileInfo triple; the disk name is derived, never stored", async () => {
    const info = {
      path: "Notes/idea.md", // BASE path — §III contract
      mtime: TS,
      deviceLabel: "Phone",
      blob: enc("theirs content\n"),
    };
    await saveConflictSiblingFile(vault as never, info);
    expect(
      fs.existsSync(
        path.join(
          dir,
          "Notes",
          "idea.conflict-from-Phone-2026-05-08T15-30-00Z.md",
        ),
      ),
    ).toBe(true);

    const bytes = await readSiblingFileFromVault(vault as never, info);
    expect(dec(bytes!)).toBe("theirs content\n");
  });

  it("read of a missing sibling → null (caller decides, STEP3-style)", async () => {
    expect(
      await readSiblingFileFromVault(vault as never, {
        path: "Notes/idea.md",
        mtime: TS,
        deviceLabel: "Ghost",
      }),
    ).toBeNull();
  });

  it("two siblings of one base differ only by mtime/label — the whole triple selects which to read", async () => {
    const a = {
      path: "Notes/idea.md",
      mtime: TS,
      deviceLabel: "Phone",
      blob: enc("A"),
    };
    const b = {
      path: "Notes/idea.md",
      mtime: TS + 60_000,
      deviceLabel: "Laptop",
      blob: enc("B"),
    };
    await saveConflictSiblingFile(vault as never, a);
    await saveConflictSiblingFile(vault as never, b);
    expect(dec((await readSiblingFileFromVault(vault as never, a))!)).toBe("A");
    expect(dec((await readSiblingFileFromVault(vault as never, b))!)).toBe("B");
  });

  describe("findConflictSiblingFilesInVault", () => {
    it("splits tracked-on-disk vs synthetic; synthetic carries the DISK path + eager sha/size/mtime", async () => {
      const base = "Notes/idea.md";
      fs.writeFileSync(path.join(dir, base), "base\n");
      const tracked = {
        path: base,
        mtime: TS,
        deviceLabel: "Phone",
        blob: enc("tracked sibling"),
      };
      const trackedGone = {
        path: base,
        mtime: TS + 1000,
        deviceLabel: "Tablet",
      };
      await saveConflictSiblingFile(vault as never, tracked);
      // A synthetic: right shape, but not in the tracked list.
      const synthName =
        "Notes/idea.conflict-from-Stranger-2026-05-09T10-00-00Z.md";
      fs.writeFileSync(path.join(dir, synthName), "synthetic content");

      const { trackedOnDisk, synthetic } =
        await findConflictSiblingFilesInVault(vault as never, base, [
          tracked,
          trackedGone,
        ]);

      // tracked present → in trackedOnDisk; deleted one → absent.
      expect(trackedOnDisk).toHaveLength(1);
      expect(trackedOnDisk[0]).toBe(tracked);

      expect(synthetic).toHaveLength(1);
      expect(synthetic[0].path).toBe(synthName); // disk path — the exception
      expect(typeof synthetic[0].sha).toBe("string");
      expect(synthetic[0].size).toBe("synthetic content".length);
      expect(typeof synthetic[0].mtime).toBe("number");
    });

    it("does not claim unrelated files, other bases' siblings, or wrong extensions", async () => {
      const base = "Notes/idea.md";
      fs.writeFileSync(path.join(dir, "Notes", "idea.md"), "x");
      fs.writeFileSync(
        path.join(
          dir,
          "Notes",
          "other.conflict-from-Phone-2026-05-08T15-30-00Z.md",
        ),
        "other base",
      );
      fs.writeFileSync(
        path.join(
          dir,
          "Notes",
          "idea.conflict-from-Phone-2026-05-08T15-30-00Z.txt",
        ),
        "wrong ext",
      );
      fs.writeFileSync(
        path.join(dir, "Notes", "idea.conflict-from-Phone-not-a-ts.md"),
        "bad timestamp",
      );

      const { trackedOnDisk, synthetic } =
        await findConflictSiblingFilesInVault(vault as never, base, []);
      expect(trackedOnDisk).toEqual([]);
      expect(synthetic).toEqual([]);
    });

    it("root-level base scans the vault root without crashing", async () => {
      fs.writeFileSync(
        path.join(dir, "root.conflict-from-D-2026-05-08T15-30-00Z.md"),
        "s",
      );
      const { synthetic } = await findConflictSiblingFilesInVault(
        vault as never,
        "root.md",
        [],
      );
      expect(synthetic).toHaveLength(1);
    });
  });
});

describe("the §8.1 migration label is reserved (DOT-FILES §8.1.5a)", () => {
  it("a device label equal to the reserved one is amended, not rejected", () => {
    // The gate refuses to sync while a migration proposal exists, and it
    // recognises one BY THIS LABEL. A real machine wearing it would emit
    // genuine siblings the gate reads as proposals — i.e. a vault that
    // can never sync again. Amending is gentler than refusing and needs
    // no error path in the settings field.
    expect(deconflictDeviceLabel(MIGRATION_DEVICE_LABEL)).not.toBe(
      MIGRATION_DEVICE_LABEL,
    );
    expect(deconflictDeviceLabel(MIGRATION_DEVICE_LABEL)).toContain(
      MIGRATION_DEVICE_LABEL,
    );
  });

  it("the amendment itself carries no ASCII `?`", () => {
    // ⚠️ This pin was RETARGETED once buildSiblingFilePath started
    // sanitising the label. It used to assert the produced FILENAME was
    // valid — which now passes for a second reason (a literal `?` would
    // be sanitised to ？), so it no longer pinned the choice it was
    // written for. Asserted on the amendment text instead: the glyph is
    // deliberate, and `？？` in a filename reads as mangled where ⁇ reads
    // as intended.
    expect(deconflictDeviceLabel(MIGRATION_DEVICE_LABEL)).not.toMatch(/\?/);
    const name = buildSiblingFilePath(
      ".gitignore",
      1_700_000_000_000,
      deconflictDeviceLabel(MIGRATION_DEVICE_LABEL),
    );
    // Still a parseable sibling, or the conflict would never appear.
    expect(parseSiblingFilename(name)?.basePath).toBe(".gitignore");
  });

  it("any other label passes through, and amending is idempotent", () => {
    // Without the pass-through half, "always append" would also satisfy
    // the first test. Exact match only: the gate compares exactly too,
    // so a different casing is already a different label.
    expect(deconflictDeviceLabel("Mac")).toBe("Mac");
    expect(deconflictDeviceLabel("old gitignore files")).toBe(
      "old gitignore files",
    );
    const once = deconflictDeviceLabel(MIGRATION_DEVICE_LABEL);
    expect(deconflictDeviceLabel(once)).toBe(once);
  });
});

describe("the device label is part of a FILENAME and is sanitised", () => {
  const nameFor = (label: string) =>
    buildSiblingFilePath("note.md", 1_700_000_000_000, label);

  it("🔑 every FORBIDDEN_TO_CANONICAL character is replaced, not passed through", () => {
    // The user can type anything into the Device-label field, and the
    // label goes straight into a filename. Raw `?`/`:`/`|`/`*` etc. fail
    // the write outright on Windows and Android; on macOS they succeed
    // and produce a file the other platforms cannot represent — a vault
    // that syncs on one machine and breaks on the next.
    for (const [forbidden, canonical] of Object.entries(
      FORBIDDEN_TO_CANONICAL,
    )) {
      const name = nameFor(`PC${forbidden}1`);
      expect(name, `label containing ${forbidden}`).toContain(canonical);
      expect(name, `label containing ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("🔑 …and the ORDER is preserved: parens still become brackets", () => {
    // The regression this fix could easily have caused, and the reason
    // sanitising runs BEFORE the paren rule. That rule PRODUCES `[`/`]`,
    // which are themselves in FORBIDDEN_TO_CANONICAL — sanitising after
    // it would yield `Mac ［work］` and change the derived name of every
    // sibling whose label has parens, orphaning files already on disk.
    expect(nameFor("Mac (work)")).toContain("Mac [work]");
    expect(nameFor("Mac (work)")).not.toContain("［");
  });

  it("a clean label is untouched, and the result still round-trips", () => {
    // Without the clean half, "replace everything" would pass the first
    // test too. The round-trip matters because a name that no longer
    // parses is a conflict that never appears in the panel.
    expect(nameFor("Mac")).toContain("conflict-from-Mac-");
    const parsed = parseSiblingFilename(nameFor("PC?1"));
    expect(parsed?.basePath).toBe("note.md");
    expect(parsed?.deviceLabel).toBe("PC？1");
  });

  it("the scan still recognises a sanitised sibling on disk", () => {
    // The label is derived, never stored — so write, read and scan must
    // agree on the SAME transformation or the engine would look for a
    // file it just wrote under a different name.
    const name = nameFor("PC|:*1");
    expect(name).toMatch(
      /^note\.conflict-from-.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/,
    );
  });
});
