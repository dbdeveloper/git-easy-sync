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
import { Vault } from "../../mock-obsidian";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import {
  atomicWriteFile,
  AtomicWriteRecovery,
  SYNC_TMP_SUFFIX,
  SYNC_BAK_SUFFIX,
  SYNC_MOD_MARKER_SUFFIX,
  stagingPathFor,
  modifyMarkerPathFor,
  parseModifyMarkerPath,
} from "../../src/sync2/atomic-write";
import { calculateGitBlobSHA } from "../../src/utils";

// Atomic-write protocol covered here:
//
//   atomicWriteFile(vault, path, bytes, afterCommit?)
//
// Sequence:
//   1. writeBinary(<path>.ges-tmp, bytes)
//   2. if exists(<path>): rename(<path>, <path>.ges-bak)
//   3. rename(<path>.ges-tmp, <path>)
//   4. afterCommit()  ← snapshot.recordSync, typically
//   5. remove(<path>.ges-bak)
//
// Crash-recovery sweep (post-Stage-13, suffix semantics corrected):
//   *.ges-tmp:                           dispatch by ownership via
//                                         ConflictStore.getBySibling
//     no record (Path A transient)        → delete (junk)
//     record + finalPath exists           → delete (Step 3 done, stale)
//     record + finalPath missing, SHA ok  → rename .ges-tmp → finalPath
//     record + finalPath missing, SHA bad → delete (record drops later)
//   *.ges-bak (Path A only, no dispatch):
//     no <file>                           → restore from .ges-bak
//     <file> + SHA == baselineSha         → delete .ges-bak [cleanup race]
//     <file> + SHA mismatch               → restore from .ges-bak
//     <file>, no snapshot entry           → restore from .ges-bak (conservative)

function fixture(): {
  root: string;
  vault: Vault;
  store: FileBaselinesStore;
  cleanup: () => void;
} {
  const root = path.join(
    os.tmpdir(),
    `atomic-write-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const store = new FileBaselinesStore({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: "git-easy-sync",
  });
  return {
    root,
    vault,
    store,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function readText(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

async function shaOf(text: string): Promise<string> {
  return await calculateGitBlobSHA(bytesOf(text));
}

describe("atomicWriteFile", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it("brand-new file: writes bytes; .ges-tmp and .ges-bak are gone afterwards", async () => {
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "Notes/note.md",
      bytesOf("hello\n"),
    );
    expect(readText(f.root, "Notes/note.md")).toBe("hello\n");
    expect(fs.existsSync(path.join(f.root, "Notes/note.ges-tmp.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "Notes/note.ges-bak.md"))).toBe(false);
  });

  it("existing file: replaces content; old version backed up then cleaned", async () => {
    fs.writeFileSync(path.join(f.root, "x.md"), "v1\n");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v2\n"),
    );
    expect(readText(f.root, "x.md")).toBe("v2\n");
    expect(fs.existsSync(path.join(f.root, "x.ges-tmp.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("afterCommit runs after the file is in place but before backup cleanup", async () => {
    // Strict invariant: at the time afterCommit fires, the install
    // is committed AND .ges-bak still exists. The cleanup is what
    // races against the user-perspective "we're done"; afterCommit
    // sees the canonical post-install state.
    fs.writeFileSync(path.join(f.root, "x.md"), "v1");
    const observed: Array<{
      fileContent: string;
      bakExists: boolean;
    }> = [];
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v2"),
      async () => {
        observed.push({
          fileContent: readText(f.root, "x.md"),
          bakExists: fs.existsSync(path.join(f.root, "x.ges-bak.md")),
        });
      },
    );
    expect(observed).toEqual([{ fileContent: "v2", bakExists: true }]);
    // Post-afterCommit: cleanup ran.
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("stale .ges-bak from a previous crash is overwritten by the rename-aside step", async () => {
    // Setup: file exists at canonical path AND a leftover .ges-bak
    // from a previous crash sits next to it. atomicWriteFile must
    // not throw on the rename(file → bak) collision.
    fs.writeFileSync(path.join(f.root, "x.md"), "current");
    fs.writeFileSync(path.join(f.root, "x.ges-bak.md"), "leftover");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("v3"),
    );
    expect(readText(f.root, "x.md")).toBe("v3");
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("stale .ges-tmp from a previous crash is silently overwritten", async () => {
    fs.writeFileSync(path.join(f.root, "x.ges-tmp.md"), "old partial");
    await atomicWriteFile(
      f.vault as unknown as import("obsidian").Vault,
      "x.md",
      bytesOf("fresh"),
    );
    expect(readText(f.root, "x.md")).toBe("fresh");
    expect(fs.existsSync(path.join(f.root, "x.ges-tmp.md"))).toBe(false);
  });
});

describe("AtomicWriteRecovery.sweep", () => {
  let f: ReturnType<typeof fixture>;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
  });

  it("orphan .ges-tmp without ConflictStore in scope: dropped (Path A transient)", async () => {
    fs.writeFileSync(path.join(f.root, "x.ges-tmp.md"), "partial");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(fs.existsSync(path.join(f.root, "x.ges-tmp.md"))).toBe(false);
  });

  it("only .ges-bak (no original): restored to canonical path", async () => {
    // Crash between step 2 (rename → bak) and step 3 (rename tmp →
    // file): backup is the only intact copy.
    fs.writeFileSync(path.join(f.root, "x.ges-bak.md"), "previous");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("previous");
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("both .ges-bak AND original, file matches snapshot: backup is cleaned up", async () => {
    // Crash between step 4 (recordSync) and step 5 (cleanup .ges-bak):
    // the install is committed AND the snapshot is updated, but the
    // cleanup didn't run. Recovery detects the SHA match and drops
    // the backup.
    fs.writeFileSync(path.join(f.root, "x.md"), "v2");
    fs.writeFileSync(path.join(f.root, "x.ges-bak.md"), "v1");
    await f.store.set("x.md", {
      baselineSha: await shaOf("v2"),
      mtime: 0,
      size: 2,
    });
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(readText(f.root, "x.md")).toBe("v2");
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("both files exist, file mismatches snapshot: restore backup", async () => {
    // Crash between step 3 (rename tmp → file) and step 4
    // (recordSync): file is new bytes, snapshot still has OLD sha.
    // The mismatch tells us we can't trust the install — restore.
    fs.writeFileSync(path.join(f.root, "x.md"), "newPartialOrNotCommitted");
    fs.writeFileSync(path.join(f.root, "x.ges-bak.md"), "previous-good");
    await f.store.set("x.md", {
      baselineSha: await shaOf("previous-good"),
      mtime: 0,
      size: 13,
    });
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("previous-good");
    expect(fs.existsSync(path.join(f.root, "x.ges-bak.md"))).toBe(false);
  });

  it("both files exist, no snapshot entry: conservative restore", async () => {
    // We can't verify; backup is the trustable copy.
    fs.writeFileSync(path.join(f.root, "x.md"), "unverified");
    fs.writeFileSync(path.join(f.root, "x.ges-bak.md"), "known-good");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(readText(f.root, "x.md")).toBe("known-good");
  });

  it("recursive walk: finds artifacts deep in subfolders", async () => {
    // Real vaults have nested folders; sweep must reach them all.
    fs.mkdirSync(path.join(f.root, "Notes/Sub/Deep"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "Notes/Sub/Deep/a.ges-tmp.md"), "x");
    fs.writeFileSync(path.join(f.root, "Notes/Sub/b.ges-bak.md"), "y");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1); // a.ges-tmp.md
    expect(result.restored).toBe(1); // b.ges-bak.md → b.md
    expect(
      fs.existsSync(path.join(f.root, "Notes/Sub/Deep/a.ges-tmp.md")),
    ).toBe(false);
    expect(readText(f.root, "Notes/Sub/b.md")).toBe("y");
  });

  it("no artifacts in vault: sweep is a no-op", async () => {
    fs.writeFileSync(path.join(f.root, "regular.md"), "no artifacts");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result).toEqual({ cleaned: 0, restored: 0, appliedPaths: [] });
  });

  it("modify-in-place forward-complete reports applied path (2.0.2-beta2)", async () => {
    // The marker + .ges-tmp pair from Path C (modify-in-place
    // strategy) gets forward-completed: rename ges-tmp over target,
    // remove marker. Surface the target path in appliedPaths so the
    // caller can trigger reloadPlugin(id) when the target is under
    // configDir/plugins/<id>/.
    fs.writeFileSync(path.join(f.root, "x.md"), "old-bytes");
    fs.writeFileSync(path.join(f.root, "x.ges-tmp.md"), "new-bytes");
    fs.writeFileSync(path.join(f.root, ".x.md.ges-tmp."), "");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(0);
    expect(result.restored).toBe(1);
    expect(result.appliedPaths).toEqual(["x.md"]);
    expect(readText(f.root, "x.md")).toBe("new-bytes");
    expect(fs.existsSync(path.join(f.root, "x.ges-tmp.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, ".x.md.ges-tmp."))).toBe(false);
  });

  it("modify-in-place marker without ges-tmp: cleaned only, no applied path (2.0.2-beta2)", async () => {
    // Marker without tmp = the modify completed and the cleanup
    // crashed mid-way. No new bytes appear; just remove the marker.
    // appliedPaths stays empty.
    fs.writeFileSync(path.join(f.root, "x.md"), "old-bytes");
    fs.writeFileSync(path.join(f.root, ".x.md.ges-tmp."), "");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.cleaned).toBe(1);
    expect(result.restored).toBe(0);
    expect(result.appliedPaths).toEqual([]);
    expect(fs.existsSync(path.join(f.root, ".x.md.ges-tmp."))).toBe(false);
  });

  it("ges-bak rollback: NOT reported in appliedPaths (rollback is not 'new bytes')", async () => {
    // Crash between rename(live → bak) and rename(tmp → live):
    // sweep restores bak → live. This is ROLLBACK to old bytes —
    // any running plugin already matches. Don't surface in
    // appliedPaths.
    fs.writeFileSync(path.join(f.root, "y.ges-bak.md"), "old-bytes");
    const recovery = new AtomicWriteRecovery(
      f.vault as unknown as import("obsidian").Vault,
      f.store,
    );
    const result = await recovery.sweep();
    expect(result.restored).toBe(1);
    expect(result.appliedPaths).toEqual([]);
    expect(readText(f.root, "y.md")).toBe("old-bytes");
  });

  it("constants exported: SYNC_TMP_SUFFIX / SYNC_BAK_SUFFIX match the file suffixes", () => {
    // Pin the suffix shape so callers (gitignore-invariants etc.)
    // can reference the same constants without drift.
    expect(SYNC_TMP_SUFFIX).toBe(".ges-tmp");
    expect(SYNC_BAK_SUFFIX).toBe(".ges-bak");
  });
});

// ─── stagingPathFor — pre-suffix insertion algorithm ──────────────────
//
// See docs/PSEUDO-MERGE-MODE.md §9.2 for the naming convention.
describe("stagingPathFor", () => {
  it("normal file → inserts .ges-bak before the extension", () => {
    expect(stagingPathFor("Folder/note.md")).toBe("Folder/note.ges-bak.md");
    expect(stagingPathFor("Plugins/foo/manifest.json")).toBe(
      "Plugins/foo/manifest.ges-bak.json",
    );
    expect(stagingPathFor("Folder/image.png")).toBe(
      "Folder/image.ges-bak.png",
    );
  });

  it("hidden file with no extension → appends .ges-bak (no insertion)", () => {
    expect(stagingPathFor(".gitignore")).toBe(".gitignore.ges-bak");
    expect(stagingPathFor(".obsidian/.gitignore")).toBe(
      ".obsidian/.gitignore.ges-bak",
    );
    expect(stagingPathFor(".editorconfig")).toBe(".editorconfig.ges-bak");
  });

  it("extensionless file → appends .ges-bak (no insertion)", () => {
    expect(stagingPathFor("README")).toBe("README.ges-bak");
    expect(stagingPathFor("Folder/Makefile")).toBe("Folder/Makefile.ges-bak");
  });

  it("file with multiple dots in name → insertion uses LAST extension", () => {
    expect(stagingPathFor("Folder/file.tar.gz")).toBe(
      "Folder/file.tar.ges-bak.gz",
    );
    // Conflict-from sibling shape from ConflictStore.create; this is
    // the path shape that ConflictStore calls stagingPathFor with.
    expect(
      stagingPathFor("Folder/note.conflict-from-Phone-2026-05-22T15-30-00Z.md"),
    ).toBe(
      "Folder/note.conflict-from-Phone-2026-05-22T15-30-00Z.ges-bak.md",
    );
  });

  it("`which='tmp'` variant uses .ges-tmp pre-suffix", () => {
    expect(stagingPathFor("Folder/note.md", "tmp")).toBe(
      "Folder/note.ges-tmp.md",
    );
    expect(stagingPathFor(".gitignore", "tmp")).toBe(".gitignore.ges-tmp");
  });
});

// (The "AtomicWriteRecovery SHA-verify (ConflictStore-owned
// siblings)" describe died at THE SWITCH: the v1 write pattern it
// recovered no longer exists — v2 sibling writes go through the
// standard atomicWriteFile, and an interrupted STEP3 replace is
// sibling-tx recovery's job. Every unmarked .ges-tmp is a Path A
// transient now; that behavior is pinned in the sweep suite above.)

// ───────────────────────────────────────────────────────────────────

describe("modifyMarkerPathFor + parseModifyMarkerPath", () => {
  it("round-trips a regular path: notes/folder/note.md", () => {
    const target = "notes/folder/note.md";
    const marker = modifyMarkerPathFor(target);
    expect(marker).toBe("notes/folder/.note.md.ges-tmp.");
    expect(parseModifyMarkerPath(marker)).toBe(target);
  });

  it("round-trips a root-level path: note.md", () => {
    const marker = modifyMarkerPathFor("note.md");
    expect(marker).toBe(".note.md.ges-tmp.");
    expect(parseModifyMarkerPath(marker)).toBe("note.md");
  });

  it("round-trips a hidden file: .obsidian/.gitignore", () => {
    const target = ".obsidian/.gitignore";
    const marker = modifyMarkerPathFor(target);
    // Two leading dots: one we always add + one from the target name.
    expect(marker).toBe(".obsidian/..gitignore.ges-tmp.");
    expect(parseModifyMarkerPath(marker)).toBe(target);
  });

  it("parseModifyMarkerPath returns null for a regular file", () => {
    expect(parseModifyMarkerPath("notes/note.md")).toBeNull();
  });

  it("parseModifyMarkerPath returns null for a staging file shape", () => {
    // .eslintrc.json.ges-tmp ends in .ges-tmp with NO trailing
    // dot — it's an existing staging file for the hidden config
    // file `.eslintrc.json`. parseModifyMarkerPath must reject
    // it so the existing parseStagingPath stays authoritative for
    // that shape.
    expect(parseModifyMarkerPath(".eslintrc.json.ges-tmp")).toBeNull();
  });

  it("parseModifyMarkerPath returns null when basename lacks the leading dot", () => {
    // A file that ends in `.ges-tmp.` but doesn't start with `.`
    // is not a marker (it's some user file that happens to have
    // the suffix). The leading dot is essential.
    expect(parseModifyMarkerPath("notes/note.md.ges-tmp.")).toBeNull();
  });

  it("uses the exported suffix constant", () => {
    expect(SYNC_MOD_MARKER_SUFFIX).toBe(".ges-tmp.");
  });
});

describe("AtomicWriteRecovery — modify-in-place markers (forward-recovery)", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    f.cleanup();
  });

  it(
    "marker + ges-tmp present + target present (partial) → " +
      "rename ges-tmp over target (forward-complete)",
    async () => {
      // Simulates: modifyBinary crashed mid-write, leaving the
      // target with partial bytes. The ges-tmp has the intended
      // final state — recovery renames it over the target.
      const targetPath = "Notes/n.md";
      const newBytes = bytesOf("new content from upstream");
      const partialBytes = bytesOf("new "); // simulate truncated write
      fs.mkdirSync(path.join(f.root, "Notes"));
      fs.writeFileSync(
        path.join(f.root, targetPath),
        Buffer.from(partialBytes),
      );
      const tmpPath = stagingPathFor(targetPath, "tmp");
      fs.writeFileSync(path.join(f.root, tmpPath), Buffer.from(newBytes));
      const markerPath = modifyMarkerPathFor(targetPath);
      fs.writeFileSync(path.join(f.root, markerPath), "");

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(restored).toBe(1);
      expect(cleaned).toBe(0);
      expect(fs.existsSync(path.join(f.root, markerPath))).toBe(false);
      expect(fs.existsSync(path.join(f.root, tmpPath))).toBe(false);
      // Target now has the intended new content.
      expect(readText(f.root, targetPath)).toBe("new content from upstream");
    },
  );

  it(
    "marker + ges-tmp present + target already has new bytes → " +
      "rename overwrites (idempotent forward-complete)",
    async () => {
      // Simulates: modifyBinary + afterCommit completed but the
      // marker / ges-tmp cleanup crashed. Recovery still renames;
      // the result is byte-identical because ges-tmp has the same
      // bytes as the live file.
      const targetPath = "Notes/n.md";
      const newBytes = bytesOf("new content");
      fs.mkdirSync(path.join(f.root, "Notes"));
      fs.writeFileSync(path.join(f.root, targetPath), Buffer.from(newBytes));
      const tmpPath = stagingPathFor(targetPath, "tmp");
      fs.writeFileSync(path.join(f.root, tmpPath), Buffer.from(newBytes));
      const markerPath = modifyMarkerPathFor(targetPath);
      fs.writeFileSync(path.join(f.root, markerPath), "");

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(restored).toBe(1);
      expect(cleaned).toBe(0);
      expect(fs.existsSync(path.join(f.root, markerPath))).toBe(false);
      expect(fs.existsSync(path.join(f.root, tmpPath))).toBe(false);
      expect(readText(f.root, targetPath)).toBe("new content");
    },
  );

  it(
    "marker + ges-tmp present + target missing → " +
      "rename creates target from ges-tmp",
    async () => {
      const targetPath = "Notes/n.md";
      const newBytes = bytesOf("recovered");
      fs.mkdirSync(path.join(f.root, "Notes"));
      // No live target file.
      const tmpPath = stagingPathFor(targetPath, "tmp");
      fs.writeFileSync(path.join(f.root, tmpPath), Buffer.from(newBytes));
      const markerPath = modifyMarkerPathFor(targetPath);
      fs.writeFileSync(path.join(f.root, markerPath), "");

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(restored).toBe(1);
      expect(cleaned).toBe(0);
      expect(fs.existsSync(path.join(f.root, markerPath))).toBe(false);
      expect(fs.existsSync(path.join(f.root, tmpPath))).toBe(false);
      expect(readText(f.root, targetPath)).toBe("recovered");
    },
  );

  it(
    "marker present + ges-tmp missing → " +
      "defensive cleanup of the marker (nothing to land)",
    async () => {
      const targetPath = "Notes/n.md";
      const existingBytes = bytesOf("untouched");
      fs.mkdirSync(path.join(f.root, "Notes"));
      fs.writeFileSync(
        path.join(f.root, targetPath),
        Buffer.from(existingBytes),
      );
      const markerPath = modifyMarkerPathFor(targetPath);
      fs.writeFileSync(path.join(f.root, markerPath), "");
      // No ges-tmp.

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(cleaned).toBe(1);
      expect(restored).toBe(0);
      expect(fs.existsSync(path.join(f.root, markerPath))).toBe(false);
      // Target untouched — we had nothing to land.
      expect(readText(f.root, targetPath)).toBe("untouched");
    },
  );

  it(
    "ges-tmp present + NO marker → " +
      "existing Path A logic drops it as transient",
    async () => {
      // Mirror of "modify aborted before marker was created". The
      // existing Path A branch handles it — no double-handling.
      const targetPath = "Notes/n.md";
      const someBytes = bytesOf("transient");
      fs.mkdirSync(path.join(f.root, "Notes"));
      const tmpPath = stagingPathFor(targetPath, "tmp");
      fs.writeFileSync(path.join(f.root, tmpPath), Buffer.from(someBytes));
      // No marker, no target.

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(cleaned).toBe(1);
      expect(restored).toBe(0);
      expect(fs.existsSync(path.join(f.root, tmpPath))).toBe(false);
      expect(fs.existsSync(path.join(f.root, targetPath))).toBe(false);
    },
  );

  it(
    "marker for a hidden file (.gitignore) round-trips correctly",
    async () => {
      // Verifies that hidden-file paths (which carry an extra leading
      // dot in the basename) still parse correctly through the
      // sweep walk and produce the right rename target.
      const targetPath = "Notes/.gitignore";
      const newBytes = bytesOf("ignored\n");
      fs.mkdirSync(path.join(f.root, "Notes"));
      const tmpPath = stagingPathFor(targetPath, "tmp");
      fs.writeFileSync(path.join(f.root, tmpPath), Buffer.from(newBytes));
      const markerPath = modifyMarkerPathFor(targetPath);
      expect(markerPath).toBe("Notes/..gitignore.ges-tmp.");
      fs.writeFileSync(path.join(f.root, markerPath), "");

      const sweep = new AtomicWriteRecovery(
        f.vault as unknown as import("obsidian").Vault,
        f.store,
      );
      const { cleaned, restored } = await sweep.sweep();

      expect(restored).toBe(1);
      expect(cleaned).toBe(0);
      expect(fs.existsSync(path.join(f.root, markerPath))).toBe(false);
      expect(fs.existsSync(path.join(f.root, tmpPath))).toBe(false);
      expect(readText(f.root, targetPath)).toBe("ignored\n");
    },
  );
});
