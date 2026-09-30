// PLUGIN-UPDATE-COMPAT Фаза 2, Крок 4 — the primitives the gate is a
// thin layer over.
//
// The unit of holding is the PLUGIN FOLDER, never a file (§5.2). A
// bundle is not four independent files: `main.js` and `manifest.json`
// can arrive in different batches, and holding half of one leaves the
// other half to be resolved by rules that know nothing about the part
// being held.

import { describe, it, expect } from "vitest";
import {
  pluginFolderOf,
  isHeldPath,
  type HeldPluginUpdates,
} from "../../src/sync2/held-plugins";

const CD = ".obsidian";

describe("pluginFolderOf", () => {
  it("names the plugin a path belongs to", () => {
    expect(pluginFolderOf(`${CD}/plugins/templater/main.js`, CD)).toEqual({
      id: "templater",
      folder: `${CD}/plugins/templater`,
    });
    expect(
      pluginFolderOf(`${CD}/plugins/templater/manifest.json`, CD),
    ).toEqual({ id: "templater", folder: `${CD}/plugins/templater` });
  });

  it("claims EVERYTHING under the folder, at any depth", () => {
    // `data.json` is in the allowlist and syncs (§5.2): a new config
    // of a new schema under an old main.js is the second way to break
    // a working plugin. Nested paths are ours too — a plugin may keep
    // whatever it likes down there.
    expect(pluginFolderOf(`${CD}/plugins/templater/data.json`, CD)?.id).toBe(
      "templater",
    );
    expect(
      pluginFolderOf(`${CD}/plugins/templater/deep/er/file.js`, CD)?.id,
    ).toBe("templater");
  });

  it("the folder itself counts — it is what gets created or not", () => {
    expect(pluginFolderOf(`${CD}/plugins/templater`, CD)?.id).toBe("templater");
  });

  it("is null for everything that is not inside a plugin folder", () => {
    expect(pluginFolderOf(`${CD}/plugins/.gitignore`, CD)).toBeNull();
    expect(pluginFolderOf(`${CD}/app.json`, CD)).toBeNull();
    expect(pluginFolderOf("notes/plugins/templater/main.js", CD)).toBeNull();
    expect(pluginFolderOf("README.md", CD)).toBeNull();
    expect(pluginFolderOf(`${CD}/pluginsX/templater/main.js`, CD)).toBeNull();
  });

  it("respects a non-default configDir", () => {
    expect(pluginFolderOf(".config/plugins/x/main.js", ".config")?.id).toBe("x");
    expect(pluginFolderOf(".obsidian/plugins/x/main.js", ".config")).toBeNull();
  });
});

describe("isHeldPath", () => {
  const held: HeldPluginUpdates = {
    templater: {
      minAppVersion: "1.13.0",
      heldVersion: "2.24.3",
      baselines: [],
    },
  };

  it("holds every path of the held plugin, and nothing else", () => {
    expect(isHeldPath(`${CD}/plugins/templater/main.js`, CD, held)).toBe(true);
    expect(isHeldPath(`${CD}/plugins/templater/data.json`, CD, held)).toBe(
      true,
    );
    expect(isHeldPath(`${CD}/plugins/dataview/main.js`, CD, held)).toBe(false);
    expect(isHeldPath(`${CD}/app.json`, CD, held)).toBe(false);
    expect(isHeldPath("note.md", CD, held)).toBe(false);
  });

  it("🔑 a plugin whose id is a PREFIX of the held one is not held", () => {
    // `templater-extras` must not be caught by a `startsWith` over the
    // folder string — a whole class of "it worked in the test" bugs.
    expect(isHeldPath(`${CD}/plugins/templater-extras/main.js`, CD, held)).toBe(
      false,
    );
  });

  it("no records means nothing is held", () => {
    expect(isHeldPath(`${CD}/plugins/templater/main.js`, CD, {})).toBe(false);
  });
});
