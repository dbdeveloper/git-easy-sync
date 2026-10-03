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
  getBranchHead,
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
import { reconcileConflictsForTest, trackedSiblingPathsFor } from "../helpers";

// §VIII K.1 (Phase 6) — the crash-matrix subset that earns a REAL server.
//
// ── WHY THIS ONE IS HERE AND THE REST ARE NOT ────────────────────────────────
// The criterion agreed with the owner: an integration cell earns its cost only
// where the fake world and real GitHub can DISAGREE. Most crash points are pure
// local-state ordering (journal persists, epilogue steps) — the fake covers them
// exactly, and the unit matrix does. This one is different.
//
// FINALIZE's deferral hangs on an assumption about a server we do not control:
// that a NON-FAST-FORWARD ref update is rejected with a status our client maps to
// `ValidationError`. The unit cell (drain-conflicts, "G.7 defer") proves what the
// engine does WHEN that error arrives — by throwing a synthesized one. It cannot
// prove the error arrives, or arrives in that shape. If GitHub answered anything
// else, the drain would take `statusFromError` instead of the deferral branch: the
// run would end in an error, and the branch would wait for a retry that reads as a
// failure to the user rather than as the routine race it is.
//
// ── HOW THE 422 IS PROVOKED: GENUINELY, NOT SYNTHESIZED ──────────────────────
// That distinction is the whole point of paying for a network test. FINALIZE
// builds a merge commit whose first parent is the main head it just read, then
// PATCHes main to it. If main moves in between, the PATCH is not a fast-forward
// and the server refuses. So the test hooks the moment AFTER the merge commit is
// created — recognisable because it is the only commit with TWO parents — and
// pushes an unrelated file to main from outside. Everything after that is the real
// GitHub API answering a real non-fast-forward update.
//
// ⚠️ The hook is on the CLIENT, not on the error path. Nothing here fakes a
// response, a status code, or an error class.
describe.skipIf(!integrationEnabled())(
  "FINALIZE defers on a REAL non-fast-forward ref update (§VIII K.1)",
  () => {
    let branch: string;
    let client: Sync2TestClient | undefined;
    let conflictBranchToCleanup: string | undefined;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-finalize-422");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
      if (conflictBranchToCleanup) {
        await deleteBranchIfExists(conflictBranchToCleanup);
        conflictBranchToCleanup = undefined;
      }
    });

    it(
      "main moves while the merge commit is being built → the sync still succeeds, the branch is KEPT, and the next sync finalizes",
      async () => {
        await writeRemoteFile(
          branch,
          "note.md",
          "shared baseline\n",
          "[seed] baseline",
        );
        client = await createSync2Client({ branch });
        await sync2AllAndAssertNoErrors(client);

        // Diverge on the same line → a real modify-vs-modify conflict,
        // which is what mints the conflict branch FINALIZE will try to
        // merge.
        fs.writeFileSync(
          path.join(client.vaultPath, "note.md"),
          "ours version\n",
          "utf8",
        );
        await writeRemoteFile(
          branch,
          "note.md",
          "theirs version\n",
          "[web] divergent",
        );
        await sync2AllAndAssertNoErrors(client);

        const records = trackedSiblingPathsFor(client, "note.md");
        expect(records).toHaveLength(1);
        const cb = client.hotMeta.getConflictBranch();
        expect(cb).not.toBeNull();
        conflictBranchToCleanup = cb!.name;

        // Resolve (accept ours) so the next sync would otherwise
        // FINALIZE: merge the branch into main and delete it.
        fs.rmSync(path.join(client.vaultPath, records[0]));
        await reconcileConflictsForTest(client);
        expect(client.conflictStore.hasBase("note.md")).toBe(false);

        // THE HOOK. `createCommit` with TWO parents is the FINALIZE
        // merge and nothing else — ordinary pushes have one. Right
        // after it is built, move main from outside, so the PATCH that
        // follows is a genuine non-fast-forward.
        let mergeCommitsBuilt = 0;
        const realClient = client.client as unknown as {
          createCommit: (args: {
            parents?: string[];
            [k: string]: unknown;
          }) => Promise<string>;
        };
        const origCreateCommit = realClient.createCommit.bind(realClient);
        realClient.createCommit = async (args) => {
          const sha = await origCreateCommit(args);
          if ((args.parents?.length ?? 0) === 2) {
            mergeCommitsBuilt += 1;
            if (mergeCommitsBuilt === 1) {
              await writeRemoteFile(
                branch,
                "intruder.md",
                "another device got there first\n",
                "[web] moves main under FINALIZE",
              );
            }
          }
          return sha;
        };

        // A DEFERRAL IS NOT AN ERROR — if the real 422 were mapped to
        // anything else this call would throw, and that is half the
        // claim.
        await sync2AllAndAssertNoErrors(client);
        expect(mergeCommitsBuilt).toBe(1); // the hook really fired

        // The branch is KEPT: nothing was merged, so nothing may be
        // deleted. Losing it here would strand the conflict's history
        // (the merge is what makes those commits reachable).
        expect(await getBranchHead(cb!.name)).not.toBeNull();
        expect(client.hotMeta.getConflictBranch()?.name).toBe(cb!.name);
        // And main carries the intruder, not our merge.
        expect(await readRemoteFile(branch, "intruder.md")).toBe(
          "another device got there first\n",
        );

        // The retry. The hook no longer fires (it is armed once), so
        // this run finalizes for real.
        await sync2AllAndAssertNoErrors(client);
        expect(mergeCommitsBuilt).toBe(2);
        expect(await getBranchHead(cb!.name)).toBeNull(); // merged, then deleted
        expect(client.hotMeta.getConflictBranch()).toBeNull();
        // The resolution stands, and so does the intruder — a deferred
        // FINALIZE must cost neither side its content.
        expect(await readRemoteFile(branch, "note.md")).toBe("ours version\n");
        expect(await readRemoteFile(branch, "intruder.md")).toBe(
          "another device got there first\n",
        );
        conflictBranchToCleanup = undefined;
      },
      360_000,
    );
  },
);
