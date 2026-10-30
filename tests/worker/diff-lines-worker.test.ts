// DIFF-EDITOR-V2.md §2.1.1: the REAL cpu-worker.ts answers the diff
// editor's diff-lines job — the same parts the inline `diffLines` gives,
// or null when its own time budget runs out (the worker survives).

import { describe, expect, it } from "vitest";
import { diffLines } from "diff";
import { makeRealCpuWorkerClient } from "../helpers/real-cpu-worker";

describe("cpu-worker diff-lines", () => {
  it("🔑 answers with the same parts as the inline comparison", async () => {
    const a = "a\nb\nc\nd\n";
    const b = "a\nB\nc\nd\ne\n";
    const client = makeRealCpuWorkerClient();
    const parts = await client.diffLines(a, b);
    const strip = (ps: { value: string; added?: boolean; removed?: boolean }[]) =>
      ps.map((p) => [!!p.added, !!p.removed, p.value]);
    expect(strip(parts!)).toEqual(strip(diffLines(a, b)));
    client.terminate();
  });

  it("🔑 past its own budget the library gives up → null", async () => {
    // ~4 000 lines, every one changed on one side: far more than 1 ms of work.
    let a = "";
    let b = "";
    for (let i = 0; i < 4000; i++) {
      a += `line ${i} a\n`;
      b += `line ${i} b\n`;
    }
    const client = makeRealCpuWorkerClient({ diffTimeoutMs: 1 });
    expect(await client.diffLines(a, b)).toBeNull();
    client.terminate();
  });
});
