import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../../mock-obsidian";
import { TrashStore } from "../../../src/diff2/trash-store";
import { sweepOnload } from "../../../src/diff2/trash-recovery";
import type { TrashRecord } from "../../../src/diff2/types";

// R8.1 — kill during the atomic-write of lift's meta.json. The
// canonical meta.json is intact (no torn JSON); meta.json.tmp was
// written but the safeRename hadn't run yet. From the on-disk state,
// the marker was NEVER recorded — the record looks "not lifted".
//
// Recovery semantic: sweepOnload cleans the orphan .tmp, leaves the
// canonical meta intact, and the record is in normal (not-lifted)
// state on next access.

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "github-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `lift-kill-mid-meta-${crypto.randomBytes(4).toString("hex")}`,
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

function baseRecord(id: string, originalPath: string): TrashRecord {
  return {
    id,
    originalPath,
    originalDeletedAt: new Date(Date.UTC(2026, 4, 26, 9, 0, 0)).toISOString(),
    sha: "deadbeef",
    size: 4,
    mtime: 0,
  };
}

describe("crash: kill during lift's atomic meta-write", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("torn .tmp + intact canonical meta → tmp cleaned, marker absent", async () => {
    // Pre-seed a canonical, not-lifted record.
    const rec = baseRecord("20260526100000000", "note.md");
    const dir = path.join(fx.root, fx.trashRoot, rec.id);
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vault", "note.md"), "seed");
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(rec));
    // Crash signature: lift wrote tmp with the marker, then died before
    // safeRename moved it over the canonical meta.
    const tmpRec = { ...rec, liftedAsSessionId: "session-that-died" };
    fs.writeFileSync(path.join(dir, "meta.json.tmp"), JSON.stringify(tmpRec));

    await sweepOnload(fx.deps);

    // Tmp gone.
    expect(fs.existsSync(path.join(dir, "meta.json.tmp"))).toBe(false);
    // Canonical meta untouched.
    const canonical = JSON.parse(
      fs.readFileSync(path.join(dir, "meta.json"), "utf8"),
    );
    expect(canonical.liftedAsSessionId).toBeUndefined();
    expect(canonical.id).toBe(rec.id);

    // Record visible via TrashStore.list() as not-lifted; cleanup
    // hooks can now claim it normally.
    const records = await fx.trashStore.list();
    expect(records).toHaveLength(1);
    expect(records[0].liftedAsSessionId).toBeUndefined();
  });

  it("kill AFTER the safeRename (marker committed): equivalent to lift-then-kill", async () => {
    // Crash signature: safeRename completed → canonical meta has
    // marker; tmp is already gone. This is the lift-then-kill case
    // covered separately, but verify sweepOnload handles it here too.
    const rec = baseRecord("20260526100000000", "note.md");
    const dir = path.join(fx.root, fx.trashRoot, rec.id);
    fs.mkdirSync(path.join(dir, "vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vault", "note.md"), "seed");
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ ...rec, liftedAsSessionId: "stale" }),
    );

    await sweepOnload(fx.deps);

    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, "meta.json"), "utf8"),
    );
    expect(meta.liftedAsSessionId).toBeUndefined();
  });
});
