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
import { RemoteFileChange, DELETED_SHA_HASH } from "../../src/sync2/discovery";
import { NetworkError } from "../../src/errors";
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

describe("drain conflict lifecycle (§VIII C + E.3-5 + L.3)", () => {
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
  ): Promise<RemoteFileChange[]> => {
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
    return out;
  };

  const stageBatch = async (
    files: Record<string, string | null>,
    mtime = 100,
  ): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      if (content === null) {
        entries.push({ path: p, sha: null, size: null, mtime: null });
        continue;
      }
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({ path: p, sha: s, size: enc(content).byteLength, mtime });
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
        getConflictBranch: () => null,
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

  it("C.1 + C.4 + C.13(step1) + L.3: STEP1 births the conflict — branch gets local, main gets the OTHER file, base file untouched, first sibling written", async () => {
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
    // The fold RAN: the theirs-side moved on (2 siblings here because
    // v1-vs-v2 same-line divergence cannot auto-merge → §III STEP3
    // п.2 ERROR branch appends; a clean fold would have replaced).
    expect(r2.vaultStepErrors).toEqual([]); // ← the defect surfaced HERE
    expect(e2.siblings.length).toBeGreaterThan(1);
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

    // Remote rewrites line 1 AGAIN differently → conflicts with the
    // sibling relative to conflictBase → append.
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
    // The next commit+drain will re-commit the file and likely birth
    // a fresh, healthy conflict — that is the designed self-heal.
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
  let hotUpdates: Array<{
    lastSyncCommitSha: string | null;
    lastSyncTreeSha: string | null;
    conflictBranchName: string | null;
  }>;

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
    batches = [];
    baseCommit = null;
    seq = 0;
    hotUpdates = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const honest = async (base: string | null, head: string): Promise<RemoteFileChange[]> => {
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
    return out;
  };

  const stage = async (files: Record<string, string>): Promise<void> => {
    const entries: BatchEntry[] = [];
    for (const [p, content] of Object.entries(files)) {
      const s = await sha(content);
      await syncStore.saveBlobToSyncStore(s, enc(content));
      entries.push({ path: p, sha: s, size: enc(content).byteLength, mtime: 100 });
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
      getConflictBranch: () => null,
      update: async (f) => {
        hotUpdates.push(f);
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

  it("G.9 🔑 + G.10 + G.12: resolution → FINALIZE reachability-merge — main tree byte-identical, parents [main, conflict] positionally, empty diff", async () => {
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

  it("G.6: the branch name survives BETWEEN drains via the hot fallback when no journal exists", async () => {
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
    expect(heads).toContain("hot-carried-branch"); // NOT a regenerated name
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
});

