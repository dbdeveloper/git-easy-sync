// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { planGitkeeps, type GitkeepPlanInput } from "../../src/sync2/gitkeep-plan";
import { GITKEEP_SHA } from "../../src/sync2/text-normalize";

// GITKEEP §3.6.1 (docs/tasks/GITKEEP.md): ONE reconcile of every marked
// subtree, both ways — folders that exist without a record get an
// addition, records whose folder is gone get a deletion. The three
// truths: getAllFolders (what IS), the records (what WAS), the queue
// (what is already committed but not pushed). .gitignore decides per
// visited folder (I22 step 2).
const JUNK = "junk-sha";
const plan = (over: Partial<GitkeepPlanInput>) =>
  planGitkeeps({
    snapshot: [],
    folders: [],
    records: new Map(),
    syncable: async () => true,
    queued: async () => undefined,
    ...over,
  });
const rec = (...entries: Array<[string, string]>) => new Map(entries);

describe("planGitkeeps — the table of §3.6.1", () => {
  it("🔑 folder exists, no record → add", async () => {
    const p = await plan({ snapshot: ["notes"], folders: ["notes"] });
    expect(p).toEqual({ add: ["notes/.gitkeep"], update: [], remove: [], forget: [], visited: expect.any(Array) });
  });

  it("🔑 record exists, folder gone → remove", async () => {
    const p = await plan({ snapshot: ["notes"], records: rec(["notes/.gitkeep", GITKEEP_SHA]) });
    expect(p).toEqual({ add: [], update: [], remove: ["notes/.gitkeep"], forget: [], visited: expect.any(Array) });
  });

  it("🔑 folder and record, record is the server's non-empty sha → update (heals the server)", async () => {
    const p = await plan({ snapshot: ["notes"], folders: ["notes"], records: rec(["notes/.gitkeep", JUNK]) });
    expect(p).toEqual({ add: [], update: ["notes/.gitkeep"], remove: [], forget: [], visited: expect.any(Array) });
  });

  it("folder and an empty record → nothing", async () => {
    const p = await plan({ snapshot: ["notes"], folders: ["notes"], records: rec(["notes/.gitkeep", GITKEEP_SHA]) });
    expect(p).toEqual({ add: [], update: [], remove: [], forget: [], visited: expect.any(Array) });
  });
});

describe("planGitkeeps — the subtree", () => {
  it("🔑 an appeared folder brings ALL its subfolders", async () => {
    const p = await plan({ snapshot: ["a"], folders: ["a", "a/b", "a/b/c", "other"] });
    expect(p.add.sort()).toEqual(["a/.gitkeep", "a/b/.gitkeep", "a/b/c/.gitkeep"]);
  });

  it("🔑 a vanished folder takes ALL recorded subfolders — by the records, events do not come for each", async () => {
    const p = await plan({
      snapshot: ["a"],
      records: rec(["a/.gitkeep", GITKEEP_SHA], ["a/b/.gitkeep", GITKEEP_SHA], ["a/b/c/.gitkeep", GITKEEP_SHA], ["ab/.gitkeep", GITKEEP_SHA]),
    });
    expect(p.remove.sort()).toEqual(["a/.gitkeep", "a/b/.gitkeep", "a/b/c/.gitkeep"]);
  });

  it("🔑 a recorded subfolder that is gone under a prefix with NO record of its own is still removed", async () => {
    const p = await plan({ snapshot: ["a"], folders: ["a"], records: rec(["a/.gitkeep", GITKEEP_SHA], ["a/old/.gitkeep", GITKEEP_SHA]) });
    expect(p).toEqual({ add: [], update: [], remove: ["a/old/.gitkeep"], forget: [], visited: expect.any(Array) });
  });

  it("a rename is both: the old path vanished, the new appeared", async () => {
    const p = await plan({
      snapshot: ["old", "new"],
      folders: ["new", "new/sub"],
      records: rec(["old/.gitkeep", GITKEEP_SHA], ["old/sub/.gitkeep", GITKEEP_SHA]),
    });
    expect(p.add.sort()).toEqual(["new/.gitkeep", "new/sub/.gitkeep"]);
    expect(p.remove.sort()).toEqual(["old/.gitkeep", "old/sub/.gitkeep"]);
  });

  it("a sibling that merely shares a name prefix is not in the subtree", async () => {
    const p = await plan({ snapshot: ["notes"], folders: ["notes", "notes2", "notes-x/y"] });
    expect(p.add).toEqual(["notes/.gitkeep"]);
  });
});

describe("planGitkeeps — .gitignore per visited folder (I22 step 2, I35)", () => {
  const notUnder = (prefix: string) => async (p: string) => !(p === `${prefix}/.gitkeep` || p.startsWith(`${prefix}/`));

  it("🔑 an excluded SUBFOLDER of a marked folder gets no addition", async () => {
    const p = await plan({ snapshot: ["notes"], folders: ["notes", "notes/private", "notes/private/x"], syncable: notUnder("notes/private") });
    expect(p.add).toEqual(["notes/.gitkeep"]);
  });

  it("🔑 an excluded folder's record is FORGOTTEN silently — no deletion goes to the server", async () => {
    const p = await plan({
      snapshot: ["notes"],
      folders: ["notes", "notes/private"],
      records: rec(["notes/.gitkeep", GITKEEP_SHA], ["notes/private/.gitkeep", GITKEEP_SHA]),
      syncable: notUnder("notes/private"),
    });
    expect(p).toEqual({ add: [], update: [], remove: [], forget: ["notes/private/.gitkeep"], visited: expect.any(Array) });
  });

  it("an excluded folder that is also gone: its record is forgotten, not deleted (the detector's two-way mute)", async () => {
    const p = await plan({ snapshot: ["x"], records: rec(["x/.gitkeep", GITKEEP_SHA]), syncable: async () => false });
    expect(p).toEqual({ add: [], update: [], remove: [], forget: ["x/.gitkeep"], visited: expect.any(Array) });
  });
});

describe("planGitkeeps — already committed, not yet pushed (I26)", () => {
  it("🔑 an addition already queued with the empty sha is not queued again", async () => {
    const p = await plan({ snapshot: ["n"], folders: ["n"], queued: async () => GITKEEP_SHA });
    expect(p.add).toEqual([]);
  });

  it("a queued DELETION of an existing folder's .gitkeep: the folder is back → add", async () => {
    const p = await plan({ snapshot: ["n"], folders: ["n"], records: rec(["n/.gitkeep", GITKEEP_SHA]), queued: async () => null });
    expect(p.update.concat(p.add)).toEqual(["n/.gitkeep"]);
  });

  it("a gone folder whose deletion is already queued: nothing more", async () => {
    const p = await plan({ snapshot: ["n"], records: rec(["n/.gitkeep", GITKEEP_SHA]), queued: async () => null });
    expect(p.remove).toEqual([]);
  });

  it("🔑 a gone folder whose ADDITIONS were queued, never pushed, no records → deletions cancel ALL of them", async () => {
    // Commit added a/.gitkeep and a/b/.gitkeep; before the push the user
    // deleted `a`. Without the subfolder, a/b/.gitkeep would reach the
    // server and the other devices would grow a ghost folder.
    const p = await plan({
      snapshot: ["a"],
      queuedPaths: ["a/.gitkeep", "a/b/.gitkeep", "other/.gitkeep"],
      queued: async (path) => (path.startsWith("a/") ? GITKEEP_SHA : undefined),
    });
    expect(p.remove.sort()).toEqual(["a/.gitkeep", "a/b/.gitkeep"]);
  });
});

describe("planGitkeeps — visited: every existing folder of the walk, excluded ones too (I1)", () => {
  it("🔑 step 1 places into excluded folders as well — only the SENDING is filtered", async () => {
    const p = await plan({
      snapshot: ["notes"],
      folders: ["notes", "notes/private", "other"],
      syncable: async (path) => !path.startsWith("notes/private/"),
    });
    expect(p.visited.sort()).toEqual(["notes", "notes/private"]);
    expect(p.add).toEqual(["notes/.gitkeep"]);
  });

  it("🔑 each existing folder is asked about exactly ONCE — 20 000 top-level, and a deep tree", async () => {
    const top = Array.from({ length: 20000 }, (_, i) => `f${i}`);
    let asks = 0;
    await plan({ snapshot: top, folders: top, syncable: async () => (asks++, true) });
    expect(asks).toBe(20000);

    const deep: string[] = [];
    let p = "root";
    for (let i = 0; i < 2000; i++) {
      deep.push(p);
      p = `${p}/d${i % 40}`;
      if (i % 40 === 39) p = `root/b${i}`;
    }
    asks = 0;
    await plan({ snapshot: ["root"], folders: deep, syncable: async () => (asks++, true) });
    expect(asks).toBe(new Set(deep).size);
  });
});

describe("planGitkeeps — dot folders and the root are not its business (I8, I22)", () => {
  it("a dot prefix in the snapshot and dot folders in the list are ignored", async () => {
    const p = await plan({ snapshot: [".trash", "notes/.hidden", "notes"], folders: [".trash/x", "notes", "notes/.hidden"] });
    expect(p.add).toEqual(["notes/.gitkeep"]);
  });

  it("the root is never given a .gitkeep", async () => {
    const p = await plan({ snapshot: ["", "/"], folders: ["/", ""] });
    expect(p.add).toEqual([]);
  });
});

describe("planGitkeeps — cost grows with the input (owner: 2000 folders; 10x = 20 000)", () => {
  const time = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return performance.now() - t0;
  };
  // The first commit after the upgrade: every top-level folder marked,
  // none recorded — the worst case, the collapse does not help.
  const run = (n: number) => () => {
    const folders = Array.from({ length: n }, (_, i) => `f${i}`);
    return plan({ snapshot: folders, folders });
  };
  it("one plan of 20 000 costs about what ten of 2000 do", async () => {
    const tenSmall = async () => {
      for (let k = 0; k < 10; k++) await run(2000)();
    };
    await tenSmall(); // warm-up
    const bestOf = async (fn: () => Promise<unknown>, n: number) => {
      let best = Infinity;
      for (let i = 0; i < n; i++) best = Math.min(best, await time(fn));
      return best;
    };
    const small = await bestOf(tenSmall, 5);
    const large = await bestOf(run(20000), 5);
    // Linear ≈ 1, quadratic ≈ 10; 5 leaves room for a GC pause.
    expect(large / small).toBeLessThan(5);
  });
});
