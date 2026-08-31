import { describe, it, beforeAll, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead, deleteBranchIfExists, ensureRepoNotBare,
  getDefaultBranchHead, uniqueBranchName, integrationEnabled, readRemoteFile,
} from "./helpers";
import { createSync2Client, sync2AllAndAssertNoErrors, Sync2TestClient } from "./scenarios/sync2/helpers";
import { resetRuntimeState, removeResetMarker } from "../../src/sync2/reset";
import { calculateGitBlobSHA } from "../../src/utils";

const sha = (s: string) => calculateGitBlobSHA(new TextEncoder().encode(s).buffer as ArrayBuffer);

describe.skipIf(!integrationEnabled())("i1 debug", () => {
  let client: Sync2TestClient | undefined;
  let branch: string;
  afterEach(async () => { client?.cleanup(); await deleteBranchIfExists(branch); });
  beforeAll(async () => { await ensureRepoNotBare(); });

  it("probe .gitignore drift after reset re-align", async () => {
    branch = uniqueBranchName("sync2-i1dbg");
    const head = await getDefaultBranchHead();
    await createBranchFromHead(branch, head!);
    client = await createSync2Client({ branch });
    await client.vault.adapter.write("a.md", "a\n");
    await sync2AllAndAssertNoErrors(client);

    const local1 = fs.readFileSync(path.join(client.vaultPath, ".gitignore"), "utf8");
    console.log("AFTER SYNC1 local .gitignore sha:", await sha(local1), "len", local1.length);
    const remote1 = await readRemoteFile(branch, ".gitignore");
    console.log("AFTER SYNC1 remote .gitignore sha:", remote1 === null ? "ABSENT" : await sha(remote1));

    await resetRuntimeState({
      vault: client.vault, selfPluginId: "git-easy-sync",
      cancelDrain: () => client!.manager.cancelDrain(),
      isDrainRunning: () => client!.manager.isDrainRunning(),
      reinitStores: async () => {
        await client!.hotMeta.load(); await client!.baselines.clear(); await client!.conflictStore.load();
      },
    });
    await removeResetMarker(client.vault, "git-easy-sync");
    await sync2AllAndAssertNoErrors(client);

    const local2 = fs.readFileSync(path.join(client.vaultPath, ".gitignore"), "utf8");
    const remote2 = await readRemoteFile(branch, ".gitignore");
    const base = await client.baselines.get(".gitignore");
    console.log("AFTER SYNC2 local sha:", await sha(local2), "len", local2.length);
    console.log("AFTER SYNC2 remote sha:", remote2 === null ? "ABSENT" : await sha(remote2));
    console.log("BASELINE:", JSON.stringify(base));
    console.log("LOCAL===REMOTE?", local2 === remote2);
    if (remote2 !== null && local2 !== remote2) {
      console.log("DIFF local vs remote:", JSON.stringify(local2.slice(-120)), "VS", JSON.stringify(remote2.slice(-120)));
    }
    const changes = await client.detector.findChanges();
    console.log("findChanges:", JSON.stringify(changes));
    expect(true).toBe(true);
  }, 240_000);
});
