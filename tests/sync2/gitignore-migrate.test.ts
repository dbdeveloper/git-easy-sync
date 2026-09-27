// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// DOT-FILES §8.1 Крок E2 — the pure half of the migration: which
// `.gitignore` files must move, and what each of their rules becomes
// once it lives in the root file instead.

import { describe, it, expect } from "vitest";
import {
  needsMigration,
  translateRule,
  translateFile,
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
