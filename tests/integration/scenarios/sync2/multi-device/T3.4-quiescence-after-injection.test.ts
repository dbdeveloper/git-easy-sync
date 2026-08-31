import {
// ⚔️ PIN RE-ARMED AT THE SWITCH (Phase 5.5 step 4): it.fails removed
// in the flip commit — quiescence must now hold.
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
  getBranchHead,
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

// T3.4 (SYNC2-FIX §7) — QUIESCENCE (I3) after the G9 concurrent
// injection. Deliberately a SEPARATE file from G9: G9 lives under
// it.fails (its I2 contract is expected-RED until the new drain), and
// an assertion inside an it.fails body can never signal — a real I3
// violation there would be masked as "expected failure".
//
// This test asserts only what must hold on TODAY's engine, clobber
// and all:
//   - the state CONVERGES: after sync #2 and sync #3 the world
//     (branch head, remote contents, vault contents, conflict set) is
//     identical — no oscillation, no creeping loss;
//   - a further sync #4 is a true no-op: queue empty, head unmoved;
//   - note1..note6 (untouched by the injection) never degrade from
//     "ours".
// What it does NOT assert: survival of theirs 7..10 — that is G9's
// expected-fail contract (I2), not I3.

describe.skipIf(!integrationEnabled())(
  "sync2 T3.4 — state converges and stays quiescent after mid-drain injection",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 10;
    const file = (i: number): string => `note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t3-4-quiescence");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    // One comparable world-state snapshot: branch head + remote and
    // vault content of every note + the conflict set.
    const worldState = async (c: Sync2TestClient): Promise<string> => {
      const parts: string[] = [`head=${await getBranchHead(c.branch)}`];
      for (let i = 1; i <= N; i++) {
        let remote: string;
        try {
          remote = await readRemoteFile(c.branch, file(i));
        } catch {
          remote = "(absent)";
        }
        const p = path.join(c.vaultPath, file(i));
        const vault = fs.existsSync(p)
          ? fs.readFileSync(p, "utf8")
          : "(absent)";
        parts.push(`${file(i)}:r=${JSON.stringify(remote)}:v=${JSON.stringify(vault)}`);
      }
      parts.push(
        `conflicts=${JSON.stringify(
          [...c.conflictStore.getCachedState().entries.keys()]
            .sort(),
        )}`,
      );
      return parts.join("\n");
    };

    it(
      "after the G9 scenario: sync #2 and #3 identical, sync #4 a no-op, note1-6 never degrade",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline + 10 separate local batches (the G9 setup).
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `base ${i}\n`);
        }
        await sync2AllAndAssertNoErrors(client);
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
          await client.manager.commitOnly();
        }

        // Inject theirs 7..10 at the 6th push (the G9 injection).
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
          if (!injected && calls === 6) {
            injected = true;
            for (let i = 7; i <= N; i++) {
              await writeRemoteFile(
                branch,
                file(i),
                `theirs ${i}\n`,
                `[other] concurrent ${file(i)}`,
              );
            }
          }
          return orig(a);
        };

        // Sync #1 (injection happens inside), then #2 and #3.
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        expect(injected).toBe(true);
        const stateAfter2 = await worldState(client);
        await sync2AllAndAssertNoErrors(client);
        const stateAfter3 = await worldState(client);

        // I3 — convergence: nothing oscillates or keeps leaking after
        // the engine has had its "call me again" round.
        expect(stateAfter3).toBe(stateAfter2);

        // Sync #4 on the converged state is a true no-op.
        const headBefore4 = await getBranchHead(branch);
        await sync2AllAndAssertNoErrors(client);
        expect(await client.queue.list()).toEqual([]);
        expect(await getBranchHead(branch)).toBe(headBefore4);

        // note1..note6 never degrade (no revert to base, no loss).
        for (let i = 1; i <= 6; i++) {
          expect(await readRemoteFile(branch, file(i))).toBe(`ours ${i}\n`);
          expect(
            fs.readFileSync(path.join(client.vaultPath, file(i)), "utf8"),
          ).toBe(`ours ${i}\n`);
        }
      },
      600_000,
    );
  },
);
