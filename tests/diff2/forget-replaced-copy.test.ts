// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-09: when the drain REPLACES a conflict copy with a newer
// server version, the OLD copy's diff2-autosave dir is wiped — whether a tab
// was open or not.
//
// Owner, 2026-11-04 (TODO 59): the OLD copy's editor tabs are NOT this
// function's business any more. The replace transaction deletes the old copy
// before the drain calls us, and the vanished-copy cleaner closes its tabs
// on that delete — silently, the focused one to the Diff Panel. Field run
// 2026-11-04: the cleaner won both times, and this function then failed on
// the dir the cleaner had just wiped (ENOENT) and logged a false WARN.

import { describe, expect, it } from "vitest";
import { forgetReplacedConflictCopy } from "../../src/diff2/forget-replaced-copy";
import { autosaveDir, deriveAutosaveId } from "../../src/diff2/autosave-store";

const BASE = "notes/a.md";
const OLD = "notes/a.conflict-from-Mac-2026-10-09T18-26-16Z.md";
const NEW = "notes/a.conflict-from-Mac-2026-10-09T18-26-52Z.md";

function setup(dirs: string[]) {
  const existing = new Set(dirs);
  const removed: string[] = [];
  const adapter = {
    exists: async (p: string) => existing.has(p),
    rmdir: async (p: string, _recursive?: boolean) => {
      if (!existing.has(p)) throw new Error(`ENOENT: no such file or directory, lstat '${p}'`);
      removed.push(p);
      existing.delete(p);
    },
  };
  return { existing, removed, adapter };
}

describe("forgetReplacedConflictCopy", () => {
  const oldDir = autosaveDir(deriveAutosaveId("tracked", BASE, OLD));
  const newDir = autosaveDir(deriveAutosaveId("tracked", BASE, NEW));

  it("🔑 wipes the OLD copy's autosave dir; the new copy's dir is untouched", async () => {
    const s = setup([oldDir, newDir]);
    const r = await forgetReplacedConflictCopy({ adapter: s.adapter }, BASE, OLD);
    expect(s.removed).toEqual([oldDir]);
    expect(s.existing.has(newDir)).toBe(true);
    expect(r).toEqual({ wipedDirs: 1 });
  });

  it("nothing there → nothing done", async () => {
    const s = setup([newDir]);
    expect(await forgetReplacedConflictCopy({ adapter: s.adapter }, BASE, OLD)).toEqual({ wipedDirs: 0 });
    expect(s.removed).toEqual([]);
  });

  // The field race of 2026-11-04: `exists` says yes, the vanished-copy
  // cleaner wipes the same dir, then our rmdir finds nothing.
  it("🔑 the dir vanishes between exists and rmdir (the cleaner got there first) → no throw", async () => {
    const s = setup([oldDir]);
    const adapter = {
      exists: s.adapter.exists,
      rmdir: async (p: string) => {
        s.existing.delete(p); // the other deleter, a moment earlier
        return s.adapter.rmdir(p, true);
      },
    };
    await expect(forgetReplacedConflictCopy({ adapter }, BASE, OLD)).resolves.toEqual({ wipedDirs: 0 });
  });

  it("a real rmdir failure (the dir is still there) is NOT swallowed", async () => {
    const s = setup([oldDir]);
    const adapter = {
      exists: s.adapter.exists,
      rmdir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    await expect(forgetReplacedConflictCopy({ adapter }, BASE, OLD)).rejects.toThrow("EACCES");
  });
});
