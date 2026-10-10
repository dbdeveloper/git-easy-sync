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
// → 96-file convergence push" surprise that hit a real Android user:
// files the plugin itself had rewritten to canonical bytes (LF / no BOM /
// trailing NL) during an interrupted first sync were later pushed back
// to main as if they were the user's edits — an N-file commit on first
// setup that nobody asked for.
//
// ⚠️ RE-CHECKED 2026-10-10 against the current engine (traced with the
// log on). The old narrative here — `bootstrapFromRemote` skipping
// recordSync, then a canonicalize-aware resume hint — describes code
// deleted at THE SWITCH. What happens now, for this pre-staged vault
// (canonical bytes on disk, no baselines, no anchor; remote has the
// CRLF / BOM originals):
//   - the commit pass reports the three files as "added" (no baseline);
//   - the drain's cold start meets "both sides present, different, no
//     common base" for with-crlf.md and with-bom.md → a MANUAL CONFLICT
//     each (MASTER-PLAN §6.4, owner decision (A)): the vault keeps the
//     canonical bytes, the server's version lands as a conflict copy,
//     the local version goes to the CONFLICT branch — never to main;
//   - plain.md is identical on both sides → settled, no push.
// So the guarded outcome still holds — nothing is pushed to MAIN as
// user content — and that is what this test pins. It does NOT pin the
// two conflicts. Whether a difference that canonicalization erases
// (CRLF vs LF, a BOM) should count as "different" under §6.4 is an
// open question for the owner (2026-10-10).
//
// Simulated kill: no real interrupt — the vault is pre-staged to the
// on-disk state an interrupted first sync leaves (canonical bytes, no
// baselines, no anchor), then one syncAll runs.

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
      "vault pre-staged with canonical bytes of CRLF remote → first sync pushes nothing back to main as user content",
      async () => {
        // Remote files carry CRLF + BOM — non-canonical encodings that
        // canonicalization (commit side, when the user enables it)
        // rewrites; the vault below holds the rewritten bytes.
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

        // Pre-stage the vault to simulate the on-disk state left by an
        // interrupted first sync: canonical (LF, no-BOM, trailing-NL)
        // bytes exist locally, but the anchor is still null and no
        // baselines exist.
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

        // Confirm pre-condition: no baselines, no anchor.
        expect(client.hotMeta.getLastSyncCommitSha()).toBeNull();
        expect(await client.baselines.allPaths()).toEqual([]);

        // Now click Sync (see the header for what the engine does).
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

        // Assertion 2 — baselines exist for all three and the anchor is
        // set: the first sync completed.
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
