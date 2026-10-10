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
  failOnNthMatch,
  getDefaultBranchHead,
  installRequestFaultInjector,
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

// C3 — push interrupted mid-flight, then the remote moves on a path
// that ALSO sits in the queued batch. The retry must:
//   1. Not clobber the remote's change with the batch's stale
//      snapshot.
//   2. Run a 3-way merge against the batch's snapshot (NOT the live
//      vault) so the queue stays the source of truth for queued
//      paths.
//   3. Push the merged content as part of the resumed batch.
//
// Implementation guard: `pullIfNeeded` skips `applyRemoteAddOrModify`
// for any path that's currently in any pending batch, AND withholds
// the lastSync advancement so `processBatch` enters Case 4 and runs
// `reconcileBatchAgainstHead` on those exact paths.

const isCreateBlob = (url: string, method: string): boolean =>
  method === "POST" && /\/git\/blobs(\?|$)/.test(url);

describe.skipIf(!integrationEnabled())(
  "sync2 C3 — resume push with concurrent remote change on a queued path",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-c3-resume-race");
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
      "B1 crashes mid-push, remote modifies a queued text file, retry → 3-way merge in batch, merged content lands",
      async () => {
        // Seed the branch with a baseline notes.md BEFORE the prime
        // sync, so when the merge happens at retry time both sides
        // share a real base. Without this the merge becomes
        // add-vs-add and diff3 produces a conflict, which is a
        // different scenario (covered by the conflicts/ test family,
        // not this one).
        await writeRemoteFile(
          branch,
          "notes.md",
          "line one\nline two\nline three\n",
          "[seed] base notes",
        );

        client = await createSync2Client({ branch });
        // Prime: the first sync cold-starts — the drain pulls notes.md
        // (already canonical, so the pull writes it unchanged even with
        // this client's canonicalize on), enforce() writes the invariant
        // .gitignore files and the drain pushes them. After this
        // lastSyncCommitSha = C0 and notes.md at C0 carries the baseline
        // content.
        await sync2AllAndAssertNoErrors(client);

        // Stage one text file edit (insertion in the middle) plus a
        // few binaries (so createBlob fires often enough for the
        // fault injector to bite somewhere predictable). The local
        // edit and the remote edit (below) touch different lines,
        // so 3-way merge will be clean.
        await client.vault.adapter.write(
          "notes.md",
          "line one\nlocal middle\nline two\nline three\n",
        );
        await client.vault.adapter.writeBinary(
          "attachments/a.png",
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33, 0x44])
            .buffer as ArrayBuffer,
        );
        await client.vault.adapter.writeBinary(
          "attachments/b.png",
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x55, 0x66, 0x77, 0x88])
            .buffer as ArrayBuffer,
        );
        await client.vault.adapter.writeBinary(
          "attachments/c.png",
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd])
            .buffer as ArrayBuffer,
        );

        // Sync #1: crash on the 2nd createBlob. With three binaries
        // queued, allSettled lets the OTHER two complete — uploadedBlobs
        // ends up populated for 2 of them, blank for 1.
        installRequestFaultInjector(
          failOnNthMatch(
            isCreateBlob,
            2,
            "Simulated crash mid-push of notes.md+binaries",
          ),
        );
        await expect(client.manager.syncAll()).rejects.toThrow(
          /Simulated crash/,
        );
        installRequestFaultInjector(null);

        // Sanity: queue has one batch, holds all 4 paths.
        const queueIds = await client.queue.list();
        expect(queueIds.length).toBe(1);
        const queuedBatch = await client.queue.read(queueIds[0]);
        expect(queuedBatch.files.sort()).toEqual(
          ["attachments/a.png", "attachments/b.png", "attachments/c.png", "notes.md"].sort(),
        );

        // Server-side race: another device appends to notes.md on
        // the SAME branch. The local edit (line 2 insertion) and
        // this remote edit (appended trailing line) touch disjoint
        // line ranges relative to the shared base, so diff3 returns
        // a clean merge.
        await writeRemoteFile(
          branch,
          "notes.md",
          "line one\nline two\nline three\nremote tail\n",
          "[other device] append tail",
        );

        // Sync #2: retry. pullIfNeeded should see the remote diff on
        // notes.md, notice it's in the queue, defer it (don't write to
        // vault, don't advance lastSync). processBatch then enters
        // reconcileBatchAgainstHead, 3-way merges notes.md against
        // (base=C0, ours=batch's snapshot, theirs=remote head). Clean
        // merge writes the result back into the batch via
        // queue.overwriteFile, push lands the merged bytes.
        await sync2AllAndAssertNoErrors(client);

        // Queue drained.
        expect(await client.queue.list()).toEqual([]);

        // Remote notes.md is the clean 3-way merge of:
        //   base   = the seed (line one / line two / line three)
        //   ours   = base + "local middle" inserted between 1 and 2
        //   theirs = base + "remote tail" appended after line three
        // Both edits land in the result, in their respective places.
        const finalNotes = await readRemoteFile(branch, "notes.md");
        expect(finalNotes).toContain("line one");
        expect(finalNotes).toContain("local middle");
        expect(finalNotes).toContain("line two");
        expect(finalNotes).toContain("line three");
        expect(finalNotes).toContain("remote tail");

        // All three binaries land on the server too.
        for (const p of [
          "attachments/a.png",
          "attachments/b.png",
          "attachments/c.png",
        ]) {
          expect(
            fs.existsSync(path.join(client.vaultPath, p)),
            `local ${p}`,
          ).toBe(true);
        }
      },
      240_000,
    );
  },
);
