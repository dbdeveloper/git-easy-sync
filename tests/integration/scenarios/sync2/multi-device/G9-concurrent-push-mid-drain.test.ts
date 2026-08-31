import {
// ⚔️ PIN RE-ARMED AT THE SWITCH (Phase 5.5 step 4): the new drain's
// rolling base + Layer 2 FIX the clobber — G9 RED→GREEN is THE main
// contract of the whole redesign. it.fails removed in the same commit
// that flipped syncAll to drainOnce.
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

// BUG INVESTIGATION (user scenario): 10 local commits C1..C10, one file
// each (note1..note10). During the drain, right before the 6th commit's
// push, another device changes note7..note10 (files that C7..C10 also
// touch — NOT note6). Injecting via a wrapper around the client's
// updateBranchHead: on the 6th call it writes the remote changes (moving
// the branch head), so our 6th push 422s naturally.
//
// Question: do C7..C10 CLOBBER the concurrent remote changes to
// note7..note10, or reconcile/merge them? (Traces predicted a clobber
// because chaining skips the per-batch pull and the fast-path skips
// reconcile when our chained head matches.)
//
// ARMED 2026-08-30 (Phase 0 of the sync2 rewrite, MASTER-PLAN §8.1):
// the diagnostic run confirmed the clobber reproduces (theirs 7..10
// silently lost after three syncAlls, zero conflicts), so the
// correctness criterion below is now asserted for real, wrapped in
// `it.fails` — the suite stays green while the defect exists, and the
// moment the new drain (Фаза 5) fixes it, `it.fails` itself fails,
// forcing the marker's removal (the RED→GREEN gate in marker form).
// CAVEAT of it.fails: an UNRELATED failure (network, setup) also
// counts as "expected failure" — if this test's diagnostics look off,
// re-run it without the marker to see the real error.

describe.skipIf(!integrationEnabled())(
  "sync2 G9 — concurrent remote change to later-commit files mid-drain",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    const N = 10;
    const file = (i: number): string => `note${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-g9-concurrent");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "injects remote changes to note7..note10 before the 6th push; theirs must survive as conflict or merge (I2)",
      async () => {
        client = await createSync2Client({ branch });

        // 1. Baseline: all 10 files on remote + snapshot.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `base ${i}\n`);
        }
        await sync2AllAndAssertNoErrors(client);

        // 2. Ten SEPARATE local commits (consolidateCommits=false): edit
        //    note-i, commitOnly → one queued batch per file.
        for (let i = 1; i <= N; i++) {
          fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
          await client.manager.commitOnly();
        }
        const queued = await client.queue.list();
        console.error("QUEUED BATCHES:", queued.length);

        // 3. Wrap the MAIN-ref mover: inject at the 6th call (= C6's
        //    push). THE SWITCH re-derivation: the new engine PATCHes
        //    the ref via updateReference (pushCommitFromTree) — count
        //    only heads/<branch> PATCHes (the conflict branch PATCHes
        //    a different ref). This IS deterministically C6: pushes
        //    1..5 run clean before the injection.
        const gh = client.client as unknown as {
          updateReference: (a: {
            ref: string;
            sha: string;
            retry?: boolean;
          }) => Promise<void>;
        };
        const orig = gh.updateReference.bind(gh);
        const callLog: string[] = [];
        let injected = false;
        gh.updateReference = async (a) => {
          if (a.ref !== `heads/${branch}`) return orig(a);
          callLog.push(a.sha.slice(0, 8));
          // Inject exactly once, at the 6th distinct push target.
          if (!injected && callLog.length === 6) {
            injected = true;
            for (let i = 7; i <= N; i++) {
              await writeRemoteFile(branch, file(i), `theirs ${i}\n`, `[other] concurrent ${file(i)}`);
            }
          }
          return orig(a);
        };

        const out: string[] = [];
        const snapshot = async (label: string): Promise<void> => {
          out.push(`--- ${label} ---`);
          out.push(`updateBranchHead calls so far: ${callLog.length} [${callLog.join(",")}]`);
          for (let i = 1; i <= N; i++) {
            let remote: string;
            try {
              remote = JSON.stringify(await readRemoteFile(branch, file(i)));
            } catch (e) {
              remote = `(read error: ${(e as Error).message})`;
            }
            const p = path.join(client!.vaultPath, file(i));
            const vault = fs.existsSync(p) ? JSON.stringify(fs.readFileSync(p, "utf8")) : "(missing)";
            out.push(`  ${file(i)}: remote=${remote} vault=${vault}`);
          }
          out.push(`  conflicts: ${JSON.stringify([...client!.conflictStore.getCachedState().entries.keys()])}`);
        };

        // 4. Drain #1 (the one with mid-drain injection).
        await sync2AllAndAssertNoErrors(client);
        await snapshot("after syncAll #1 (injection happened here)");

        // 5. The engine contract is "call me again" — pull defers overlap
        //    and leaves expectedHead unchanged. Re-drain and re-observe:
        //    does it CONVERGE (→ multi-sync convergence, by design) or
        //    stay broken (→ real data loss)?
        await sync2AllAndAssertNoErrors(client);
        await snapshot("after syncAll #2");
        await sync2AllAndAssertNoErrors(client);
        await snapshot("after syncAll #3");

        fs.writeFileSync("/tmp/g9-result.txt", `QUEUED BATCHES: ${queued.length}\n${out.join("\n")}\n`);

        // THE CONTRACT (I2 — no foreign change is silently overwritten),
        // asserted after convergence (three syncAlls above):
        //
        // note7..note10: the concurrent "theirs i" content must survive
        // SOMEWHERE — as a registered conflict for the path, or merged
        // into the remote/vault content. "ours everywhere + zero
        // conflicts" is the silent clobber this test exists to catch.
        const conflictPaths = [...client.conflictStore.getCachedState().entries.keys()];
        for (let i = 7; i <= N; i++) {
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

        // note1..note6: untouched by the injection — they must land as
        // "ours" and never revert to "base".
        for (let i = 1; i <= 6; i++) {
          const remote = await readRemoteFile(branch, file(i));
          expect(remote, `${file(i)} must stay ours on remote`).toBe(
            `ours ${i}\n`,
          );
          const vault = fs.readFileSync(
            path.join(client.vaultPath, file(i)),
            "utf8",
          );
          expect(vault, `${file(i)} must stay ours in vault`).toBe(
            `ours ${i}\n`,
          );
        }
      },
      600_000,
    );
  },
);
