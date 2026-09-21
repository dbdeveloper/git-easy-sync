// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// SYNC2-DOT-FILES-REFACTOR §10 probes 1-4, committed as tests (§12 step 0).
//
// These four probes are what the whole dot-space design rests on: D1
// (default-invisible), D3 (recursive dot-hide), the configDir composition,
// and — the one with teeth — the choice of ANCHORED `!/.gitignore` over the
// bare form. They were originally run as throwaway scripts and deleted,
// which made §10 a log of a run nobody could repeat. Committed here so the
// claims are re-measured on every `pnpm test`.
//
// Split by oracle, deliberately:
//   probes 1-2 — the raw `ignore` package, single-level. This is the rule
//                ENGINE's semantics, with no no-descent layer on top.
//   probes 3-4 — the real `GI`, multi-node. This is what the plugin
//                actually asks, and it is NOT the same question: GI adds
//                git's no-descent rule (gi.ts:108-123).
// A claim proven at one level does not transfer to the other. Probe 5
// (real `git` as the oracle) lives in gi-git-parity.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import ignore from "ignore";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import GI, { whitelistedGitignoreDirs } from "../src/gi";

// The dot-hide rules as §10 states them. In the probes they are just a
// test INPUT string; in production they are a physical managed section of
// the root .gitignore (§3.1) — never an in-memory injection.
const SYNTH = ".*\n.*/\n!.gitignore\n";

// Single-level matcher over `rules`. Returns true when the path is hidden.
const hides = (rules: string, p: string): boolean =>
  ignore().add(rules).ignores(p);

describe("§10 probe 1 — dot-hide + opt-in (raw `ignore`, single level)", () => {
  it("SYNTH alone: every dot-path hidden, ordinal paths untouched", () => {
    expect(hides(SYNTH, ".editorconfig")).toBe(true);
    expect(hides(SYNTH, ".gitignore")).toBe(false); // kept by `!.gitignore`
    expect(hides(SYNTH, "notes/.hidden/foo.md")).toBe(true);
    expect(hides(SYNTH, ".obsidian/app.json")).toBe(true);
    expect(hides(SYNTH, "notes/regular.md")).toBe(false);
  });

  it("`!.editorconfig` opts in that ONE file, nothing else", () => {
    const r = `${SYNTH}!.editorconfig\n`;
    expect(hides(r, ".editorconfig")).toBe(false);
    expect(hides(r, ".other")).toBe(true);
  });

  it("`!.myconfig/` opts in the directory's ordinal content at any depth", () => {
    const r = `${SYNTH}!.myconfig/\n`;
    expect(hides(r, ".myconfig/foo.md")).toBe(false);
    expect(hides(r, ".myconfig/deep/bar.md")).toBe(false);
  });

  it("TRAP §7.1: a file-level `!` inside a hidden dir gives nothing", () => {
    // `!.myconfig/foo.md` without re-admitting `.myconfig/` itself. The
    // natural "I will just allow the one file I need" attempt, and it is
    // worth exactly zero — the same trap probe 5-D measured on real git.
    const r = `${SYNTH}!.myconfig/foo.md\n`;
    expect(hides(r, ".myconfig/foo.md")).toBe(true);
  });

  it("a nested anchored dot-dir can be opted in too", () => {
    const r = `${SYNTH}!notes/.hidden/\n`;
    expect(hides(r, "notes/.hidden/foo.md")).toBe(false);
  });
});

describe("§10 probe 2 — recursive dot-hide, D3 (raw `ignore`)", () => {
  // D3 is what makes opting in a dot-directory SAFE: you get its ordinal
  // content, not a blanket "everything below is now public". Secrets that
  // live in a nested dot-path stay hidden unless named again.
  const OPT_IN = `${SYNTH}!.myconfig/\n`;

  it("ordinal content surfaces, nested dot-paths stay hidden", () => {
    expect(hides(OPT_IN, ".myconfig/foo.md")).toBe(false);
    expect(hides(OPT_IN, ".myconfig/sub/baz.md")).toBe(false);
    expect(hides(OPT_IN, ".myconfig/.hidden")).toBe(true);
    expect(hides(OPT_IN, ".myconfig/.sub/bar.md")).toBe(true);
  });

  it("a nested dot-DIR needs its own explicit opt-in", () => {
    const r = `${OPT_IN}!.myconfig/.sub/\n`;
    expect(hides(r, ".myconfig/.sub/bar.md")).toBe(false);
    expect(hides(r, ".myconfig/.hidden")).toBe(true); // still hidden
  });

  it("a nested dot-FILE needs its own explicit opt-in", () => {
    const r = `${OPT_IN}!.myconfig/.hidden\n`;
    expect(hides(r, ".myconfig/.hidden")).toBe(false);
  });
});

// ── probes 3-4: the real GI, multi-node ────────────────────────────────

// Seeds as the plugin ships them today (gitignore-invariants.ts). Kept as
// literals rather than imported: these probes pin the BEHAVIOUR of a given
// rule text, so a future edit to the constants must show up as a failing
// probe to be re-measured, not silently ride along.
const CONFIG_SEED =
  "workspace.json\nworkspace-mobile.json\ncommunity-plugins.json\n" +
  "plugins/*/data.json\n" +
  "plugins/*/*\n!plugins/*/\n" +
  "!plugins/*/main.js\n!plugins/*/manifest.json\n!plugins/*/styles.css\n";
const SELF_SEED = "*\n!main.js\n!manifest.json\n!styles.css\n!.gitignore\n";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gi-dot-probe-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const w = (rel: string, content = "") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

// Lay down the standard configDir fixture and return a fresh GI over it.
// `rootRules` is the whole root .gitignore for this case.
function giWithConfigDir(rootRules: string): GI {
  w(".gitignore", rootRules);
  w(".obsidian/.gitignore", CONFIG_SEED);
  w(".obsidian/plugins/foo/.gitignore", SELF_SEED);
  // The real D5 whitelist: these probes are ABOUT the configDir nodes,
  // so a root-only matcher would answer a different question.
  return new GI(root, undefined, whitelistedGitignoreDirs(".obsidian"));
}

describe("§10 probe 3 — `!<configDir>/` composition (real GI, multi-node)", () => {
  it("re-admitting the directory lets the configDir's own nodes take over", () => {
    const gi = giWithConfigDir(`${SYNTH}!.obsidian/\n`);
    expect(gi.ignored(".obsidian/app.json")).toBe(false);
    expect(gi.ignored(".obsidian/plugins/foo/main.js")).toBe(false);
    expect(gi.ignored(".obsidian/plugins/foo/manifest.json")).toBe(false);
    // The seed allowlist is NOT inverted by the re-admission — the single
    // most destructive way this could go wrong (whole plugin folders would
    // start travelling).
    expect(gi.ignored(".obsidian/plugins/foo/other.js")).toBe(true);
    // Dot-paths outside configDir are unaffected by any of it.
    expect(gi.ignored("notes/.hidden/x.md")).toBe(true);
    expect(gi.ignored(".editorconfig")).toBe(true);
  });
});

describe("§10 probe 4 — the physical section, and WHY `!/.gitignore` is anchored", () => {
  // Every variant below differs by ONE line. That line decides whether D6
  // ("a .gitignore syncs only where it is honoured") holds or is broken.
  const block = (variant: string) => `.*\n.*/\n${variant}\n!.obsidian/\n`;

  it("A — anchored `!/.gitignore`: correct on every count", () => {
    const gi = giWithConfigDir(block("!/.gitignore"));
    expect(gi.ignored(".gitignore")).toBe(false); // root control file syncs
    expect(gi.ignored("notes/.gitignore")).toBe(true); // D6, natively
    expect(gi.ignored(".obsidian/plugins/foo/.gitignore")).toBe(false);
    expect(gi.ignored(".obsidian/plugins/foo/main.js")).toBe(false);
    expect(gi.ignored(".obsidian/app.json")).toBe(false);
    expect(gi.ignored(".editorconfig")).toBe(true);
  });

  it("A — but `<configDir>/.gitignore` itself is NOT re-admitted (this is why §3.1.1 exists)", () => {
    // Root `.*` catches it by basename at any depth, and re-admitting the
    // DIRECTORY does not rescue a dot-FILE inside it. The per-plugin file
    // above survives only because the self seed says `!.gitignore` at its
    // own node. `<configDir>/.gitignore` has no such line today — hence
    // the `final` section §3.1.1 adds one.
    const gi = giWithConfigDir(block("!/.gitignore"));
    expect(gi.ignored(".obsidian/.gitignore")).toBe(true);
  });

  it("B — bare `!.gitignore`: D6 BROKEN, a nested .gitignore starts syncing", () => {
    const gi = giWithConfigDir(block("!.gitignore"));
    expect(gi.ignored("notes/.gitignore")).toBe(false); // ← the defect
  });

  it("C — a user `!` rule BELOW the section overrides it (D2.3)", () => {
    const gi = giWithConfigDir(`${block("!/.gitignore")}!.editorconfig\n`);
    expect(gi.ignored(".editorconfig")).toBe(false);
  });

  it("D — `!./.gitignore` does nothing; the `./` form is not gitignore syntax", () => {
    const gi = giWithConfigDir(block("!./.gitignore"));
    expect(gi.ignored(".gitignore")).toBe(true); // still hidden
  });
});
