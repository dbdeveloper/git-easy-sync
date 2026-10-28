// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TFolder, Vault } from "../mock-obsidian";

// The folder journal (GITKEEP I17, I22) enumerates folders through
// Vault.getAllFolders(). The mock mirrors Obsidian 1.13.4: the index
// holds no path with a dot segment (`Dl`), and the root comes back only
// when asked for (`includeRoot`, default false).
describe("mock Vault.getAllFolders", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
  const vaultWith = (dirs: string[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mock-folders-"));
    roots.push(root);
    for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
    return new Vault(root);
  };

  it("every visible folder, at any depth, as TFolder; no dot folders, no root", () => {
    const v = vaultWith(["notes/sub/deep", "a", ".obsidian/plugins/x", ".trash/old", "notes/.hidden/inner"]);
    const got = v.getAllFolders();
    expect(got.every((f) => f instanceof TFolder)).toBe(true);
    expect(got.map((f) => f.path).sort()).toEqual(["a", "notes", "notes/sub", "notes/sub/deep"]);
  });

  it("includeRoot = true adds the root as `/`", () => {
    const v = vaultWith(["a"]);
    expect(v.getAllFolders(true).map((f) => f.path).sort()).toEqual(["/", "a"]);
  });
});
