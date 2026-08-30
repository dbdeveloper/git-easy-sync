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
import { evaluateConflictState } from "../../../../../src/sync2/conflict-classifier";

// T6.1 (SYNC2-FIX §7, Scenario E shape) — three conflicts in one
// session. branch-lifecycle pins the single-conflict lifecycle;
// multi-copy-pair pins two siblings on one path. This file pins the
// MULTI-conflict session, split into two independent contracts:
//
// 1. Registration preserves EVERY conflicted path's ours on the
//    conflict branch tip (I1 — the branch's whole purpose is "the
//    pre-conflict local state is preserved on GitHub").
//    EMPIRICAL 2026-08-30 (Phase 0 triage): stable RED — with three
//    conflicts registered in one sync the branch tip carries
//    theirs 1 / theirs 2 / ours 3: only the LAST registered path's
//    ours survives on the tip; ours 1/2 exist nowhere on GitHub.
//    (SYNC2-FIX §7 expected this "регресія GREEN" — refuted, like
//    T3.2.) Lives under it.fails per the G9 precedent.
//
// 2. The FINALIZE GATE: resolving one-by-one, the conflict branch is
//    never merged+deleted while the store still holds pending
//    conflicts, and only disappears after the last resolution.

describe.skipIf(!integrationEnabled())(
  "sync2 T6.1 — three conflicts in one session",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;
    let conflictBranchToCleanup: string | undefined;
    const N = 3;
    const file = (i: number): string => `c${i}.md`;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t6-1-three-conflicts");
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

    // Shared setup: baseline 3 files, diverge all three on the same
    // line, sync → 3 pending conflicts + a conflict branch. Returns
    // the conflict-branch state.
    const registerThreeConflicts = async (): Promise<{
      name: string;
      head: string;
    }> => {
      for (let i = 1; i <= N; i++) {
        await writeRemoteFile(
          branch,
          file(i),
          `base ${i}\n`,
          `[seed] ${file(i)}`,
        );
      }
      client = await createSync2Client({ branch });
      await sync2AllAndAssertNoErrors(client);

      for (let i = 1; i <= N; i++) {
        fs.writeFileSync(path.join(client.vaultPath, file(i)), `ours ${i}\n`);
        await writeRemoteFile(
          branch,
          file(i),
          `theirs ${i}\n`,
          `[web] divergent ${file(i)}`,
        );
      }
      await sync2AllAndAssertNoErrors(client);

      for (let i = 1; i <= N; i++) {
        expect(
          client.conflictStore.hasPending(file(i)),
          `${file(i)} must be pending`,
        ).toBe(true);
      }
      const cb = client!.hotMeta.getConflictBranch();
      expect(cb).not.toBeNull();
      conflictBranchToCleanup = cb!.name;
      return cb!;
    };

    // Resolve one path via sibling-delete (case 1: accept ours) and
    // re-run the classifier, as the vault event listener would.
    const resolveViaSiblingDelete = async (p: string): Promise<void> => {
      const records = client!.conflictStore.getByPath(p);
      expect(records.length).toBeGreaterThan(0);
      fs.rmSync(path.join(client!.vaultPath, records[0].siblingPath));
      await evaluateConflictState(
        client!.conflictStore,
        client!.vault as unknown as import("obsidian").Vault,
      );
      expect(client!.conflictStore.hasPending(p)).toBe(false);
    };

    it.fails(
      "registration preserves every path's ours on the branch tip (I1) — today only the LAST survives",
      async () => {
        const cb = await registerThreeConflicts();
        for (let i = 1; i <= N; i++) {
          expect(
            await readRemoteFile(cb.name, file(i)),
            `${file(i)}: pre-conflict local state missing from the branch tip`,
          ).toBe(`ours ${i}\n`);
        }
      },
      600_000,
    );

    it(
      "one-by-one resolution: branch survives until the store empties, then merge + deleteRef",
      async () => {
        const cb = await registerThreeConflicts();

        // Resolve #1 → sync. Store still holds 2 → the branch MUST
        // survive (the gate under test).
        await resolveViaSiblingDelete(file(1));
        await sync2AllAndAssertNoErrors(client!);
        expect(
          await getBranchHead(cb.name),
          "conflict branch deleted with 2 conflicts still pending",
        ).not.toBeNull();

        // Resolve #2 → sync. Store still holds 1 → branch survives.
        await resolveViaSiblingDelete(file(2));
        await sync2AllAndAssertNoErrors(client!);
        expect(
          await getBranchHead(cb.name),
          "conflict branch deleted with 1 conflict still pending",
        ).not.toBeNull();

        // Resolve #3 → sync. Store empty → finalize: merge +
        // deleteRef, local conflict-branch state cleared.
        await resolveViaSiblingDelete(file(3));
        await sync2AllAndAssertNoErrors(client!);
        expect(await getBranchHead(cb.name)).toBeNull();
        conflictBranchToCleanup = undefined;
        const cbAfter = client!.hotMeta.getConflictBranch();
        expect(cbAfter).toBeNull();

        // End state of the accept-ours resolutions: the local vault
        // still carries ours for all three (nothing reverted), and
        // sibling files are gone.
        for (let i = 1; i <= N; i++) {
          expect(
            fs.readFileSync(path.join(client!.vaultPath, file(i)), "utf8"),
          ).toBe(`ours ${i}\n`);
        }
      },
      600_000,
    );

    it(
      "after all three accept-ours resolutions MAIN carries ours for every path (I1/I3)",
      async () => {
        await registerThreeConflicts();
        for (let i = 1; i <= N; i++) {
          await resolveViaSiblingDelete(file(i));
          await sync2AllAndAssertNoErrors(client!);
        }
        // One extra convergence round ("call me again" contract).
        await sync2AllAndAssertNoErrors(client!);
        for (let i = 1; i <= N; i++) {
          expect(
            await readRemoteFile(branch, file(i)),
            `${file(i)}: accept-ours resolution never reached main`,
          ).toBe(`ours ${i}\n`);
        }
        expect(client!.conflictStore.getAll()).toEqual([]);
      },
      600_000,
    );
  },
);
