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
  readRemoteFile,
} from "../../../helpers";
import {
  createSync2Client,
  Sync2TestClient,
  sync2AllAndAssertNoErrors,
  conflictEntryCount,
} from "../helpers";

// B7 — regression guard for the "interrupted adoption + canonicalize ON
// → 96-file convergence push" surprise that hit a real Android user:
// files the plugin itself had rewritten to canonical bytes (LF / no BOM /
// trailing NL) during an interrupted first sync were later pushed back
// to main as if they were the user's edits — an N-file commit on first
// setup that nobody asked for.
//
// ⚠️ CONTRACT CHANGED 2026-10-10 (owner's decision, SYNC2-NEW-DRAIN
// §II.20). The old narrative here — `bootstrapFromRemote` skipping
// recordSync, then a canonicalize-aware resume hint — describes code
// deleted at THE SWITCH. Traced with the log on, the new engine at first
// resolved this vault (canonical bytes on disk, no baselines, no anchor;
// the repo holds the CRLF / BOM originals) with TWO manual conflicts:
// "both sides present, different, no common base" (§6.4 (A)) — although
// the two sides differ only by what the user's own canonicalization
// erases. Now "different" means different AFTER that canonicalization:
// the repo version is the common ancestor (this device's pull would have
// made the local bytes from it), and the ordinary rules push the
// canonical version — the same one normalization commit any pull of a
// non-canonical file leads to with the setting on.
//
// Contract: ZERO conflicts; the canonical bytes end up on BOTH sides
// (vault and main); plain.md, identical everywhere, is untouched.
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
      "vault pre-staged with canonical bytes of CRLF remote → no conflicts, canonical bytes on both sides",
      async () => {
        // Remote files carry CRLF + BOM — non-canonical encodings that
        // canonicalization rewrites (when the user enables it, on BOTH
        // the pull and the commit side); the vault below holds the
        // rewritten bytes.
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

        // Assertion 3 — THE KEY CHECK (§II.20): no conflict, and main
        // now carries the canonical bytes — the one normalization commit.
        expect(conflictEntryCount(client)).toBe(0);
        expect(await readRemoteFile(branch, "with-crlf.md")).toBe(
          "line one\nline two\nline three\n",
        );
        expect(await readRemoteFile(branch, "Folder/with-bom.md")).toBe(
          "unicode header\nbody\n",
        );
        expect(await readRemoteFile(branch, "Folder/plain.md")).toBe(
          "already canonical\n",
        );
      },
      120_000,
    );
  },
);
