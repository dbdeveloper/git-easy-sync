// The autosave root is reconfigurable at plugin onload (setAutosaveRoot) so the
// dir lives WITH the plugin's data — `<configDir>/plugins/<id>/.runtime/diff2-autosave/`
// — instead of cluttering the vault root. The unit tests keep the vault-root
// default; this file pins the setter + the ES live binding (autosaveDir AND
// sweepAll in autosave-cleanup.ts must see the new root). Reset in afterEach so
// the mutation never leaks (vitest isolates files, but be explicit).

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../../mock-obsidian";
import type { Vault } from "obsidian";
import {
  autosaveDir,
  setAutosaveRoot,
  startSession,
} from "../../src/diff2/autosave-store";
import { sweepAll } from "../../src/diff2/autosave-cleanup";

afterEach(() => setAutosaveRoot("")); // → normalizePath("/.runtime/diff2-autosave") = ".runtime/diff2-autosave" (default)

function fixture(): Vault {
  const root = path.join(os.tmpdir(), `autosave-root-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return new MockVault(root) as unknown as Vault;
}

describe("setAutosaveRoot — relocate the autosave dir under the plugin folder", () => {
  it("default is the vault-root path", () => {
    expect(autosaveDir("cid")).toBe(".runtime/diff2-autosave/cid");
  });

  it("after setAutosaveRoot(parent) the dir lives under <parent>/.runtime/diff2-autosave", () => {
    setAutosaveRoot(".obsidian/plugins/git-easy-sync");
    expect(autosaveDir("cid")).toBe(
      ".obsidian/plugins/git-easy-sync/.runtime/diff2-autosave/cid",
    );
  });

  it("the live binding reaches sweepAll (autosave-cleanup reads the SAME root)", async () => {
    const vault = fixture();
    setAutosaveRoot(".obsidian/plugins/git-easy-sync");
    // A real session under the NEW root with an empty history (sweep cond 2b).
    await vault.adapter.writeBinary("b.md", new TextEncoder().encode("base\n").buffer as ArrayBuffer);
    await vault.adapter.writeBinary("s.md", new TextEncoder().encode("sib\n").buffer as ArrayBuffer);
    await startSession(vault, "cid", "b.md", "s.md");
    // Mkdir landed under the plugin folder, not the vault root.
    expect(await vault.adapter.exists(".obsidian/plugins/git-easy-sync/.runtime/diff2-autosave/cid")).toBe(true);
    expect(await vault.adapter.exists(".runtime/diff2-autosave/cid")).toBe(false);

    // sweepAll walks AUTOSAVE_ROOT — if the live binding failed it would scan the
    // old default and find nothing. It finds + sweeps the empty-history session.
    const res = await sweepAll(vault);
    expect(res.map((r) => r.conflictId)).toEqual(["cid"]);
    expect(res[0].decision.action).toBe("sweep");
  });
});
