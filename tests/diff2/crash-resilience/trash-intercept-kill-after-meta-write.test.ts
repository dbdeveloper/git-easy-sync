import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../../mock-obsidian";
import { TrashStore } from "../../../src/diff2/trash-store";
import { sweepOnload } from "../../../src/diff2/trash-recovery";
import type { TrashRecord } from "../../../src/diff2/types";

// R8.1 — intercept kill AFTER meta.json was written but BEFORE the
// originating vault.delete (monkey-patch wrapper) reached its
// `await originalDelete(file)` step. The trash bundle is complete
// (meta.json + bytes), but the vault still has the original file
// because the delete never ran.
//
// Recovery semantic: no-op. The bundle is valid per case-C check
// (vault file inside the bundle is present), so sweepOnload doesn't
// touch it. The duplicated state (file in both vault AND .trash) sits
// until the next drain's layer-2 sweep claims the trash entry. User
// sees the file in vault (their delete didn't visibly complete) and
// can re-delete; the next sync confirms.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `kill-after-meta-write-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const trashStore = new TrashStore({
    vault: vault as never,
    configDir: CONFIG_DIR,
    selfPluginId: SELF_PLUGIN_ID,
    now: () => new Date(Date.UTC(2026, 4, 26, 10, 30, 0, 0)),
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
    },
  };
}

function cleanup(root: string) {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function fullRecord(id: string, originalPath: string): TrashRecord {
  return {
    id,
    originalPath,
    originalDeletedAt: new Date(Date.UTC(2026, 4, 26, 9, 0, 0)).toISOString(),
    sha: "deadbeef",
    size: 13,
    mtime: 0,
  };
}

describe("crash: intercept kill after meta-write, before original delete", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("post-crash + sweepOnload: bundle and vault file both intact", async () => {
    // Trash bundle: meta.json present, vault file copy present.
    const rec = fullRecord("20260526100000000", "note.md");
    const trashDir = path.join(fx.root, fx.trashRoot, rec.id);
    const trashVault = path.join(trashDir, "vault");
    fs.mkdirSync(trashVault, { recursive: true });
    fs.writeFileSync(path.join(trashVault, "note.md"), "duplicated");
    fs.writeFileSync(path.join(trashDir, "meta.json"), JSON.stringify(rec));
    // Original vault file STILL present (delete never ran).
    fs.writeFileSync(path.join(fx.root, "note.md"), "duplicated");

    let fired = 0;
    fx.trashStore.subscribe(() => { fired++; });

    await sweepOnload(fx.deps);

    // sweepOnload sees a valid bundle in canonical post-intercept
    // state — no recovery action. Bundle and vault file both still
    // present. anyChange stayed false → no notify.
    expect(fired).toBe(0);
    expect(fs.existsSync(path.join(fx.root, "note.md"))).toBe(true);
    expect(fs.existsSync(trashDir)).toBe(true);

    // TrashStore.list() reports the entry as healthy.
    const records = await fx.trashStore.list();
    expect(records.map((r) => r.id)).toEqual(["20260526100000000"]);
  });

  it("duplicate state is resolved by next layer-2 sweep, vault untouched", async () => {
    const rec = fullRecord("20260526100000000", "note.md");
    const trashDir = path.join(fx.root, fx.trashRoot, rec.id);
    const trashVault = path.join(trashDir, "vault");
    fs.mkdirSync(trashVault, { recursive: true });
    fs.writeFileSync(path.join(trashVault, "note.md"), "x");
    fs.writeFileSync(path.join(trashDir, "meta.json"), JSON.stringify(rec));
    fs.writeFileSync(path.join(fx.root, "note.md"), "x");

    await sweepOnload(fx.deps);
    // Simulate the next drain's layer-2 backstop.
    await fx.trashStore.sweepOlderThan("99990101000000000");

    // Trash entry gone; vault file still there.
    expect(await fx.trashStore.list()).toEqual([]);
    expect(fs.readFileSync(path.join(fx.root, "note.md"), "utf8")).toBe("x");
  });
});
