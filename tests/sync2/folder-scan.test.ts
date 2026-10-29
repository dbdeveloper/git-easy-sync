// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { scanFolders, type FolderScanInput } from "../../src/sync2/folder-scan";
import { GITKEEP_SHA } from "../../src/sync2/text-normalize";

// GITKEEP I16-I19 (docs/tasks/GITKEEP.md): the start scan only MARKS.
// A folder is marked when its .gitkeep is missing, non-empty, unrecorded,
// or recorded with the server's non-empty sha; a recorded .gitkeep whose
// folder is gone marks that folder. .gitignore is not asked here (I13).
const run = async (over: Partial<FolderScanInput> & { disk?: Record<string, number> }) => {
  const marked: string[] = [];
  const stats: string[] = [];
  const disk = over.disk ?? {};
  const n = await scanFolders({
    folders: [],
    records: new Map(),
    stat: async (p) => (stats.push(p), p in disk ? { size: disk[p] } : null),
    mark: (f) => marked.push(f),
    pause: async () => {},
    ...over,
  });
  return { n, marked: marked.sort(), stats };
};

describe("scanFolders — what marks a folder (I17, I18)", () => {
  it("🔑 the four reasons, and the one case that marks nothing", async () => {
    const r = await run({
      folders: ["missing", "nonempty", "unrecorded", "junk", "fine"],
      disk: {
        "nonempty/.gitkeep": 7,
        "unrecorded/.gitkeep": 0,
        "junk/.gitkeep": 0,
        "fine/.gitkeep": 0,
      },
      records: new Map([
        ["nonempty/.gitkeep", GITKEEP_SHA],
        ["junk/.gitkeep", "server-junk-sha"],
        ["fine/.gitkeep", GITKEEP_SHA],
        ["missing/.gitkeep", GITKEEP_SHA],
      ]),
    });
    expect(r.marked).toEqual(["junk", "missing", "nonempty", "unrecorded"]);
    expect(r.n).toBe(4);
  });

  it("🔑 a recorded .gitkeep whose folder is gone marks that folder", async () => {
    const r = await run({ folders: ["kept"], disk: { "kept/.gitkeep": 0 }, records: new Map([["kept/.gitkeep", GITKEEP_SHA], ["gone/sub/.gitkeep", GITKEEP_SHA]]) });
    expect(r.marked).toEqual(["gone/sub"]);
  });

  it("dot folders and the root are skipped — their .gitkeep is the detector's (I8)", async () => {
    const r = await run({ folders: [".trash", "notes/.hidden", "/", ""], records: new Map([[".mydir/.gitkeep", GITKEEP_SHA]]) });
    expect(r.marked).toEqual([]);
    expect(r.stats).toEqual([]);
  });

  it("no .gitignore question here: an excluded folder without a record is marked like any other (I13)", async () => {
    const r = await run({ folders: ["private"], disk: { "private/.gitkeep": 0 } });
    expect(r.marked).toEqual(["private"]);
  });
});

describe("scanFolders — quiet on a phone (I16, I19)", () => {
  it("🔑 pauses between chunks, one stat per folder", async () => {
    let pauses = 0;
    const folders = Array.from({ length: 2000 }, (_, i) => `f${i}`);
    const r = await run({ folders, pause: async () => void pauses++ });
    expect(r.stats).toHaveLength(2000);
    expect(new Set(r.stats).size).toBe(2000);
    expect(pauses).toBeGreaterThanOrEqual(2000 / 100 - 1);
  });

  it("20 000 folders: still one stat each (no re-walk)", async () => {
    const folders = Array.from({ length: 20000 }, (_, i) => `d${i % 100}/f${i}`);
    const r = await run({ folders });
    expect(r.stats).toHaveLength(20000);
  });
});
