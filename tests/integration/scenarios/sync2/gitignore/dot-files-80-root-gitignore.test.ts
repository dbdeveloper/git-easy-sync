import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import {
  createBranchFromHead,
  deleteBranchIfExists,
  ensureRepoNotBare,
  getDefaultBranchHead,
  integrationEnabled,
  readRemoteFile,
  removeRemoteFile,
  uniqueBranchName,
  writeRemoteFile,
} from "../../../helpers";
import { createSync2Client, Sync2TestClient } from "../helpers";
import { INVARIANT_BEGIN } from "../../../../../src/sync2/gitignore-invariants";

// DOT-FILES §8.0 — the end-to-end half the unit tests cannot give.
//
// §8.0 was opened by a MEASUREMENT (two probes on real GitHub,
// 2026-09-01) and its gate is the same measurement repeated: on a vault
// that has never synced, against a repo that already has a root
// `.gitignore`, the sync must NOT manufacture a conflict. Only this
// path can prove it — it crosses commit pass → drain → commit pass, and
// no unit harness composes both sides.
//
// The mechanism under test (owner's design, 2026-09-20): the managed
// files are written BEFORE any sync, as they always were, but a file
// whose bytes are exactly what we seed is marked as ours, and the drain
// then uses that content as the file's own ANCESTOR. The repo's version
// reads as an ordinary edit on top of it (rule 4.3, clean pull) instead
// of an unrelated file with no common base (rule 4.2, manual conflict).
//
// A  — the defect: vault had no .gitignore, so every byte of the old
//      conflict came from us.
// A2 — the trap the marker must NOT spring: with no .gitignore in the
//      repo, our seeded file still has to be pushed.
// B  — not a defect: the user's own .gitignore versus the repo's is a
//      genuine no-common-base collision (§6.4 rule A). We splice our
//      block into it first, deliberately — invariants stand before any
//      sync — so the conflict carries "user + our block".

const REPO_RULES = "# repo rules\n*.tmp\n";
const USER_RULES = "# my own rules\n*.bak\n";

describe.skipIf(!integrationEnabled())(
  "sync2 §8.0: a repo's root .gitignore is adopted, never fought",
  () => {
    let client: Sync2TestClient | undefined;
    let branch: string;

    beforeAll(async () => {
      await ensureRepoNotBare();
    });

    beforeEach(async () => {
      branch = uniqueBranchName("sync2-dot80");
      const head = await getDefaultBranchHead();
      if (!head) throw new Error("default branch missing");
      await createBranchFromHead(branch, head);
      await writeRemoteFile(
        branch,
        ".gitignore",
        REPO_RULES,
        "seed: repo already has a root .gitignore",
      );
    });

    afterEach(async () => {
      client?.cleanup();
      await deleteBranchIfExists(branch);
    });

    it(
      "A: vault has NO .gitignore — the first sync adopts the repo's one with ZERO conflicts, the next pass adds our block",
      async () => {
        client = await createSync2Client({ branch });
        // Nothing of ours has ever run here: no baseline, no local
        // .gitignore. This is every new user connecting an existing repo.
        expect(await client.vault.adapter.exists(".gitignore")).toBe(false);

        await client.manager.syncAll();

        // THE assertion §8.0 exists for. Before the fix this was
        // [".gitignore"] — a manual conflict the user never caused.
        expect([
          ...client.conflictStore.getCachedState().entries.keys(),
        ]).toEqual([]);

        // Adopted by an ordinary pull (rule 4.1.b), byte-for-byte.
        expect(await client.vault.adapter.read(".gitignore")).toBe(REPO_RULES);

        // Second pass: the baseline now exists, so enforce() splices our
        // block into the adopted file and it travels as an ordinary
        // local change. Still no conflict.
        await client.manager.syncAll();
        expect([
          ...client.conflictStore.getCachedState().entries.keys(),
        ]).toEqual([]);

        const local = await client.vault.adapter.read(".gitignore");
        expect(local).toContain(INVARIANT_BEGIN);
        expect(local).toContain("*.conflict-from-*");
        // The repo's own rules survived underneath ours.
        expect(local).toContain("*.tmp");

        const remote = await readRemoteFile(branch, ".gitignore");
        expect(remote).toBe(local);
      },
      600_000,
    );

    it(
      "A2: repo has NO .gitignore — the seeded file must still be PUSHED (the fake ancestor must not fire)",
      async () => {
        // The trap this guards: a fake ancestor applied unconditionally
        // would make base == local with remote == null, which no rule
        // in _diff3 handles — 2.a/2.b need matching nullness and
        // 4.3-4.6 all require local.sha !== base.sha, so it falls
        // through to the merge path with a null remote. Today the
        // right answer is base == null → 4.1.a → push ours, and it
        // must stay that way.
        // A real note FIRST, then drop the .gitignore: without it the
        // branch would be left with git's empty tree
        // (4b825dc642cb6eb9a060e54bf8d69288fbee4904), and GitHub
        // answers 404 for that sha — measured, not guessed. That is a
        // different state from "bare repo" and it is not what this
        // test is about.
        await writeRemoteFile(
          branch,
          "a2-note.md",
          "hello from A2\n",
          "seed: keep the tree non-empty",
        );
        await removeRemoteFile(
          branch,
          ".gitignore",
          "seed removal: this scenario has no repo .gitignore",
        );
        client = await createSync2Client({ branch });

        await client.manager.syncAll();

        expect([
          ...client.conflictStore.getCachedState().entries.keys(),
        ]).toEqual([]);
        const remote = await readRemoteFile(branch, ".gitignore");
        expect(remote).toContain(INVARIANT_BEGIN);
        expect(remote).toContain("*.log"); // our seeded defaults travelled
      },
      600_000,
    );

    it(
      "B: vault has its OWN differing .gitignore — the conflict is legitimate, but our block must not pollute the user's side",
      async () => {
        client = await createSync2Client({ branch });
        // The user wrote this before ever syncing.
        await client.vault.adapter.write(".gitignore", USER_RULES);

        await client.manager.syncAll();

        // Two real files, no common ancestor → a conflict is the
        // DESIGNED answer (§6.4 rule A), not a defect.
        expect([
          ...client.conflictStore.getCachedState().entries.keys(),
        ]).toEqual([".gitignore"]);

        // …and the ours-side is the user's file WITH our block in it.
        // That is the owner's decision (2026-09-20): invariants stand
        // before any sync, so a pre-existing .gitignore is spliced
        // first and the conflict compares "user + our block" against
        // the repo's version. Our block is ours and idempotent; the
        // user's own rules are untouched below it.
        const ours = await client.vault.adapter.read(".gitignore");
        expect(ours).toContain(INVARIANT_BEGIN);
        expect(ours).toContain("*.bak"); // the user's rule survived

        // Theirs landed beside it as a sibling, as designed.
        const siblings = (await client.vault.adapter.list("")).files.filter(
          (f) => f.includes(".conflict-from-"),
        );
        expect(siblings).toHaveLength(1);
      },
      600_000,
    );
  },
);
