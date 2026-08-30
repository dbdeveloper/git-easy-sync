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
  uniqueBranchName,
  writeRemoteFile,
  getBranchCommitMessages,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
} from "../helpers";

// B7 — regression guard for the "interrupted adoption + canonicalize ON
// → 96-file convergence push" surprise that hit a real Android user.
//
// Scenario being reproduced:
//   1) Fresh client on a new device, autoCanonicalize: true.
//   2) Adoption starts: bootstrapFromRemote pulls files from GitHub
//      and writes them locally as canonical bytes (LF/no-BOM/trailing-
//      NL). recordSync is intentionally skipped for any file whose
//      bytes were rewritten (this is the documented "convergence push"
//      escape hatch).
//   3) Process dies mid-adoption (Android suspending the JS runtime
//      after Obsidian goes to background; or a crash; or the user
//      force-closing the app). lastSyncCommitSha is NOT yet set —
//      it lands at the end of bootstrapFromRemote, which never ran.
//   4) Plugin restarts. syncAll routes back into bootstrapIfNeeded →
//      bootstrapFromRemote.
//   5) Resume sees the partially-written files: they exist on disk
//      with canonical bytes; their git-blob SHA does NOT match the
//      raw remote item.sha (because remote bytes had CRLF/BOM).
//
// The bug: before the canonicalize-aware resume hint, step 5 fell
// into the mtime branch — local mtime (just-written, "now") was
// always newer than the remote commit date, so the file was
// classified as "local wins", recordSync was skipped again, and the
// next findChanges emitted it as "added" and pushed the canonical
// bytes back to GitHub as if they were user content. For a vault
// with N non-canonical files, that's an N-file commit on first
// setup that the user neither intended nor expected.
//
// The fix: bootstrapFromRemote now refetches the blob, canonicalizes
// it the same way writeRemoteText would, recomputes the SHA, and if
// the canonical-SHA matches the local SHA, treats the file as
// identical (recordSync against canonical SHA) instead of falling
// into mtime branch.
//
// Simulated kill: we don't actually need to interrupt — we just
// pre-stage the vault to match the on-disk state a killed adoption
// would have produced (canonical bytes, no snapshot entries, no
// lastSync). Then run syncAll and assert that no convergence push
// commit appears.

describe.skipIf(!integrationEnabled())(
  "sync2 B7 — adoption resume after interrupt with autoCanonicalize ON",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-b7-interrupt-canon");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "vault pre-staged with canonical bytes of CRLF remote → adoption resume records identical, no push back",
      async () => {
        // Remote files carry CRLF + BOM — non-canonical encodings the
        // plugin would normalize on pull. These are what triggers the
        // "changed" flag in writeRemoteText and the recordSync skip
        // that interrupted-adoption then forgets to clean up.
        const crlfText = "line one\r\nline two\r\nline three\r\n";
        const bomText = "﻿unicode header\r\nbody\r\n";
        await writeRemoteFile(
          branch,
          "with-crlf.md",
          crlfText,
          "[seed] CRLF file",
        );
        await writeRemoteFile(
          branch,
          "Folder/with-bom.md",
          bomText,
          "[seed] BOM file",
        );
        await writeRemoteFile(
          branch,
          "Folder/plain.md",
          "already canonical\n",
          "[seed] canonical file",
        );

        // Capture the seed commit count BEFORE the client runs anything.
        // The fix means adoption produces at most ONE follow-up commit
        // (sync2's invariant gitignores landing for the first time).
        // Without the fix, we'd see a second commit pushing the three
        // canonicalized files back as if they were user edits.
        const seedCommits = await getBranchCommitMessages(branch);

        // Spin up a fresh client with autoCanonicalize explicitly ON
        // — this is the regression's prerequisite. Off, no rewrite,
        // no SHA divergence, no bug.
        client = await createSync2Client({
          branch,
          autoCanonicalize: true,
        });

        // Pre-stage the vault to simulate the on-disk state left by a
        // killed adoption: canonical (LF, no-BOM, trailing-NL) bytes
        // exist locally, but lastSync is still null and no snapshot
        // entries exist. This is exactly what bootstrapFromRemote
        // produces just before it gets to setLastSync at the very
        // end of the loop — kill there, and this is the picture.
        await client.vault.adapter.write(
          "with-crlf.md",
          "line one\nline two\nline three\n",
        );
        await client.vault.adapter.mkdir("Folder");
        await client.vault.adapter.write(
          "Folder/with-bom.md",
          "unicode header\nbody\n",
        );
        await client.vault.adapter.write(
          "Folder/plain.md",
          "already canonical\n",
        );

        // Confirm pre-condition: snapshot empty, lastSync null.
        expect(client.hotMeta.getLastSyncCommitSha()).toBeNull();
        expect(await client.baselines.allPaths()).toEqual([]);

        // Now click Sync. bootstrapIfNeeded → bootstrapFromRemote
        // should run the canonicalize-aware resume check, recognize
        // these files as previously-canonicalized, record them as
        // identical, and skip the mtime branch entirely.
        await sync2AllAndAssertNoErrors(client);

        // Assertion 1 — files unchanged on disk after sync.
        const crlfPath = path.join(client.vaultPath, "with-crlf.md");
        const bomPath = path.join(client.vaultPath, "Folder/with-bom.md");
        const plainPath = path.join(client.vaultPath, "Folder/plain.md");
        expect(fs.readFileSync(crlfPath, "utf8")).toBe(
          "line one\nline two\nline three\n",
        );
        expect(fs.readFileSync(bomPath, "utf8")).toBe(
          "unicode header\nbody\n",
        );
        expect(fs.readFileSync(plainPath, "utf8")).toBe(
          "already canonical\n",
        );

        // Assertion 2 — snapshot now has entries for all three with
        // canonical SHAs recorded, and lastSync is set. This is the
        // adoption-success state.
        expect(client.hotMeta.getLastSyncCommitSha()).not.toBeNull();
        expect(await client.baselines.get("with-crlf.md")).toBeDefined();
        expect(await client.baselines.get("Folder/with-bom.md")).toBeDefined();
        expect(await client.baselines.get("Folder/plain.md")).toBeDefined();

        // Assertion 3 — THE KEY CHECK: the commit history on the
        // branch did not gain a "Sync at ..." convergence commit
        // pushing canonicalized versions back as user content.
        // Before the fix, the user would see a 3-file commit here
        // (one per non-canonical file). After the fix, at most one
        // commit appears, and only when sync2's invariant gitignores
        // are landing for the first time — never one that pushes
        // user-facing markdown files back.
        const finalCommits = await getBranchCommitMessages(branch);
        const newCommits = finalCommits.length - seedCommits.length;
        // 0 or 1 is fine (the optional invariants commit), but each
        // new commit must not mention any of the three test files.
        const newCommitMessages = finalCommits.slice(0, newCommits);
        for (const msg of newCommitMessages) {
          // Sync commit messages don't include file paths by default,
          // but as defense-in-depth we'd still want to make sure the
          // commit count is bounded and reasonable.
          expect(msg).not.toMatch(/with-crlf|with-bom|plain/i);
        }
        // Hard cap: we expect at most ONE extra commit (the invariant
        // gitignores), never three or more.
        expect(newCommits).toBeLessThanOrEqual(1);
      },
      120_000,
    );
  },
);
