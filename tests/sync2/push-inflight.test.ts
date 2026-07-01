import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  writePushInflight,
  readPushInflight,
  clearPushInflight,
  PUSH_INFLIGHT_FILE_NAME,
} from "../../src/sync2/push-inflight";

// SYNC2 §7.9 — the push→record crash marker. The recovery logic (heal decision) is
// exercised end-to-end in sync2-manager.test.ts ("FIX: crash gap WITH the push-inflight
// marker"); these cover the marker file's own fault-tolerance guarantees.

const PLUGIN_ID = "github-easy-sync";
const markerRel = `.obsidian/plugins/${PLUGIN_ID}/${PUSH_INFLIGHT_FILE_NAME}`;

function makeVault() {
  const root = path.join(
    os.tmpdir(),
    `push-inflight-${crypto.randomBytes(4).toString("hex")}`,
  );
  // The plugin's own folder always exists in production (the plugin loads from it).
  fs.mkdirSync(path.join(root, ".obsidian", "plugins", PLUGIN_ID), { recursive: true });
  const vault = new Vault(root) as unknown as import("obsidian").Vault;
  return { vault, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("push-inflight marker", () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it("write → read roundtrip preserves the fields", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    await writePushInflight(vault, PLUGIN_ID, { newHead: "abc", newTreeSha: "tree1", batchId: "b1" });
    expect(await readPushInflight(vault, PLUGIN_ID)).toEqual({
      newHead: "abc",
      newTreeSha: "tree1",
      batchId: "b1",
    });
  });

  it("lands in the plugin folder, NOT the config-dir root", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    await writePushInflight(vault, PLUGIN_ID, { newHead: "abc", newTreeSha: "t" });
    expect(await vault.adapter.exists(markerRel)).toBe(true);
    // Not at the historic snapshot-metadata location (config-dir root).
    expect(await vault.adapter.exists(`.obsidian/${PUSH_INFLIGHT_FILE_NAME}`)).toBe(false);
  });

  it("absent marker → null", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    expect(await readPushInflight(vault, PLUGIN_ID)).toBeNull();
  });

  it("corrupt JSON → null (degrades to no-marker = today's behaviour, never worse)", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    await vault.adapter.write(markerRel, "{ not valid json");
    expect(await readPushInflight(vault, PLUGIN_ID)).toBeNull();
  });

  it("valid JSON but wrong shape (no newHead / newTreeSha) → null", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    await vault.adapter.write(markerRel, JSON.stringify({ newHead: "x" })); // missing newTreeSha
    expect(await readPushInflight(vault, PLUGIN_ID)).toBeNull();
  });

  it("clear removes the marker and is idempotent", async () => {
    const { vault, cleanup: c } = makeVault();
    cleanup = c;
    await writePushInflight(vault, PLUGIN_ID, { newHead: "abc", newTreeSha: "t" });
    await clearPushInflight(vault, PLUGIN_ID);
    expect(await readPushInflight(vault, PLUGIN_ID)).toBeNull();
    await expect(clearPushInflight(vault, PLUGIN_ID)).resolves.not.toThrow(); // second clear = no-op
  });
});
