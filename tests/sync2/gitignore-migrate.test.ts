// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1 Крок E2 — the pure half of the migration: which
// `.gitignore` files must move, and what each of their rules becomes
// once it lives in the root file instead.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault } from "../../mock-obsidian";
import {
  needsMigration,
  translateRule,
  translateFile,
  findMigrationCandidates,
} from "../../src/sync2/gitignore-migrate";

const CONFIG_DIR = ".obsidian";
const scope = (p: string) => needsMigration(p, CONFIG_DIR);

describe("§8.1.1 which .gitignore files migrate", () => {
  it("the four whitelisted locations do NOT migrate — except plugins/", () => {
    // D5's honoured set, from gi.ts's single definition rather than
    // restated here. The root file is the TARGET, so it cannot be a
    // source either.
    expect(scope(".gitignore")).toBe(false);
    expect(scope(`${CONFIG_DIR}/.gitignore`)).toBe(false);
    expect(scope(`${CONFIG_DIR}/plugins/brat/.gitignore`)).toBe(false);
  });

  it("🔑 `<configDir>/plugins/.gitignore` DOES migrate, though it is honoured", () => {
    // The case the owner singled out, and the only one where "honoured"
    // and "safe to leave" come apart: enforce() replaces this file
    // WHOLE ("no user content here to preserve" — it carries only the
    // per-device data.json switch), so any user content in it is
    // destroyed on the next commit or drain. Being read by git is no
    // protection when we overwrite it.
    expect(scope(`${CONFIG_DIR}/plugins/.gitignore`)).toBe(true);
  });

  it("everything else in the tree migrates, at any depth", () => {
    expect(scope("notes/.gitignore")).toBe(true);
    expect(scope("a/b/c/d/.gitignore")).toBe(true);
    // A dot-directory is not special here — depth and dottiness are the
    // walk's business (§8.1.1a), not this predicate's.
    expect(scope(".myconfig/.gitignore")).toBe(true);
    expect(scope(`${CONFIG_DIR}/plugins/brat/sub/.gitignore`)).toBe(true);
  });

  it("a path that is not a .gitignore at all is never in scope", () => {
    // Stated because the walk hands this predicate whatever it finds,
    // and "ends with .gitignore" is not the same as "is one".
    expect(scope("notes/gitignore")).toBe(false);
    expect(scope("notes/my.gitignore")).toBe(false);
    expect(scope("notes/.gitignore.bak")).toBe(false);
  });
});

describe("§8.1.2 rule translation into the root file", () => {
  const t = (rule: string) => translateRule(rule, "dir1/dir2");

  it("a bare pattern gains the dir prefix and `**` — it matched at any depth", () => {
    // `build` in dir1/dir2/.gitignore matches build ANYWHERE below
    // dir1/dir2, and `**` matches zero directories too, so the root form
    // still covers dir1/dir2/build itself.
    expect(t("build")).toBe("dir1/dir2/**/build");
  });

  it("an ANCHORED pattern stays one level deep", () => {
    expect(t("/build")).toBe("/dir1/dir2/build");
  });

  it("dir-only trailing slash survives translation", () => {
    // Dropping it would widen a directory rule to files of the same
    // name — a different rule, silently.
    expect(t("build/")).toBe("dir1/dir2/**/build/");
    expect(t("/build/")).toBe("/dir1/dir2/build/");
  });

  it("🔑 an INTERNAL slash already means anchored, so it must not gain `**`", () => {
    // git's rule: a pattern containing a slash other than a trailing one
    // is relative to the .gitignore's own directory. Treating `a/b` like
    // a bare name would turn a one-place rule into an any-depth one.
    expect(t("a/b")).toBe("/dir1/dir2/a/b");
    // `**/x` is the same shape and already carries its own any-depth
    // semantics — prefixing is enough.
    expect(t("**/x")).toBe("/dir1/dir2/**/x");
  });

  it("negation is preserved, and lands before the path", () => {
    expect(t("!keep")).toBe("!dir1/dir2/**/keep");
    expect(t("!/keep")).toBe("!/dir1/dir2/keep");
  });

  it("🔑 a negated DOT-path is forced ANCHORED and glob-free", () => {
    // §8.1.2: this is the one place translation may not be literal.
    // `!dir1/dir2/**/.myconfig/` would be faithful, but addressedPath
    // REJECTS globs ("a glob addresses a shape, not a path"), so D7
    // would grant nothing and the rule would be inert — exactly what
    // the dot-space warning exists to shout about. Anchoring narrows it
    // to one depth, and that narrowing costs nothing real: the rule was
    // never honoured by this plugin at any depth before the migration.
    expect(t("!.myconfig/")).toBe("!/dir1/dir2/.myconfig/");
    expect(t("!.editorconfig")).toBe("!/dir1/dir2/.editorconfig");
    // Already anchored → unchanged in shape.
    expect(t("!/.myconfig/")).toBe("!/dir1/dir2/.myconfig/");
  });

  it("a NON-negated dot-pattern is not forced — nothing depends on it", () => {
    // The anchoring mandate is about GRANTING permission, which only a
    // `!`-rule does. A plain dot-pattern only hides, and hiding works
    // through the ordinary matcher where `**` is fine.
    expect(t(".cache")).toBe("dir1/dir2/**/.cache");
  });

  it("comments and blank lines pass through untouched", () => {
    // They are what makes the resulting conflict readable — the user has
    // to understand these rules well enough to accept or reject them.
    expect(t("# my rules")).toBe("# my rules");
    expect(t("")).toBe("");
    expect(t("   ")).toBe("");
  });

  it("🔑 a leading escape is dropped when it stops being leading", () => {
    // `\#foo` and `\!foo` escape a character that is only special at
    // position 0. After prefixing, `#`/`!` are ordinary — so keeping the
    // backslash would turn it into a LITERAL backslash in the pattern
    // and the rule would stop matching.
    expect(t("\\#foo")).toBe("dir1/dir2/**/#foo");
    expect(t("\\!foo")).toBe("dir1/dir2/**/!foo");
  });

  it("a one-segment dir works the same", () => {
    expect(translateRule("build", "notes")).toBe("notes/**/build");
    expect(translateRule("/build", "notes")).toBe("/notes/build");
  });
});

describe("translateFile — one source file becomes a labelled block", () => {
  it("emits a provenance header, then the translated rules in order", () => {
    // Order is preserved because gitignore is last-match-wins: reordering
    // rules within a file can invert their meaning.
    const out = translateFile("build\n/dist\n\n# keep\n!keep\n", "dir1");
    expect(out).toEqual([
      "# rules from dir1/.gitignore",
      "dir1/**/build",
      "/dir1/dist",
      "",
      "# keep",
      "!dir1/**/keep",
    ]);
  });

  it("a file with no rules at all yields nothing — not a bare header", () => {
    // A header with nothing under it would read as "these rules moved"
    // when none did.
    expect(translateFile("", "dir1")).toEqual([]);
    expect(translateFile("\n\n  \n", "dir1")).toEqual([]);
  });

  it("a comment-only file still yields nothing", () => {
    // Same reason: comments carry no rules, so nothing migrated. Keeping
    // them would add noise to a conflict the user must read carefully.
    expect(translateFile("# just a note\n", "dir1")).toEqual([]);
  });

  it("CRLF input does not leak carriage returns into the output", () => {
    // The vault is cross-platform and a Windows-authored .gitignore is
    // ordinary; a trailing \r would become part of the pattern.
    expect(translateFile("build\r\n/dist\r\n", "dir1")).toEqual([
      "# rules from dir1/.gitignore",
      "dir1/**/build",
      "/dir1/dist",
    ]);
  });
});

describe("§8.1.1a the walk: every directory, minus what git would not enter", () => {
  let root: string;
  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  function vaultWith(files: Record<string, string>): Vault {
    root = path.join(os.tmpdir(), `mig-walk-${crypto.randomBytes(4).toString("hex")}`);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    return new Vault(root);
  }

  // The production oracle is a GI honouring EVERY level; here it is a
  // fake so the walk's own logic is what gets tested.
  const ignoreDirs = (...dirs: string[]) => (relDir: string) =>
    dirs.some((d) => relDir === d || relDir.startsWith(`${d}/`));

  const walk = (vault: Vault, dirIgnored: (relDir: string) => boolean = () => false) =>
    findMigrationCandidates({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      dirIgnored,
    });

  it("finds nested .gitignore files at any depth, and never the root one", async () => {
    const vault = vaultWith({
      ".gitignore": ".*\n",
      "a/.gitignore": "x\n",
      "a/b/c/.gitignore": "y\n",
      "a/note.md": "hi",
    });
    const r = await walk(vault);
    expect(r.candidates.map((c) => c.path)).toEqual([
      "a/.gitignore",
      "a/b/c/.gitignore",
    ]);
    expect(r.completed).toBe(true);
  });

  it("🔑 orders candidates SHALLOWEST-FIRST — gitignore is last-match-wins", async () => {
    // Not cosmetic. Flattened into one file, a deeper rule must appear
    // LATER or it stops overriding the shallower one it overrode in git.
    const vault = vaultWith({
      "a/b/c/.gitignore": "deep\n",
      "a/.gitignore": "shallow\n",
      "z/.gitignore": "other\n",
      "a/b/.gitignore": "mid\n",
    });
    const r = await walk(vault);
    expect(r.candidates.map((c) => c.dir)).toEqual(["a", "z", "a/b", "a/b/c"]);
  });

  it("🔑 an IGNORED directory is not entered, so its .gitignore is not migrated", async () => {
    // Correctness, not speed (§8.1.1a): git never reads a `.gitignore`
    // inside an excluded directory, so its rules affect nothing today.
    // Migrating them to the root would ACTIVATE dead rules — changing
    // behaviour instead of preserving it.
    const vault = vaultWith({
      "keep/.gitignore": "x\n",
      "node_modules/.gitignore": "y\n",
      "node_modules/deep/nested/.gitignore": "z\n",
    });
    const r = await walk(vault, ignoreDirs("node_modules"));
    expect(r.candidates.map((c) => c.path)).toEqual(["keep/.gitignore"]);
    expect(r.dirsPruned).toBe(1);
  });

  it("…and pruning stops the DESCENT, not just the file", async () => {
    // The distinction that matters for cost: a pruned subtree is never
    // listed at all, which is what makes the worst case survivable.
    //
    // Measured as a DIFFERENCE rather than an absolute, which is also the
    // mistake the first version of this test made: it asserted "1 dir
    // scanned", forgetting that <configDir> is legitimately walked (that
    // is where plugins/.gitignore lives), so it failed on a correct
    // implementation.
    const files = { "big/a/b/c/d/.gitignore": "x\n", "big/f.md": "hi" };
    const pruned = await walk(vaultWith(files), ignoreDirs("big"));
    const full = await walk(vaultWith(files));

    expect(pruned.candidates).toEqual([]);
    expect(full.candidates.map((c) => c.path)).toEqual([
      "big/a/b/c/d/.gitignore",
    ]);
    // five directories of `big/` never listed at all.
    expect(full.dirsScanned - pruned.dirsScanned).toBe(5);
    expect(pruned.dirsPruned).toBe(1);
  });

  it("<configDir>/plugins/.gitignore is reached, and the whitelisted ones are not taken", async () => {
    const vault = vaultWith({
      [`${CONFIG_DIR}/.gitignore`]: "a\n",
      [`${CONFIG_DIR}/plugins/.gitignore`]: "b\n",
      [`${CONFIG_DIR}/plugins/brat/.gitignore`]: "c\n",
      [`${CONFIG_DIR}/plugins/brat/sub/.gitignore`]: "d\n",
    });
    const r = await walk(vault);
    expect(r.candidates.map((c) => c.path)).toEqual([
      `${CONFIG_DIR}/plugins/.gitignore`,
      `${CONFIG_DIR}/plugins/brat/sub/.gitignore`,
    ]);
  });

  it("dot-directories ARE walked — the walk covers hidden dirs too", async () => {
    // Unlike walkDotDir, which prunes dot-names by D3: this walk answers
    // "what would git honour", and git has no notion of hidden.
    // Whether a dot-dir survives is the PRUNER's decision, not the
    // walker's.
    const vault = vaultWith({ ".myconfig/.gitignore": "x\n" });
    const r = await walk(vault);
    expect(r.candidates.map((c) => c.path)).toEqual([".myconfig/.gitignore"]);
  });

  it("🔑 a walk that could not finish says so — the caller must not mark done", async () => {
    // An incomplete walk means "a .gitignore may have been missed", and
    // a migration that marks itself done on that basis would never look
    // again. Same contract walkDotDir already carries.
    const vault = vaultWith({ "a/.gitignore": "x\n" });
    const broken = {
      adapter: {
        list: async () => {
          throw new Error("EIO");
        },
      },
    };
    const r = await findMigrationCandidates({
      vault: broken as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      dirIgnored: () => false,
    });
    expect(r.completed).toBe(false);
    void vault;
  });
});
