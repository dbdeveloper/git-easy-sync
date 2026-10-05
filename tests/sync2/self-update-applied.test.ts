import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import HotMetadataStore from "../../src/sync2/hot-metadata";
import ChangeDetector from "../../src/sync2/change-detector";
import GI from "../../src/gi";
import { calculateGitBlobSHA } from "../../src/utils";
import { runSelfUpdateBootloader } from "../../src/sync2/plugin-update-bootloader";
import {
  SELF_UPDATE_APPLIED_MARKER,
  settleSelfUpdateBaselines,
} from "../../src/sync2/self-update-applied";

// FIELD FINDING 2026-10-05 (owner's ping-pong between two test vaults):
// after the bootloader applied a staged build of OUR plugin, the next
// commit read the freshly RECEIVED main.js as a LOCAL edit — the drain
// deliberately leaves the baseline old while the bytes are only staged
// (86c808e's downgrade trap), and nothing ever told the baseline that
// the stage had been applied. With a newer build already on the server
// that became a false plugin-core "collision" decided by the clock.
//
// The bootloader now records what it applied; the next onload, once the
// stores are open, writes the baseline for each recorded file whose live
// bytes still match — and only then.

const PLUGIN_ID = "git-easy-sync";
const CONFIG_DIR = ".obsidian";
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/${PLUGIN_ID}`;
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("a self-update the bootloader applied settles its baseline", () => {
  let dir: string;
  let vault: Vault;
  const abs = (rel: string) => path.join(dir, rel);
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), content);
  };
  const v = () => vault as unknown as import("obsidian").Vault;
  const baselines = () => new FileBaselinesStore({ vault: v(), selfPluginId: PLUGIN_ID });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "self-applied-"));
    fs.mkdirSync(abs(`${PLUGIN_DIR}/.runtime`), { recursive: true });
    vault = new Vault(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The world right after a drain staged a new build: the baseline says
  // OLD (what the drain left), the live file is OLD, the stage is NEW.
  const stagedWorld = async () => {
    put(`${PLUGIN_DIR}/main.js`, "OLD BUILD");
    put(`${PLUGIN_DIR}/main.ges-tmp.js`, "NEW BUILD");
    put(`${PLUGIN_DIR}/.main.js.ges-tmp.`, await calculateGitBlobSHA(enc("NEW BUILD")));
    const st = fs.statSync(abs(`${PLUGIN_DIR}/main.js`));
    await baselines().setMany([
      {
        path: `${PLUGIN_DIR}/main.js`,
        baselineSha: await calculateGitBlobSHA(enc("OLD BUILD")),
        mtime: Math.floor(st.mtimeMs),
        size: st.size,
      },
    ]);
  };
  const bootloader = () =>
    runSelfUpdateBootloader({
      adapter: vault.adapter as never,
      pluginDir: PLUGIN_DIR,
      computeSha: calculateGitBlobSHA,
      reloadPlugin: () => {},
      scheduleReload: () => {},
    });
  const settle = (b = baselines()) =>
    settleSelfUpdateBaselines({
      adapter: vault.adapter as never,
      pluginDir: PLUGIN_DIR,
      computeSha: calculateGitBlobSHA,
      baselines: b,
    });
  const detector = async (b: FileBaselinesStore) => {
    const hot = new HotMetadataStore({ vault: v(), selfPluginId: PLUGIN_ID });
    await hot.load();
    return new ChangeDetector({
      vault: v(),
      hotMeta: hot,
      baselines: b,
      gi: new GI(dir),
      configDir: CONFIG_DIR,
      selfPluginId: PLUGIN_ID,
      vaultRoot: dir,
      syncConfigDir: () => true,
      queue: { peekLatestPathSha: async () => null },
    });
  };

  it("the bootloader records what it applied", async () => {
    await stagedWorld();
    await bootloader();
    expect(fs.existsSync(abs(`${PLUGIN_DIR}/.runtime/${SELF_UPDATE_APPLIED_MARKER}`))).toBe(true);
  });

  it("🔑 after apply + settle, the next commit does NOT see main.js as a local edit", async () => {
    await stagedWorld();
    await bootloader();
    const b = baselines();
    await settle(b);
    const changes = await (await detector(b)).findChanges();
    expect(changes.map((c) => c.path)).not.toContain(`${PLUGIN_DIR}/main.js`);
    const rec = await b.get(`${PLUGIN_DIR}/main.js`);
    expect(rec?.baselineSha).toBe(await calculateGitBlobSHA(enc("NEW BUILD")));
    // The record is consumed: a second settle has nothing to do.
    expect(fs.existsSync(abs(`${PLUGIN_DIR}/.runtime/${SELF_UPDATE_APPLIED_MARKER}`))).toBe(false);
  });

  it("…and without the settle it WOULD (the field finding, pinned)", async () => {
    await stagedWorld();
    await bootloader();
    const changes = await (await detector(baselines())).findChanges();
    expect(changes.map((c) => c.path)).toContain(`${PLUGIN_DIR}/main.js`);
  });

  it("🔑 the live file no longer matches the recorded sha (someone put another main.js) → the baseline is NOT touched", async () => {
    await stagedWorld();
    await bootloader();
    put(`${PLUGIN_DIR}/main.js`, "HAND-INSTALLED BUILD");
    const b = baselines();
    await settle(b);
    const rec = await b.get(`${PLUGIN_DIR}/main.js`);
    expect(rec?.baselineSha).toBe(await calculateGitBlobSHA(enc("OLD BUILD")));
    const changes = await (await detector(b)).findChanges();
    expect(changes.map((c) => c.path)).toContain(`${PLUGIN_DIR}/main.js`);
  });

  it("a TORN record (crash mid-write) changes nothing and is removed", async () => {
    await stagedWorld();
    await bootloader();
    const marker = abs(`${PLUGIN_DIR}/.runtime/${SELF_UPDATE_APPLIED_MARKER}`);
    const full = fs.readFileSync(marker, "utf8");
    fs.writeFileSync(marker, full.slice(0, full.length - 12)); // sha cut short
    const b = baselines();
    expect(await settle(b)).toEqual([]);
    expect((await b.get(`${PLUGIN_DIR}/main.js`))?.baselineSha).toBe(
      await calculateGitBlobSHA(enc("OLD BUILD")),
    );
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("no record → settle is a no-op", async () => {
    const b = baselines();
    await settle(b);
    expect(await b.get(`${PLUGIN_DIR}/main.js`)).toBeUndefined();
  });
});
