import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx, {
  SIBLING_TX_MARK_FILE,
} from "../../src/sync2/sibling-tx";
import { drainOnce, DrainDeps } from "../../src/sync2/drain";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import {
  buildSiblingFilePath,
  formatTimestampForFilename,
} from "../../src/sync2/conflict-siblings";
import { ClaimedBatch } from "../../src/sync2/get-batch";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import {
  RemoteFileChange,
  DiscoveryResult,
  DELETED_SHA_HASH,
} from "../../src/sync2/discovery";
import { AuthError, NetworkError } from "../../src/errors";
import { calculateGitBlobSHA } from "../../src/utils";
import {
  FakeWorld,
  FakeVaultFiles,
  RepoFiles,
  enc,
  dec,
  sha,
} from "./drain-harness";

// §VIII category C (manual-conflict lifecycle, §II.6) driven through
// the FULL drainOnce — STEP1/STEP2/STEP3 wired (Phase 5 steps 5-6) —
// plus C.19a (the two-drain no-clobber proof), E.3-5 (device_label
// NETWORK_ERROR aborts on all three birth sites) and L.3 (MAIN and
// CONFLICT refs advance independently).

const PLUGIN_ID = "git-easy-sync";
const NOTE = "note.md";
const V0 = "one\ntwo\nthree\n";

describe("drain conflict lifecycle (§VIII C + E.1-E.5 + J.1/J.6 + L.3)", () => {
  let dir: string;
  let vault: Vault;
  let world: FakeWorld;
  let syncStore: SyncStore;
  let journal: DrainJournal;
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let vaultFiles: FakeVaultFiles;
  let baselines: Map<
    string,
    { baselineSha: string; mtime: number; size: number }
  >;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let baseCommit: string | null;
  let batchSeq: number;
  let commitInfoCalls: string[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "drain-conf-test-"));
    vault = new Vault(dir);
    world = new FakeWorld();
    syncStore = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    journal = new DrainJournal({ vault: vault as never, selfPluginId: PLUGIN_ID });
    conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
      generateGuid: () => `guid-${++batchSeq}`,
    });
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    batches = [];
    baseCommit = null;
    batchSeq = 0;
    commitInfoCalls = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const honestDiscovery = async (
    base: string | null,
    head: string,
  ): Promise<DiscoveryResult> => {
    const headFiles = world.filesAt(head);
    const baseFiles: RepoFiles =
      base === null ? new Map() : world.filesAt(base);
    const out: RemoteFileChange[] = [];
    const all = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const p of all) {
      const h = headFiles.get(p) ?? null;
      const b = baseFiles.get(p) ?? null;
      if (h?.sha === b?.sha) continue;
      out.push({
        path: p,
        sha: h?.sha ?? DELETED_SHA_HASH,
        // ⚠️ HONEST FAKE (gate finding 2026-08-31): the production
        // compare path returns NO sizes — the old fake filled them
        // from the bytes and thereby HID a real defect (a sibling
        // stored with size=null froze the conflict's theirs-side).
        // Only the tree fallback knows sizes; the fold must cope.
        size: null,
        mtime: null,
        deleted: h === null,
      });
    }
    // tree: null → Layer 2 keeps using the per-path transport,
    // so every pre-existing assertion here still covers THAT path.
    return { changes: out, tree: null };
  };

  const stageBatch = async (
    files: Record<string, string | null>,
    mtime = 100,
  ): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      if (content === null) {
        entries.push({ path: p, sha: null, size: null, mtime: null, deletedSha: null });
        continue;
      }
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({
        path: p,
        sha: s,
        size: enc(content).byteLength,
        mtime,
        deletedSha: null,
      });
    }
    const id = `b${++batchSeq}`;
    batches.push({
      claimed: {
        id,
        dir: `queue/${id}`,
        meta: { v: 1, id, createdAt: 0, entries },
      },
      removed: false,
    });
  };

  const makeDeps = (over?: Partial<DrainDeps>): DrainDeps => {
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, atSha) => {
      commitInfoCalls.push(p);
      return origInfo(p, atSha);
    };
    return {
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      client,
      syncStore,
      journal,
      retry: new NetworkRetry({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
        maxAttempts: 2,
        sleep: async () => {},
      }),
      claimBatch: async () => {
        const next = batches.find((b) => !b.removed);
        return next ? next.claimed : null;
      },
      removeBatchDir: async (d) => {
        const b = batches.find((x) => x.claimed.dir === d);
        if (b) b.removed = true;
      },
      baselines: {
      get: async (p) => baselines.get(p),
      // §5.4 — a hold rescues a folder\'s baselines. No fixture
      // here holds anything, so empty is the honest answer.
      listUnder: async () => [],
      setMany: async (entries) => {
        for (const e of entries) {
          baselines.set(e.path, {
            baselineSha: e.baselineSha,
            mtime: e.mtime,
            size: e.size,
          });
        }
      },
      removeMany: async (paths) => {
        for (const p of paths) baselines.delete(p);
      },
    },
      discoverChangedFiles: honestDiscovery,
      hot: {
        getLastSyncCommitSha: () => baseCommit,
        getLastSyncTreeSha: () => null,
        getConflictBranch: () => null,
        getHeldPluginUpdates: () => ({}),
        update: async () => {},
      },
      conflictStore,
      siblingTx,
      tokenExpired: async () => false,
      vaultFiles,
      mergeBlobs: mergeBlobsWithMainThreadDiff3,
      computeSha: calculateGitBlobSHA,
      maxAutoMergeFileSize: () => 10_000_000,
      deviceLabel: () => "this-device",
      commitMessage: () => "Sync at test (this-device)",
      mergeMessage: () => "Merge conflict branch (this-device)",
      now: () => 1_800_000_000_000,
      ...over,
    };
  };

  const setupAligned = async (extra: Record<string, string> = {}) => {
    baseCommit = await world.commitFiles({ [NOTE]: V0, ...extra });
    for (const [p, content] of Object.entries({ [NOTE]: V0, ...extra })) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
  };

  // The remote fake stamps this label/date via getCommitInfoForPath.
  const REMOTE_LABEL = "other-device";
  const remoteSiblingName = (mtimeMs: number): string =>
    buildSiblingFilePath(NOTE, mtimeMs, REMOTE_LABEL);
  const vaultHas = (p: string): boolean => fs.existsSync(path.join(dir, p));

  // Same-line clash: remote and local both rewrite line 1.
  const REMOTE_CLASH = "REMOTE\ntwo\nthree\n";
  const LOCAL_CLASH = "LOCAL\ntwo\nthree\n";

  // + G.2: the journal doesn't confirm and the branch doesn't exist
  // yet (conflict_head_hash == null) → shouldPushToConflictBranch says
  // PUSH. That decision is what mints the branch below.
  it("C.1 + C.4 + C.13(step1) + L.3 + G.2: STEP1 births the conflict — branch gets local, main gets the OTHER file, base file untouched, first sibling written", async () => {
    await setupAligned({ "clean.md": "clean v0\n" });
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH, "clean.md": "clean v1\n" });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    vaultFiles.files.set("clean.md", { content: "clean v1\n", mtime: 100 });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts.some((v) => v.site === "step1")).toBe(true);

    // L.3: the two refs advanced independently — main carries the
    // clean file, NEVER the conflicted local content…
    expect(dec(world.headFiles().get("clean.md")!.bytes)).toBe("clean v1\n");
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH);
    // …and the conflict branch carries exactly the local content.
    const branchNames = [...world.branchHeads.keys()];
    expect(branchNames).toHaveLength(1);
    const branchFiles = world.filesAt(world.branchHeads.get(branchNames[0])!);
    expect(dec(branchFiles.get(NOTE)!.bytes)).toBe(LOCAL_CLASH);

    // Durable record: conflictBase = local; first sibling = remote.
    const durable = await conflictStore.load();
    const rec = durable.entries.get(NOTE)!;
    expect(rec.conflictBase.sha).toBe(await sha(LOCAL_CLASH));
    expect(rec.siblings).toHaveLength(1);
    expect(rec.siblings[0].sha).toBe(await sha(REMOTE_CLASH));
    // C.13/step1: the sibling is attributed to the REMOTE device+date.
    expect(rec.siblings[0].deviceLabel).toBe(REMOTE_LABEL);
    // C.4: the sibling file exists; the base file in the vault is NOT
    // touched (still the user's local content).
    expect(vaultHas(remoteSiblingName(rec.siblings[0].mtime!))).toBe(true);
    expect(vaultFiles.files.get(NOTE)!.content).toBe(LOCAL_CLASH);
  });

  // ── §VIII D — crash BETWEEN the MAIN push and the CONFLICT push ───
  //
  // Phase 6, crash matrix. The scenario above is the one batch that
  // writes to BOTH refs, so it is also the only place this window
  // exists: main has taken the commit, the branch has not, and the
  // journal — which is persisted after both — still describes the
  // world as it was before either.
  //
  // Neighbouring cells cover the ends and left this middle open: B.4
  // crashes after a main push with no conflict in play, G.3 crashes
  // after the BRANCH push. What is specific here is the asymmetry —
  // one ref moved, the other did not, and the redo must finish the
  // second without doing the first twice.
  it("D: crash between the MAIN push and the CONFLICT push → the redo lands the branch commit and does NOT duplicate the main one", async () => {
    await setupAligned({ "clean.md": "clean v0\n" });
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH, "clean.md": "clean v1\n" });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    vaultFiles.files.set("clean.md", { content: "clean v1\n", mtime: 100 });
    const commitsBefore = world.commits.length;

    const d1 = makeDeps();
    d1.client.pushCommitToBranch = async () => {
      throw new Error("power loss between the two pushes");
    };
    await expect(drainOnce(d1)).rejects.toThrow("power loss");

    // ⚠️ THE INTERMEDIATE STATE, asserted before the redo. Without
    // this the test would also pass if the crash had fired somewhere
    // else entirely — the vacuity trap this whole category has.
    expect(world.commits.length).toBe(commitsBefore + 1); // main DID move…
    expect(dec(world.headFiles().get("clean.md")!.bytes)).toBe("clean v1\n");
    expect(world.branchHeads.size).toBe(0); // …the branch did NOT
    expect(batches[0].removed).toBe(false); // the work is still owed

    // The redo. It must finish the half that never happened.
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    const branchNames = [...world.branchHeads.keys()];
    expect(branchNames).toHaveLength(1);
    expect(
      dec(world.filesAt(world.branchHeads.get(branchNames[0])!).get(NOTE)!.bytes),
    ).toBe(LOCAL_CLASH);
    // …without doing the half that did: `clean.md` is already on main
    // byte-for-byte, so the second run must find nothing to push for
    // it. A duplicate commit here would be B.4's defect wearing a
    // conflict costume.
    expect(r2.pushedCommits).toHaveLength(0);
    expect(dec(world.headFiles().get("clean.md")!.bytes)).toBe("clean v1\n");
    expect(batches[0].removed).toBe(true);
    // And the conflict itself survived the crash intact.
    const rec2 = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec2.siblings).toHaveLength(1);
    expect(vaultFiles.files.get(NOTE)!.content).toBe(LOCAL_CLASH);
  });

  // + G.1 (head-unchanged half): the journal confirms
  // ⚠️ NOT G.1, despite the resemblance — verified by probe
  // 2026-09-20. Re-committing identical content never reaches
  // shouldPushToConflictBranch at all: the restored placeholder makes
  // tracked.base == local, so the entry is resolved as "unchanged"
  // before STEP2. Disabling the journal-confirm branch entirely leaves
  // this test green. G.1 (the journal confirms → skip, no network) has
  // its own test in the §VIII G suite, where tracked.base is made to
  // DIFFER so STEP2 is actually entered.

  // ── 🔴 THE SAME LIE, IN THE CONFLICT PATHS ───────────────────────
  //
  // The Vault-step's skip sites are mostly HERE: a sibling file gone
  // from the vault, a fold whose blob is unavailable, a remote that
  // vanished before the conflict could be registered. Each records a
  // `vaultStepError` and continues — and the epilogue then transfers
  // `tracked.remote` into the baseline anyway, about a file nothing
  // wrote.
  //
  // ⚠️ Site 2193 carries a comment claiming "base NOT advanced, the
  // next drain retries". It is true of `tracked.base` and false of the
  // PERSISTED baseline, which is what the next scan actually reads —
  // the same divergence a probe caught in the staging work the day
  // before.
  describe("🔴 a conflict path the Vault-step SKIPPED keeps its old baseline", () => {
    it("a fresh remote whose blob is gone → fold skipped, baseline NOT advanced", async () => {
      // The conflict must already EXIST for the Vault-step to be the
      // one that meets the missing blob: inside the batch loop the
      // same absence makes `_diff3` THROW, which aborts the whole
      // drain — noisy, but the safe direction (the journal survives
      // and the next run retries). The quiet, dangerous path is this
      // one.
      await setupAligned();
      await world.commitFiles({ [NOTE]: REMOTE_CLASH });
      await stageBatch({ [NOTE]: LOCAL_CLASH });
      vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
      await drainOnce(makeDeps());
      baseCommit = world.head;

      // A SECOND remote version arrives while the conflict is live,
      // and its object is not in the repo.
      const V3 = "REMOTE-3\ntwo\nthree\n";
      await world.commitFiles({ [NOTE]: V3 });
      const v3Sha = await sha(V3);
      world.blobs.delete(v3Sha);
      const baselineBefore = baselines.get(NOTE)?.baselineSha;

      const r = await drainOnce(makeDeps());
      expect(r.vaultStepErrors.length).toBeGreaterThan(0);
      // Nothing of V3 reached the vault — no sibling carries it...
      for (const f of vaultFiles.files.values()) {
        expect(f.content).not.toBe(V3);
      }
      // ...so the baseline must not have moved to it.
      expect(baselines.get(NOTE)?.baselineSha).not.toBe(v3Sha);
      expect(baselines.get(NOTE)?.baselineSha).toBe(baselineBefore);
    });
  });

  it("C.2: STEP2 dedups the branch push — identical local content is NOT re-pushed; a new edit IS", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const branch = [...world.branchHeads.keys()][0];
    const headAfterStep1 = world.branchHeads.get(branch)!;

    // Drain 2: the SAME local content re-committed (churn shape) —
    // the journal confirms conflictBase.sha == local.sha → no push.
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(world.branchHeads.get(branch)).toBe(headAfterStep1);

    // Drain 3: a NEW local edit while in conflict → branch advances.
    const LOCAL_2 = "LOCAL-2\ntwo\nthree\n";
    await stageBatch({ [NOTE]: LOCAL_2 });
    vaultFiles.files.set(NOTE, { content: LOCAL_2, mtime: 200 });
    const r3 = await drainOnce(makeDeps());
    expect(r3.status).toBe("ok");
    const newBranchHead = world.branchHeads.get(branch)!;
    expect(newBranchHead).not.toBe(headAfterStep1);
    expect(dec(world.filesAt(newBranchHead).get(NOTE)!.bytes)).toBe(LOCAL_2);
    const durable = await conflictStore.load();
    expect(durable.entries.get(NOTE)!.conflictBase.sha).toBe(
      await sha(LOCAL_2),
    );
    // Main NEVER saw any of the local versions.
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH);
  });

  it("C.3 + C.5 + C.13(pull-folding): a fresh remote while in conflict FOLDS into the sibling (replace — same list length, old file gone)", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const firstSibling = (await conflictStore.load()).entries.get(NOTE)!
      .siblings[0];

    // Remote edits line 3 on top (line 1 stays REMOTE) → foldable.
    const REMOTE_2 = "REMOTE\ntwo\nTHREE-v2\n";
    world.committedAt += 5000;
    await world.commitFiles({ [NOTE]: REMOTE_2 });
    baseCommit = world.commits[world.commits.length - 2]; // pre-R2 anchor

    commitInfoCalls = [];
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    // C.13/pull-folding: the lazy info call fired for the conflicted path.
    expect(commitInfoCalls).toContain(NOTE);

    const durable = await conflictStore.load();
    const rec = durable.entries.get(NOTE)!;
    expect(rec.siblings).toHaveLength(1); // replace, not append
    // The fold: diff3(base=LOCAL, ours=R1-sibling, theirs=R2) — line 1
    // agreed (REMOTE), line 3 from R2.
    const newSibPath = remoteSiblingName(rec.siblings[0].mtime!);
    expect(vaultHas(newSibPath)).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, newSibPath), "utf8"),
    ).toBe(REMOTE_2);
    // The OLD sibling file is gone (mark transaction step 4).
    expect(vaultHas(remoteSiblingName(firstSibling.mtime!))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime", SIBLING_TX_MARK_FILE))).toBe(false);
    // C.13/pull-folding, owner rule §II.6 п.5 — asserted against the
    // SOURCE of the name, not against the stored value. `rec.siblings
    // [0].mtime` above is the very field the rule sets, so deriving
    // the expected name from it can only prove self-consistency; a
    // fold that stamped the merge moment instead of the folded remote
    // commit would sail through. The fake stamps R2 at this time.
    expect(rec.siblings[0].mtime).toBe(world.committedAt);
  });

  it("C.5b: a NO-OP fold (the user's sibling edit already equals the fresh remote → merged == sibling) must not run the replace transaction", async () => {
    // Found by mutation probe (§IX.3, 2026-09-23): deleting the
    // `merged.sha === previousSibling.sha` short-circuit left the
    // whole suite green, and the §II.11 mark transaction is the ONE
    // branch that destroys evidence — it deletes the old sibling file
    // in step 4. Nothing was watching it run on a fold with nothing
    // to replace.
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const firstSibling = (await conflictStore.load()).entries.get(NOTE)!
      .siblings[0];
    const firstName = remoteSiblingName(firstSibling.mtime!);
    expect(vaultHas(firstName)).toBe(true);

    // The user already edited the sibling to exactly what the other
    // device then pushes. diff3(origin=REMOTE_CLASH, ours=edited sibling,
    // theirs=the same text) → both sides made the same change → merged ==
    // the sibling on disk, byte for byte: nothing to replace.
    const SAME = "REMOTE\ntwo\nTHREE-both\n";
    fs.writeFileSync(path.join(dir, firstName), SAME);
    world.committedAt += 5000;
    await world.commitFiles({ [NOTE]: SAME });
    baseCommit = world.commits[world.commits.length - 2];

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    const rec = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec.siblings).toHaveLength(1);
    // The sibling survived, under its ORIGINAL name, with its bytes.
    // This `vaultHas` is the one the mutation breaks, and it confirms
    // the source comment's mechanism exactly: `merged` IS the previous
    // sibling's own FileInfo (ours-wins returns the object, not a
    // copy), so the `merged.mtime = tracked.remote.mtime` further down
    // mutates it IN PLACE — old and new then derive the same file name
    // and the transaction's step 4 deletes what its step 2 wrote. The
    // record keeps pointing at a file that is no longer there.
    expect(rec.siblings[0].sha).toBe(firstSibling.sha);
    expect(vaultHas(firstName)).toBe(true);
    expect(fs.readFileSync(path.join(dir, firstName), "utf8")).toBe(SAME);
    // The origin still moved on to the remote just folded — the next
    // fold must start from it, not from the older version.
    expect(rec.siblings[0].originSha).toBe(await sha(SAME));
    // And no transaction mark was left behind by a run that should
    // never have started.
    expect(fs.existsSync(path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime", SIBLING_TX_MARK_FILE))).toBe(false);
  });

  it("C.21 (free size): every sibling persisted in conflicts.json carries a PROVEN size — the fake compare gives none", async () => {
    baseCommit = await world.commitFiles({ [NOTE]: V0 });
    baselines.set(NOTE, { baselineSha: await sha(V0), mtime: 50, size: 12 });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    const e = conflictStore.getCachedState().entries.get(NOTE)!;
    // conflictBase (ours, from the batch metafile) AND the sibling
    // (theirs, from a size-less compare) both carry real sizes.
    expect(e.conflictBase.size).toBe(enc(LOCAL_CLASH).byteLength);
    expect(e.siblings[0].size).toBe(enc(REMOTE_CLASH).byteLength);
    // And the durable baseline is truthful too (never 0).
    expect(baselines.get(NOTE)!.size).toBe(enc(REMOTE_CLASH).byteLength);
  });

  it("C.20 (gate regression 2026-08-31): a SECOND divergent remote version FOLDS into the sibling — size=null from compare must not freeze the theirs-side", async () => {
    // EXACT real-test shapes: single-line files.
    baseCommit = await world.commitFiles({ [NOTE]: "v0 baseline\n" });
    baselines.set(NOTE, {
      baselineSha: await sha("v0 baseline\n"),
      mtime: 50,
      size: 12,
    });
    vaultFiles.files.set(NOTE, { content: "ours v1\n", mtime: 100 });
    await world.commitFiles({ [NOTE]: "theirs v1\n" });
    await stageBatch({ [NOTE]: "ours v1\n" });
    const r1 = await drainOnce(makeDeps());
    expect(r1.status).toBe("ok");
    const e1 = conflictStore.getCachedState().entries.get(NOTE)!;
    expect(e1.siblings).toHaveLength(1);
    // Sizes are BACKFILLED at birth even though compare gave none —
    // otherwise the fold below dies on _diff3's rule-6 assert.
    expect(e1.siblings[0].size).toBeGreaterThan(0);

    // Remote moves AGAIN (theirs v2), local unchanged.
    baseCommit = world.head;
    await world.commitFiles({ [NOTE]: "theirs v2\n" });
    // The commit pass would re-emit the path (local != baseline).
    await stageBatch({ [NOTE]: "ours v1\n" });
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    const e2 = conflictStore.getCachedState().entries.get(NOTE)!;
    // The fold RAN: the theirs-side moved on. ONE sibling: the fold's
    // ancestor is the sibling's origin (theirs v1), and the sibling is
    // unedited, so v2 replaces it (owner, 2026-10-09 — it used to
    // APPEND, because the ancestor was conflictBase, i.e. OUR side).
    expect(r2.vaultStepErrors).toEqual([]); // ← the defect surfaced HERE
    expect(e2.siblings).toHaveLength(1);
    expect(e2.siblings.at(-1)!.sha).not.toBe(e1.siblings[0].sha);
    // conflictBase (ours) is carried through verbatim.
    expect(e2.conflictBase.sha).toBe(e1.conflictBase.sha);
  });

  it("C.6 + C.12: an UNFOLDABLE new remote APPENDS a sibling — the list grows, both files on disk, order = append = mtime order", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const sib1 = (await conflictStore.load()).entries.get(NOTE)!.siblings[0];

    // The fold's ancestor is the sibling's ORIGIN (owner, 2026-10-09), so
    // an unedited sibling always folds cleanly. An append needs a REAL
    // clash: the user edited line 1 in the sibling, and the remote
    // rewrites the same line differently.
    fs.writeFileSync(path.join(dir, remoteSiblingName(sib1.mtime!)), "MINE\ntwo\nthree\n");
    const REMOTE_2 = "REMOTE-OTHER\ntwo\nthree\n";
    world.committedAt += 5000;
    await world.commitFiles({ [NOTE]: REMOTE_2 });
    baseCommit = world.commits[world.commits.length - 2];
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");

    const rec = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec.siblings).toHaveLength(2); // C.12: grew by one
    expect(rec.siblings[0].sha).toBe(sib1.sha); // old stays tracked
    expect(rec.siblings[1].sha).toBe(await sha(REMOTE_2));
    expect(rec.siblings[0].mtime!).toBeLessThan(rec.siblings[1].mtime!);
    expect(vaultHas(remoteSiblingName(rec.siblings[0].mtime!))).toBe(true);
    expect(vaultHas(remoteSiblingName(rec.siblings[1].mtime!))).toBe(true);
  });

  // ── The fold's ANCESTOR (owner's field test, 2026-10-09) ─────────────
  // A fresh remote version descends, on main, from the remote version the
  // previous sibling was made from. So the fold's ancestor is THAT version
  // (recorded per sibling), not conflictBase — conflictBase is OUR side,
  // and with it as the ancestor every repeated remote change of the same
  // line appended one more sibling instead of replacing the old one.
  //   Field run: common 6 → remote 8 / local 7 → conflict (sibling 8) →
  //   remote 10 / local 9 → expected ONE sibling (10), got two (8, 10).
  describe("🔑 the fold's ancestor is the remote version the sibling was made from", () => {
    // A gap line between "head" and the value: diff3 treats changes on
    // ADJACENT lines as one clash, and the edit-survives test needs two.
    const ver = (n: number) => `head\ngap\nsyncInterval ${n}\ntail\n`;

    const birth = async () => {
      baseCommit = await world.commitFiles({ [NOTE]: ver(6) });
      baselines.set(NOTE, { baselineSha: await sha(ver(6)), mtime: 50, size: enc(ver(6)).byteLength });
      vaultFiles.files.set(NOTE, { content: ver(7), mtime: 100 });
      await world.commitFiles({ [NOTE]: ver(8) });
      await stageBatch({ [NOTE]: ver(7) });
      const r1 = await drainOnce(makeDeps());
      expect(r1.status).toBe("ok");
      const rec1 = (await conflictStore.load()).entries.get(NOTE)!;
      expect(rec1.siblings).toHaveLength(1);
      return rec1.siblings[0];
    };

    // Every conflict decision reaches the log (owner, 2026-10-09).
    const logged: { level: string; message: string }[] = [];
    const logger = {
      info: (message: string) => logged.push({ level: "info", message }),
      warn: (message: string) => logged.push({ level: "warn", message }),
    };

    const nextRound = async (remote: string, local: string) => {
      baseCommit = world.head;
      world.committedAt += 5000;
      await world.commitFiles({ [NOTE]: remote });
      vaultFiles.files.set(NOTE, { content: local, mtime: 200 });
      await stageBatch({ [NOTE]: local });
      logged.length = 0;
      const r2 = await drainOnce(makeDeps({ logger }));
      expect(r2.status).toBe("ok");
      expect(r2.vaultStepErrors).toEqual([]);
      return (await conflictStore.load()).entries.get(NOTE)!;
    };

    it("🔑 the field run: 6 → 8/7 → 10/9 leaves ONE sibling, holding 10; the old file is gone", async () => {
      const sib1 = await birth();
      const rec = await nextRound(ver(10), ver(9));
      expect(rec.siblings).toHaveLength(1); // replaced, not appended
      const p = remoteSiblingName(rec.siblings[0].mtime!);
      expect(fs.readFileSync(path.join(dir, p), "utf8")).toBe(ver(10));
      expect(vaultHas(remoteSiblingName(sib1.mtime!))).toBe(false);
      // Our side moved on to 9 (the conflict branch's job — unchanged).
      expect(rec.conflictBase.sha).toBe(await sha(ver(9)));
      expect(logged).toContainEqual({ level: "info", message: "Conflict copy updated to the newer server version (old copy replaced)" });
    });

    it("🔑 THREE rounds (8 → 10 → 12) still leave ONE sibling — the origin moves on with each fold", async () => {
      await birth();
      await nextRound(ver(10), ver(9));
      const rec = await nextRound(ver(12), ver(11));
      expect(rec.siblings).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, remoteSiblingName(rec.siblings[0].mtime!)), "utf8")).toBe(ver(12));
      expect(rec.siblings[0].originSha).toBe(await sha(ver(12)));
    });

    it("the user's own edit in the sibling (another line) survives the fold", async () => {
      const sib1 = await birth();
      const sibPath = path.join(dir, remoteSiblingName(sib1.mtime!));
      fs.writeFileSync(sibPath, "HEAD-EDITED\ngap\nsyncInterval 8\ntail\n");
      const rec = await nextRound(ver(10), ver(9));
      expect(rec.siblings).toHaveLength(1);
      const p = remoteSiblingName(rec.siblings[0].mtime!);
      expect(fs.readFileSync(path.join(dir, p), "utf8")).toBe("HEAD-EDITED\ngap\nsyncInterval 10\ntail\n");
    });

    it("the user's own edit in the sibling ON THE SAME LINE as the new remote change → a second sibling (a real clash)", async () => {
      const sib1 = await birth();
      const sibPath = path.join(dir, remoteSiblingName(sib1.mtime!));
      fs.writeFileSync(sibPath, ver(42));
      const rec = await nextRound(ver(10), ver(9));
      expect(rec.siblings).toHaveLength(2);
      expect(fs.readFileSync(sibPath, "utf8")).toBe(ver(42)); // the user's edit untouched
      expect(logged.some((l) => l.level === "warn" && l.message.includes("a second conflict copy is added"))).toBe(true);
    });
  });

  it("C.7: the sibling's filename timestamp is the REMOTE COMMIT date, never the write moment", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const rec = (await conflictStore.load()).entries.get(NOTE)!;
    // The fake's getCommitInfoForPath returns world.committedAt — the
    // remote commit date; deps.now() (1_800_000_000_000) must NOT
    // appear in the name.
    const name = remoteSiblingName(rec.siblings[0].mtime!);
    expect(name).toContain(formatTimestampForFilename(rec.siblings[0].mtime!));
    expect(name).not.toContain(
      formatTimestampForFilename(1_800_000_000_000),
    );
    expect(vaultHas(name)).toBe(true);
  });

  it("C.8: first-sibling blob confirmed GONE from the repo (siblings==[]) → the conflict mode is CANCELLED explicitly", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    // The remote blob vanishes between discovery and the Vault-step
    // (repo-corruption class — NOT a network failure). The conflict
    // must be born WITHOUT the blob — the rule-7 size gate is the
    // sha-only birth path (§II.6 STEP2 п.3: the blob is deferred to
    // the Vault-step by design).
    world.blobs.delete(await sha(REMOTE_CLASH));

    const r = await drainOnce(makeDeps({ maxAutoMergeFileSize: () => 1 }));
    expect(r.status).toBe("ok");
    expect(r.vaultStepErrors.some((e) => e.path === NOTE)).toBe(true);
    const durable = await conflictStore.load();
    expect(durable.entries.has(NOTE)).toBe(false); // record removed directly
    // ⚠️ AND THE USER IS TOLD (owner's rule, 2026-10-02). This is the
    // one vault-step failure that notifies, because it is the one
    // nothing retries: the record was deleted on purpose so a later
    // restore cannot resurrect it. Contrast C.9 below, which skips
    // with the record intact and stays a log line.
    expect(r.cancelledConflicts).toEqual([NOTE]);
    // The next commit+drain will re-commit the file and likely birth
    // a fresh, healthy conflict — that is the designed self-heal.
  });

  // ── §VIII D — the OTHER RECONCILE window ─────────────────────────
  //
  // C.8 cancels a conflict in three statements: drop it from the
  // in-memory map, lower the tracked flag, save the store. A crash in
  // the gap loses the first two (they were only ever in memory) and
  // never performs the third — so the disk still describes a LIVE
  // conflict, and the journal's flag still matches it.
  //
  // That consistency is the whole answer: the pair is the benign one
  // of W1's four states, so the next run simply does the cancellation
  // again. Worth a cell precisely because the site looks dangerous —
  // it is the one place the engine deletes a conflict record outright.
  //
  // ⚠️ WHAT THIS CELL DOES *NOT* PIN, found by probing it. The
  // tempting claim is that the three statements must run in THIS order
  // (save last). They need not: inverting them — save first, then
  // delete — changes nothing observable, because the epilogue's step-2
  // save writes the same map a moment later and is the real backstop.
  // The probe that inverted the order left all 47 tests green,
  // including this one.
  //
  // Nor does the early save make the window safer. After it succeeds
  // the disk holds (no record) while the journal still holds (flag) —
  // W1's forbidden-looking pair, reached legitimately yet again, and
  // handled by RECONCILE (pinned by the 2→4 cell below). So the early
  // save narrows the window, it does not remove it, and the cell
  // claims only what it shows: a crash before the cancel is durable
  // leaves a LIVE, self-consistent conflict, and the redo reaches the
  // same verdict and records it.
  it("D: crash between the in-memory cancel and its durable save → the conflict is still LIVE on disk; the redo cancels it properly", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    world.blobs.delete(await sha(REMOTE_CLASH));

    // ⚠️ The store is shared, so the override must come back off
    // before the redo — the redo is the half being checked.
    const origSave = conflictStore.save.bind(conflictStore);
    conflictStore.save = async (c) => {
      // Fire ONLY on the cancelling save: the record is gone from the
      // map being written, which no other save in this run can say.
      if (!c.entries.has(NOTE)) {
        throw new Error("power loss before the cancel became durable");
      }
      return origSave(c);
    };
    try {
      await expect(
        drainOnce(makeDeps({ maxAutoMergeFileSize: () => 1 })),
      ).rejects.toThrow("power loss before the cancel");
    } finally {
      conflictStore.save = origSave;
    }

    // THE INTERMEDIATE STATE: disk unchanged, so the conflict is still
    // live — and the journal agrees with it. Benign by construction.
    const durable = await conflictStore.load();
    expect(durable.entries.has(NOTE)).toBe(true);
    const js = await journal.load();
    expect(js!.trackedFiles.get(NOTE)?.isManualConflict).toBe(true);

    // The redo reaches the same verdict and this time records it.
    const r2 = await drainOnce(makeDeps({ maxAutoMergeFileSize: () => 1 }));
    expect(r2.status).toBe("ok");
    expect(r2.cancelledConflicts).toEqual([NOTE]);
    expect((await conflictStore.load()).entries.has(NOTE)).toBe(false);
    // The user's own copy was never touched through any of this.
    expect(vaultFiles.files.get(NOTE)!.content).toBe(LOCAL_CLASH);
  });

  it("C.9: the same NOT_FOUND with an EXISTING sibling → skip only, the record and the older sibling survive", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps()); // conflict + first sibling exist now

    const REMOTE_2 = "REMOTE-OTHER\ntwo\nthree\n";
    world.committedAt += 5000;
    await world.commitFiles({ [NOTE]: REMOTE_2 });
    baseCommit = world.commits[world.commits.length - 2];
    world.blobs.delete(await sha(REMOTE_2)); // the new content vanishes

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.vaultStepErrors.some((e) => e.path === NOTE)).toBe(true);
    // ⚠️ The contrast half of C.8: the record SURVIVES, so the next
    // sync retries — hope exists, and the user is not interrupted.
    expect(r2.cancelledConflicts).toEqual([]);
    const rec = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec.siblings).toHaveLength(1); // untouched
    expect(vaultHas(remoteSiblingName(rec.siblings[0].mtime!))).toBe(true);
  });

  it("C.10 + C.13(vault-step-born): a conflict born ON the Vault-step → conflictBase=remote, siblings=[remote], flag up, base file untouched", async () => {
    await setupAligned();
    // Remote-only change + an UNCOMMITTED same-line vault edit.
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    vaultFiles.files.set(NOTE, { content: "USER\ntwo\nthree\n", mtime: 200 });

    commitInfoCalls = [];
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([{ path: NOTE, site: "vault-step" }]);
    expect(commitInfoCalls).toContain(NOTE); // the third lazy site

    const rec = (await conflictStore.load()).entries.get(NOTE)!;
    const remoteSha = await sha(REMOTE_CLASH);
    expect(rec.conflictBase.sha).toBe(remoteSha);
    expect(rec.siblings.map((s) => s.sha)).toEqual([remoteSha]);
    expect(vaultFiles.files.get(NOTE)!.content).toBe("USER\ntwo\nthree\n");
    expect(vaultHas(remoteSiblingName(rec.siblings[0].mtime!))).toBe(true);
  });

  it("C.11: an idle lingering conflict (no fresh pull, no batch) passes through the drain with ZERO side effects", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const before = fs.readFileSync(
      path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime/conflicts.json"),
      "utf8",
    );
    baseCommit = world.head; // nothing new on remote

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.pushedCommits).toEqual([]);
    const after = fs.readFileSync(
      path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime/conflicts.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("C.13 negative half: ordinary (non-conflict) files NEVER trigger getCommitInfoForPath", async () => {
    await setupAligned();
    await world.commitFiles({ [NOTE]: "one\ntwo\nREMOTE-ONLY\n" });
    await stageBatch({ "other.md": "unrelated local\n" });
    vaultFiles.files.set("other.md", { content: "unrelated local\n", mtime: 100 });

    commitInfoCalls = [];
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([]);
    expect(commitInfoCalls).toEqual([]); // paid ONLY at conflict sites
  });

  it("J.3 + J.4: a durable record with EMPTY siblings seeds is_manual_conflict=true with non-null placeholder halves — the batch goes STEP2, never main", async () => {
    await setupAligned();
    // Fresh STEP1 shape persisted by a previous (crashed) run: record
    // exists, siblings=[] — STEP3 never ran.
    const durable = await conflictStore.load();
    durable.entries.set(NOTE, {
      conflictBase: {
        path: NOTE,
        sha: await sha(V0),
        size: null,
        mtime: null,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      siblings: [],
    });
    await conflictStore.save(durable);

    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok"); // no null-deref on the placeholder (J.4)
    expect(r.conflictVerdicts.some((v) => v.site === "step2-existing")).toBe(
      true,
    ); // seeded flag routed the batch to STEP2 (J.3)
    expect(r.pushedCommits).toEqual([]); // NOT pushed to main
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(V0);
  });

  it("J.3b: seeding must RAISE the flag on a tracked record that already exists — the else-branch, where an unraised flag sends conflict content to MAIN", async () => {
    // Found by mutation probe (§IX.3, 2026-09-23): deleting
    // `existing.isManualConflict = true` from the seeding loop left
    // the whole suite green. J.3 only covers the `undefined` branch
    // (no journal record → create one flagged), and J.5's assertions
    // survive because its dedup (conflictBase.sha == local.sha) blocks
    // the push for an unrelated reason.
    //
    // The shape that actually hurts: a crashed run left a tracked
    // record whose halves are ALIGNED (base == remote == V0) and whose
    // flag is down. Read without the seeding raise, _diff3 calls that
    // a clean local-only change and pushes it to MAIN — publishing one
    // side of an unresolved conflict over the other device's work.
    // The durable record is the only thing that knows better, and the
    // raise is how it gets a say.
    await setupAligned();
    const js =
      (await journal.load()) ??
      (await import("../../src/sync2/drain-journal")).emptyDrainState();
    js.trackedFiles.set(NOTE, {
      base: { path: NOTE, sha: await sha(V0), size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      remote: { path: NOTE, sha: await sha(V0), size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(js);
    // conflictBase differs from the local content, so STEP1/STEP2's
    // idempotent-push dedup cannot mask the missing raise.
    const durable = await conflictStore.load();
    durable.entries.set(NOTE, {
      conflictBase: { path: NOTE, sha: await sha(V0), size: null, mtime: null, blob: null, mode: "", deviceLabel: null },
      siblings: [],
    });
    await conflictStore.save(durable);

    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts.some((v) => v.site === "step2-existing")).toBe(
      true,
    );
    expect(r.pushedCommits).toEqual([]); // MAIN untouched
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(V0);
  });

  it("J.5: seeding never overwrites the journal's in-flight progress for a conflict path", async () => {
    await setupAligned();
    // The journal (from a crashed run) already carries REAL progress:
    // remote == the batch content (a completed branch push).
    const localSha = await sha(LOCAL_CLASH);
    const js = (await journal.load()) ?? (await import("../../src/sync2/drain-journal")).emptyDrainState();
    js.trackedFiles.set(NOTE, {
      base: { path: NOTE, sha: localSha, size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      remote: { path: NOTE, sha: localSha, size: 1, mtime: 1, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(js);
    // And a durable conflict record exists for the same path.
    const durable = await conflictStore.load();
    durable.entries.set(NOTE, {
      conflictBase: { path: NOTE, sha: localSha, size: null, mtime: null, blob: null, mode: "", deviceLabel: null },
      siblings: [],
    });
    await conflictStore.save(durable);

    await stageBatch({ [NOTE]: LOCAL_CLASH });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // Had seeding replaced the tracked record with placeholders, the
    // STEP2 dedup (conflictBase.sha == local.sha) would still hold —
    // but the journal's halves must be the REAL ones: no branch push
    // happened (dedup) and nothing landed on main.
    expect(world.branchHeads.size).toBe(0);
    expect(r.pushedCommits).toEqual([]);
  });

  it("J.7: RECONCILE does NOT fire for a conflict that simply hasn't reached STEP3 (siblings==[] is 'in progress', not 'resolved')", async () => {
    await setupAligned();
    const durable = await conflictStore.load();
    durable.entries.set(NOTE, {
      conflictBase: { path: NOTE, sha: await sha(LOCAL_CLASH), size: null, mtime: null, blob: null, mode: "", deviceLabel: null },
      siblings: [],
    });
    await conflictStore.save(durable);

    // An idle drain (no batches, no remote change).
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // The record SURVIVED (I.7 at the store level + J.7 at the drain
    // level): the flag was seeded and never reset.
    const after = await conflictStore.load();
    expect(after.entries.has(NOTE)).toBe(true);
    // And FINALIZE stayed blocked: the (auto-generated) branch name is
    // still in the journal, nothing was merged.
    expect(r.finalizedMergeSha).toBeNull();
  });

  it("C.19a 🔑 (two-drain, end-to-end): the §II.11 double-loss crash must NOT cascade into a silent clobber of remote", async () => {
    // Drain 1: birth a conflict with ONE sibling (the typical shape).
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps());
    const rec1 = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec1.siblings).toHaveLength(1);

    // Simulate the catastrophic §II.11 window: a replace transaction
    // died with BOTH candidates unusable — the mark stands, the old
    // sibling file is gone, the new one never materialized.
    const oldSibling = rec1.siblings[0];
    fs.rmSync(path.join(dir, remoteSiblingName(oldSibling.mtime!)));
    const phantomNew = { ...oldSibling, sha: await sha("never-written\n"), mtime: oldSibling.mtime! + 7000 };
    const committed = await conflictStore.load();
    committed.entries.set(NOTE, {
      conflictBase: rec1.conflictBase,
      siblings: [phantomNew],
    });
    committed.lastSiblingTxGuid = "crash-guid";
    await conflictStore.save(committed);
    const markBytes = new TextEncoder().encode(
      JSON.stringify({
        guid: "crash-guid",
        path: NOTE,
        oldSibling: { ...oldSibling, blob: undefined },
        newSibling: { ...phantomNew, blob: undefined },
      }),
    );
    fs.writeFileSync(
      path.join(dir, ".obsidian/plugins", PLUGIN_ID, ".runtime", SIBLING_TX_MARK_FILE),
      Buffer.from(markBytes),
    );

    // Drain 2: recovery must keep the record alive (siblings → []),
    // and STEP3 must rebuild the first sibling THIS very drain.
    baseCommit = world.commits[0];
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    const rec2 = (await conflictStore.load()).entries.get(NOTE)!;
    expect(rec2).toBeDefined(); // ← the cascade's first domino must NOT fall
    expect(rec2.siblings).toHaveLength(1); // rebuilt in the same drain

    // Drain 3 — the clobber probe: a new local edit is committed.
    // With the record alive it goes to the CONFLICT branch; if the
    // record had been pruned, rule 4 would push it to MAIN and
    // silently erase REMOTE_CLASH.
    const LOCAL_2 = "LOCAL-2\ntwo\nthree\n";
    await stageBatch({ [NOTE]: LOCAL_2 });
    vaultFiles.files.set(NOTE, { content: LOCAL_2, mtime: 300 });
    const r3 = await drainOnce(makeDeps());
    expect(r3.status).toBe("ok");
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH); // NOT clobbered
  });

  it("E.3-5: a device_label NETWORK_ERROR aborts the WHOLE drain on each of the three birth sites", async () => {
    // (a) STEP1 site.
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    let deps = makeDeps();
    deps.client.getCommitInfoForPath = async () => {
      throw new NetworkError("net down");
    };
    expect((await drainOnce(deps)).status).toBe("network-error");

    // (b) pull-folding-refresh site: heal the network, birth the
    // conflict, then break it again for the refresh pull.
    let r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    world.committedAt += 5000;
    await world.commitFiles({ [NOTE]: "REMOTE\ntwo\nTHREE-v2\n" });
    baseCommit = world.commits[world.commits.length - 2];
    deps = makeDeps();
    deps.client.getCommitInfoForPath = async () => {
      throw new NetworkError("net down");
    };
    expect((await drainOnce(deps)).status).toBe("network-error");

    // (c) vault-step-born site (fresh world to isolate).
    world = new FakeWorld();
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    batches = [];
    conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: `${PLUGIN_ID}-c`,
    });
    journal = new DrainJournal({
      vault: vault as never,
      selfPluginId: `${PLUGIN_ID}-c`,
    });
    siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: `${PLUGIN_ID}-c`,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
    });
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    vaultFiles.files.set(NOTE, { content: "USER\ntwo\nthree\n", mtime: 200 });
    deps = makeDeps();
    deps.client.getCommitInfoForPath = async () => {
      throw new NetworkError("net down");
    };
    expect((await drainOnce(deps)).status).toBe("network-error");
  });

  // ── E.1: every Vault-step network site aborts the WHOLE drain ─────
  // The spec asks for one case per site. E.3-5 above covers the three
  // getCommitInfoForPath sites; the two below cover the BLOB sites,
  // which is where the sites can differ — every network call in the
  // Vault-step ends with `return statusFromError(...)` except one.
  //
  // Both error classes are checked, because both must abort by the
  // same route (§II.6 п.8): NetworkError → "network-error",
  // AuthError → "token-expired". A retry helper returns the second one
  // WITHOUT retrying, so a site that only inspects "did retry give me
  // bytes" swallows an expired token exactly as it swallows a dead
  // network.

  const FAILURES: Array<[string, () => Error, string]> = [
    ["NETWORK_ERROR", () => new NetworkError("net down"), "network-error"],
    ["TOKEN_EXPIRED", () => new AuthError("token expired", 401), "token-expired"],
  ];

  for (const [label, make, expected] of FAILURES) {
    it(`E.1 (plain pull site): ${label} on the remote blob fetch aborts the whole drain`, async () => {
      await setupAligned();
      // A remote-only change: no batch, the vault file untouched →
      // _diff3 rule 4.3 hands back the remote VERBATIM (sha only), so
      // the Vault-step has to materialise the bytes itself.
      await world.commitFiles({ [NOTE]: "remote v2\n" });
      const deps = makeDeps();
      deps.client.getBlobFromRepo = async () => {
        throw make();
      };
      const r = await drainOnce(deps);
      expect(r.status).toBe(expected);
      // Aborted BEFORE the vault was touched — the next drain repeats
      // the whole Vault-step from the surviving journal (§IV.2).
      expect(vaultFiles.writes).toEqual([]);
    });

    it(`E.1 (fold-result site): ${label} while materialising the fold result aborts the whole drain`, async () => {
      await setupAligned();
      await world.commitFiles({ [NOTE]: REMOTE_CLASH });
      await stageBatch({ [NOTE]: LOCAL_CLASH });
      vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
      await drainOnce(makeDeps()); // births the conflict + first sibling

      // Seeded on purpose: conflictBase is made EQUAL to the sibling.
      // That is what puts the fold on rule 4.3 (local == base → the
      // remote wins verbatim), the one fold outcome that returns a
      // sha-only FileInfo and forces the drain to fetch the bytes
      // itself. The healthy flow rarely produces this shape —
      // conflictBase is ours, the sibling is theirs — but a restore
      // from the durable store after a crash can, and the abort
      // contract does not depend on how the state was reached.
      const durable = await conflictStore.load();
      const rec = durable.entries.get(NOTE)!;
      rec.conflictBase = { ...rec.siblings[0] };
      await conflictStore.save(durable);

      const REMOTE_2 = "REMOTE\ntwo\nTHREE-v2\n";
      world.committedAt += 5000;
      await world.commitFiles({ [NOTE]: REMOTE_2 });
      baseCommit = world.commits[world.commits.length - 2];
      const remote2Sha = await sha(REMOTE_2);

      const deps = makeDeps();
      const passThrough = deps.client.getBlobFromRepo.bind(deps.client);
      // Scoped to the ONE blob the fold needs: any other fetch failing
      // would abort at a different (already correct) site and the test
      // would pass for the wrong reason.
      deps.client.getBlobFromRepo = async (s: string) => {
        if (s === remote2Sha) throw make();
        return passThrough(s);
      };

      const r = await drainOnce(deps);
      expect(r.status).toBe(expected);
    });
  }

  it("W1: a conflict flag never reaches the journal before its record is durable", async () => {
    // THE ORDER IS THE CONTRACT (§IV.2 / §VIII D). STEP1 raises
    // `isManualConflict`, and the journal persist is the only place
    // that flag becomes durable. Of the four crash states between the
    // two writes exactly ONE is destructive: flag-without-record, where
    // RECONCILE reads the empty scan as "resolved externally", drops
    // the flag, FINALIZE merges and deletes the branch, and the next
    // batch takes rule 4.4 and clobbers theirs on main — silent,
    // G9-class. Saving the store FIRST makes the only reachable
    // in-between state the benign one.
    //
    // ⚠️ This test exists because a mutation probe (2026-09-23, audit
    // §IX) swapped the two lines back to the pre-fix order and the
    // ENTIRE suite stayed green. The fix (`d8018b2`) was real and the
    // reasoning was written into the code, but nothing would have
    // caught a refactor undoing it.
    //
    // Phrased as the invariant, not as line order, so a future
    // restructuring that preserves the guarantee some other way still
    // passes: whenever a state carrying the flag is persisted, the
    // record for that path must ALREADY be readable from disk by an
    // independent reader.
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });

    const violations: string[] = [];
    let flagPersists = 0;
    const realPersist = journal.persist.bind(journal);
    journal.persist = async (state) => {
      for (const [path, t] of state.trackedFiles) {
        if (!t.isManualConflict) continue;
        flagPersists++;
        // A SEPARATE store instance: "durable" means on disk, not in
        // the drain's own cached state.
        const onDisk = await new ConflictStoreV2({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
        }).load();
        if (!onDisk.entries.has(path)) violations.push(path);
      }
      return realPersist(state);
    };

    const r = await drainOnce(makeDeps());
    journal.persist = realPersist;

    expect(r.status).toBe("ok");
    // The setup really did raise the flag — otherwise this passes for
    // the wrong reason.
    expect(flagPersists).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("J.1: a journal on disk RESUMES the interrupted drain — tracked files and the branch name come back verbatim", async () => {
    // Distinct from B.3 (a 422 restart INSIDE one run): here the
    // process is gone and a brand-new drainOnce has to pick the state
    // back up off the disk.
    const OTHER = "other.md";
    await setupAligned({ [OTHER]: "other v0\n" });
    await world.commitFiles({
      [NOTE]: REMOTE_CLASH,
      [OTHER]: "other v2\n",
    });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    const otherSha = await sha("other v2\n");

    // Drain 1 dies in the Vault-step — AFTER the batch completed, so
    // STEP1 has already pushed the branch and the journal carries both
    // the tracked files and the branch name.
    const d1 = makeDeps();
    const passThrough = d1.client.getBlobFromRepo.bind(d1.client);
    d1.client.getBlobFromRepo = async (s: string) => {
      if (s === otherSha) throw new NetworkError("net down");
      return passThrough(s);
    };
    expect((await drainOnce(d1)).status).toBe("network-error");

    const crashed = await journal.load();
    expect(crashed).not.toBeNull();
    const branchFromJournal = crashed!.conflictBranchName;
    expect(branchFromJournal).not.toBeNull();
    expect(crashed!.trackedFiles.get(NOTE)!.isManualConflict).toBe(true);
    const trackedRemoteSha = crashed!.trackedFiles.get(NOTE)!.remote.sha;

    // Drain 2: healthy network, fresh deps. It must RESUME — same
    // branch, no second one minted, and the tracked remote it acts on
    // is the one the journal kept.
    expect(trackedRemoteSha).toBe(await sha(REMOTE_CLASH));

    // Drain 2: healthy network, fresh deps. The restored name must be
    // the one from the journal — a second mint would strand the branch
    // this device already pushed to, and every later drain would make
    // yet another one. Asserted over the branch names the drain
    // actually TOUCHES, not over the end state (what FINALIZE then
    // does with that branch is G's business, not J.1's).
    const touched: string[] = [];
    // A LATER clock, on purpose: the branch name is minted from
    // (deviceLabel, now), so with the harness's frozen clock a re-mint
    // would be byte-identical to the restored name and this test could
    // not tell restore from re-mint. Ten minutes later it can.
    const carriedForward: Array<string | null> = [];
    const d2 = makeDeps({
      now: () => 1_800_000_600_000,
      hot: {
        getLastSyncCommitSha: () => baseCommit,
        getLastSyncTreeSha: () => null,
        getConflictBranch: () => null,
        getHeldPluginUpdates: () => ({}),
        update: async (f) => {
          // `update` is PARTIAL now — a hold writes its own field
          // alone — so a run that never touches the branch reports
          // `undefined` rather than null.
          if (f.conflictBranchName !== undefined) {
            carriedForward.push(f.conflictBranchName);
          }
        },
      },
    });
    const realHead = d2.client.getBranchHeadSha.bind(d2.client);
    d2.client.getBranchHeadSha = async (b: string) => {
      touched.push(b);
      return realHead(b);
    };
    const realDelete = d2.client.deleteBranch.bind(d2.client);
    d2.client.deleteBranch = async (b: string) => {
      touched.push(b);
      return realDelete(b);
    };

    const r2 = await drainOnce(d2);
    expect(r2.status).toBe("ok");
    // NEGATIVE half: whatever the drain touched, it was not a second
    // branch. (Since §II.7.1 this drain touches NOTHING — it resumes a
    // Vault-step and never reaches a conflict-branch push site, so
    // there is nothing to ask the network about. An empty list is the
    // strongest possible form of "no second branch".)
    expect(touched.filter((b) => b !== branchFromJournal)).toEqual([]);
    // POSITIVE half, and the one that survives having no network calls
    // at all: the name this drain CARRIES FORWARD is the restored one.
    // A re-mint under the later clock would show up here as a
    // different string — which is what the ten-minute offset above is
    // for. This is the assertion that actually pins J.1.
    expect(carriedForward[carriedForward.length - 1]).toBe(branchFromJournal);
    // And the work the crash interrupted actually finished.
    expect(vaultFiles.files.get(OTHER)!.content).toBe("other v2\n");
  });

  it("W1 ordering, benign half: a durable record with NO journal converges — the flag comes back, the branch gets no duplicate commit", async () => {
    // The fix saves the store BEFORE the journal, so the only crash
    // state it can create is this one. It has to be harmless, or the
    // ordering argument collapses: seeding (J.3) must re-assert the
    // flag from the record alone, and the idempotent push check must
    // keep the branch from growing a second identical commit.
    await setupAligned();
    await world.commitFiles({ [NOTE]: REMOTE_CLASH });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    await drainOnce(makeDeps()); // births the conflict; epilogue clears the journal
    const branch = [...world.branchHeads.keys()][0];
    const tip = world.branchHeads.get(branch)!;
    expect(await journal.load()).toBeNull(); // the "no journal" half is real

    // The same local content is committed again (the crashed run's
    // batch is re-claimed after a restart).
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // Flag re-asserted from the record alone — the batch is conflict
    // traffic, not main traffic.
    expect(r.conflictVerdicts.some((v) => v.site === "step2-existing")).toBe(
      true,
    );
    expect(r.pushedCommits).toEqual([]);
    expect(world.branchHeads.get(branch)).toBe(tip); // no duplicate commit
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH);
  });

  it("W1 (§VIII D): a crash between STEP1 and the epilogue must NOT end with theirs overwritten — the redo re-creates the sibling", async () => {
    // The same crash as J.1, judged by its OUTCOME instead of by the
    // restore. Before the durable save was paired with the per-batch
    // journal persist, this ran as follows, each step correct by its
    // own rule and the sum silently destructive:
    //   drain 2 — RECONCILE saw flag=true + an EMPTY authoritative
    //             scan (the record only ever reached the journal) ⇒
    //             "resolved externally" ⇒ flag down; FINALIZE then
    //             counted zero conflicts ⇒ merge + DELETE the branch;
    //             the epilogue wrote baseline := THEIRS.
    //   drain 3 — findChanges reports the vault file as modified, the
    //             batch resolves base==remote==THEIRS vs local=LOCAL
    //             ⇒ rule 4.4 "clean push" ⇒ LOCAL lands on main with
    //             no conflict, no sibling, no verdict. The G9 contract,
    //             one commit-cycle late.
    const OTHER = "other.md";
    await setupAligned({ [OTHER]: "other v0\n" });
    await world.commitFiles({
      [NOTE]: REMOTE_CLASH,
      [OTHER]: "other v2\n",
    });
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });
    const otherSha = await sha("other v2\n");

    // Drain 1 dies in the Vault-step — after the batch completed, so
    // STEP1 pushed the branch and the journal carries the flag.
    const d1 = makeDeps();
    const passThrough = d1.client.getBlobFromRepo.bind(d1.client);
    d1.client.getBlobFromRepo = async (s: string) => {
      if (s === otherSha) throw new NetworkError("net down");
      return passThrough(s);
    };
    expect((await drainOnce(d1)).status).toBe("network-error");
    const branch = [...world.branchHeads.keys()][0];

    // Drain 2: the redo. The conflict must survive it.
    expect((await drainOnce(makeDeps())).status).toBe("ok");
    const after2 = await conflictStore.load();
    expect([...after2.entries.keys()]).toEqual([NOTE]);
    expect(after2.entries.get(NOTE)!.siblings).toHaveLength(1); // re-created
    expect(world.branchHeads.has(branch)).toBe(true); // FINALIZE stayed out
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH);

    // Drain 3: the next local edit is still conflict traffic — it goes
    // to the branch (STEP2), never to main.
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    const r3 = await drainOnce(makeDeps());
    expect(r3.status).toBe("ok");
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(REMOTE_CLASH);
    expect(r3.pushedCommits).toEqual([]);
  });

  it("J.6: RECONCILE resets a flag whose path is gone from the authoritative scan (the positive half of J.7)", async () => {
    await setupAligned();
    // A journal from a previous run still flags the path as a manual
    // conflict, but conflicts.json no longer has it: the user resolved
    // it outside the drain (deleted the sibling, reconciled the file).
    const { emptyDrainState } = await import("../../src/sync2/drain-journal");
    const js = emptyDrainState();
    const info = {
      path: NOTE,
      sha: await sha(V0),
      size: enc(V0).byteLength,
      mtime: 50,
      blob: null,
      mode: "" as const,
      deviceLabel: null,
    };
    js.trackedFiles.set(NOTE, {
      base: { ...info },
      remote: { ...info },
      isManualConflict: true,
    });
    await journal.persist(js);

    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => warnings.push(m),
    };
    await stageBatch({ [NOTE]: LOCAL_CLASH });
    vaultFiles.files.set(NOTE, { content: LOCAL_CLASH, mtime: 100 });

    const r = await drainOnce(makeDeps({ logger } as Partial<DrainDeps>));
    expect(r.status).toBe("ok");
    expect(warnings.some((w) => w.startsWith("RECONCILE:"))).toBe(true);
    // The flag really went down: the batch took the MAIN route, not
    // STEP2 — the exact inverse of J.3's seeded-flag assertion.
    expect(r.pushedCommits).toHaveLength(1);
    expect(dec(world.headFiles().get(NOTE)!.bytes)).toBe(LOCAL_CLASH);
    expect(world.branchHeads.size).toBe(0);
  });

  it("E.2: a CONFIRMED absence is NOT an abort — the path is recorded and the rest of the drain finishes", async () => {
    // The other half of E.1's boundary, and the reason the fix above
    // had to distinguish them: `error != null` (the transport failed,
    // retry may help) aborts everything; `result == null` (the
    // transport worked and the repo simply has no such blob) is a
    // narrow per-path record. Getting this backwards would make a
    // single corrupt path stop every future sync.
    await setupAligned({ "clean.md": "clean v0\n" });
    await world.commitFiles({
      [NOTE]: "remote v2\n",
      "clean.md": "clean v2\n",
    });
    const vanishedSha = await sha("remote v2\n");

    const deps = makeDeps();
    const passThrough = deps.client.getBlobFromRepo.bind(deps.client);
    deps.client.getBlobFromRepo = async (s: string) =>
      s === vanishedSha ? null : passThrough(s);

    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    expect(r.vaultStepErrors.map((e) => e.path)).toEqual([NOTE]);
    // The healthy path in the SAME drain still landed in the vault.
    expect(vaultFiles.files.get("clean.md")!.content).toBe("clean v2\n");
    expect(vaultFiles.files.get(NOTE)!.content).toBe(V0); // untouched
  });
});

describe("FINALIZE + shouldPushToConflictBranch (§VIII G)", () => {
  // Reuses the same harness shape as the lifecycle suite above but
  // with its own state (fresh per test).
  let dir: string;
  let vault: Vault;
  let world: FakeWorld;
  let syncStore: SyncStore;
  let journal: DrainJournal;
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let vaultFiles: FakeVaultFiles;
  let baselines: Map<string, { baselineSha: string; mtime: number; size: number }>;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let baseCommit: string | null;
  let seq: number;
  // PARTIAL since the hold gate (§5.5): a write may carry only
  // `heldPluginUpdates`, mid-run, so the fields are optional here too.
  let hotUpdates: Array<{
    lastSyncCommitSha?: string | null;
    lastSyncTreeSha?: string | null;
    conflictBranchName?: string | null;
    heldPluginUpdates?: Record<string, unknown>;
  }>;
  // The hot pair's conflict-branch field, read back by the fake below.
  let hotConflictBranch: string | null;

  const NOTE2 = "note.md";
  const V0b = "one\ntwo\nthree\n";
  const REMOTE_B = "REMOTE\ntwo\nthree\n";
  const LOCAL_B = "LOCAL\ntwo\nthree\n";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "drain-fin-test-"));
    vault = new Vault(dir);
    world = new FakeWorld();
    syncStore = new SyncStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    journal = new DrainJournal({ vault: vault as never, selfPluginId: PLUGIN_ID });
    conflictStore = new ConflictStoreV2({ vault: vault as never, selfPluginId: PLUGIN_ID });
    siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
    });
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    hotConflictBranch = null;
    batches = [];
    baseCommit = null;
    seq = 0;
    hotUpdates = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const honest = async (
    base: string | null,
    head: string,
  ): Promise<DiscoveryResult> => {
    const headFiles = world.filesAt(head);
    const baseFiles: RepoFiles = base === null ? new Map() : world.filesAt(base);
    const out: RemoteFileChange[] = [];
    for (const p of new Set([...headFiles.keys(), ...baseFiles.keys()])) {
      const h = headFiles.get(p) ?? null;
      const b = baseFiles.get(p) ?? null;
      if (h?.sha === b?.sha) continue;
      out.push({
        path: p,
        sha: h?.sha ?? DELETED_SHA_HASH,
        // ⚠️ HONEST FAKE (gate finding 2026-08-31): the production
        // compare path returns NO sizes — the old fake filled them
        // from the bytes and thereby HID a real defect (a sibling
        // stored with size=null froze the conflict's theirs-side).
        // Only the tree fallback knows sizes; the fold must cope.
        size: null,
        mtime: null,
        deleted: h === null,
      });
    }
    // tree: null → this fake keeps Layer 2 on the per-path
    // transport, mirroring the compare path it imitates.
    return { changes: out, tree: null };
  };

  const stage = async (files: Record<string, string>): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({ path: p, sha: s, size: enc(content).byteLength, mtime: 100 , deletedSha: null});
    }
    const id = `g${++seq}`;
    batches.push({
      claimed: { id, dir: `queue/${id}`, meta: { v: 1, id, createdAt: 0, entries } },
      removed: false,
    });
  };

  const deps = (over?: Partial<DrainDeps>): DrainDeps => ({
    vault: vault as never,
    selfPluginId: PLUGIN_ID,
    client: world.makeClient(),
    syncStore,
    journal,
    retry: new NetworkRetry({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      maxAttempts: 2,
      sleep: async () => {},
    }),
    claimBatch: async () => {
      const next = batches.find((b) => !b.removed);
      return next ? next.claimed : null;
    },
    removeBatchDir: async (d) => {
      const b = batches.find((x) => x.claimed.dir === d);
      if (b) b.removed = true;
    },
    baselines: {
      get: async (p) => baselines.get(p),
      // §5.4 — a hold rescues a folder\'s baselines. No fixture
      // here holds anything, so empty is the honest answer.
      listUnder: async () => [],
      setMany: async (entries) => {
        for (const e of entries) {
          baselines.set(e.path, {
            baselineSha: e.baselineSha,
            mtime: e.mtime,
            size: e.size,
          });
        }
      },
      removeMany: async (paths) => {
        for (const p of paths) baselines.delete(p);
      },
    },
    discoverChangedFiles: honest,
    hot: {
      getLastSyncCommitSha: () => baseCommit,
      getLastSyncTreeSha: () => null,
      // ⚠️ READS BACK what update() wrote, as production's hot pair
      // does. It used to return a flat null, and the whole G-series
      // still passed — because `now` is FROZEN here, so a drain that
      // "regenerated" the name produced a byte-identical string and
      // found the real branch anyway. That is a frozen-clock
      // coincidence, not the mechanism: in production the stamp moves
      // every millisecond, and the hot pair is the ONLY thing that
      // carries a branch from the drain that births it to the drain
      // that finalizes it. Exposed 2026-09-23 by §II.7.1 (lazy
      // minting), which removed the regeneration the coincidence
      // rode on.
      getConflictBranch: () =>
        hotConflictBranch === null ? null : { name: hotConflictBranch },
      getHeldPluginUpdates: () => ({}),
      update: async (f) => {
        hotUpdates.push(f);
        if (f.conflictBranchName !== undefined) {
          hotConflictBranch = f.conflictBranchName;
        }
      },
    },
    conflictStore,
    siblingTx,
    tokenExpired: async () => false,
    vaultFiles,
    mergeBlobs: mergeBlobsWithMainThreadDiff3,
    computeSha: calculateGitBlobSHA,
    maxAutoMergeFileSize: () => 10_000_000,
    deviceLabel: () => "this-device",
    commitMessage: () => "Sync at test (this-device)",
    mergeMessage: () => "Merge conflict branch (this-device)",
    now: () => 1_800_000_000_000,
    ...over,
  });

  const setup = async (): Promise<void> => {
    baseCommit = await world.commitFiles({ [NOTE2]: V0b });
    baselines.set(NOTE2, {
      baselineSha: await sha(V0b),
      mtime: 50,
      size: enc(V0b).byteLength,
    });
    vaultFiles.files.set(NOTE2, { content: V0b, mtime: 50 });
  };

  // Births a conflict (STEP1 + first sibling) and returns the branch name.
  const birthConflict = async (): Promise<string> => {
    await world.commitFiles({ [NOTE2]: REMOTE_B });
    await stage({ [NOTE2]: LOCAL_B });
    vaultFiles.files.set(NOTE2, { content: LOCAL_B, mtime: 100 });
    const r = await drainOnce(deps());
    expect(r.status).toBe("ok");
    return [...world.branchHeads.keys()][0];
  };

  // ── §VIII D — the two RECONCILE windows ──────────────────────────
  //
  // Phase 6, crash matrix. Both are about the pair (journal flag,
  // durable record), and they are interesting because the SAFE state
  // and the DESTRUCTIVE one look identical on disk.
  //
  // The invariant the batch loop maintains is "a flag readable from
  // the journal implies a durable record" — W1's lesson, bought with a
  // silent G9-class clobber. The epilogue BREAKS that invariant on
  // purpose in its step-2→step-4 gap: step 2 saves a conflicts file
  // that no longer holds the record, while the journal persisted back
  // at batch end still carries the flag.
  //
  // ⚠️ So the on-disk state here is EXACTLY the one W1 called
  // destructive — flag, no record — and RECONCILE will do exactly what
  // it did there: read the empty scan as "resolved externally" and
  // drop the flag. The difference is not in the state but in how it
  // was reached: here the record is gone BECAUSE the user genuinely
  // resolved the conflict, so RECONCILE's conclusion is true. W1's fix
  // did not teach the engine to tell the two apart — it made the
  // false one unreachable by ordering. This cell pins that the true
  // one still works, which is the other half of that bargain.
  it("🔑 D: crash in the epilogue's 2→4 gap (durable already closed, journal still flagged) → RECONCILE self-heals", async () => {
    await setup();
    const branch = await birthConflict();
    const rec = (await conflictStore.load()).entries.get(NOTE2)!;
    const sibling = path.join(
      dir,
      buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device"),
    );

    // ⚠️ THE TIMING IS THE WHOLE CELL, and the first draft got it
    // wrong. Resolving BEFORE the drain does not reach this window:
    // the record is then closed by the scan at drain START, so the
    // flag is never seeded and the journal persists with it already
    // down. The forbidden pair needs the conflict to be OPEN when the
    // batch persists the journal, and CLOSED by the time step 2 saves
    // — i.e. the sibling has to disappear mid-run. Which it really
    // can: the Vault-step removes sibling duplicates, and the user can
    // delete the file at any moment.
    //
    // So: an unrelated file gives the run a batch (and with it a
    // journal carrying the flag), and the sibling vanishes during
    // epilogue step 1.
    await stage({ "other.md": "other v1\n" });
    vaultFiles.files.set("other.md", { content: "other v1\n", mtime: 300 });
    baseCommit = world.head;

    const d2 = deps();
    const origSetMany = d2.baselines.setMany;
    d2.baselines.setMany = async (entries) => {
      if (fs.existsSync(sibling)) fs.rmSync(sibling); // between steps 1 and 2
      return origSetMany(entries);
    };

    // Crash at step 4 — after step 2 has written the now-closed
    // conflicts file.
    const origClear = journal.clear.bind(journal);
    journal.clear = async () => {
      throw new Error("power loss in the 2→4 gap");
    };
    try {
      await expect(drainOnce(d2)).rejects.toThrow("2→4 gap");
    } finally {
      journal.clear = origClear;
    }

    // THE INTERMEDIATE STATE — the forbidden-looking pair, reached
    // legitimately. Asserting BOTH halves is the point: either one
    // alone would also hold in states this cell is not about.
    expect((await conflictStore.load()).entries.has(NOTE2)).toBe(false);
    const js = await journal.load();
    expect(js).not.toBeNull();
    expect(js!.trackedFiles.get(NOTE2)?.isManualConflict).toBe(true);

    // The redo: RECONCILE must resolve the disagreement in favour of
    // the durable store, say so out loud, and finish the job.
    const warnings: string[] = [];
    const r2 = await drainOnce(
      deps({
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
      } as Partial<DrainDeps>),
    );
    expect(r2.status).toBe("ok");
    expect(warnings.some((w) => w.startsWith("RECONCILE:"))).toBe(true);
    expect(await journal.load()).toBeNull();
    // …and nothing was clobbered: the conflict closed because its
    // sibling went away, so main keeps the remote version it already
    // had. The W1 failure would show up right here, as the LOCAL copy
    // silently overwriting it.
    expect(dec(world.headFiles().get(NOTE2)!.bytes)).toBe(REMOTE_B);
    // The branch was merged and deleted — FINALIZE ran once the flag
    // came down, which is the behaviour that makes this window close
    // rather than repeat.
    expect(world.branchHeads.has(branch)).toBe(false);
  });

  it("§II.17: a cancel landing just before FINALIZE skips the merge — and the NEXT drain does it", async () => {
    // FINALIZE is another multi-request stretch (compare, getCommit,
    // createMergeCommit, the main ref move, the branch delete), so it
    // gets its own checkpoint. Skipping it costs nothing: §II.14 checks
    // reachability first, so the merge is idempotent and the next drain
    // finds the same branch waiting.
    await setup();
    const branch = await birthConflict();
    const rec = (await conflictStore.load()).entries.get(NOTE2)!;
    // Resolve it, so FINALIZE would otherwise fire.
    fs.rmSync(
      path.join(
        dir,
        buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device"),
      ),
    );
    baseCommit = world.head;

    // False at the batch boundary (nothing to claim), TRUE at the
    // FINALIZE checkpoint — the click lands in between.
    let calls = 0;
    const r = await drainOnce(deps({ cancelRequested: () => ++calls > 1 }));
    expect(r.status).toBe("cancelled");
    expect(r.finalizedMergeSha).toBeNull();
    expect(world.branchHeads.has(branch)).toBe(true); // branch untouched

    const r2 = await drainOnce(deps());
    expect(r2.status).toBe("ok");
    expect(r2.finalizedMergeSha).not.toBeNull();
    expect(world.branchHeads.has(branch)).toBe(false); // merged and deleted
  });

  it("G.7: FINALIZE never fires while unresolved tracked conflicts remain — the branch stays", async () => {
    await setup();
    const branch = await birthConflict();
    expect(world.branchHeads.has(branch)).toBe(true);
    // Another idle drain: conflict still unresolved → still no merge.
    baseCommit = world.head;
    const r = await drainOnce(deps());
    expect(r.status).toBe("ok");
    expect(r.finalizedMergeSha).toBeNull();
    expect(world.branchHeads.has(branch)).toBe(true);
  });

  // + G.11: the last assertion — the epilogue's hot anchor records the
  // MERGE commit, not the pre-merge head (the blocker found 2026-08-29).
  it("G.9 🔑 + G.10 + G.11 + G.12: resolution → FINALIZE reachability-merge — main tree byte-identical, parents [main, conflict] positionally, empty diff, hot anchor = merge sha", async () => {
    await setup();
    const branch = await birthConflict();
    const rec = (await conflictStore.load()).entries.get(NOTE2)!;

    // The user resolves: reconciles the base file and deletes the
    // sibling (Scenario C — all siblings gone = conflict closed).
    const sibName = buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device");
    fs.rmSync(path.join(dir, sibName));
    // The resolved content gets committed as a normal batch.
    const RESOLVED = "RESOLVED\ntwo\nthree\n";
    await stage({ [NOTE2]: RESOLVED });
    vaultFiles.files.set(NOTE2, { content: RESOLVED, mtime: 300 });
    baseCommit = world.head;

    let mergeArgs: { treeSha: string; parents: [string, string] } | null = null;
    const d = deps();
    const origMerge = d.client.createMergeCommit.bind(d.client);
    d.client.createMergeCommit = async (args) => {
      mergeArgs = { treeSha: args.treeSha, parents: args.parents };
      return origMerge(args);
    };

    const preMergeMainFiles = () => world.headFiles();
    const r = await drainOnce(d);
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(1); // the resolved content
    expect(r.finalizedMergeSha).not.toBeNull();

    // G.9: the merge commit carries the MAIN tree — content unchanged.
    const mergeFiles = world.filesAt(r.finalizedMergeSha!);
    expect(dec(mergeFiles.get(NOTE2)!.bytes)).toBe(RESOLVED);
    expect(world.head).toBe(r.finalizedMergeSha); // ref moved to the merge
    // G.10: positional parents [main_head, conflict_head].
    expect(mergeArgs!.parents[0]).toBe(r.pushedCommits[0]);
    expect(mergeArgs!.parents[1].startsWith("cbranch-")).toBe(true);
    // G.12: the merge changed NOTHING vs the pre-merge main tree.
    const pre = world.filesAt(mergeArgs!.parents[0]);
    expect([...mergeFiles.keys()].sort()).toEqual([...pre.keys()].sort());
    for (const [p, f] of mergeFiles) {
      expect(f.sha).toBe(pre.get(p)!.sha);
    }
    // Branch gone; the promoted hot anchor carries a NULL name and
    // the merge commit as lastSync; the journal is CLEARED by the
    // epilogue (step 4 — its absence means 'drain finished').
    expect(world.branchHeads.has(branch)).toBe(false);
    const lastHot = hotUpdates[hotUpdates.length - 1];
    expect(lastHot.conflictBranchName).toBeNull();
    expect(lastHot.lastSyncCommitSha).toBe(r.finalizedMergeSha);
    expect(await journal.load()).toBeNull();
    void preMergeMainFiles;
  });

  it("G.8: tip already reachable from main (crash after merge, before delete) → NO second merge, just the delete; 404 branch → just the field cleanup", async () => {
    await setup();
    const branch = await birthConflict();
    // Resolve + finalize fully once.
    const rec = (await conflictStore.load()).entries.get(NOTE2)!;
    fs.rmSync(path.join(dir, buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device")));
    await stage({ [NOTE2]: "RESOLVED\ntwo\nthree\n" });
    vaultFiles.files.set(NOTE2, { content: "RESOLVED\ntwo\nthree\n", mtime: 300 });
    baseCommit = world.head;
    const r1 = await drainOnce(deps());
    expect(r1.finalizedMergeSha).not.toBeNull();

    // Crash simulation: the branch resurrects pointing at its old tip
    // (already merged = reachable), and the journal still holds the
    // name — the exact post-merge/pre-delete window.
    const oldTip = r1.finalizedMergeSha!;
    world.branchHeads.set(branch, oldTip); // tip == merge sha → identical/ahead
    const js = (await import("../../src/sync2/drain-journal")).emptyDrainState();
    js.conflictBranchName = branch;
    await journal.persist(js); // the crash left a journal with the name
    baseCommit = world.head;

    let merges = 0;
    const d = deps();
    const origMerge = d.client.createMergeCommit.bind(d.client);
    d.client.createMergeCommit = async (a) => {
      merges += 1;
      return origMerge(a);
    };
    const r2 = await drainOnce(d);
    expect(r2.status).toBe("ok");
    expect(merges).toBe(0); // ancestor-check: no second merge
    expect(world.branchHeads.has(branch)).toBe(false);

    // 404 variant: name set, branch gone → field cleanup only.
    const js2 = (await import("../../src/sync2/drain-journal")).emptyDrainState();
    js2.conflictBranchName = "ghost-branch";
    await journal.persist(js2);
    const r3 = await drainOnce(deps());
    expect(r3.status).toBe("ok");
    expect(hotUpdates[hotUpdates.length - 1].conflictBranchName).toBeNull();
  });

  it("G.13: 422 on the main-ref move → FINALIZE DEFERS (branch + name kept, drain ok); the next drain merges", async () => {
    await setup();
    const branch = await birthConflict();
    const rec = (await conflictStore.load()).entries.get(NOTE2)!;
    fs.rmSync(path.join(dir, buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device")));
    await stage({ [NOTE2]: "RESOLVED\ntwo\nthree\n" });
    vaultFiles.files.set(NOTE2, { content: "RESOLVED\ntwo\nthree\n", mtime: 300 });
    baseCommit = world.head;

    const d = deps();
    const origUpd = d.client.updateMainRef.bind(d.client);
    let blocked = true;
    d.client.updateMainRef = async (sha) => {
      if (blocked) {
        blocked = false;
        throw new (await import("../../src/errors")).ValidationError(
          "422: main moved",
        );
      }
      return origUpd(sha);
    };
    const r1 = await drainOnce(d);
    expect(r1.status).toBe("ok"); // deferral is NOT an error
    expect(r1.finalizedMergeSha).toBeNull();
    expect(world.branchHeads.has(branch)).toBe(true); // kept
    // The hot anchor carries the KEPT name forward between drains —
    // 'no conflicts right now' is NOT 'the branch was merged'.
    expect(hotUpdates[hotUpdates.length - 1].conflictBranchName).toBe(branch);

    baseCommit = world.head;
    const r2 = await drainOnce(deps());
    expect(r2.status).toBe("ok");
    expect(r2.finalizedMergeSha).not.toBeNull(); // retried and landed
    expect(world.branchHeads.has(branch)).toBe(false);
  });

  // + J.2: this IS restoreTrackedFilesFromDiskOrCreateNewOne's
  // no-journal-but-conflicts-non-empty branch — conflictBranchName
  // must come from the hot fallback, never back as null.
  it("G.6 + J.2: the branch name survives BETWEEN drains via the hot fallback when no journal exists", async () => {
    await setup();
    await journal.clear();
    // A live unresolved conflict blocks FINALIZE — otherwise the
    // 404-branch cleanup would legitimately null the field (a
    // hot-carried name whose branch never existed IS "already
    // finalized").
    const durable = await conflictStore.load();
    const sib = {
      path: NOTE2,
      size: 2,
      mtime: 700,
      sha: await sha("s\n"),
      blob: null,
      mode: "" as const,
      deviceLabel: "other-device",
    };
    durable.entries.set(NOTE2, {
      conflictBase: { ...sib, sha: await sha(V0b) },
      siblings: [sib],
    });
    await conflictStore.save(durable);
    fs.writeFileSync(
      path.join(dir, buildSiblingFilePath(NOTE2, 700, "other-device")),
      "s\n",
    );
    const heads: string[] = [];
    const d = deps({
      hot: {
        getLastSyncCommitSha: () => baseCommit,
        getLastSyncTreeSha: () => null,
        getHeldPluginUpdates: () => ({}),
        getConflictBranch: () => ({ name: "hot-carried-branch" }),
        update: async (f) => {
          hotUpdates.push(f);
        },
      },
    });
    const origHead = d.client.getBranchHeadSha.bind(d.client);
    d.client.getBranchHeadSha = async (b) => {
      heads.push(b);
      return origHead(b);
    };
    const r = await drainOnce(d);
    expect(r.status).toBe("ok");
    // Since §II.7.1 this drain asks the network about no branch at all
    // — an unresolved conflict with no batch never reaches a push
    // site, and reading a head nobody consumes was exactly the cost
    // that fix removed. So the invariant is asserted where it lives:
    // the name goes THROUGH this drain unchanged, and no regenerated
    // one appears anywhere.
    expect(heads.filter((b) => b !== "hot-carried-branch")).toEqual([]);
    expect(hotUpdates[hotUpdates.length - 1].conflictBranchName).toBe(
      "hot-carried-branch",
    );
  });

  it("G.3: crash-recovery dedup — the journal doesn't confirm, but the LIVE branch already holds the sha → push skipped", async () => {
    await setup();
    const branch = await birthConflict();
    const tipAfterBirth = world.branchHeads.get(branch)!;

    // Simulate "push succeeded, disk didn't": the durable conflictBase
    // regresses to V0 (≠ local), while the branch tip already carries
    // LOCAL_B. The next drain's STEP2 must skip the push via the LIVE
    // check, not duplicate the commit.
    const durable = await conflictStore.load();
    const rec = durable.entries.get(NOTE2)!;
    durable.entries.set(NOTE2, {
      conflictBase: { ...rec.conflictBase, sha: await sha(V0b) },
      siblings: rec.siblings,
    });
    await conflictStore.save(durable);
    await stage({ [NOTE2]: LOCAL_B }); // same content again
    baseCommit = world.head;

    const r = await drainOnce(deps());
    expect(r.status).toBe("ok");
    expect(world.branchHeads.get(branch)).toBe(tipAfterBirth); // no new commit
  });

  it("G.1: the journal confirms the same sha → STEP2 skips the push WITHOUT touching the network", async () => {
    await setup();
    const branch = await birthConflict();
    const tip = world.branchHeads.get(branch)!;

    // Entering STEP2 at all takes a tracked.base that DIFFERS from
    // local — otherwise the entry resolves as "unchanged" long before
    // the branch decision (that is why C.2, which looks like this
    // scenario, does not actually exercise it; probe-verified).
    // A journal from an interrupted run gives exactly that shape:
    // base still V0, while the durable conflictBase already carries
    // the content we are about to commit again.
    const { emptyDrainState } = await import("../../src/sync2/drain-journal");
    const js = emptyDrainState();
    const mk = async (content: string) => ({
      path: NOTE2,
      sha: await sha(content),
      size: enc(content).byteLength,
      mtime: 50,
      blob: null,
      mode: "" as const,
      deviceLabel: null,
    });
    js.trackedFiles.set(NOTE2, {
      base: await mk(V0b),
      remote: await mk(REMOTE_B),
      isManualConflict: true,
    });
    js.conflictBranchName = branch;
    await journal.persist(js);

    await stage({ [NOTE2]: LOCAL_B }); // == the durable conflictBase
    baseCommit = world.head;

    const d = deps();
    const branchReads: string[] = [];
    const realMeta = d.client.getContentsMetadataAtRef.bind(d.client);
    d.client.getContentsMetadataAtRef = async (p: string, ref: string) => {
      if (ref === tip) branchReads.push(p); // scoped BY REF: Layer 2
      return realMeta(p, ref); // legitimately reads main in the same run
    };
    let branchPushes = 0;
    const realPush = d.client.pushCommitToBranch.bind(d.client);
    d.client.pushCommitToBranch = async (
      args: Parameters<typeof realPush>[0],
    ) => {
      branchPushes += 1;
      return realPush(args);
    };

    const r = await drainOnce(d);
    expect(r.status).toBe("ok");
    expect(world.branchHeads.get(branch)).toBe(tip); // nothing pushed
    expect(branchPushes).toBe(0);
    // The whole point of G.1: the durable record ANSWERED, so the live
    // check never ran. G.3 is the mirror — record silent, live check
    // used. The answer is guarded TWICE (the STEP2 caller compares
    // conflictBase.sha first, shouldPushToConflictBranch compares it
    // again for its other caller, STEP1 crash-restart), so the probe
    // that arms this assertion has to remove both.
    expect(branchReads).toEqual([]);
  });

  it("G.4: the live check finds a DIFFERENT sha, or no such path on the branch → PUSH (the inverse of G.3)", async () => {
    await setup();
    const branch = await birthConflict();
    const tipAfterBirth = world.branchHeads.get(branch)!;
    const V0sha = await sha(V0b);
    const LOCAL_2 = "LOCAL-2\ntwo\nthree\n";

    // Both halves regress the durable conflictBase, so the journal can
    // never confirm and the decision rests ENTIRELY on the live read.
    const forgetConflictBase = async (): Promise<void> => {
      const durable = await conflictStore.load();
      const rec = durable.entries.get(NOTE2)!;
      durable.entries.set(NOTE2, {
        conflictBase: { ...rec.conflictBase, sha: V0sha },
        siblings: rec.siblings,
      });
      await conflictStore.save(durable);
    };

    // (a) the branch holds LOCAL_B, ours is LOCAL_2 → different → push.
    await forgetConflictBase();
    await stage({ [NOTE2]: LOCAL_2 });
    vaultFiles.files.set(NOTE2, { content: LOCAL_2, mtime: 200 });
    baseCommit = world.head;
    expect((await drainOnce(deps())).status).toBe("ok");
    const tipAfterPush = world.branchHeads.get(branch)!;
    expect(tipAfterPush).not.toBe(tipAfterBirth);
    expect(dec(world.filesAt(tipAfterPush).get(NOTE2)!.bytes)).toBe(LOCAL_2);

    // (b) the 404 shape — the branch carries no such path at all.
    // Ours did NOT change since (a), so a push here can only come
    // from the live answer, never from a content comparison.
    await forgetConflictBase();
    await stage({ [NOTE2]: LOCAL_2 });
    baseCommit = world.head;
    const d = deps();
    const origMeta = d.client.getContentsMetadataAtRef.bind(d.client);
    d.client.getContentsMetadataAtRef = async (p: string, ref: string) =>
      ref === tipAfterPush ? null : origMeta(p, ref);
    expect((await drainOnce(d)).status).toBe("ok");
    expect(world.branchHeads.get(branch)).not.toBe(tipAfterPush);
  });

  it("G.5: the branch NAME reaches the journal BEFORE the first network call that touches the branch (§II.7)", async () => {
    await setup();
    // The point of the ordering: a crash between "minted" and
    // "persisted" would leave a branch on GitHub this device can no
    // longer name — every later drain would mint a second one.
    const order: string[] = [];
    const realPersist = journal.persist.bind(journal);
    journal.persist = async (s) => {
      if (s.conflictBranchName !== null) order.push("journal:name");
      return realPersist(s);
    };

    const d = deps();
    const realHead = d.client.getBranchHeadSha.bind(d.client);
    d.client.getBranchHeadSha = async (b: string) => {
      order.push("net:getBranchHeadSha");
      return realHead(b);
    };
    const realPush = d.client.pushCommitToBranch.bind(d.client);
    d.client.pushCommitToBranch = async (args: Parameters<typeof realPush>[0]) => {
      order.push("net:pushCommitToBranch");
      return realPush(args);
    };

    await world.commitFiles({ [NOTE2]: REMOTE_B });
    await stage({ [NOTE2]: LOCAL_B });
    vaultFiles.files.set(NOTE2, { content: LOCAL_B, mtime: 100 });
    expect((await drainOnce(d)).status).toBe("ok");

    // Not "contains, in some order" — the FIRST event of the whole
    // sequence must be the persist.
    expect(order[0]).toBe("journal:name");
    expect(order).toContain("net:getBranchHeadSha");
    expect(order).toContain("net:pushCommitToBranch");
  });

  // G.14 — isAncestorOf is compare().status, and only these four
  // values exist. The two ancestor answers mean "a previous merge
  // already landed": delete the branch, do NOT merge again (that is
  // what keeps FINALIZE idempotent after a crash). The two others
  // mean the branch still carries commits main cannot reach → merge.
  const ANCESTOR_CASES: Array<
    ["ahead" | "behind" | "identical" | "diverged", boolean]
  > = [
    ["ahead", true],
    ["identical", true],
    ["diverged", false],
    ["behind", false],
  ];

  for (const [status, isAncestor] of ANCESTOR_CASES) {
    it(`G.14: compare status "${status}" → ${isAncestor ? "ancestor: delete only" : "not an ancestor: merge"}`, async () => {
      await setup();
      const branch = await birthConflict();
      const rec = (await conflictStore.load()).entries.get(NOTE2)!;
      // Resolve: sibling deleted, reconciled content committed.
      fs.rmSync(
        path.join(
          dir,
          buildSiblingFilePath(NOTE2, rec.siblings[0].mtime!, "other-device"),
        ),
      );
      const RESOLVED = "RESOLVED\ntwo\nthree\n";
      await stage({ [NOTE2]: RESOLVED });
      vaultFiles.files.set(NOTE2, { content: RESOLVED, mtime: 300 });
      baseCommit = world.head;

      const d = deps();
      d.client.compareStatus = async () => status;
      const r = await drainOnce(d);

      expect(r.status).toBe("ok");
      expect(r.finalizedMergeSha === null).toBe(isAncestor);
      // Either way the branch is gone and the name is cleared —
      // the difference is only whether a merge commit was made.
      expect(world.branchHeads.has(branch)).toBe(false);
      expect(hotUpdates[hotUpdates.length - 1].conflictBranchName).toBeNull();
    });
  }
});

