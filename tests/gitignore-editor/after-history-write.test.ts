// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-08: a version saved over the ROOT .gitignore from History
// (e.g. its empty "deleted" side) must get the plugin's managed blocks back
// AT ONCE — not at the next Sync, which with manual sync may be far away.

import { describe, expect, it } from "vitest";
import { enforceIfRootGitignore } from "../../src/gitignore-editor/after-history-write";

describe("enforceIfRootGitignore", () => {
  const run = async (path: string) => {
    let n = 0;
    const did = await enforceIfRootGitignore(path, async () => {
      n++;
    });
    return { did, n };
  };

  it("🔑 the root .gitignore → the blocks are restored now", async () => {
    expect(await run(".gitignore")).toEqual({ did: true, n: 1 });
  });

  it("any other file, a nested .gitignore included → nothing", async () => {
    expect(await run("notes/a.md")).toEqual({ did: false, n: 0 });
    expect(await run("sub/.gitignore")).toEqual({ did: false, n: 0 });
    expect(await run(".gitignore.md")).toEqual({ did: false, n: 0 });
  });
});
