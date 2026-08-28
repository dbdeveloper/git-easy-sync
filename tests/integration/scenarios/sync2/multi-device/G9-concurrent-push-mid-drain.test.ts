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
      "injects remote changes to note7..note10 before the 6th push; observe clobber vs merge",
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

        // 3. Wrap updateBranchHead: inject at the 6th call (= C6's push).
        //    This IS deterministically C6: pushes 1..5 (C1..C5) run before
        //    any injection, so nothing can 422/retry to shift the count
        //     before we reach call 6. We log every target sha (callLog) so
        //    the injection point is auditable post-hoc, and only the
        //    RETRY/convergence after injection varies the later counts.
        const gh = client.client as unknown as {
          updateBranchHead: (a: { sha: string; retry?: boolean }) => Promise<void>;
          getCommit?: (sha: string) => Promise<unknown>;
        };
        const orig = gh.updateBranchHead.bind(gh);
        const callLog: string[] = [];
        let injected = false;
        gh.updateBranchHead = async (a) => {
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
          out.push(`  conflicts: ${JSON.stringify(client!.conflictStore.getAll().map((r) => r.vaultPath))}`);
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

        // Diagnostic run — no hard assertion yet. Correctness (to encode
        // once behavior is understood): after convergence note7..note10
        // are CONFLICTS or merged (never silently clobbered to "ours"),
        // and note1..note6 are "ours" (never reverted to "base").
        expect(true).toBe(true);
      },
      600_000,
    );
  },
);
