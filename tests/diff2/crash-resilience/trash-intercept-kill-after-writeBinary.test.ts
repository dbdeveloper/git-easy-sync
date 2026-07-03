import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../../mock-obsidian";
import { TrashStore } from "../../../src/diff2/trash-store";
import { sweepOnload } from "../../../src/diff2/trash-recovery";

// R8.1 — intercept kill after writeBinary, before atomicWriteJson.
//
// Simulated state on disk: bytes landed at
// .trash/<id>/vault/<originalPath>, but meta.json was never written
// (or was torn). On next plugin onload, sweepOnload sees this as a
// Case-A orphan and restores the file to vault root.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `kill-after-writeBinary-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const FIXED_NOW = new Date(Date.UTC(2026, 4, 26, 10, 30, 0, 0));
  const trashStore = new TrashStore({
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => FIXED_NOW,
  });
  const trashRoot = `${CONFIG_DIR}/plugins/${SELF_PLUGIN_ID}/.runtime/trash`;
  return {
    root,
    trashStore,
    trashRoot,
    deps: {
      vault: vault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      trashStore,
      now: () => FIXED_NOW,
    },
  };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

// Hand-craft the post-crash disk state: vault/<path> bytes are present,
// meta.json is NOT. Mirrors what would be on disk if intercept crashed
// between adapter.writeBinary(dstFile, ...) and atomicWriteJson(...).
function seedOrphanAfterWriteBinary(
  root: string,
  trashRoot: string,
  id: string,
  originalPath: string,
  content: string,
): void {
  const orphanDir = path.join(root, trashRoot, id);
  const vaultDir = path.join(orphanDir, "vault");
  const fileAbs = path.join(vaultDir, originalPath);
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  fs.writeFileSync(fileAbs, content);
  // Intentionally NO meta.json — that's the crash signature.
}

describe("crash: intercept kill after writeBinary", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("post-crash + sweepOnload: file restored to vault root, orphan wiped", async () => {
    seedOrphanAfterWriteBinary(
      fx.root,
      fx.trashRoot,
      "20260526100000000",
      "note.md",
      "crash-survived content",
    );

    await sweepOnload(fx.deps);

    // Restored at vault root, content preserved.
    const restored = path.join(fx.root, "note.md");
    expect(fs.existsSync(restored)).toBe(true);
    expect(fs.readFileSync(restored, "utf8")).toBe("crash-survived content");

    // Orphan dir wiped.
    expect(
      fs.existsSync(path.join(fx.root, fx.trashRoot, "20260526100000000")),
    ).toBe(false);

    // TrashStore queries see no record (orphan was unindexable
    // anyway — list() skips dirs without valid meta).
    expect(await fx.trashStore.list()).toEqual([]);
  });

  it("post-crash + sweepOnload x 2: second sweep is no-op", async () => {
    seedOrphanAfterWriteBinary(
      fx.root,
      fx.trashRoot,
      "20260526100000000",
      "note.md",
      "x",
    );

    await sweepOnload(fx.deps);
    // After first sweep, no orphan, file restored. Second sweep finds
    // an empty .trash/ and does nothing.
    let fired = 0;
    fx.trashStore.subscribe(() => { fired++; });
    await sweepOnload(fx.deps);
    expect(fired).toBe(0);

    expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe("x");
  });

  it("post-crash + vault path already occupied → collision-rename", async () => {
    seedOrphanAfterWriteBinary(
      fx.root,
      fx.trashRoot,
      "20260526100000000",
      "Folder/note.md",
      "orphan content",
    );
    // Between the crash and the next onload, the user recreated the
    // file (or another device synced it back) so vault now has it.
    fs.mkdirSync(path.join(fx.root, "Folder"), { recursive: true });
    fs.writeFileSync(
      path.join(fx.root, "Folder", "note.md"),
      "fresh content",
    );

    await sweepOnload(fx.deps);

    // Fresh content untouched.
    expect(
      fs.readFileSync(path.join(fx.root, "Folder", "note.md"), "utf8"),
    ).toBe("fresh content");
    // Orphan content recovered alongside under .recovered-<ts>.
    const recovered = path.join(
      fx.root,
      "Folder",
      "note.recovered-2026-05-26T10-30-00Z.md",
    );
    expect(fs.existsSync(recovered)).toBe(true);
    expect(fs.readFileSync(recovered, "utf8")).toBe("orphan content");
  });
});
