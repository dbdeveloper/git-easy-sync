// PLUGIN-UPDATE-COMPAT §5.11 — the ONE semver comparison in the plugin.
//
// Three consumers depend on it being right, and each of them fails
// SILENTLY when it is wrong: the managed-section yield rule (§5.11), the
// `requireApiVersion` mock behind Phase 1's tests (§6.0), and the
// plugin-core semver resolver (§5.12.5). A comparison that is merely
// "close enough" produces a plugin that quietly overwrites the newer
// side — so the table below is deliberately more thorough than the
// three call sites strictly need.

import { describe, it, expect } from "vitest";
import { compareSemver } from "../../src/sync2/semver";

// Direction helper: reads like the claim it makes.
const lt = (a: string, b: string) => expect(compareSemver(a, b)).toBeLessThan(0);
const gt = (a: string, b: string) =>
  expect(compareSemver(a, b)).toBeGreaterThan(0);
const eq = (a: string, b: string) => expect(compareSemver(a, b)).toBe(0);

describe("compareSemver", () => {
  it("compares numerically, not lexically", () => {
    lt("1.9.0", "1.10.0");
    lt("2.0.9", "2.0.10");
    gt("10.0.0", "9.9.9");
  });

  it("🔑 does NOT collapse to major.minor — the §6.2.4 trap", () => {
    // A truncating comparison folds both into "1.13" and calls them
    // equal, which is exactly the false-pass the reload gate must not
    // have: the plugin asks for 1.13.4 and we are on 1.13.0.
    lt("1.13.0", "1.13.4");
    gt("1.13.4", "1.13.0");
  });

  it("orders the three fields by significance", () => {
    lt("1.12.9", "1.13.0");
    gt("2.0.0", "1.99.99");
  });

  it("🔑 a prerelease is LOWER than the release it leads to", () => {
    lt("2.0.3-beta", "2.0.3");
    gt("2.0.3", "2.0.3-beta");
    // ...and still higher than the previous release.
    gt("2.0.3-beta", "2.0.2");
  });

  it("orders prerelease identifiers — numeric parts numerically", () => {
    // Lexically "beta10" < "beta2"; by identifier it is not.
    lt("2.0.3-beta.2", "2.0.3-beta.10");
    lt("2.0.3-alpha", "2.0.3-beta");
    // Fewer identifiers sort first when the common prefix is equal.
    lt("2.0.3-beta", "2.0.3-beta.1");
  });

  it("treats a bare numeric suffix like the identifier it is", () => {
    // Our own tags are spelled `2.0.3-beta2`, not `2.0.3-beta.2` — the
    // suffix must still order sensibly against its siblings.
    lt("2.0.3-beta2", "2.0.3-beta10");
    lt("2.0.3-beta2", "2.0.3");
  });

  it("is tolerant of the forms it will actually meet", () => {
    eq("v2.1.0", "2.1.0"); // a leading v
    eq("2.1", "2.1.0"); // missing patch
    eq("2", "2.0.0");
    eq("2.1.0+build7", "2.1.0"); // build metadata is not precedence
    eq(" 2.1.0 ", "2.1.0"); // surrounding whitespace
  });

  it("garbage is not a version — and must not read as 0", () => {
    // `null` is the caller's signal to fall back, never a silent zero:
    // a corrupt stamp that compares as 0.0.0 would make every device
    // "newer" and hand the file to whoever wrote garbage last.
    expect(compareSemver("", "2.1.0")).toBeNull();
    expect(compareSemver("not-a-version", "2.1.0")).toBeNull();
    expect(compareSemver("2.1.0", "¯\\_(ツ)_/¯")).toBeNull();
  });

  it("equal is equal, including across spellings", () => {
    eq("2.1.0", "2.1.0");
    eq("2.1.0-beta", "2.1.0-beta");
  });
});
