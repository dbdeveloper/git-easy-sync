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
  installRequestFaultInjector,
  integrationEnabled,
  readRemoteFile,
  uniqueBranchName,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// T5.2 (SYNC2-FIX §7) — eventually-consistent head READ (the §7.10
// regression, must stay GREEN). Right after our push moves the branch,
// a replica-lagged GET returns the PRE-push head. The monotonic-head
// guard must recognise the read as stuck behind a head we ourselves
// confirmed and re-read — never reconcile against the stale head,
// which would surface our own just-pushed content as a foreign diff
// ("own data as conflict", I2) or spin forever (I6).
//
// Where today's engine actually re-reads the head: NOT between
// chained pushes (a clean chain never re-GETs — first probe of this
// test proved fakesServed stayed 0 with an intra-drain injector), but
// at the START of the NEXT drain, via the guarded head read that
// compares against the confirmed lastSync head. So the stale window
// is built ACROSS two syncAlls: sync #1 pushes and confirms head H1;
// the injector then serves the pre-#1 head H0 for the first 2 head
// GETs of sync #2 — a deterministic replica lag. Without the guard,
// sync #2 would reconcile against H0 and see its OWN #1 content as a
// foreign diff. Test-side helper reads use their own fetch and are
// not intercepted.

describe.skipIf(!integrationEnabled())(
  "sync2 T5.2 — stale head read after own push: guard re-reads, no self-conflict",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-t5-2-stale-head");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      installRequestFaultInjector(null);
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "next drain's head GETs serve the pre-push head → no self-conflict, everything lands",
      async () => {
        client = await createSync2Client({ branch });

        // Baseline.
        fs.writeFileSync(path.join(client.vaultPath, "a.md"), "base a\n");
        fs.writeFileSync(path.join(client.vaultPath, "b.md"), "base b\n");
        await sync2AllAndAssertNoErrors(client);
        const staleHead = await getBranchHead(branch); // H0
        if (!staleHead) throw new Error("branch head missing");

        // Sync #1 — push a.md; the branch moves to H1 and H1 becomes
        // this device's confirmed lastSync head.
        fs.writeFileSync(path.join(client.vaultPath, "a.md"), "ours a\n");
        await client.manager.commitOnly();
        await sync2AllAndAssertNoErrors(client);
        const confirmedHead = await getBranchHead(branch); // H1
        expect(confirmedHead).not.toBe(staleHead);

        // Replica lag: the first 2 head GETs of the NEXT drain return
        // the superseded H0 (§7.10 window).
        let fakesServed = 0;
        installRequestFaultInjector({
          intercept(url, method) {
            if (
              fakesServed < 2 &&
              method === "GET" &&
              url.includes("/git/refs/heads/")
            ) {
              fakesServed += 1;
              return {
                status: 200,
                body: JSON.stringify({
                  ref: `refs/heads/${branch}`,
                  object: { sha: staleHead, type: "commit" },
                }),
              };
            }
            return null;
          },
        });

        // Sync #2 — a new batch; its guarded head read hits the lag.
        fs.writeFileSync(path.join(client.vaultPath, "b.md"), "ours b\n");
        await client.manager.commitOnly();
        await sync2AllAndAssertNoErrors(client);
        installRequestFaultInjector(null);

        // The stale window must actually have been exercised.
        expect(fakesServed).toBeGreaterThan(0);

        // I1 — both syncs' content is on the branch.
        expect(await readRemoteFile(branch, "a.md")).toBe("ours a\n");
        expect(await readRemoteFile(branch, "b.md")).toBe("ours b\n");

        // I2 — no "own data as conflict": the guard re-read instead of
        // reconciling our own push as a foreign change.
        expect(client.conflictStore.getAll()).toEqual([]);

        // I6/I5 — clean exit with consistent state.
        expect(await client.queue.list()).toEqual([]);
        expect(client.store.getLastSyncCommitSha()).toBe(
          await getBranchHead(branch),
        );
      },
      300_000,
    );
  },
);
