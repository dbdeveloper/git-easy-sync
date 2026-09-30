// PLUGIN-UPDATE-COMPAT §5.11 — the version stamp in the BEGIN marker,
// and the rule that stops two plugin versions from overwriting each
// other's managed sections forever.
//
// The defect being closed: markers are identical across versions, so a
// device running v1 sees v2's body, finds it "not canonical", rewrites
// it, pushes — and v2's device does the same in reverse, on every sync,
// with no user-visible cause. `.obsidian/` resolves silently, so nobody
// is ever told.

import { describe, it, expect } from "vitest";
import {
  beginMarker,
  endMarker,
  beginPattern,
  parseBeginMarker,
  newerSectionVersion,
} from "../../src/sync2/gitignore-markers";
import {
  assembleManagedSections,
  ManagedSection,
} from "../../src/sync2/gitignore-assemble";

describe("the BEGIN marker carries the version (§5.11)", () => {
  it("writes the version, and the unversioned form is still the same line as before", () => {
    expect(beginMarker("invariants", "2.1.0")).toBe(
      "# ===== git-easy-sync invariants v2.1.0 - DO NOT EDIT =====",
    );
    // 🔒 The pre-stamp spelling, byte for byte. Everything already on
    // disk and in every repo is written this way.
    expect(beginMarker("invariants", null)).toBe(
      "# ===== git-easy-sync invariants - DO NOT EDIT =====",
    );
    expect(beginMarker("final", "2.1.0")).toBe(
      "# ===== git-easy-sync final v2.1.0 - DO NOT EDIT =====",
    );
  });

  it("END is NOT versioned — one carrier of the value, by decision", () => {
    expect(endMarker("invariants")).toBe(
      "# ===== end of git-easy-sync invariants =====",
    );
    expect(endMarker("final")).toBe("# ===== end of git-easy-sync final =====");
  });

  it("🔒 the recognizer accepts BOTH forms — that is the whole contract", () => {
    for (const kind of ["invariants", "final"] as const) {
      expect(parseBeginMarker(beginMarker(kind, null))).toEqual({
        kind,
        version: null,
      });
      expect(parseBeginMarker(beginMarker(kind, "2.1.0"))).toEqual({
        kind,
        version: "2.1.0",
      });
      // ...and a version this build has never heard of, which is the
      // case the rule exists for.
      expect(parseBeginMarker(beginMarker(kind, "99.0.0-beta7"))).toEqual({
        kind,
        version: "99.0.0-beta7",
      });
      expect(beginPattern(kind).test(beginMarker(kind, "2.1.0"))).toBe(true);
    }
  });

  it("does not recognise someone else's marker, or a near miss", () => {
    expect(
      parseBeginMarker("# ===== github-easy-sync invariants - DO NOT EDIT ====="),
    ).toBeNull();
    expect(
      parseBeginMarker("# ===== git-easy-sync invariants — DO NOT EDIT ====="),
    ).toBeNull(); // em dash: the pre-2026-09-21 form, deliberately foreign
    expect(parseBeginMarker("# ===== git-easy-sync invariants =====")).toBeNull();
    expect(parseBeginMarker(".*")).toBeNull();
  });

  it("the two kinds do not answer for each other", () => {
    expect(beginPattern("final").test(beginMarker("invariants", "2.1.0"))).toBe(
      false,
    );
  });
});

describe("the yield rule — an older plugin does not touch a newer section", () => {
  const fileAt = (version: string | null): string =>
    [beginMarker("invariants", version), ".*", endMarker("invariants")].join(
      "\n",
    );

  it("a NEWER stamp in the file wins — we report it and write nothing", () => {
    expect(newerSectionVersion(fileAt("2.2.0"), "2.1.0")).toBe("2.2.0");
  });

  it("our own version, or older, does not yield", () => {
    expect(newerSectionVersion(fileAt("2.1.0"), "2.1.0")).toBeNull();
    expect(newerSectionVersion(fileAt("2.0.0"), "2.1.0")).toBeNull();
  });

  it("🔑 NO stamp reads as v0 — we win, and the pre-stamp body gets updated", () => {
    // The opposite choice ("unknown → leave alone") would freeze every
    // file written before the stamp existed, forever.
    expect(newerSectionVersion(fileAt(null), "2.1.0")).toBeNull();
    expect(newerSectionVersion("just user rules\n.*\n", "2.1.0")).toBeNull();
  });

  it("a prerelease of the same version is NOT newer", () => {
    expect(newerSectionVersion(fileAt("2.1.0-beta"), "2.1.0")).toBeNull();
    expect(newerSectionVersion(fileAt("2.1.0"), "2.1.0-beta")).toBe("2.1.0");
  });

  it("🔑 a GARBAGE stamp does not win — it would have no way out", () => {
    // Yielding to an unreadable version freezes the file until someone
    // edits it by hand; writing over it restores a canonical stamp on
    // the spot. Same direction as §7.1.1 for a corrupt manifest.
    expect(newerSectionVersion(fileAt("not-a-version"), "2.1.0")).toBeNull();
  });

  it("the HIGHEST stamp in the file decides, whichever section carries it", () => {
    const mixed = [
      beginMarker("invariants", "2.1.0"),
      ".*",
      endMarker("invariants"),
      "",
      beginMarker("final", "3.0.0"),
      "!.obsidian/",
      endMarker("final"),
    ].join("\n");
    expect(newerSectionVersion(mixed, "2.1.0")).toBe("3.0.0");
  });
});

// ── The reason all of the above exists ──────────────────────────────
//
// Two plugin versions with DIFFERENT bodies, alternating over one file.
// This is the ping-pong of §5.11 reproduced end to end at the pure
// layer: without the rule it never settles, and every round is a commit
// nobody asked for.
describe("🔴 alternating enforce between two plugin versions CONVERGES", () => {
  const sectionAt = (version: string, body: string): ManagedSection => ({
    begin: beginMarker("invariants", version),
    beginPattern: beginPattern("invariants"),
    end: endMarker("invariants"),
    body,
  });

  const OLD = { version: "2.0.0", body: ".*\n!/.gitignore" };
  const NEW = { version: "2.1.0", body: ".*\n!/.gitignore\n!/.editorconfig" };

  // One device's pass: yield if the file is newer, otherwise assemble.
  const pass = (content: string, v: { version: string; body: string }) => {
    if (newerSectionVersion(content, v.version) !== null) return content;
    return assembleManagedSections(content, {
      invariants: sectionAt(v.version, v.body),
    }).content;
  };

  it("settles after the newer version has written once, and stays settled", () => {
    let c = pass("user.md\n", OLD);
    c = pass(c, NEW);
    const settled = c;
    // Now hammer it: old, new, old, new... nothing may move again.
    for (let i = 0; i < 4; i++) {
      c = pass(c, OLD);
      expect(c).toBe(settled);
      c = pass(c, NEW);
      expect(c).toBe(settled);
    }
    expect(settled).toContain("!/.editorconfig");
    expect(settled).toContain(beginMarker("invariants", "2.1.0"));
  });

  it("the older device leaves the newer section EXACTLY as it found it", () => {
    const newerFile = pass("user.md\n", NEW);
    expect(pass(newerFile, OLD)).toBe(newerFile);
  });

  it("🔑 without the version stamp the same pair never settles", () => {
    // The defect itself, pinned: same markers, different bodies, no
    // stamp to arbitrate — each pass undoes the other, forever.
    const unstamped = (body: string): ManagedSection => ({
      begin: beginMarker("invariants", null),
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

describe("an older version's section is REPLACED, not left behind", () => {
  it("the stale BEGIN line does not survive as litter", () => {
    // Before the recognizer this was the failure mode: the old BEGIN
    // matched nothing, so the new one was inserted above it and the old
    // line stayed in user space — a marker with no section, able to
    // confuse the next pass and every reader.
    const stale = [
      beginMarker("invariants", "2.0.0"),
      "old-rule",
      endMarker("invariants"),
      "user.md",
    ].join("\n");
    const r = assembleManagedSections(stale, {
      invariants: {
        begin: beginMarker("invariants", "2.1.0"),
        beginPattern: beginPattern("invariants"),
        end: endMarker("invariants"),
        body: ".*",
      },
    });
    expect(r.content).not.toContain(beginMarker("invariants", "2.0.0"));
    expect(r.content).toContain(beginMarker("invariants", "2.1.0"));
    expect(r.content).not.toContain("old-rule");
    expect(r.content).toContain("user.md");
    // The pair was found, so the interior was dropped as a unit.
    expect(r.replacedSections).toEqual([beginMarker("invariants", "2.1.0")]);
  });
});
