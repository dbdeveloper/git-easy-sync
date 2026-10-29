// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TFile, TFolder, Vault } from "../../mock-obsidian";
import { FolderWatcher } from "../../src/sync2/folder-watcher";

// GITKEEP I12, I15: Obsidian's folder events only MARK — create, delete,
// rename (both paths); file events are ignored. Read-only, like
// ConflictWatcher: the second explicit exception to the polling rule.
describe("FolderWatcher", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "folder-watcher-"));
    roots.push(root);
    const vault = new Vault(root);
    const marked: string[] = [];
    const w = new FolderWatcher({ vault: vault as never, mark: (f) => marked.push(f) });
    return { vault, marked, w };
  };

  it("🔑 folder create / delete mark the folder; rename marks both paths", () => {
    const { vault, marked, w } = setup();
    w.start();
    vault.fireEvent("create", new TFolder("a/new"));
    vault.fireEvent("delete", new TFolder("b/old"));
    vault.fireEvent("rename", new TFolder("c/to"), "c/from");
    expect(marked).toEqual(["a/new", "b/old", "c/to", "c/from"]);
  });

  it("file events are ignored", () => {
    const { vault, marked, w } = setup();
    w.start();
    vault.fireEvent("create", new TFile("a/x.md"));
    vault.fireEvent("delete", new TFile("a/x.md"));
    vault.fireEvent("rename", new TFile("a/y.md"), "a/x.md");
    vault.fireEvent("modify", new TFolder("a"));
    expect(marked).toEqual([]);
  });

  it("start is idempotent; stop removes the listeners", () => {
    const { vault, marked, w } = setup();
    w.start();
    w.start();
    vault.fireEvent("create", new TFolder("a"));
    expect(marked).toEqual(["a"]);
    w.stop();
    vault.fireEvent("create", new TFolder("b"));
    expect(marked).toEqual(["a"]);
  });
});
