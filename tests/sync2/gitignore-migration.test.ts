// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1 Крок E4 — the procedure and every crash window in it.
//
// The forward path is six steps and recovery has six cases, so the tests
// are organised by STATE rather than by function: each one seeds the disk
// as a crash would have left it, runs recovery, and asserts what came out.
// A test that only ran the happy path would say nothing about the windows
// this module exists for.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  runMigrationFull,
  runMigrationResume,
  readDoneMarker,
  migrationReportText,
  IN_PROGRESS_MARKER_NAME,
  DONE_MARKER_NAME,
  type MigrationDeps,
} from "../../src/sync2/gitignore-migration";
import {
  serializeMigrationList,
  parseMigrationList,
  splitAtFinalSection,
  buildMigrationProposal,
} from "../../src/sync2/gitignore-migrate";
import {
  FINAL_BEGIN,
  FINAL_END,
  INVARIANTS_BEGIN,
  INVARIANTS_END,
} from "../../src/sync2/gitignore-invariants";
import { MIGRATION_DEVICE_LABEL } from "../../src/sync2/conflict-siblings";

const CONFIG_DIR = ".obsidian";
const SELF = "git-easy-sync";
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/${SELF}`;
const AT = 1_700_000_000_000;
// buildSiblingFilePath's shape for this moment and the reserved label.
const PROPOSAL =
  `.gitignore.conflict-from-${MIGRATION_DEVICE_LABEL}-2023-11-14T22-13-20Z`;

// An ASSEMBLED root file — enforce() has run, which is a precondition of
// the full pass (§8.1.4 phase 2).
const ROOT = [
  INVARIANTS_BEGIN,
  ".*",
  ".*/",
  "!/.gitignore",
  INVARIANTS_END,
  "",
  "*.log",
  "",
  FINAL_BEGIN,
  "*.conflict-from-*",
  FINAL_END,
  "",
].join("\n");

let root: string;
afterEach(() => {
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function setup(files: Record<string, string>): MigrationDeps {
  root = path.join(os.tmpdir(), `mig-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, `${PLUGIN_DIR}/.runtime`), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return {
    vault: new Vault(root) as unknown as import("obsidian").Vault,
    configDir: CONFIG_DIR,
    selfPluginId: SELF,
    dirIgnored: () => false,
    nowMs: () => AT,
  };
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));

describe("§8.1.4 the forward path", () => {
  it("🔑 migrates: proposal raised, sources renamed, markers settled", async () => {
    const deps = setup({
      ".gitignore": ROOT,
      "a/.gitignore": "build\n",
      "a/b/.gitignore": "/dist\n",
    });
    const r = await runMigrationFull(deps);

    expect(r.kind).toBe("migrated");
    expect(r.sources).toEqual(["a/.gitignore", "a/b/.gitignore"]);
    expect(r.conflictPath).toBe(PROPOSAL);

    // Sources are gone from git's and our reach, but reversibly.
    expect(exists("a/.gitignore")).toBe(false);
    expect(read("a/.gitignore.bak")).toBe("build\n");
    expect(read("a/b/.gitignore.bak")).toBe("/dist\n");

    // The proposal is wrapped in the root file's own halves, so the diff
    // editor shows one insertion in the right place.
    const proposal = read(PROPOSAL);
    expect(proposal.startsWith(INVARIANTS_BEGIN)).toBe(true);
    expect(proposal).toContain("# rules from a/.gitignore");
    expect(proposal).toContain("a/**/build");
    expect(proposal).toContain("/a/b/dist");
    expect(proposal.trimEnd().endsWith(FINAL_END)).toBe(true);

    // Step 5 then 6: done down, in-progress lifted. No staging left.
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(true);
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(false);
    expect(exists(`${PROPOSAL}.ges-tmp`)).toBe(false);

    // §8.1.6 — the drain needs to know what to delete remotely.
    const marker = await readDoneMarker(deps);
    expect(marker?.remotePending).toEqual(r.sources);
  });

  it("🔑 deeper rules land LATER in the proposal — last-match-wins", async () => {
    // Order is the whole reason the walk sorts. If `a/b` came first, its
    // rules would stop overriding `a`'s, silently.
    const deps = setup({
      ".gitignore": ROOT,
      "a/b/.gitignore": "deep\n",
      "a/.gitignore": "shallow\n",
    });
    await runMigrationFull(deps);
    const body = read(PROPOSAL);
    expect(body.indexOf("a/**/shallow")).toBeLessThan(
      body.indexOf("a/b/**/deep"),
    );
  });

  it("nothing found: marked done, no proposal, silent", async () => {
    const deps = setup({ ".gitignore": ROOT });
    const r = await runMigrationFull(deps);
    expect(r.kind).toBe("nothing-found");
    expect(r.conflictPath).toBeNull();
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(true);
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(false);
  });

  it("a second run is a no-op — the done marker is the gate", async () => {
    const deps = setup({ ".gitignore": ROOT, "a/.gitignore": "x\n" });
    await runMigrationFull(deps);
    const again = await runMigrationFull(deps);
    expect(again.kind).toBe("already-done");
  });

  it("🔑 REFUSES when the root file has no final section", async () => {
    // The proposal BECOMES the root file when accepted. Without the bottom
    // half it would drop the absolute rules — `*.conflict-from-*` among
    // them — and every sibling in the vault would become pushable. Doing
    // nothing is strictly better.
    const deps = setup({ ".gitignore": ".*\n", "a/.gitignore": "x\n" });
    const r = await runMigrationFull(deps);
    expect(r.kind).toBe("refused");
    expect(exists("a/.gitignore")).toBe(true); // untouched
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(false);
  });

  it("🔑 an INCOMPLETE walk is not marked done", async () => {
    // "A .gitignore may have been missed" and "there were none" must not
    // collapse: marking done on the first reading means never looking
    // again.
    const deps = setup({ ".gitignore": ROOT });
    deps.vault = {
      ...deps.vault,
      adapter: {
        ...deps.vault.adapter,
        list: async () => {
          throw new Error("EIO");
        },
      },
    } as unknown as import("obsidian").Vault;
    const r = await runMigrationFull(deps);
    expect(r.kind).toBe("incomplete");
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(false);
  });

  it("🔑 an existing .bak is never overwritten — .bak2 is used", async () => {
    // A previous migration's backup plus a newly created `.gitignore` in
    // the same folder. POSIX rename would clobber the old backup silently;
    // Capacitor would throw. Neither is acceptable.
    const deps = setup({
      ".gitignore": ROOT,
      "a/.gitignore": "new\n",
      "a/.gitignore.bak": "older backup\n",
    });
    await runMigrationFull(deps);
    expect(read("a/.gitignore.bak")).toBe("older backup\n");
    expect(read("a/.gitignore.bak2")).toBe("new\n");
  });

  it("whitelisted files are left alone; plugins/.gitignore is taken", async () => {
    const deps = setup({
      ".gitignore": ROOT,
      [`${CONFIG_DIR}/.gitignore`]: "keep\n",
      [`${CONFIG_DIR}/plugins/.gitignore`]: "moved\n",
    });
    const r = await runMigrationFull(deps);
    expect(r.sources).toEqual([`${CONFIG_DIR}/plugins/.gitignore`]);
    expect(exists(`${CONFIG_DIR}/.gitignore`)).toBe(true);
    expect(exists(`${CONFIG_DIR}/plugins/.gitignore`)).toBe(false);
  });
});

describe("§8.1.4 recovery — one test per crash window", () => {
  // Seed the disk exactly as a crash at each point would have left it.
  const seedAfterStep1 = () =>
    setup({
      ".gitignore": ROOT,
      "a/.gitignore": "build\n",
      [`${PROPOSAL}.ges-tmp`]: "staged bytes\n",
    });

  const seedAfterStep2 = (list = "a/.gitignore\n1\n") =>
    setup({
      ".gitignore": ROOT,
      "a/.gitignore": "build\n",
      [`${PROPOSAL}.ges-tmp`]: "staged bytes\n",
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: list,
    });

  it("case 1 — done marker present, in-progress left behind → step 6 finishes", async () => {
    const deps = setup({
      ".gitignore": ROOT,
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: "a/.gitignore\n1\n",
      [`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`]: "{}",
    });
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("already-done");
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(false);
  });

  it("🔑 case 2 — staging but NO marker: resume must not touch anything", async () => {
    // The sweep performs exactly the deletion this state wants, and the
    // full run then starts fresh. Acting here would duplicate it, and
    // acting on an unverified staging file is how a half-built proposal
    // becomes the root file.
    const deps = seedAfterStep1();
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("already-done");
    expect(exists(`${PROPOSAL}.ges-tmp`)).toBe(true);
    expect(exists("a/.gitignore")).toBe(true);
  });

  it("🔑 case 3/4 — marker complete + staging intact → the run finishes", async () => {
    const deps = seedAfterStep2();
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("resumed");
    expect(r.conflictPath).toBe(PROPOSAL);
    expect(read(PROPOSAL)).toBe("staged bytes\n");
    expect(read("a/.gitignore.bak")).toBe("build\n");
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(true);
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(false);
  });

  it("case 4 — sources ALREADY renamed: step 3 is idempotent, not repeated", async () => {
    // Cases 3 and 4 deliberately share one action; this is why they can.
    const deps = setup({
      ".gitignore": ROOT,
      "a/.gitignore.bak": "build\n",
      [`${PROPOSAL}.ges-tmp`]: "staged bytes\n",
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: "a/.gitignore\n1\n",
    });
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("resumed");
    // No second backup invented for a file that was already moved.
    expect(exists("a/.gitignore.bak2")).toBe(false);
  });

  it("🔑 a TORN marker is discarded, never read as an empty list", async () => {
    // The difference between the two readings is everything: one re-scans,
    // the other marks a migration done having moved nothing.
    const deps = seedAfterStep2("a/.gitignore\nb/.gitignore\n5\n");
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("already-done");
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(false);
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(false);
    expect(exists("a/.gitignore")).toBe(true); // nothing renamed
  });

  it("case 3 with a `0` marker — nothing was staged, so only 5 and 6 remain", async () => {
    const deps = setup({
      ".gitignore": ROOT,
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: "0\n",
    });
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("resumed");
    expect(r.sources).toEqual([]);
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(true);
  });

  it("case 5 — proposal already renamed, marker still down → finish", async () => {
    const deps = setup({
      ".gitignore": ROOT,
      [PROPOSAL]: "already renamed\n",
      "a/.gitignore.bak": "build\n",
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: "a/.gitignore\n1\n",
    });
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("resumed");
    expect(r.conflictPath).toBe(PROPOSAL);
    expect(read(PROPOSAL)).toBe("already renamed\n");
  });

  it("🔑 STALLED is reported, not papered over", async () => {
    // Sources renamed, staging gone. Unreachable while resume precedes the
    // sweep — but if it ever happens the rules are in the `.bak` files and
    // cannot be re-derived, so the marker is KEPT and the state named.
    const errors: unknown[] = [];
    const deps = setup({
      ".gitignore": ROOT,
      "a/.gitignore.bak": "build\n",
      [`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`]: "a/.gitignore\n1\n",
    });
    deps.logger = {
      info: () => {},
      warn: () => {},
      error: (_m, d) => errors.push(d),
    };
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("stalled");
    expect(r.sources).toEqual(["a/.gitignore"]);
    expect(errors).toHaveLength(1);
    // Kept deliberately: a forgotten stall is a silent one.
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(true);
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(false);
  });

  it("🔑 a crash BETWEEN steps 5 and 6 leaves BOTH markers, never neither", async () => {
    // Found by mutation probe, 2026-09-27: reversing finish()'s two
    // writes passed every other test in this file, and the order is
    // load-bearing. With NEITHER marker on disk the next run re-scans,
    // sees no live nested `.gitignore` (they are already `*.bak`), and
    // records `sources: []` — so `remotePending` comes out EMPTY and
    // §8.1.6 never deletes them from the remote. The divergence §8.1
    // exists to remove would persist forever, silently.
    //
    // Writing `done` FIRST makes the only reachable in-between state
    // "both present", which recovery case 1 resolves by finishing step 6.
    const deps = setup({ ".gitignore": ROOT, "a/.gitignore": "build\n" });
    const realRemove = deps.vault.adapter.remove.bind(deps.vault.adapter);
    deps.vault = {
      ...deps.vault,
      adapter: {
        ...deps.vault.adapter,
        remove: async (p: string) => {
          if (p.endsWith(IN_PROGRESS_MARKER_NAME)) throw new Error("crash");
          return realRemove(p);
        },
      },
    } as unknown as import("obsidian").Vault;

    await expect(runMigrationFull(deps)).rejects.toThrow("crash");
    expect(exists(`${PLUGIN_DIR}/.runtime/${DONE_MARKER_NAME}`)).toBe(true);
    expect(exists(`${PLUGIN_DIR}/${IN_PROGRESS_MARKER_NAME}`)).toBe(true);

    // …and the state is benign: case 1 completes it, with the source list
    // intact so the remote deletion still has its work.
    const marker = await readDoneMarker(deps);
    expect(marker?.remotePending).toEqual(["a/.gitignore"]);
  });

  it("no marker at all — resume is a no-op", async () => {
    const deps = setup({ ".gitignore": ROOT, "a/.gitignore": "x\n" });
    const r = await runMigrationResume(deps);
    expect(r.kind).toBe("already-done");
    expect(exists("a/.gitignore")).toBe(true);
  });
});

describe("the marker format is provably complete or discarded", () => {
  it("round-trips a list and an empty list", () => {
    expect(parseMigrationList(serializeMigrationList(["a", "b"]))).toEqual([
      "a",
      "b",
    ]);
    expect(parseMigrationList(serializeMigrationList([]))).toEqual([]);
  });

  it("🔑 rejects every shape that is not provably complete", () => {
    // Each of these is a torn write, and each must read as "discard",
    // never as "empty" — the reading is what separates re-scanning from
    // marking a migration done having moved nothing.
    expect(parseMigrationList("")).toBeNull(); // nothing written
    expect(parseMigrationList("a/.gitignore\n")).toBeNull(); // no count
    expect(parseMigrationList("a\nb\n3\n")).toBeNull(); // count too high
    expect(parseMigrationList("a\nb\n1\n")).toBeNull(); // count too low
    expect(parseMigrationList("a\n\nb\n3\n")).toBeNull(); // hole in the list
    expect(parseMigrationList("a\nnotanumber\n")).toBeNull();
  });
});

describe("§8.1.3 the proposal's shape", () => {
  it("splits at the final marker, and refuses when it is absent", () => {
    const split = splitAtFinalSection(ROOT);
    expect(split?.top).toContain("*.log");
    expect(split?.top).not.toContain(FINAL_BEGIN);
    expect(split?.bottom.startsWith(FINAL_BEGIN)).toBe(true);
    expect(splitAtFinalSection(".*\n")).toBeNull();
  });

  it("🔑 the rules land BETWEEN the halves, both kept verbatim", () => {
    // That placement is the trick: because both ends are the root file
    // itself, the diff editor shows one insertion after the user's rules
    // and before the absolute ones.
    const split = splitAtFinalSection(ROOT);
    if (!split) throw new Error("fixture must split");
    const out = buildMigrationProposal(split, [["# rules from a", "a/**/x"]]);
    expect(out.indexOf("*.log")).toBeLessThan(out.indexOf("a/**/x"));
    expect(out.indexOf("a/**/x")).toBeLessThan(out.indexOf(FINAL_BEGIN));
  });

  it("with no rules the halves rejoin unchanged", () => {
    const split = splitAtFinalSection(ROOT);
    if (!split) throw new Error("fixture must split");
    expect(buildMigrationProposal(split, [[]])).toBe(ROOT);
  });
});

describe("§8.1.5 what the Settings button reports", () => {
  const r = (
    kind: Parameters<typeof migrationReportText>[0]["kind"],
    sources: string[] = [],
    conflictPath: string | null = null,
  ) => ({ kind, sources, conflictPath });

  it("🔑 nothing found AND nothing open → reassurance, not silence", async () => {
    // A button that says nothing reads as broken, which is why the owner
    // asked for this case explicitly.
    const out = migrationReportText(r("nothing-found"), null);
    expect(out.title).toContain("No problems");
    expect(out.resolvePath).toBeNull();
  });

  it("🔑 nothing found but a proposal STILL open → reminds, with a way in", async () => {
    // The reason the button matters beyond the first run: it is the only
    // surface that reports this, since the badge counts tracked only.
    const out = migrationReportText(r("nothing-found"), "prop");
    expect(out.title).toContain("still open");
    expect(out.resolvePath).toBe("prop");
  });

  it("migrated → says what moved and that sync is paused", async () => {
    const out = migrationReportText(r("migrated", ["a/.gitignore"], "prop"), null);
    expect(out.body).toContain("1 .gitignore file");
    expect(out.body).toContain(".bak");
    expect(out.body).toContain("paused");
    expect(out.resolvePath).toBe("prop");
  });

  it("the failure kinds say what to do, and offer no resolve link", async () => {
    // Each of these means "nothing changed"; offering a Resolve button
    // would point at nothing.
    for (const kind of ["incomplete", "refused", "stalled"] as const) {
      const out = migrationReportText(r(kind, ["a/.gitignore"]), null);
      expect(out.resolvePath, kind).toBeNull();
      expect(out.body.length, kind).toBeGreaterThan(40);
    }
  });
});

describe("§8.1.6 remotePending accumulates across runs", () => {
  it("🔑 a manual re-run MERGES the pending list instead of replacing it", async () => {
    // A forced run can land before the drain that consumes the previous
    // list. Replacing it would silently drop those paths, and the nested
    // `.gitignore` files would stay on the remote forever — the one thing
    // the deletion step exists to prevent.
    const deps = setup({
      ".gitignore": ROOT,
      "a/.gitignore": "one\n",
    });
    await runMigrationFull(deps);
    // A second source appears, and the user presses the button.
    fs.mkdirSync(path.join(root, "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "b/.gitignore"), "two\n");
    await runMigrationFull(deps, { force: true });

    const marker = await readDoneMarker(deps);
    expect(marker?.remotePending?.sort()).toEqual([
      "a/.gitignore",
      "b/.gitignore",
    ]);
  });

  it("force is what lets the button work at all", async () => {
    const deps = setup({ ".gitignore": ROOT, "a/.gitignore": "x\n" });
    await runMigrationFull(deps);
    expect((await runMigrationFull(deps)).kind).toBe("already-done");
    fs.writeFileSync(path.join(root, "a/.gitignore"), "again\n");
    expect((await runMigrationFull(deps, { force: true })).kind).toBe(
      "migrated",
    );
  });
});
