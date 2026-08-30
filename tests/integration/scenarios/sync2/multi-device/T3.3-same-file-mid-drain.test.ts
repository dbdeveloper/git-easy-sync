import {
  describe,
  it,
  beforeAll,
  beforeEach,
  afterEach,
  expect,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// T3.3 (SYNC2-FIX §7) — direct modify-vs-modify mid-drain: the foreign
// change hits the very file of the batch ABOUT TO PUSH. Three local
// batches (note1..note3); right before batch #2's ref update, another
// device rewrites note2 remotely. The 422 lands on the exact batch
// whose file diverged.
//
// Invariant (I2): both versions survive — theirs as a registered
// conflict or merged content, never a silent overwrite. note1/note3
// (no concurrent edit) must land as ours.

describe.skipIf(!integrationEnabled())(
  "sync2 T3.3 — concurrent remote change to the CURRENT batch's file mid-drain",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 3;
    const file = (i: number): string => `note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t3-3-same-file");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "inject theirs to note2 before ITS OWN push → conflict or merge, both versions preserved",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline: all files on remote + snapshot.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `base ${i}\n`);
        }
        await sync2AllAndAssertNoErrors(client);

        // Three separate local batches.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
          await client.manager.commitOnly();
        }
        expect((await client.queue.list()).length).toBe(N);

        // Inject at the SECOND updateBranchHead call — batch #2's own
        // push. Call 1 (batch #1, note1) runs clean, so the count is
        // deterministic up to the injection point.
        const gh = client.client as unknown as {
          updateBranchHead: (a: {
            sha: string;
            retry?: boolean;
          }) => Promise<void>;
        };
        const orig = gh.updateBranchHead.bind(gh);
        let calls = 0;
        let injected = false;
        gh.updateBranchHead = async (a) => {
          calls += 1;
          if (!injected && calls === 2) {
            injected = true;
            await writeRemoteFile(
              branch,
              file(2),
              "theirs 2\n",
              "[other] concurrent note2.md",
            );
          }
          return orig(a);
        };

        // Drain + converge ("call me again" contract).
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        expect(injected).toBe(true);

        // note1/note3 — no concurrent edit: ours everywhere.
        for (const i of [1, 3]) {
          expect(await readRemoteFile(branch, file(i))).toBe(`ours ${i}\n`);
          expect(
            fs.readFileSync(path.join(client.vaultPath, file(i)), "utf8"),
          ).toBe(`ours ${i}\n`);
        }

        // note2 — I2: theirs survives as a conflict or merged content.
        const conflictPaths = client.conflictStore
          .getAll()
          .map((r) => r.vaultPath);
        const remote = await readRemoteFile(branch, file(2));
        const p = path.join(client.vaultPath, file(2));
        const vault = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
        const theirsSurvived =
          remote.includes("theirs 2") || vault.includes("theirs 2");
        const conflictRegistered = conflictPaths.includes(file(2));
        expect(
          theirsSurvived || conflictRegistered,
          `note2.md: concurrent remote change silently clobbered ` +
            `(remote=${JSON.stringify(remote)} vault=${JSON.stringify(vault)} ` +
            `conflicts=${JSON.stringify(conflictPaths)})`,
        ).toBe(true);
      },
      600_000,
    );
  },
);
