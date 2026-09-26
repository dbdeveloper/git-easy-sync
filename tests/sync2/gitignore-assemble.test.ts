// DOT-FILES §3.1.5 — line-wise assembly of the managed sections.
//
// Pure, so every property is asserted on bytes. The two that matter most
// are IDEMPOTENCE (a second pass is a no-op) and CONVERGENCE (any
// damaged input reaches canonical form in one pass) — the block model
// could promise neither without its orphan-repair state.

import { describe, it, expect } from "vitest";
import {
  assembleManagedSections,
  ManagedSection,
} from "../../src/sync2/gitignore-assemble";

// Shapes deliberately close to the real ones: the top section carries a
// blank line in the middle (the blank-line hazard), and BOTH sections
// share their second line (the order dependency).
const SHARED = "# Editing this block triggers a rewrite to canonical on next load.";

const TOP: ManagedSection = {
  begin: "# ===== plugin invariants - DO NOT EDIT =====",
  end: "# ===== end of plugin invariants =====",
  body: [SHARED, "", ".*", ".*/", "", "!/.gitignore"].join("\n"),
};

const BOTTOM: ManagedSection = {
  begin: "# ===== plugin final - DO NOT EDIT =====",
  end: "# ===== end of plugin final =====",
  body: [SHARED, "", "!.obsidian/", "*.conflict-from-*"].join("\n"),
};

const both = { invariants: TOP, final: BOTTOM };
const run = (input: string) => assembleManagedSections(input, both);

// The canonical form, derived the only honest way: from the assembler
// itself over empty input. §8.0's seed marker compares BYTES, so a
// hand-written expectation here would be a second source of truth and
// the two would drift.
const CANONICAL = run("").content;

describe("assembleManagedSections (§3.1.5)", () => {
  it("builds both sections from nothing, top at line 1, bottom at EOF", () => {
    const lines = CANONICAL.split("\n");
    expect(lines[0]).toBe(TOP.begin);
    expect(lines[1]).toBe(SHARED);
    expect(lines[7]).toBe(TOP.end); // begin + 6 body lines
    // exactly one trailing newline, and the bottom marker is last
    expect(CANONICAL.endsWith(`${BOTTOM.end}\n`)).toBe(true);
    expect(CANONICAL.endsWith("\n\n")).toBe(false);
  });

  it("🔑 IDEMPOTENT: a second pass changes nothing", () => {
    expect(run(CANONICAL).content).toBe(CANONICAL);
    expect(run(CANONICAL).removed).toEqual([]);
  });

  it("🔑 ORDER: the line shared by BOTH sections survives in both", () => {
    // The top pass purges every occurrence — including the bottom's —
    // and the bottom pass recreates it as missing. Swap the passes and
    // the bottom section loses its first line, silently.
    const occurrences = CANONICAL.split("\n").filter((l) => l === SHARED);
    expect(occurrences).toHaveLength(2);
    const topIdx = CANONICAL.split("\n").indexOf(TOP.begin);
    const botIdx = CANONICAL.split("\n").indexOf(BOTTOM.begin);
    const sharedIdxs = CANONICAL.split("\n")
      .map((l, i) => (l === SHARED ? i : -1))
      .filter((i) => i >= 0);
    expect(sharedIdxs[0]).toBe(topIdx + 1);
    expect(sharedIdxs[1]).toBe(botIdx + 1);
  });

  it("CONVERGES from shuffled lines — no marker pair needed", () => {
    const shuffled = [".*/", TOP.end, "user.md", TOP.begin, ".*"].join("\n");
    expect(run(shuffled).content).toBe(
      CANONICAL.replace(`${TOP.end}\n`, `${TOP.end}\nuser.md\n`),
    );
  });

  it("CONVERGES from an ORPHANED begin — the case orphan-repair existed for", () => {
    // A lone BEGIN with a stale body below it. The block model needed a
    // recorded {sha,len} to find where that body ended, and refused to
    // guess when it did not match.
    const orphan = [TOP.begin, "stale-rule", ".*"].join("\n");
    const r = run(orphan);
    expect(r.content.split("\n")[0]).toBe(TOP.begin);
    expect(r.content).toContain("stale-rule"); // user space, not deleted
    expect(r.replacedSections).toEqual([]); // no pair → no interior drop
  });

  it("MIGRATES a section whose BOTH markers are present: interior replaced wholesale", () => {
    const old = [
      TOP.begin,
      "# some older version's text",
      "old-rule-1",
      "old-rule-2",
      TOP.end,
      "user.md",
    ].join("\n");
    const r = run(old);
    expect(r.replacedSections).toEqual([TOP.begin]);
    expect(r.content).not.toContain("old-rule-1");
    expect(r.content).toContain("user.md");
  });

  it("an OLD version's markers are NOT ours — they stay in user space", () => {
    // Different marker text (an em dash, the previous plugin name) is
    // not found, so nothing is spliced; the rules that match ours
    // textually are drawn into place and the rest is left alone.
    const old = [
      "# ===== old-plugin invariants — DO NOT EDIT =====",
      ".*",
      "# ===== end of old-plugin invariants =====",
    ].join("\n");
    const r = run(old);
    expect(r.content).toContain("# ===== old-plugin invariants — DO NOT EDIT =====");
    expect(r.replacedSections).toEqual([]);
    // `.*` was ours, so it moved into the top block and left user space.
    const userPart = r.content
      .split(TOP.end)[1]
      .split(BOTTOM.begin)[0];
    expect(userPart).not.toContain("\n.*\n");
  });

  it("a duplicate of our rule in user space is REMOVED and REPORTED", () => {
    const input = [CANONICAL.trimEnd(), "", ".*"].join("\n");
    const r = run(input);
    expect(r.removed).toEqual([".*"]);
    expect(r.content).toBe(CANONICAL);
  });

  it("trailing whitespace does not hide a duplicate — git ignores it too", () => {
    const r = run([CANONICAL.trimEnd(), "", ".*   "].join("\n"));
    expect(r.removed).toEqual([".*"]);
  });

  it("an INDENTED line is a different rule and survives — leading space is part of the pattern", () => {
    const r = run([CANONICAL.trimEnd(), "", "  .*"].join("\n"));
    expect(r.removed).toEqual([]);
    expect(r.content).toContain("  .*");
  });
});

describe("§3.1.5 blank-line handling", () => {
  it("🔑 the user's own double blank lines SURVIVE — we do not reformat the file", () => {
    // The first answer to "a deleted duplicate leaves two blanks" was a
    // global collapse; it was rejected precisely because it touched
    // blanks the user put there and we never broke.
    const user = ["a.md", "", "", "b.md"].join("\n");
    const r = run(user);
    expect(r.content).toContain("a.md\n\n\nb.md");
  });

  it("rule 1: a neighbour with text → only the line goes", () => {
    const r = run(["a.md", ".*", "b.md"].join("\n"));
    expect(r.content).toContain("a.md\nb.md");
  });

  it("rule 1: blank above, text below → only the line goes, the blank still separates", () => {
    const r = run(["a.md", "", ".*", "b.md"].join("\n"));
    expect(r.content).toContain("a.md\n\nb.md");
  });

  it("rule 2: blank above AND below → the line and ONE blank go", () => {
    const r = run(["a.md", "", ".*", "", "b.md"].join("\n"));
    expect(r.content).toContain("a.md\n\nb.md");
    expect(r.content).not.toContain("a.md\n\n\nb.md");
  });

  it("rule 2 CONVERGES over consecutive deletions — our own `.*` / `.*/` are adjacent", () => {
    // The first takes rule 1 (text below), the second rule 2. Exactly
    // one blank must remain, not two and not zero.
    const r = run(["a.md", "", ".*", ".*/", "", "b.md"].join("\n"));
    expect(r.content).toContain("a.md\n\nb.md");
  });

  it("a file holding ONLY our lines is absorbed whole — no user space is invented", () => {
    // Nothing here is the user's: a blank carries no meaning in
    // gitignore, and `.*` is our rule. So both are drawn into the block
    // and NOTHING is destroyed — the deletion rules never even run.
    const r = run(["", ".*", ""].join("\n"));
    expect(r.removed).toEqual([]);
    expect(r.content).toBe(CANONICAL);
  });

  it("rule 1 at the TOP of user space: the line above is ours, so only the duplicate goes", () => {
    // The boundary case cannot arise for a deletion — every deletion
    // happens below content we have already placed, so "above" is never
    // the edge of the file. What this pins is that the blank BELOW the
    // duplicate survives, because rule 2 needs blanks on BOTH sides.
    const user = [".*", "", "a.md"].join("\n");
    const r = run([CANONICAL.trimEnd(), user].join("\n"));
    expect(r.removed).toEqual([".*"]);
    const tail = r.content.split(TOP.end)[1];
    expect(tail.startsWith("\n\na.md")).toBe(true);
  });
});


describe("§3.1.5 single-section files", () => {
  it("a file with ONLY a final section anchors it to EOF and leaves the top alone", () => {
    const r = assembleManagedSections("user.md\n", { final: BOTTOM });
    expect(r.content.startsWith("user.md\n")).toBe(true);
    expect(r.content.endsWith(`${BOTTOM.end}\n`)).toBe(true);
    expect(r.content).not.toContain(TOP.begin);
  });

  it("…and is idempotent too", () => {
    const once = assembleManagedSections("user.md\n", { final: BOTTOM }).content;
    expect(assembleManagedSections(once, { final: BOTTOM }).content).toBe(once);
  });
});
