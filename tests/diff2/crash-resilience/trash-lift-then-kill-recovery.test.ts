import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../../mock-obsidian";
import { TrashStore } from "../../../src/diff2/trash-store";
import { sweepOnload } from "../../../src/diff2/trash-recovery";

// R8.1 — Obsidian killed while a compare session was active. The
// trash record's meta.json holds liftedAsSessionId pointing at a
// session that no longer exists (UI vanished with the process).
//
// Recovery semantic (Case B): clear the field; the file under vault/
// is untouched (metadata-only protocol of R3.7).

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `lift-then-kill-${crypto.randomBytes(4).toString("hex")}`,
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

describe("crash: Obsidian killed during compare-lift session", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.trashStore.init();
  });

  afterEach(() => {
    cleanup(fx.root);
  });

  it("intercept → lift → kill → sweepOnload clears the marker, file preserved", async () => {
    // Set up a live trash record via intercept.
    fs.writeFileSync(path.join(fx.root, "note.md"), "important content");
    const recBefore = await fx.trashStore.intercept("note.md");

    // User opens compare → lift marks the record.
    const lift = await fx.trashStore.liftForCompare(recBefore.id);
    expect(lift.record.liftedAsSessionId).toBe(lift.sessionId);

    // Obsidian killed: the in-memory store dies but the marker
    // survives on disk in meta.json. Simulate this by spinning up a
    // FRESH TrashStore against the same dir and running sweep.
    const freshVault = new Vault(fx.root);
    const freshStore = new TrashStore({
      vault: freshVault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
    });
    await freshStore.init();

    // Confirm the pre-sweep state matches the kill scenario.
    const preSweep = JSON.parse(
      fs.readFileSync(
        path.join(fx.root, fx.trashRoot, recBefore.id, "meta.json"),
        "utf8",
      ),
    );
    expect(preSweep.liftedAsSessionId).toBe(lift.sessionId);

    await sweepOnload({
      vault: freshVault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      trashStore: freshStore,
    });

    // Marker cleared on disk.
    const postSweep = JSON.parse(
      fs.readFileSync(
        path.join(fx.root, fx.trashRoot, recBefore.id, "meta.json"),
        "utf8",
      ),
    );
    expect(postSweep.liftedAsSessionId).toBeUndefined();

    // Vault file inside trash untouched.
    const trashVaultFile = path.join(
      fx.root,
      fx.trashRoot,
      recBefore.id,
      "vault",
      "note.md",
    );
    expect(fs.readFileSync(trashVaultFile, "utf8")).toBe("important content");

    // Record now eligible for layer-2 cleanup (no more shield).
    await freshStore.sweepOlderThan("99990101000000000");
    expect(await freshStore.list()).toEqual([]);
  });

  it("multiple lifted records all cleared in one sweep", async () => {
    fs.writeFileSync(path.join(fx.root, "a.md"), "A");
    fs.writeFileSync(path.join(fx.root, "b.md"), "B");
    fs.writeFileSync(path.join(fx.root, "c.md"), "C");

    const ra = await fx.trashStore.intercept("a.md");
    const rb = await fx.trashStore.intercept("b.md");
    const rc = await fx.trashStore.intercept("c.md");

    await fx.trashStore.liftForCompare(ra.id);
    await fx.trashStore.liftForCompare(rb.id);
    // rc stays unlifted

    // Spin up fresh store (simulates restart).
    const freshVault = new Vault(fx.root);
    const freshStore = new TrashStore({
      vault: freshVault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
    });
    await freshStore.init();

    await sweepOnload({
      vault: freshVault as never,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      trashStore: freshStore,
    });

    const allRecords = await freshStore.list();
    expect(allRecords).toHaveLength(3);
    expect(allRecords.every((r) => r.liftedAsSessionId === undefined)).toBe(true);
  });
});
