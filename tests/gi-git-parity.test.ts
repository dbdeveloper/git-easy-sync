// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// GI ↔ real git parity.
//
// Every other GI test asserts our model against our own expectations,
// which cannot catch a shared misconception. This one feeds the same
// fixture to `GI.ignored()` and to the `git` binary and demands the same
// answer. git is the only oracle here that is not us.
//
// Method: `git init` + `git add -A` + `git diff --cached --name-only`.
// ⚠️ NOT `git check-ignore -v` — it prints the LAST rule that matched
// even when that rule is a negation, so its output reads backwards. Only
// the index tells the truth. (Learned the hard way, 2026-08-31.)
//
// The fixtures below are the ones that motivated no-descent
// (SYNC2-DOT-FILES-REFACTOR §10 probe 5) plus the multi-level cases that
// predate it, so parity is asserted where we merely BELIEVED we agreed.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import GI from "../src/gi";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {}
  }
});

// Build the fixture on disk, ask git what it would track, ask GI about
// every file, and return both verdict sets keyed by path.
function bothVerdicts(files: Record<string, string>): {
  git: Map<string, boolean>;
  gi: Map<string, boolean>;
} {
  const root = path.join(
    os.tmpdir(),
    `gi-parity-${crypto.randomBytes(4).toString("hex")}`,
  );
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "."]);
  run(["config", "core.quotepath", "false"]);
  run(["add", "-A"]);
  const staged = new Set(
    run(["diff", "--cached", "--name-only"])
      .split("\n")
      .filter((s) => s.length > 0),
  );

  const gi = new GI(root);
  const gitMap = new Map<string, boolean>();
  const giMap = new Map<string, boolean>();
  for (const rel of Object.keys(files)) {
    gitMap.set(rel, !staged.has(rel)); // ignored == not tracked
    giMap.set(rel, gi.ignored(rel));
  }
  return { git: gitMap, gi: giMap };
}

function expectParity(files: Record<string, string>): void {
  const { git, gi } = bothVerdicts(files);
  // Compare as objects so a mismatch prints the whole picture, not just
  // the first differing path.
  expect(Object.fromEntries(gi)).toEqual(Object.fromEntries(git));
}

const SELF_ALLOWLIST = "*\n!main.js\n!manifest.json\n!styles.css\n!.gitignore\n";

describe.skipIf(!gitAvailable())("GI ↔ real git parity", () => {
  it("probe 5 A: dot-hide with no directory re-inclusion", () => {
    expectParity({
      ".gitignore": ".*\n.*/\n",
      ".obsidian/.gitignore": "!.gitignore\n",
      ".obsidian/app.json": "{}",
      ".obsidian/plugins/git-easy-sync/.gitignore": SELF_ALLOWLIST,
      ".obsidian/plugins/git-easy-sync/main.js": "//",
      ".obsidian/plugins/git-easy-sync/data.json": "{}",
      "note.md": "hi",
    });
  });

  it("probe 5 B/C: dot-hide + `!<configDir>/` (with and without the redundant file line)", () => {
    const base = {
      ".obsidian/.gitignore": "!.gitignore\n",
      ".obsidian/app.json": "{}",
      ".obsidian/plugins/git-easy-sync/.gitignore": SELF_ALLOWLIST,
      ".obsidian/plugins/git-easy-sync/main.js": "//",
      ".obsidian/plugins/git-easy-sync/data.json": "{}",
      "note.md": "hi",
    };
    expectParity({
      ...base,
      ".gitignore": ".*\n.*/\n!.obsidian/\n!.obsidian/.gitignore\n",
    });
    expectParity({ ...base, ".gitignore": ".*\n.*/\n!.obsidian/\n" });
  });

  it("probe 5 C': re-admitted directory, but the configDir node does NOT self-allow", () => {
    expectParity({
      ".gitignore": ".*\n.*/\n!.obsidian/\n",
      ".obsidian/.gitignore": "workspace.json\n",
      ".obsidian/app.json": "{}",
      ".obsidian/workspace.json": "{}",
      "note.md": "hi",
    });
  });

  it("probe 5 D: a file-level ! without the directory re-inclusion", () => {
    expectParity({
      ".gitignore": ".*\n.*/\n!.obsidian/.gitignore\n",
      ".obsidian/.gitignore": "!.gitignore\n",
      ".obsidian/app.json": "{}",
      "note.md": "hi",
    });
  });

  // ── the shipped layout, as of DOT-FILES Крок A ────────────────────
  //
  // Two sections in the root file with DIFFERENT authority, and a single
  // `final` section in configDir and in plugin files. These literals
  // mirror what GitignoreInvariants writes; keeping them here rather
  // than importing the constants is deliberate — an edit to the shipped
  // rules must surface as a failing parity test to be re-measured
  // against git, not ride along silently.
  const ROOT_TOP = ".*\n.*/\n!/.gitignore\n";
  const ROOT_BOTTOM =
    "!.obsidian/\n*.conflict-from-*\n*.ges-tmp*\n*.ges-bak*\n";
  const ROOT_DEFAULTS = "*.log\n.DS_Store\n.trash/\n";
  const CONFIG_DEFAULTS =
    "plugins/*/*\n!plugins/*/\n" +
    "!plugins/*/main.js\n!plugins/*/manifest.json\n!plugins/*/styles.css\n";
  const CONFIG_FINAL_ON =
    "!/.gitignore\n!/plugins/*/.gitignore\n" +
    "workspace.json\nworkspace-mobile.json\ncommunity-plugins.json\n" +
    "plugins/*/data.json\n";
  // The data.json line rides through OFF, inert below `*` — the toggle
  // has nowhere else to live (see configDirFinalBody).
  const CONFIG_FINAL_OFF = "plugins/*/data.json\n/.gitignore\n*\n";
  const SILENCER = "*\n";

  const VAULT_FILES = {
    ".obsidian/plugins/git-easy-sync/main.js": "//",
    ".obsidian/plugins/git-easy-sync/data.json": "{}",
    ".obsidian/plugins/git-easy-sync/nested/thing.json": "{}",
    ".obsidian/plugins/brat/main.js": "//",
    ".obsidian/plugins/brat/data.json": "{}",
    ".obsidian/plugins/brat/sub/data.json": "{}",
    ".obsidian/app.json": "{}",
    ".obsidian/workspace.json": "{}",
    ".obsidian/snippets/.gitignore": "!secret.css\n",
    ".obsidian/snippets/secret.css": "body{}",
    "note.md": "hi",
    "notes/.gitignore": "!anything\n",
    ".editorconfig": "root = true",
    "note.md.ges-tmp": "staging",
    "note.conflict-from-Mac-2026-01-01T00-00-00Z.md": "sibling",
    "git-easy-sync.log": "log",
    ".trash/gone.md": "trashed",
  };

  it("the shipped layout at syncConfigDir=ON", () => {
    expectParity({
      ...VAULT_FILES,
      ".gitignore": ROOT_TOP + ROOT_DEFAULTS + ROOT_BOTTOM,
      ".obsidian/.gitignore": CONFIG_DEFAULTS + CONFIG_FINAL_ON,
      ".obsidian/plugins/git-easy-sync/.gitignore": SELF_ALLOWLIST,
      ".obsidian/plugins/brat/.gitignore": "*.map\n",
    });
  });

  it("the shipped layout at syncConfigDir=OFF", () => {
    // The silencer goes into configDir, our own file and EVERY
    // third-party plugin .gitignore that exists — our node and theirs
    // both speak last for their own folders, so <configDir>'s `*` alone
    // would not hold.
    expectParity({
      ...VAULT_FILES,
      ".gitignore": ROOT_TOP + ROOT_DEFAULTS + ROOT_BOTTOM,
      ".obsidian/.gitignore": CONFIG_DEFAULTS + CONFIG_FINAL_OFF,
      ".obsidian/plugins/git-easy-sync/.gitignore":
        SELF_ALLOWLIST + SILENCER,
      ".obsidian/plugins/brat/.gitignore": "*.map\n" + SILENCER,
    });
  });

  it("a user rule between the two root sections: overrides the top, not the bottom", () => {
    // The asymmetry the whole two-section split exists for, measured
    // against git rather than against our own matcher.
    expectParity({
      ...VAULT_FILES,
      ".gitignore":
        ROOT_TOP +
        ROOT_DEFAULTS +
        "!.editorconfig\n!*.conflict-from-*\n" +
        ROOT_BOTTOM,
      ".obsidian/.gitignore": CONFIG_DEFAULTS + CONFIG_FINAL_ON,
      ".obsidian/plugins/git-easy-sync/.gitignore": SELF_ALLOWLIST,
      ".obsidian/plugins/brat/.gitignore": "*.map\n",
    });
  });

  it("the data.json toggle ON is honoured BELOW the recommended catch-all", () => {
    // The formerly-pinned defect: with the allow line above
    // `plugins/*/*` the opt-in was a no-op. Asked of git directly.
    expectParity({
      ...VAULT_FILES,
      ".gitignore": ROOT_TOP + ROOT_DEFAULTS + ROOT_BOTTOM,
      ".obsidian/.gitignore":
        CONFIG_DEFAULTS +
        CONFIG_FINAL_ON.replace(
          "plugins/*/data.json",
          "!plugins/*/data.json",
        ),
      ".obsidian/plugins/git-easy-sync/.gitignore": SELF_ALLOWLIST,
      ".obsidian/plugins/brat/.gitignore": "*.map\n",
    });
  });

  it("dir-only patterns and nested exclusion", () => {
    expectParity({
      ".gitignore": "build/\nnode_modules/\n",
      "build/.gitignore": "!keep.js\n",
      "build/keep.js": "//",
      "build/sub/deep.js": "//",
      "node_modules/pkg/index.js": "//",
      "src/app.js": "//",
    });
  });

  it("multi-level FILE patterns still agree (the cases that predate no-descent)", () => {
    expectParity({
      ".gitignore": "*.log\n",
      "a/.gitignore": "!keep.log\n",
      "a/keep.log": "x",
      "a/other.log": "x",
      "keep.log": "x",
    });
    expectParity({
      ".gitignore": "a/b/c/file\n",
      "a/.gitignore": "!b/c/file\n",
      "a/b/.gitignore": "c/file\n",
      "a/b/c/.gitignore": "!file\n",
      "a/b/c/file": "x",
    });
    expectParity({
      ".gitignore": "*.x\n",
      "a/.gitignore": "!*.x\n",
      "a/b/.gitignore": "*.x\n",
      "a/b/c/.gitignore": "!*.x\n",
      "a/b/c/file.x": "x",
      "a/file.x": "x",
      "a/b/file.x": "x",
    });
  });

  it("a user rule below the managed block wins, at any depth", () => {
    expectParity({
      ".gitignore": "*.log\nPrivate/\n!Private/README.md\n",
      "Private/README.md": "x",
      "Private/diary.md": "x",
      "notes/a.log": "x",
      "notes/a.md": "x",
    });
  });
});
