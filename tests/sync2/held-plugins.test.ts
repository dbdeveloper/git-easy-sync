// PLUGIN-UPDATE-COMPAT Фаза 2, Крок 4 — the primitives the gate is a
// thin layer over.
//
// The unit of holding is the PLUGIN FOLDER, never a file (§5.2). A
// bundle is not four independent files: `main.js` and `manifest.json`
// can arrive in different batches, and holding half of one leaves the
// other half to be resolved by rules that know nothing about the part
// being held.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setMockApiVersion } from "../../mock-obsidian";
import {
  pluginFolderOf,
  isHeldPath,
  decideHold,
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

// PLUGIN-UPDATE-COMPAT Фаза 2, Крок 5 — the decision, as a pure
// function, so the whole table below is checked without an engine.
//
// ⚠️ IT FAILS IN THE OPPOSITE DIRECTION TO ФАЗА 1'S GATE, on purpose.
// The reload gate reads the manifest ON DISK and skips when it cannot
// read it (a wrong skip costs one restart). This reads the INCOMING
// manifest from the repo and does NOT hold when it cannot read it
// (§7.1.1): holding on a corrupt file would leave a state with no
// automatic way out, since the only thing that could lift it is the
// very file we cannot parse. Same input class, opposite answer, both
// deliberate.
describe("decideHold (§6.3)", () => {
  const manifest = (m: Record<string, unknown>) => JSON.stringify(m);

  beforeEach(() => {
    setMockApiVersion("1.12.7");
  });
  afterEach(() => {
    setMockApiVersion("1.13.4");
  });

  it("6.3.1 the incoming version needs a newer Obsidian → HOLD", () => {
    const d = decideHold(
      manifest({ version: "2.24.3", minAppVersion: "1.13.0" }),
    );
    expect(d.hold).toBe(true);
    if (d.hold) {
      expect(d.minAppVersion).toBe("1.13.0");
      expect(d.heldVersion).toBe("2.24.3");
    }
  });

  it("6.3.2 a version this Obsidian satisfies → pass", () => {
    expect(
      decideHold(manifest({ version: "1.0.0", minAppVersion: "1.12.2" })).hold,
    ).toBe(false);
  });

  it("6.3.3 no manifest in the change → pass (the version did not move)", () => {
    // §5.2: a portion without manifest.json says nothing about
    // compatibility, and inventing an opinion would hold plugins whose
    // authors only shipped a bug fix.
    expect(decideHold(null).hold).toBe(false);
  });

  it("6.3.4 🔑 a corrupt incoming manifest → PASS, not hold (§7.1.1)", () => {
    expect(decideHold("{ not json").hold).toBe(false);
    expect(decideHold("[]").hold).toBe(false);
    expect(decideHold("null").hold).toBe(false);
  });

  it("a manifest with no minAppVersion → pass", () => {
    expect(decideHold(manifest({ version: "1.0.0" })).hold).toBe(false);
    expect(
      decideHold(manifest({ version: "1.0.0", minAppVersion: 113 })).hold,
    ).toBe(false);
  });

  it("an unreadable minAppVersion → pass, for the same reason as 6.3.4", () => {
    expect(
      decideHold(manifest({ version: "1.0.0", minAppVersion: "soon™" })).hold,
    ).toBe(false);
  });

  it("🔑 isDesktopOnly is NOT a hold condition (§5.1, owner 2026-08-02)", () => {
    // Its cure is REMOTE (the author dropping the flag) and we could
    // never see that happen: a held folder is filtered out of every
    // compare, so the manifest that would tell us is exactly the file
    // we stopped reading. A one-way trap, traded for disk space.
    const d = decideHold(
      manifest({ version: "1.0.0", isDesktopOnly: true }),
    );
    expect(d.hold).toBe(false);
  });

  it("the version is optional too — it only ever reaches a log line", () => {
    const d = decideHold(manifest({ minAppVersion: "1.13.0" }));
    expect(d.hold).toBe(true);
    if (d.hold) expect(d.heldVersion).toBe("");
  });
});
