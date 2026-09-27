// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// The one-way dependency between the engine and the conflict UI, enforced
// by a test instead of by attention.
//
// The rule (.claude/rules/diff2-ui.md): `src/diff2/` MAY import from
// `src/sync2/`, and `src/sync2/` must NEVER import from `src/diff2/`. It
// keeps the engine buildable and testable without the UI — which is what
// the integration suite relies on — and preserves the option of shipping
// diff2 as a separate plugin later.
//
// ⚠️ Why this file exists: the rule was broken during Крок E5
// (`findGitignoreDisputes` was written in `src/sync2/` and reached for
// `../diff2/strip-conflict-suffix`), and NOTHING caught it. `tsc` is
// happy — the import resolves — and every test passed, because the code
// worked. An architectural rule that only lives in a document is enforced
// by whoever happens to remember it. Now a violation fails the build.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..", "src");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

// Every module specifier a file imports, in any of the four forms that can
// create a real edge. Matching the SPECIFIER rather than the raw text is
// what keeps a comment mentioning `diff2/` from failing the test.
function importedModules(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import … from "x" / export … from "x"
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
    /\bimport\s+["']([^"']+)["']/g, // bare side-effect import "x"
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const crossesInto = (specifier: string, layer: string): boolean =>
  new RegExp(`(^|/)${layer}/`).test(specifier);

describe("engine ↔ conflict-UI dependency direction", () => {
  const engineFiles = tsFilesUnder(path.join(SRC, "sync2"));
  const uiFiles = tsFilesUnder(path.join(SRC, "diff2"));

  it("finds both layers — otherwise everything below passes vacuously", () => {
    // The guard that matters most in a test like this. If the directory
    // walk silently returned nothing, every assertion would pass while
    // checking no code at all — the exact failure mode this repo has been
    // bitten by before (a green suite asserting nothing).
    expect(engineFiles.length).toBeGreaterThan(20);
    expect(uiFiles.length).toBeGreaterThan(5);
  });

  it("🔑 no file under src/sync2/ imports from src/diff2/", () => {
    const offenders: string[] = [];
    for (const file of engineFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const specifier of importedModules(source)) {
        if (crossesInto(specifier, "diff2")) {
          offenders.push(`${path.relative(SRC, file)} → ${specifier}`);
        }
      }
    }
    // Named in the failure so the fix is obvious: MOVE the code to the
    // layer it belongs in. Re-exporting it through a third file, copying
    // the helper, or injecting it as a parameter all keep the coupling and
    // only hide it — the rule calls that bridging and forbids it.
    expect(offenders, "sync2 must not depend on diff2").toEqual([]);
  });

  it("…and the reverse direction is real, so the rule is not vacuous", () => {
    // If diff2 never imported from sync2, the one-way rule would be
    // describing a boundary nothing crosses, and the test above would
    // prove nothing about the actual layering.
    const edges = uiFiles.flatMap((file) =>
      importedModules(fs.readFileSync(file, "utf8")).filter((s) =>
        crossesInto(s, "sync2"),
      ),
    );
    expect(edges.length).toBeGreaterThan(0);
  });
});
