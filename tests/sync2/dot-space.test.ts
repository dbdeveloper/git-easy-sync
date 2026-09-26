// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §4.2 — the rule table, asserted row by row, plus the two
// structural members of the set that come from somewhere other than a
// `!`-rule.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  classifyRule,
  negationRules,
  readRootGitignore,
  underWalkTarget,
} from "../../src/sync2/dot-space";

const CONFIG_DIR = ".obsidian";

describe("classifyRule — the §4.2 table, row by row", () => {
  it("row 1: a bare or anchored single-segment name is a root dot-FILE", () => {
    for (const rule of ["!.editorconfig", "!/.editorconfig"]) {
      expect(classifyRule(rule, "file")).toEqual({
        kind: "file",
        path: ".editorconfig",
      });
    }
  });

  it("row 2: an anchored directory rule is a walk target", () => {
    expect(classifyRule("!/.myconfig/", "dir")).toEqual({
      kind: "dir",
      path: ".myconfig",
    });
    // A middle slash anchors it just as a leading one does — that is
    // git's rule, not ours.
    expect(classifyRule("!notes/.hidden/", "dir")).toEqual({
      kind: "dir",
      path: "notes/.hidden",
    });
  });

  it("row 3: anchored, NO trailing slash — the DISK decides", () => {
    // The row that was wrong until 2026-09-22. Measured on real git and
    // on our matcher: for a DIRECTORY the two anchored forms behave
    // identically, and the slash only adds "directories only". So this
    // form has to cover both, or `!/.claude` grants permission that
    // nothing walks — the exact D7 hazard.
    expect(classifyRule("!/.claude", "dir")).toEqual({
      kind: "dir",
      path: ".claude",
    });
    expect(classifyRule("!/.claude", "file")).toEqual({
      kind: "file",
      path: ".claude",
    });
  });

  it("row 3: absent on disk counts as a file, so the rule works once created", () => {
    expect(classifyRule("!/.claude", null)).toEqual({
      kind: "file",
      path: ".claude",
    });
  });

  it("row 4: a directory rule WITHOUT an anchor gives nothing", () => {
    // `!.myconfig/` matches a directory of that name at any depth.
    // "Somewhere, possibly several somewheres" is not a walk target —
    // this is the Blocker-1 shape, and the whole reason D7 exists.
    expect(classifyRule("!.myconfig/", "dir")).toEqual({ kind: "none" });
  });

  it("row 5: a dot-FILE inside an ordinary subfolder gives nothing", () => {
    // Reaching it would mean scanning subfolders we never otherwise
    // open. A rule that half-works is worse than one that does nothing.
    expect(classifyRule("!notes/.secret", "file")).toEqual({ kind: "none" });
    // ...but the same path AS A DIRECTORY is a fine walk target.
    expect(classifyRule("!notes/.secret", "dir")).toEqual({
      kind: "dir",
      path: "notes/.secret",
    });
  });

  it("row 6: globs give nothing, in every shape", () => {
    for (const rule of [
      "!**/.foo",
      "!*.x",
      "!.conf?g",
      "![ab]/.x",
      "!.a\\*b",
    ]) {
      expect(classifyRule(rule, "file"), rule).toEqual({ kind: "none" });
    }
  });

  it("ordinal paths are not members: the set only carries dot-space", () => {
    // An ordinal path is visible by default, so a `!`-rule naming one
    // grants nothing this set needs to carry.
    expect(classifyRule("!README.md", "file")).toEqual({ kind: "none" });
    expect(classifyRule("!build/", "dir")).toEqual({ kind: "none" });
  });

  it("a rule that is not a negation is not a rule here", () => {
    expect(classifyRule(".editorconfig", "file")).toEqual({ kind: "none" });
    expect(classifyRule("!", "file")).toEqual({ kind: "none" });
  });

  it("negationRules picks the `!` lines out of a file, in order", () => {
    expect(
      negationRules("*.log\n\n  !/.a  \n# !/.comment\n!.b\n"),
    ).toEqual(["!/.a", "!.b"]);
  });
});

describe("underWalkTarget", () => {
  const targets = new Set([".obsidian", "notes/.hidden"]);
  it("matches the target itself and anything below it", () => {
    expect(underWalkTarget(".obsidian", targets)).toBe(true);
    expect(underWalkTarget(".obsidian/app.json", targets)).toBe(true);
    expect(underWalkTarget("notes/.hidden/deep/x.md", targets)).toBe(true);
  });
  it("does not match a sibling that merely shares a prefix", () => {
    expect(underWalkTarget(".obsidian-backup/x", targets)).toBe(false);
    expect(underWalkTarget("notes/.hiddenish/x", targets)).toBe(false);
    expect(underWalkTarget("other/x.md", targets)).toBe(false);
  });
});

describe("readRootGitignore", () => {
  let root: string;
  let vault: Vault;

  const w = (rel: string, content = "") => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const mkdir = (rel: string) =>
    fs.mkdirSync(path.join(root, rel), { recursive: true });

  const read = (syncConfigDir = true) =>
    readRootGitignore({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      syncConfigDir: () => syncConfigDir,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dot-space-"));
    vault = new Vault(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("root `.gitignore` is a member STRUCTURALLY, not because a rule says so", () => {
    // The control file is itself a dot-path, so D7 gates it on
    // membership. If membership came from the file's own `!/.gitignore`
    // line, then a user exercising D6a (a `/.gitignore` line below the
    // invariants section) would knock the file out of DISCOVERY rather
    // than out of PERMISSION — and those are different layers. The
    // matcher is the one that can tell "the user chose to keep this
    // local" from "we cannot see it".
    w(".gitignore", "*.log\n"); // no `!`-rules at all
    return read().then((set) => {
      expect(set.dotFiles.has(".gitignore")).toBe(true);
    });
  });

  it("no root `.gitignore` at all → dot-space closes, it does not open", async () => {
    const set = await read();
    expect([...set.dotFiles]).toEqual([".gitignore"]);
    expect([...set.walkTargets]).toEqual([CONFIG_DIR]);
  });

  it("`<configDir>` joins from the SETTING, not from a rule", async () => {
    w(".gitignore", "");
    expect((await read(true)).walkTargets.has(CONFIG_DIR)).toBe(true);
    expect((await read(false)).walkTargets.has(CONFIG_DIR)).toBe(false);
  });

  it("classifies each rule against what is actually on disk", async () => {
    mkdir(".claude");
    w(".editorconfig", "x");
    mkdir("notes/.hidden");
    w(".gitignore", [
      "!.editorconfig", // file on disk → dot-file
      "!/.claude", // DIRECTORY on disk → walk target
      "!notes/.hidden/", // anchored dir → walk target
      "!.unanchored/", // no anchor → nothing
      "!**/.glob", // glob → nothing
      "!notes/.buried", // nested dot-file → nothing
    ].join("\n"));

    const set = await read();
    expect([...set.dotFiles].sort()).toEqual([".editorconfig", ".gitignore"]);
    expect([...set.walkTargets].sort()).toEqual(
      [CONFIG_DIR, ".claude", "notes/.hidden"].sort(),
    );
  });

  it("a rule that LOOKS right but grants nothing warns LOUDLY — silence was the actual defect", async () => {
    // Field report 2026-09-26: the owner wrote `!.test/` (no anchor),
    // nothing synced, and the log had ZERO mentions of the path. The
    // refusal itself is correct and load-bearing (D7: an unanchored
    // rule matches at any depth, so permission without a known location
    // would let Pass 2 read the path as deleted). What was wrong is
    // that a deliberate refusal was indistinguishable from a broken
    // feature — git honours the rule, we do not, and nobody said so.
    mkdir(".test");
    w(".gitignore", "!.test/\n");
    const warnings: Array<{ msg: string; data?: unknown }> = [];

    const set = await readRootGitignore({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      syncConfigDir: () => true,
      logger: { warn: (msg, data) => warnings.push({ msg, data }) },
    });

    expect(set.walkTargets.has(".test")).toBe(false); // still refused
    expect(warnings).toHaveLength(1);
    // The message has to carry the FIX, not just the verdict.
    expect(warnings[0].msg).toContain("!/name/");
    expect(warnings[0].data).toMatchObject({ rule: "!.test/" });
  });

  // `<configDir>` membership is settings-owned. Both halves below pin
  // the SAME invariant from the two sides that can break it, and both
  // are live: our shipped `final` section carries `!/<configDir>/`, so
  // the anchored case is not hypothetical.
  it("🔑 NO rule grants <configDir> — anchored, with the toggle off, it stays out", async () => {
    // Danger found 2026-09-26 while anchoring our own rule: anchored, it
    // classifies as a `dir` target, and that branch adds unconditionally
    // — which would have let a line in a SHARED file silently override a
    // PER-DEVICE "Sync config: off".
    mkdir(CONFIG_DIR);
    w(".gitignore", `!/${CONFIG_DIR}/\n`);
    const set = await readRootGitignore({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      syncConfigDir: () => false,
      logger: { warn: () => {} },
    });
    expect(set.walkTargets.has(CONFIG_DIR)).toBe(false);
  });

  it("🔑 …and neither form is warned about — the toggle, not the rule, decides", async () => {
    // Field report 2026-09-26: the warning fired on the plugin's own
    // rule on every pass, four times in a single sync.
    for (const rule of [`!/${CONFIG_DIR}/`, `!${CONFIG_DIR}/`]) {
      mkdir(CONFIG_DIR);
      w(".gitignore", `${rule}\n`);
      const warnings: string[] = [];
      const set = await readRootGitignore({
        vault: vault as unknown as import("obsidian").Vault,
        configDir: CONFIG_DIR,
        syncConfigDir: () => true,
        logger: { warn: (m) => warnings.push(m) },
      });
      expect(warnings, `for rule ${rule}`).toEqual([]);
      // ON still admits it — via the setting, from either spelling.
      expect(set.walkTargets.has(CONFIG_DIR), `for rule ${rule}`).toBe(true);
    }
  });

  it("an ANCHORED rule is accepted and says nothing — the warning is for refusals only", async () => {
    mkdir(".test");
    w(".gitignore", "!/.test/\n");
    const warnings: string[] = [];
    const set = await readRootGitignore({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      syncConfigDir: () => true,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(set.walkTargets.has(".test")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("the same name is a file or a target depending on what it IS", async () => {
    w(".gitignore", "!/.claude\n");
    const asFile = await read();
    expect(asFile.dotFiles.has(".claude")).toBe(true);
    expect(asFile.walkTargets.has(".claude")).toBe(false);

    fs.rmSync(path.join(root, ".gitignore"));
    mkdir(".claude");
    w(".gitignore", "!/.claude\n");
    const asDir = await read();
    expect(asDir.walkTargets.has(".claude")).toBe(true);
    expect(asDir.dotFiles.has(".claude")).toBe(false);
  });
});
