// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import { buildSiblingFilePath, isConflictPair } from "../../src/sync2/conflict-siblings";
import { startSession } from "../../src/diff2/autosave-store";
import { commit7Step } from "../../src/diff2/exit-commit";
import { closeEditorsOfVanishedCopies } from "../../src/diff2/close-vanished-copies";

// The diff editor is not only about conflicts (owner, 2026-10-12): it is
// meant to compare any two files of the vault too (not built yet). Conflict
// logic — "resolved outside", removing the copy on [←], the conflict
// analyzer, closing tabs of resolved conflicts — applies ONLY to a pair whose
// second file is a conflict copy of the first.

describe("conflict logic only for a conflict pair", () => {
  it("isConflictPair: a copy of exactly this file", () => {
    const copy = buildSiblingFilePath("notes/a.md", 1_700_000_000_000, "Phone");
    expect(isConflictPair("notes/a.md", copy)).toBe(true);
    expect(isConflictPair("notes/b.md", copy)).toBe(false); // someone else's copy
    expect(isConflictPair("notes/a.md", "notes/b.md")).toBe(false); // two ordinary files
    expect(isConflictPair("notes/a.md", "notes/a.md")).toBe(false); // History: the file itself
  });

  describe("[←] on two ordinary files", () => {
    let root: string;
    let vault: Vault;
    beforeEach(() => {
      root = path.join(os.tmpdir(), `pair-only-${crypto.randomBytes(4).toString("hex")}`);
      fs.mkdirSync(root, { recursive: true });
      vault = new MockVault(root) as unknown as Vault;
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("🔑 both sides made identical → BOTH files stay (only a conflict copy is removed)", async () => {
      fs.writeFileSync(path.join(root, "a.md"), "one\n");
      fs.writeFileSync(path.join(root, "b.md"), "two\n");
      const NOW = "2026-10-12T10:00:00.000Z";
      const meta = await startSession(vault, "cmp", "a.md", "b.md", NOW);
      const res = await commit7Step(vault, "cmp", meta, { base: "same\n", sibling: "same\n" }, { now: NOW });
      expect(fs.readFileSync(path.join(root, "b.md"), "utf8")).toBe("same\n");
      expect(res.siblingRemoved).toBe(false);
    });
  });

  it("the tab cleaner leaves a tab whose second file is not a copy of the first", async () => {
    let detached = false;
    await closeEditorsOfVanishedCopies({
      editorTabs: () => [
        { origin: "conflict", basePath: "a.md", siblingPath: "b.md", detach: () => (detached = true), isActive: false },
      ],
      adapter: { exists: async () => false } as never,
      isResolved: async () => true,
    });
    expect(detached).toBe(false);
  });
});
