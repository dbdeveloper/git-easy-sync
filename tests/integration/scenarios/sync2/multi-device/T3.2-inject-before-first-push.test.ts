import {
// ⚔️ PIN RE-ARMED AT THE SWITCH (Phase 5.5 step 4): defect A died
// with the old drain — it.fails removed in the flip commit.
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

// T3.2 (SYNC2-FIX §7) — the CONTROL to G9: the foreign change arrives
// before the FIRST push of the drain, not mid-chain. The first batch
// is the one place the current engine does a full pull/reconcile
// before pushing, so the concurrent edits must go through the normal
// defer/reconcile route and never be silently clobbered (I2).
//
// Same harness as G9 (updateBranchHead wrapper), injection at call 1.
// Local edits touch note1..note4 (one batch each); the injection
// rewrites note3+note4 remotely. Both are same-line collisions
// ("ours i" vs "theirs i" over "base i"), so the expected outcome is
// a registered conflict per path — but the asserted INVARIANT is
// weaker on purpose: theirs must survive SOMEWHERE (conflict record
// or merged content). note1/note2 are untouched remotely and must
// land as ours.
//
// EMPIRICAL RESULT 2026-08-30 (Phase 0 triage): RED, stable — the
// clobber reproduces even at the FIRST push, refuting SYNC2-FIX §7's
// expectation that this control would pass ("механізм 1-го батча
// працює"). Defect A is NOT mid-chain-specific. Wrapped in `it.fails`
// per the G9 precedent: the suite stays green while the defect lives;
// when the new drain (Фаза 4/5) fixes it, it.fails itself fails and
// the marker must be removed. Same it.fails caveat as G9: an
// unrelated failure also counts as "expected" — re-run without the
// marker when diagnosing.

describe.skipIf(!integrationEnabled())(
  "sync2 T3.2 — concurrent remote change before the 1st push (control)",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 4;
    const file = (i: number): string => `note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t3-2-first-push");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "inject theirs to note3/note4 before push #1 → theirs survives, note1/note2 land as ours",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline: all files on remote + snapshot.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `base ${i}\n`);
        }
        await sync2AllAndAssertNoErrors(client);

        // Four separate local batches.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
          await client.manager.commitOnly();
        }
        expect((await client.queue.list()).length).toBe(N);

        // Inject at the FIRST updateBranchHead call.
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
          if (!injected && calls === 1) {
            injected = true;
            for (let i = 3; i <= N; i++) {
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

        // Drain + converge ("call me again" contract).
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        await sync2AllAndAssertNoErrors(client);
        expect(injected).toBe(true);

        // note1/note2 — no concurrent edit: ours everywhere.
        for (let i = 1; i <= 2; i++) {
          expect(await readRemoteFile(branch, file(i))).toBe(`ours ${i}\n`);
          expect(
            fs.readFileSync(path.join(client.vaultPath, file(i)), "utf8"),
          ).toBe(`ours ${i}\n`);
        }

        // note3/note4 — I2: theirs survives as a conflict or merged
        // content, never a silent clobber to plain ours.
        const conflictPaths = [...client.conflictStore.getCachedState().entries.keys()];
        for (let i = 3; i <= N; i++) {
          const remote = await readRemoteFile(branch, file(i));
          const p = path.join(client.vaultPath, file(i));
          const vault = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
          const theirsSurvived =
            remote.includes(`theirs ${i}`) || vault.includes(`theirs ${i}`);
          const conflictRegistered = conflictPaths.includes(file(i));
          expect(
            theirsSurvived || conflictRegistered,
            `${file(i)}: concurrent remote change silently clobbered ` +
              `(remote=${JSON.stringify(remote)} vault=${JSON.stringify(vault)} ` +
              `conflicts=${JSON.stringify(conflictPaths)})`,
          ).toBe(true);
        }
      },
      600_000,
    );
  },
);
