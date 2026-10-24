// PLUGIN-UPDATE-COMPAT §5.11 — the version stamp of a managed section,
// and the rule that stops two plugin versions from overwriting each
// other's managed sections forever.
//
// The defect being closed: with identical markers, a device running v1
// sees v2's body, finds it "not canonical", rewrites it, pushes — and
// v2's device does the same in reverse, on every sync, with no
// user-visible cause.
//
// ⚙️ 2026-10-24 (owner): the stamp lives in its own VERSION LINE right
// under BEGIN; BEGIN and END are constants. A version inside BEGIN made a
// user rule right above it and a version bump two changes to ADJACENT
// lines — a merge conflict after every release (field, three vaults).

import { describe, it, expect } from "vitest";
import {
  beginMarker,
  endMarker,
  beginPattern,
  parseBeginMarker,
  newerVersionIn,
  ownedFileHeader,
  parseOwnedFileHeader,
  versionLine,
  versionLinePattern,
  withoutVersionLines,
  highestVersionIn,
  restampVersionLines,
} from "../../src/sync2/gitignore-markers";
import {
  assembleManagedSections,
  ManagedSection,
} from "../../src/sync2/gitignore-assemble";

describe("BEGIN and END are constants (2026-10-24)", () => {
  it("the BEGIN line carries no version", () => {
    expect(beginMarker("invariants")).toBe("# ===== git-easy-sync invariants - DO NOT EDIT =====");
    expect(beginMarker("final")).toBe("# ===== git-easy-sync final - DO NOT EDIT =====");
  });

  it("END is not versioned either", () => {
    expect(endMarker("invariants")).toBe("# ===== end of git-easy-sync invariants =====");
    expect(endMarker("final")).toBe("# ===== end of git-easy-sync final =====");
  });

  it("🔑 BEGIN is recognised by EXACT text only — a version inside it is not ours", () => {
    for (const kind of ["invariants", "final"] as const) {
      expect(parseBeginMarker(beginMarker(kind))).toEqual({ kind });
      expect(beginPattern(kind).test(beginMarker(kind))).toBe(true);
      // The dev-only spelling of 2026-09-30..10-24 — never released.
      expect(parseBeginMarker(`# ===== git-easy-sync ${kind} v2.1.0 - DO NOT EDIT =====`)).toBeNull();
    }
  });

  it("does not recognise someone else's marker, or a near miss", () => {
    expect(parseBeginMarker("# ===== github-easy-sync invariants - DO NOT EDIT =====")).toBeNull();
    expect(parseBeginMarker("# ===== git-easy-sync invariants — DO NOT EDIT =====")).toBeNull(); // em dash
    expect(parseBeginMarker("# ===== git-easy-sync invariants =====")).toBeNull();
    expect(parseBeginMarker(".*")).toBeNull();
  });

  it("the two kinds do not answer for each other", () => {
    expect(beginPattern("final").test(beginMarker("invariants"))).toBe(false);
  });
});

// §5.11 — a file that is OURS OUTRIGHT (no sections, no user content:
// <self>/.gitignore) has nowhere to put a section, but the same problem:
// two versions with different constants would rewrite it for each other
// forever. It gets a HEADER instead, carrying the stamp.
describe("the owned-file header (§5.11)", () => {
  it("says what the file is, and stamps who wrote it", () => {
    const header = ownedFileHeader("2.1.0");
    expect(header[0]).toBe("# ===== git-easy-sync v2.1.0 - managed file, DO NOT EDIT =====");
    expect(header.join("\n")).toContain("plugin's own folder");
  });

  it("is recognised whatever version wrote it — and NOT when it is someone else's line", () => {
    expect(parseOwnedFileHeader(ownedFileHeader("9.9.9")[0])).toBe("9.9.9");
    expect(parseOwnedFileHeader("# just a comment")).toBeNull();
    expect(parseOwnedFileHeader(beginMarker("invariants"))).toBeNull();
  });

  it("🔑 the SAME yield rule covers it — an older build leaves the file alone", () => {
    const newer = [...ownedFileHeader("9.9.9"), "*", "!main.js"].join("\n");
    expect(newerVersionIn(newer, "2.1.0")).toBe("9.9.9");
    expect(newerVersionIn(newer, "9.9.9")).toBeNull();
    expect(newerVersionIn("*\n!main.js\n", "2.1.0")).toBeNull();
  });
});

describe("the yield rule — an older plugin does not touch a newer section", () => {
  const fileAt = (version: string | null): string =>
    [
      beginMarker("invariants"),
      ...(version === null ? [] : [versionLine("invariants", version)]),
      ".*",
      endMarker("invariants"),
    ].join("\n");

  it("a NEWER stamp in the file wins — we report it and write nothing", () => {
    expect(newerVersionIn(fileAt("2.2.0"), "2.1.0")).toBe("2.2.0");
  });

  it("our own version, or older, does not yield", () => {
    expect(newerVersionIn(fileAt("2.1.0"), "2.1.0")).toBeNull();
    expect(newerVersionIn(fileAt("2.0.0"), "2.1.0")).toBeNull();
  });

  it("🔑 NO version line reads as v0 — we win", () => {
    expect(newerVersionIn(fileAt(null), "2.1.0")).toBeNull();
    expect(newerVersionIn("just user rules\n.*\n", "2.1.0")).toBeNull();
  });

  it("a prerelease of the same version is NOT newer", () => {
    expect(newerVersionIn(fileAt("2.1.0-beta"), "2.1.0")).toBeNull();
    expect(newerVersionIn(fileAt("2.1.0"), "2.1.0-beta")).toBe("2.1.0");
  });

  it("🔑 a GARBAGE stamp does not win — it would have no way out", () => {
    expect(newerVersionIn(fileAt("not-a-version"), "2.1.0")).toBeNull();
  });

  it("the HIGHEST stamp in the file decides, whichever section carries it", () => {
    const mixed = [
      beginMarker("invariants"),
      versionLine("invariants", "2.1.0"),
      ".*",
      endMarker("invariants"),
      "",
      beginMarker("final"),
      versionLine("final", "3.0.0"),
      "!.obsidian/",
      endMarker("final"),
    ].join("\n");
    expect(newerVersionIn(mixed, "2.1.0")).toBe("3.0.0");
  });
});

const sectionAt = (version: string, body: string): ManagedSection => ({
  begin: beginMarker("invariants"),
  beginPattern: beginPattern("invariants"),
  version: { line: versionLine("invariants", version), pattern: versionLinePattern() },
  end: endMarker("invariants"),
  body,
});

// ── The reason all of the above exists ──────────────────────────────
describe("🔴 alternating enforce between two plugin versions CONVERGES", () => {
  const OLD = { version: "2.0.0", body: ".*\n!/.gitignore" };
  const NEW = { version: "2.1.0", body: ".*\n!/.gitignore\n!/.editorconfig" };

  // One device's pass: yield if the file is newer, otherwise assemble.
  const pass = (content: string, v: { version: string; body: string }) => {
    if (newerVersionIn(content, v.version) !== null) return content;
    return assembleManagedSections(content, { invariants: sectionAt(v.version, v.body) }).content;
  };

  it("settles after the newer version has written once, and stays settled", () => {
    let c = pass("user.md\n", OLD);
    c = pass(c, NEW);
    const settled = c;
    for (let i = 0; i < 4; i++) {
      c = pass(c, OLD);
      expect(c).toBe(settled);
      c = pass(c, NEW);
      expect(c).toBe(settled);
    }
    expect(settled).toContain("!/.editorconfig");
    expect(settled).toContain(versionLine("invariants", "2.1.0"));
  });

  it("the older device leaves the newer section EXACTLY as it found it", () => {
    const newerFile = pass("user.md\n", NEW);
    expect(pass(newerFile, OLD)).toBe(newerFile);
  });

  it("🔑 without the version line the same pair never settles", () => {
    const unstamped = (body: string): ManagedSection => ({
      begin: beginMarker("invariants"),
      beginPattern: beginPattern("invariants"),
      end: endMarker("invariants"),
      body,
    });
    const blind = (content: string, body: string) =>
      assembleManagedSections(content, { invariants: unstamped(body) }).content;
    let c = blind("user.md\n", OLD.body);
    const afterOld = c;
    c = blind(c, NEW.body);
    expect(c).not.toBe(afterOld);
    c = blind(c, OLD.body);
    expect(c).toBe(afterOld); // back where it started — a closed cycle
  });
});

describe("another version's VERSION LINE is replaced, never duplicated", () => {
  it("🔑 an older section is rewritten: one version line, ours", () => {
    const stale = [
      beginMarker("invariants"),
      versionLine("invariants", "2.0.0"),
      "old-rule",
      endMarker("invariants"),
      "user.md",
    ].join("\n");
    const r = assembleManagedSections(stale, { invariants: sectionAt("2.1.0", ".*") });
    expect(r.content).not.toContain(versionLine("invariants", "2.0.0"));
    expect(r.content).toContain(versionLine("invariants", "2.1.0"));
    expect(r.content).not.toContain("old-rule");
    expect(r.content).toContain("user.md");
    expect(r.content.split("\n").filter((l) => versionLinePattern().test(l))).toHaveLength(1);
  });

  it("a STRAY version line elsewhere is removed AND reported", () => {
    const input = [
      beginMarker("invariants"),
      versionLine("invariants", "2.1.0"),
      ".*",
      endMarker("invariants"),
      "",
      "user.md",
      versionLine("invariants", "1.0.0"), // stray
    ].join("\n");
    const r = assembleManagedSections(input, { invariants: sectionAt("2.1.0", ".*") });
    expect(r.content).not.toContain(versionLine("invariants", "1.0.0"));
    expect(r.removed).toEqual([versionLine("invariants", "2.1.0")]);
    expect(r.content).toContain("user.md");
  });

  it("both sections' version lines count TOGETHER — no false 'removed' report", () => {
    const final: ManagedSection = {
      begin: beginMarker("final"),
      beginPattern: beginPattern("final"),
      version: { line: versionLine("final", "2.1.0"), pattern: versionLinePattern() },
      end: endMarker("final"),
      body: "*.conflict-from-*",
    };
    const once = assembleManagedSections("user.md\n", { invariants: sectionAt("2.1.0", ".*"), final });
    const twice = assembleManagedSections(once.content, { invariants: sectionAt("2.1.0", ".*"), final });
    expect(twice.content).toBe(once.content);
    expect(twice.removed).toEqual([]);
  });
});

// Owner, 2026-10-24: a difference only in version lines is not a conflict.
describe("comparing / merging across version lines", () => {
  const file = (v: string, eol = "\n") =>
    [beginMarker("final"), versionLine("final", v), "*.x", endMarker("final")].join(eol);

  it("🔑 two files differing only in the version compare equal without the version lines", () => {
    expect(withoutVersionLines(file("2.0.3-beta"))).toBe(withoutVersionLines(file("2.0.9-beta")));
    expect(withoutVersionLines(file("2.0.3-beta"))).not.toBe(withoutVersionLines(file("2.0.3-beta") + "\n*.y"));
  });

  it("the highest readable version wins; garbage never does", () => {
    expect(highestVersionIn(file("2.0.3-beta"), file("2.0.10-beta"))).toBe("2.0.10-beta");
    expect(highestVersionIn(file("not-a-version"))).toBeNull();
    expect(highestVersionIn("no version lines")).toBeNull();
  });

  it("🔑 restamping re-renders each version line under its BEGIN, aligned for that kind; CRLF kept", () => {
    expect(restampVersionLines(withoutVersionLines(file("2.0.3-beta")), "2.0.9-beta")).toBe(file("2.0.9-beta"));
    expect(restampVersionLines(withoutVersionLines(file("2.0.3-beta", "\r\n")), "2.0.9-beta")).toBe(
      file("2.0.9-beta", "\r\n"),
    );
    // A version line NOT under a BEGIN is left alone.
    expect(restampVersionLines(versionLine("final", "1.0.0"), "2.0.0")).toBe(versionLine("final", "1.0.0"));
  });
});
