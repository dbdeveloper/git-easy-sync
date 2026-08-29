import { describe, it, expect } from "vitest";
import {
  buildConflictBranchName,
  isConflictBranchName,
  CONFLICT_BRANCH_PREFIX,
} from "../../src/sync2/conflict-branch";

// Conflict-branch naming tests. See src/sync2/conflict-branch.ts
// + docs/PSEUDO-MERGE-MODE.md §4.3.

describe("buildConflictBranchName", () => {
  const TS = Date.UTC(2026, 4, 20, 14, 30, 22, 847);

  it("shape: prefix + label + YYYYMMDDHHMMSS + mmm", () => {
    expect(buildConflictBranchName("Obsidian", TS)).toBe(
      "git-easy-sync-conflicts-Obsidian-20260520143022-847",
    );
  });

  it("UTC formatting is stable regardless of host TZ", () => {
    // Same instant should produce the same name on any machine.
    const a = buildConflictBranchName("Phone", TS);
    const b = buildConflictBranchName("Phone", TS);
    expect(a).toBe(b);
  });

  it("zero-pads milliseconds to 3 digits", () => {
    const ts3 = Date.UTC(2026, 0, 1, 0, 0, 0, 3);
    expect(buildConflictBranchName("X", ts3)).toBe(
      "git-easy-sync-conflicts-X-20260101000000-003",
    );
    const ts50 = Date.UTC(2026, 0, 1, 0, 0, 0, 50);
    expect(buildConflictBranchName("X", ts50)).toBe(
      "git-easy-sync-conflicts-X-20260101000000-050",
    );
  });

  it("zero-pads month/day/hour/minute/second", () => {
    const ts = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // January 1, 00:00:00.000
    expect(buildConflictBranchName("X", ts)).toBe(
      "git-easy-sync-conflicts-X-20260101000000-000",
    );
  });

  it("two calls within the same second but different msec produce distinct names", () => {
    const a = buildConflictBranchName("X", TS);
    const b = buildConflictBranchName("X", TS + 1);
    expect(a).not.toBe(b);
    expect(a).toBe("git-easy-sync-conflicts-X-20260520143022-847");
    expect(b).toBe("git-easy-sync-conflicts-X-20260520143022-848");
  });

  describe("label sanitization", () => {
    it("preserves ASCII letters, digits, underscore, dash", () => {
      expect(buildConflictBranchName("Phone_2-A", TS)).toBe(
        "git-easy-sync-conflicts-Phone_2-A-20260520143022-847",
      );
    });

    it("replaces spaces with underscores", () => {
      expect(buildConflictBranchName("My Phone", TS)).toBe(
        "git-easy-sync-conflicts-My_Phone-20260520143022-847",
      );
    });

    it("replaces parens / dots / slashes / colons / special chars", () => {
      // Trailing-paren collapses to `_`, then trimmed by the rule
      // that strips trailing `_` from the label.
      expect(buildConflictBranchName("device (one of three)", TS)).toBe(
        "git-easy-sync-conflicts-device__one_of_three-20260520143022-847",
      );
      expect(buildConflictBranchName("phone.local", TS)).toBe(
        "git-easy-sync-conflicts-phone_local-20260520143022-847",
      );
    });

    it("non-ASCII unicode collapses to underscores, which then trim", () => {
      // "старий-laptop" → all Cyrillic → "______-laptop" → after
      // trim of leading `_` → "laptop".
      expect(buildConflictBranchName("старий-laptop", TS)).toBe(
        "git-easy-sync-conflicts-laptop-20260520143022-847",
      );
    });

    it("trims leading/trailing dashes and underscores from the sanitized label", () => {
      expect(buildConflictBranchName("__Phone__", TS)).toBe(
        "git-easy-sync-conflicts-Phone-20260520143022-847",
      );
      expect(buildConflictBranchName("--A--", TS)).toBe(
        "git-easy-sync-conflicts-A-20260520143022-847",
      );
    });

    it("empty / whitespace-only labels fall back to 'unknown'", () => {
      expect(buildConflictBranchName("", TS)).toBe(
        "git-easy-sync-conflicts-unknown-20260520143022-847",
      );
      expect(buildConflictBranchName("   ", TS)).toBe(
        "git-easy-sync-conflicts-unknown-20260520143022-847",
      );
      expect(buildConflictBranchName("///", TS)).toBe(
        "git-easy-sync-conflicts-unknown-20260520143022-847",
      );
    });
  });
});

describe("isConflictBranchName", () => {
  it("recognizes names produced by buildConflictBranchName", () => {
    const name = buildConflictBranchName("Phone", Date.UTC(2026, 0, 1));
    expect(isConflictBranchName(name)).toBe(true);
  });

  it("rejects unrelated branch names", () => {
    expect(isConflictBranchName("main")).toBe(false);
    expect(isConflictBranchName("feature/foo")).toBe(false);
    expect(isConflictBranchName("easy-sync-other")).toBe(false);
    expect(isConflictBranchName("")).toBe(false);
  });

  it("matches the prefix exactly (not as substring)", () => {
    expect(isConflictBranchName(`foo-${CONFLICT_BRANCH_PREFIX}bar`)).toBe(false);
  });
});
