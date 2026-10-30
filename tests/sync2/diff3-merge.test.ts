// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { merge as nodeDiff3Merge } from "node-diff3";
import { mergeLines } from "../../src/sync2/diff3-merge";

// docs/tasks/DIFF3-MYERS.md §4 — our diff3: node-diff3's region walk with
// Myers (diffArrays) in place of its slow LCS.

// A small deterministic PRNG, so a failure names a reproducible case.
const prng = (seed: number) => (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);

// Three versions from one base by inserts / deletes / replacements.
// `fresh()` supplies new line texts — unique ones for the oracle corpus.
function trio(rnd: (n: number) => number, base: string[], fresh: () => string) {
  const mutate = (lines: string[]) => {
    const out = [...lines];
    for (let k = rnd(4); k > 0; k--) {
      const at = rnd(out.length + 1);
      const op = rnd(3);
      if (op === 0) out.splice(at, 0, fresh());
      else if (op === 1 && out.length > 0) out.splice(Math.min(at, out.length - 1), 1);
      else if (out.length > 0) out[Math.min(at, out.length - 1)] = fresh();
    }
    return out;
  };
  return { o: base, a: mutate(base), b: mutate(base) };
}

describe("mergeLines — the oracle: unique lines have ONE common subsequence", () => {
  // With no repeated line the longest common subsequence is unique, so any
  // correct diff3 gives byte-identical output to node-diff3. A mismatch
  // here is a bug in our code, never a tie-break.
  it("🔑 byte-identical to node-diff3 on 5 000 random trios (verdict, clean text, conflict markers)", () => {
    const rnd = prng(2026);
    let next = 0;
    const fresh = () => `line-${next++}`;
    for (let c = 0; c < 5000; c++) {
      const base = Array.from({ length: rnd(25) }, fresh);
      const { o, a, b } = trio(rnd, base, fresh);
      const ref = nodeDiff3Merge(a, o, b, { excludeFalseConflicts: true });
      const ours = mergeLines(a, o, b);
      expect(ours, `case ${c}: o=${o.join(",")} a=${a.join(",")} b=${b.join(",")}`).toEqual({
        conflict: ref.conflict,
        result: ref.result,
      });
    }
  });

  it("edges: empty base, empty sides, identical sides, everything deleted", () => {
    const cases: Array<[string[], string[], string[]]> = [
      [[], [], []],
      [[], ["x"], []],
      [[], ["x"], ["y"]],
      [["a"], [], []],
      [["a"], [], ["a"]],
      [["a", "b"], ["a", "b"], ["a", "b"]],
      [["a"], ["a", "x"], ["y", "a"]],
    ];
    for (const [o, a, b] of cases) {
      const ref = nodeDiff3Merge(a, o, b, { excludeFalseConflicts: true });
      expect(mergeLines(a, o, b), JSON.stringify([o, a, b])).toEqual({ conflict: ref.conflict, result: ref.result });
    }
  });
});

describe("mergeLines — git merge-file agrees on the unique corpus", () => {
  const gitAvailable = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!gitAvailable)("🔑 verdict and clean text equal git's on 300 random trios", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff3-git-"));
    try {
      const rnd = prng(31);
      let next = 0;
      const fresh = () => `line-${next++}`;
      for (let c = 0; c < 300; c++) {
        const base = Array.from({ length: 1 + rnd(20) }, fresh);
        const { o, a, b } = trio(rnd, base, fresh);
        const write = (n: string, l: string[]) => fs.writeFileSync(path.join(dir, n), l.map((x) => x + "\n").join(""));
        write("o", o);
        write("a", a);
        write("b", b);
        let out = "";
        let conflict = false;
        try {
          out = execFileSync("git", ["merge-file", "-p", "a", "o", "b"], { cwd: dir, encoding: "utf8" });
        } catch (e) {
          conflict = true;
          out = (e as { stdout: string }).stdout;
        }
        const ours = mergeLines(a, o, b)!;
        expect(ours.conflict, `case ${c}`).toBe(conflict);
        if (!conflict) expect(ours.result.map((x) => x + "\n").join(""), `case ${c}`).toBe(out);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeLines — repeated lines: where an equally good alignment exists", () => {
  // Blank-heavy trios have several longest common subsequences; Myers and
  // node-diff3's Hunt–McIlroy may pick different ones, so the verdict may
  // differ. Counted and bounded here, not hidden — and a clean result must
  // still contain every line either side added.
  it("verdicts mostly agree with node-diff3; every clean merge keeps both sides' new lines", () => {
    const rnd = prng(7);
    const vocab = ["", "    ", "a", "b"];
    let next = 0;
    const fresh = () => (rnd(3) === 0 ? `new-${next++}` : vocab[rnd(vocab.length)]);
    let disagree = 0;
    const n = 5000;
    for (let c = 0; c < n; c++) {
      const base = Array.from({ length: rnd(14) }, () => vocab[rnd(vocab.length)]);
      const { o, a, b } = trio(rnd, base, fresh);
      const ref = nodeDiff3Merge(a, o, b, { excludeFalseConflicts: true });
      const ours = mergeLines(a, o, b)!;
      if (ours.conflict !== ref.conflict) disagree++;
      if (!ours.conflict) {
        for (const line of [...a, ...b]) if (line.startsWith("new-")) expect(ours.result, `case ${c}`).toContain(line);
      }
    }
    expect(disagree / n).toBeLessThan(0.1);
  });
});

describe("mergeLines — gives up instead of running forever", () => {
  it("🔑 a merge whose edit length exceeds the cap returns null (the caller makes it a manual conflict)", () => {
    const o = Array.from({ length: 3000 }, (_, i) => `line-${i}`);
    const a = o.map((x, i) => (i % 2 === 0 ? `a-${i}` : x));
    const b = o.map((x, i) => (i % 3 === 0 ? `b-${i}` : x));
    expect(mergeLines(a, o, b, { maxEditLength: 100 })).toBeNull();
    expect(mergeLines(a, o, b, { maxEditLength: 100000 })).not.toBeNull();
  });
});
