import { describe, it, beforeEach, afterEach, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  bootstrapEnabled,
  countBranchCommits,
  getBranchHead,
  listRemoteFiles,
  readRemoteFile,
  recreateRepo,
  requireBootstrapEnv,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// Sync2 against a truly bare repo (no commits, no default branch).
// Mirrors the legacy A-series scenarios: needs a classic PAT with
// public_repo + delete_repo scope on a dedicated public ephemeral
// repo, because the only way back to bare state is delete + recreate.
//
// Bare-repo bootstrap goes through processBatch Case 1:
//   1. invariants.enforce() (run by syncAll) writes <vault>/.gitignore,
//      <configDir>/.gitignore, <configDir>/plugins/<self>/.gitignore
//      with their canonical content.
//   2. seedBareRepo() PUTs one of OUR OWN batch files via the
//      Contents API — ⚠️ RE-VERIFIED EMPIRICALLY at THE SWITCH gate
//      (2026-08-31): Git Data API (blobs/trees/commits) still answers
//      409 "Git Repository is empty" until a ref exists, so a
//      parentless first commit is impossible and the seed is the only
//      door in. Counts stay "seed + sync". —
//      the only endpoint that works without a pre-existing ref — and
//      records the resulting commit as the batch's parent.
//   3. The rest of processBatch builds a normal createTree+createCommit
//      on top of the seed for any remaining files in the batch (the two
//      configDir gitignores plus any user notes).
// Net effect: one "Init at …" commit holding just <vault>/.gitignore,
// followed by one "Sync at …" commit holding everything else.

(bootstrapEnabled() ? describe : describe.skip)(
  "sync2 bootstrap — bare repo flows",
  () => {
    let client: Sync2TestClient | undefined;
    const branch = "main"; // bare repo has no branches; first commit creates it

    beforeEach(async () => {
      await recreateRepo(requireBootstrapEnv());
      await new Promise((r) => setTimeout(r, 1500));
    });

    afterEach(() => {
      client?.cleanup();
      client = undefined;
    });

    it(
      "empty vault on bare repo: seed + sync land the three invariant gitignores",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await sync2AllAndAssertNoErrors(client);

        // Branch is now born: the seed commit + the follow-up sync
        // commit carrying whatever the seed did not already contain.
        expect(await getBranchHead(branch, env)).not.toBeNull();
        expect(await countBranchCommits(branch, env)).toBe(2);

        const files = await listRemoteFiles(branch, env);
        expect(files).toContain(".gitignore");
        expect(files).toContain(".obsidian/.gitignore");
        expect(files).toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
        // No user notes were written, so nothing else should appear.
        expect(files).toHaveLength(3);
      },
      150_000,
    );

    it(
      "single file on bare repo: seed + sync, both .gitignore and the note present",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("note.md", "hello bare");

        await sync2AllAndAssertNoErrors(client);

        expect(await countBranchCommits(branch, env)).toBe(2);

        const files = await listRemoteFiles(branch, env);
        expect(files).toContain("note.md");
        expect(files).toContain(".gitignore");
        expect(files).toContain(".obsidian/.gitignore");
        expect(files).toContain(
          ".obsidian/plugins/git-easy-sync/.gitignore",
        );
        // sync2 normalises text bytes (CRLF→LF, trailing newline) before
        // push — see text-normalize.ts. So the bytes that landed on
        // GitHub are the normalized form, not the literal write.
        expect(await readRemoteFile(branch, "note.md", env)).toBe(
          "hello bare\n",
        );
      },
      150_000,
    );

    it(
      "multi-file vault on bare repo: seed + single sync commit with all the files",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("a.md", "first");
        await client.vault.adapter.mkdir("Folder");
        await client.vault.adapter.write("Folder/b.md", "second");
        await client.vault.adapter.write("Folder/c.md", "third");

        await sync2AllAndAssertNoErrors(client);

        // Still two commits: seed + one combined sync commit. We don't
        // emit a commit per file — the whole batch lands together.
        expect(await countBranchCommits(branch, env)).toBe(2);

        const files = await listRemoteFiles(branch, env);
        expect(files).toContain("a.md");
        expect(files).toContain("Folder/b.md");
        expect(files).toContain("Folder/c.md");
      },
      180_000,
    );

    it(
      "second sync after bare-repo bootstrap is incremental, not another seed",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("a.md", "v1");
        await sync2AllAndAssertNoErrors(client);

        // Two commits after the first sync (seed + initial batch).
        const commitsAfterFirst = await countBranchCommits(branch, env);
        expect(commitsAfterFirst).toBe(2);

        // Now edit and add — the next syncAll must build on the existing
        // head (Case 3 fast-path), not re-seed.
        await client.vault.adapter.write("a.md", "v2");
        await client.vault.adapter.write("b.md", "fresh");
        await sync2AllAndAssertNoErrors(client);

        // Incremental: builds on the existing head, never re-seeds.
        expect(await countBranchCommits(branch, env)).toBe(3);

        expect(await readRemoteFile(branch, "a.md", env)).toBe("v2\n");
        expect(await readRemoteFile(branch, "b.md", env)).toBe("fresh\n");

        // sync2 also rewrites the local file to canonical form on push,
        // so the on-disk copy carries the trailing newline as well.
        expect(
          fs.readFileSync(path.join(client.vaultPath, "a.md"), "utf8"),
        ).toBe("v2\n");
      },
      180_000,
    );

    // Empirical guard for the 409-on-createCommit eventual-consistency
    // flake (GitHub Community discussion #62198). Before retry-on-409
    // was wired into the GithubClient write methods, this exact pattern
    // (bare bootstrap, then immediate incremental sync ~10ms later)
    // flaked ~20% of the time — GitHub's Git Data API briefly didn't
    // see the just-updated branch head as a valid parent for the next
    // createCommit. Re-running the scenario 10× back-to-back against
    // a fresh bare repo each time catches any regression in either
    // the retry plumbing (utils.isWriteRetriableStatus, the predicate
    // wiring in GithubClient.createTree/createCommit/...) or in the
    // batched seed+sync flow itself. Each iteration takes ~10-15s
    // (recreateRepo + bare-bootstrap + incremental); the whole stress
    // test adds ~2 min to a bootstrap run but stays bounded.
    it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
      "stress: 10 fresh bare repos, all reach 3 commits without 409 — run %d/10",
      async () => {
        const env = requireBootstrapEnv();
        client = await createSync2Client({ branch, env });

        await client.vault.adapter.write("a.md", "v1");
        await sync2AllAndAssertNoErrors(client);
        expect(await countBranchCommits(branch, env)).toBe(2);

        await client.vault.adapter.write("a.md", "v2");
        await client.vault.adapter.write("b.md", "fresh");
        await sync2AllAndAssertNoErrors(client);

        // seed + first sync + the incremental one.
        expect(await countBranchCommits(branch, env)).toBe(3);
        expect(await readRemoteFile(branch, "a.md", env)).toBe("v2\n");
        expect(await readRemoteFile(branch, "b.md", env)).toBe("fresh\n");
      },
      180_000,
    );

    it(
      "disable+re-enable after bare bootstrap: next syncAll is a no-op",
      async () => {
        const env = requireBootstrapEnv();
        // First client doesn't own the temp vault — we want it to live
        // across the simulated reload. Ownership transfers to the
        // second client below so afterEach still rm-rfs it cleanly.
        const first = await createSync2Client({
          branch,
          env,
          ownsVaultPath: false,
        });
        const vaultPath = first.vaultPath;
        // Track the owning client so a throw before the second
        // createSync2Client doesn't leak the temp dir.
        client = {
          ...first,
          cleanup: () => {
            try {
              fs.rmSync(vaultPath, { recursive: true, force: true });
            } catch {}
          },
        };

        await sync2AllAndAssertNoErrors(first);

        const commitsAfterFirst = await countBranchCommits(branch, env);
        expect(commitsAfterFirst).toBe(2);
        const headAfterFirst = await getBranchHead(branch, env);

        // Simulated re-enable: fresh manager + store over the same
        // on-disk vault. The metadata stores pick up the persisted
        // metadata (lastSyncCommitSha, lastSyncTreeSha, invariantState,
        // per-file snapshots), so the next syncAll should:
        //   - bootstrapIfNeeded → lastSyncCommitSha !== null → bail.
        //   - pullIfNeeded → no remote changes → no-op.
        //   - invariants.enforce → cached mtimes match → no rewrites.
        //   - findChanges → cache-hit short-circuit → [].
        //   - syncAll → "nothing to sync".
        client = await createSync2Client({
          branch,
          env,
          vaultPath,
          ownsVaultPath: true, // claim cleanup for afterEach
        });
        await sync2AllAndAssertNoErrors(client);

        expect(await countBranchCommits(branch, env)).toBe(2);
        expect(await getBranchHead(branch, env)).toBe(headAfterFirst);
      },
      210_000,
    );
  },
);
