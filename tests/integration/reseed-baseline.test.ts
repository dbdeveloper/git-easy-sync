import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import GitignoreInvariants from "../../src/sync2/gitignore-invariants";
import InvariantStateStore from "../../src/sync2/invariant-state";
import {
  integrationEnabled,
  getDefaultBranchName,
  writeRemoteFile,
  removeRemoteFile,
  getRemoteFileSha,
} from "./helpers";

// ONE-OFF (THE SWITCH gate): dump the CURRENT invariant seeds so the
// int-repo default-branch baseline can be refreshed to "a repo synced
// by the current plugin" — its previous content predated even the
// github-easy-sync→git-easy-sync rename, so every cold adoption hit
// the §6.4 rule-4.2 conflict on .gitignore by design.
describe.skipIf(!integrationEnabled())("baseline seed dump", () => {
  it("dumps enforce output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seed-dump-"));
    fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
    const vault = new Vault(dir);
    const state = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: "git-easy-sync",
    });
    await state.load();
    const inv = new GitignoreInvariants({
      vault: vault as never,
      state,
      configDir: ".obsidian",
      selfPluginId: "git-easy-sync",
    });
    await inv.enforce();
    const out: Record<string, string> = {};
    for (const p of [
      ".gitignore",
      ".obsidian/.gitignore",
      ".obsidian/plugins/git-easy-sync/.gitignore",
    ]) {
      const abs = path.join(dir, p);
      if (fs.existsSync(abs)) out[p] = fs.readFileSync(abs, "utf8");
    }
    rmSync(dir, { recursive: true, force: true });
    expect(Object.keys(out).length).toBeGreaterThan(0);

    // Refresh the default-branch baseline to the current seeds and
    // drop the pre-rename relics — same helper surface every
    // integration test uses.
    const branch = await getDefaultBranchName();
    for (const [p, content] of Object.entries(out)) {
      await writeRemoteFile(
        branch,
        p,
        content,
        `reseed baseline: ${p} to current plugin seeds (THE SWITCH gate)`,
      );
      console.log("PUT", p);
    }
    for (const relic of [
      ".obsidian/github-sync-metadata.json",
      ".obsidian/plugins/github-easy-sync/.gitignore",
    ]) {
      const sha = await getRemoteFileSha(branch, relic);
      if (sha) {
        await removeRemoteFile(branch, relic, `drop pre-rename relic ${relic}`);
        console.log("DEL", relic);
      }
    }
  }, 240_000);
});
