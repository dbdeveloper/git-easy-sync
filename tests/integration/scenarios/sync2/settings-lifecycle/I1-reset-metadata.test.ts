import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import {
  countBranchCommits,
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";
import * as fs from "fs";
import * as path from "path";
import {
  removeResetMarker,
  resetRuntimeState,
} from "../../../../../src/sync2/reset";

// I1 — the real RESET-PLUGIN core (Phase 1.6). After a normal sync,
// run resetRuntimeState (D1: one recursive wipe of .runtime/ + the
// in-memory re-inits) exactly as the Reset button does, then sync
// again. sync2 must re-build state from the remote without re-pushing
// every file as "new" — the no-op-tree-skip elides any spurious
// commit because the SHAs match. The vault and the remote stay
// intact; this is the Phase 1.6 gate test
// ("reset → нема файлів під .runtime/ → sync → без re-push").

describe.skipIf(!integrationEnabled())(
  "sync2 I1 — reset snapshot store",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let baselineCommits = 0;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-i1-reset");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
      baselineCommits = await countBranchCommits(branch);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "snapshot reset → next sync re-aligns without re-pushing identical content",
      async () => {
        client = await createSync2Client({ branch });
        await client.vault.adapter.write("a.md", "a\n");
        await client.vault.adapter.write("b.md", "b\n");
        await sync2AllAndAssertNoErrors(client);
        const afterFirstPush = await countBranchCommits(branch);
        expect(afterFirstPush - baselineCommits).toBe(1);

        // The REAL reset core — same call the Reset button makes.
        const outcome = await resetRuntimeState({
          vault: client.vault,
          selfPluginId: "git-easy-sync",
          cancelDrain: () => client!.manager.cancelDrain(),
          isDrainRunning: () => client!.manager.isDrainRunning(),
          reinitStores: async () => {
            await client!.hotMeta.load();
            await client!.baselines.clear();
            await client!.conflictStore.load();
          },
        });
        expect(outcome).toBe("done");
        await removeResetMarker(client.vault, "git-easy-sync");

        // Phase 1.6 gate: NOTHING left under .runtime/ (the dir
        // itself is gone), and the in-memory state is clean.
        const runtimeAbs = path.join(
          client.vaultPath,
          ".obsidian",
          "plugins",
          "git-easy-sync",
          ".runtime",
        );
        expect(fs.existsSync(runtimeAbs)).toBe(false);
        expect(client.hotMeta.getLastSyncCommitSha()).toBeNull();

        // Sync again. findChanges will see a.md and b.md as "added"
        // (snapshot is empty), but the upload path computes their
        // SHAs, sees they already exist remotely, and the new tree
        // ends up identical to the parent tree — no-op-tree-skip
        // kicks in, no new commit.
        await sync2AllAndAssertNoErrors(client);

        expect(await readRemoteFile(branch, "a.md")).toBe("a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("b\n");
        const afterReset = await countBranchCommits(branch);
        expect(afterReset - baselineCommits).toBe(1);

        // Quiescence after the re-align: findChanges is empty.
        expect(await client.detector.findChanges()).toEqual([]);
      },
      240_000,
    );
  },
);
