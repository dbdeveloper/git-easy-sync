// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { sweepEmptyFolders, type FolderSweepInput } from "../../src/sync2/folder-sweep";

// GITKEEP I29-I32, C13 (docs/tasks/GITKEEP.md): after the drain's
// deletions, ONE pass removes the folders they left TRULY empty, walking
// up to the first that is not. Nothing inside a folder is ever deleted —
// a .DS_Store keeps it (the owner's "Phoenix"). An ordinary folder whose
// .gitkeep record lives on is alive and only marked; so is one whose
// .gitkeep the drain removed but that still holds something.

// A tiny disk: folder -> its direct entries (names).
const world = (tree: Record<string, string[]>) => {
  const removed: string[] = [];
  const marked: string[] = [];
  const disk = new Map(Object.entries(tree).map(([k, v]) => [k, [...v]]));
  const input = (over: Partial<FolderSweepInput>): FolderSweepInput => ({
    deletedPaths: [],
    configDir: ".obsidian",
    list: async (f) => (disk.has(f) ? disk.get(f)! : null),
    removeIfEmpty: async (f) => {
      if ((disk.get(f) ?? []).length > 0) return false;
      removed.push(f);
      disk.delete(f);
      const parent = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      const name = f.slice(f.lastIndexOf("/") + 1);
      const siblings = disk.get(parent);
      if (siblings) disk.set(parent, siblings.filter((n) => n !== name));
      return true;
    },
    hasRecord: async () => false,
    mark: (f) => marked.push(f),
    ...over,
  });
  return { input, removed, marked };
};

describe("sweepEmptyFolders — what goes", () => {
  it("🔑 a folder left empty by the drain goes, and its parent if that is empty too", async () => {
    const w = world({ "": ["a"], a: ["b"], "a/b": [] });
    const r = await sweepEmptyFolders(w.input({ deletedPaths: ["a/b/.gitkeep", "a/b/x.md", "a/.gitkeep"] }));
    expect(w.removed).toEqual(["a/b", "a"]);
    expect(r.removed).toEqual(["a/b", "a"]);
  });

  it("🔑 two emptied siblings: both go, and then their parent — whichever is looked at first", async () => {
    const w = world({ "": ["a"], a: ["b", "c"], "a/b": [], "a/c": [] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/b/x.md", "a/c/y.md", "a/.gitkeep"] }));
    expect(w.removed.sort()).toEqual(["a", "a/b", "a/c"]);
  });

  it("🔑 the walk stops at the first folder that is not empty", async () => {
    const w = world({ "": ["a"], a: ["b", ".gitkeep", "keep.md"], "a/b": [] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/b/.gitkeep"] }));
    expect(w.removed).toEqual(["a/b"]);
  });

  it("🔑 never the root, <configDir>, <configDir>/plugins — but a plugin's own folder, yes", async () => {
    const w = world({ "": [".obsidian"], ".obsidian": ["plugins"], ".obsidian/plugins": ["gone-plugin"], ".obsidian/plugins/gone-plugin": [] });
    await sweepEmptyFolders(w.input({ deletedPaths: [".obsidian/plugins/gone-plugin/main.js"] }));
    expect(w.removed).toEqual([".obsidian/plugins/gone-plugin"]);
    const w2 = world({ "": [], top: [] });
    await sweepEmptyFolders(w2.input({ deletedPaths: ["root-file.md"] }));
    expect(w2.removed).toEqual([]);
  });

  it("a redo (dead battery): the files are already gone, the folders still go", async () => {
    const w = world({ "": ["a"], a: [] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/.gitkeep", "a/x.md"] }));
    expect(w.removed).toEqual(["a"]);
  });

  it("a folder already gone (a redo after the sweep) is no error; the walk goes on up", async () => {
    const w = world({ "": ["a"], a: [] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/b/.gitkeep"] }));
    expect(w.removed).toEqual(["a"]);
  });
});

describe("sweepEmptyFolders — what stays (no data is ever lost)", () => {
  it("🔑 C12: a .DS_Store keeps the folder; nothing inside is deleted; the folder is marked (I31)", async () => {
    const w = world({ "": ["a"], a: [".DS_Store"] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/.gitkeep", "a/x.md"] }));
    expect(w.removed).toEqual([]);
    expect(w.marked).toEqual(["a"]);
  });

  it("🔑 C13: empty, but the .gitkeep RECORD lives on (silently deleted by hand) → alive, marked", async () => {
    const w = world({ "": ["a"], a: [] });
    await sweepEmptyFolders(
      w.input({ deletedPaths: ["a/x.md"], hasRecord: async (p) => p === "a/.gitkeep" }),
    );
    expect(w.removed).toEqual([]);
    expect(w.marked).toEqual(["a"]);
  });

  it("C13: a record that THIS drain is deleting does not keep the folder", async () => {
    const w = world({ "": ["a"], a: [] });
    await sweepEmptyFolders(
      w.input({ deletedPaths: ["a/.gitkeep", "a/x.md"], hasRecord: async (p) => p === "a/.gitkeep" }),
    );
    expect(w.removed).toEqual(["a"]);
  });

  it("a folder whose .gitkeep was not deleted and that still has files is just left — no mark", async () => {
    const w = world({ "": ["a"], a: [".gitkeep", "b.md"] });
    await sweepEmptyFolders(w.input({ deletedPaths: ["a/x.md"] }));
    expect(w.removed).toEqual([]);
    expect(w.marked).toEqual([]);
  });

  it("🔑 something appears between the look and the removal → the folder stays (the final check is at the removal)", async () => {
    const w = world({ "": ["a"], a: [] });
    let first = true;
    const input = w.input({ deletedPaths: ["a/x.md"] });
    const realRemove = input.removeIfEmpty;
    input.removeIfEmpty = async (f) => {
      if (first) {
        first = false;
        return false; // a note was saved into it just now
      }
      return realRemove(f);
    };
    await sweepEmptyFolders(input);
    expect(w.removed).toEqual([]);
  });

  it("dot folders: truly empty goes, no record question, no mark", async () => {
    const w = world({ "": [".mydir"], ".mydir": [".DS_Store"], ".mydir/sub": [] });
    const w2 = world({ "": [".mydir"], ".mydir": ["sub"], ".mydir/sub": [] });
    await sweepEmptyFolders(w.input({ deletedPaths: [".mydir/f.md"] }));
    expect(w.removed).toEqual([]);
    expect(w.marked).toEqual([]);
    await sweepEmptyFolders(w2.input({ deletedPaths: [".mydir/sub/f.md"] }));
    expect(w2.removed).toEqual([".mydir/sub", ".mydir"]);
  });
});
