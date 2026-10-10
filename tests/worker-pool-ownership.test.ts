// Owner, 2026-10-11: "fix the orphan workers after crashes or plugin
// reloads". Measured on the phone through Chrome DevTools: every plugin
// reload ADDED 5 workers (12 → 17 → 22) although onunload did call
// workerClient.terminate(). The second pool came from BatchWriter, which
// built its OWN WorkerClient when main.ts did not hand it one — 4 CPU + 1
// network worker that nobody ever terminated (and that the cancel signal
// never reached).
//
// One owner: main.ts builds the only WorkerClient and terminates it in
// onunload; everything else receives it.

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
  );
}

describe("the worker pool has ONE owner", () => {
  it("in src/, only main.ts constructs a WorkerClient", () => {
    const src = path.join(__dirname, "..", "src");
    const builders = tsFiles(src)
      .filter((f) =>
        fs
          .readFileSync(f, "utf8")
          .split("\n")
          .some((l) => !l.trim().startsWith("//") && /new WorkerClient\s*\(/.test(l)),
      )
      .map((f) => path.relative(src, f));
    expect(builders).toEqual(["main.ts"]);
  });

  it("main.ts hands its WorkerClient to the BatchWriter", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.ts"), "utf8");
    const i = main.indexOf("new BatchWriter({");
    expect(i).toBeGreaterThan(0);
    const block = main.slice(i, main.indexOf("});", i));
    expect(block).toMatch(/workerClient:\s*this\.workerClient/);
  });
});
