import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import NetworkRetry from "../../src/sync2/retry-network";
import {
  drainOnce,
  DrainDeps,
  DrainClient,
  DrainProgress,
} from "../../src/sync2/drain";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import { mergeBlobsWithMainThreadDiff3 } from "../../src/sync2/diff3";
import { ClaimedBatch } from "../../src/sync2/get-batch";
import { BatchEntry } from "../../src/sync2/batch-metafile";
import {
  RemoteFileChange,
  DiscoveryResult,
  DELETED_SHA_HASH,
} from "../../src/sync2/discovery";
import { NetworkError, ValidationError } from "../../src/errors";
import { calculateGitBlobSHA } from "../../src/utils";
import { setMockApiVersion } from "../../mock-obsidian";
import {
  addRecheckPaths,
  readRecheckPaths,
} from "../../src/sync2/recheck-paths";

// §VIII B (rolling base / chaining, §II.3-II.5) + P.1-12/27-29
// (Layer 2 + the lying-discovery model) + L (sequential per-file,
// stat short-circuit read counts) + E п.1-5 (one wrapper test) —
// drainOnce() against a fake GitHub WORLD with real trees/commits/422
// semantics and the REAL SyncStore / DrainJournal / NetworkRetry.
//
// The world has TWO independent eyes (§VIII P prologue): `truth` —
// what really sits at head (Layer 2 / blobs read it), and
// `discoveryAnswer` — what discovery claims changed. Splitting them
// is the model of a Layer-1 blindspot (P.8-13).

const PLUGIN_ID = "git-easy-sync";

import {
  FakeWorld,
  FakeVaultFiles,
  RepoFiles,
  enc,
  dec,
  sha,
} from "./drain-harness";

describe("drainOnce (§VIII B + P + L + E)", () => {
  let dir: string;
  let vault: Vault;
  let world: FakeWorld;
  let syncStore: SyncStore;
  let journal: DrainJournal;
  let vaultFiles: FakeVaultFiles;
  let baselines: Map<
    string,
    { baselineSha: string; mtime: number; size: number }
  >;
  let batches: Array<{ claimed: ClaimedBatch; removed: boolean }>;
  let removedDirs: string[];
  let conflictStore: ConflictStoreV2;
  let siblingTx: SiblingTx;
  let baseCommit: string | null;
  let discoveryOverride:
    ((base: string | null, head: string) => Promise<DiscoveryResult>) | null;
  let progressLog: Array<[number, number]>;
  let batchSeq: number;
  // PARTIAL since the hold gate (§5.5): a write may carry only
  // `heldPluginUpdates`, mid-run, so every field is optional.
  let hotUpdates: Array<{
    lastSyncCommitSha?: string | null;
    lastSyncTreeSha?: string | null;
    conflictBranchName?: string | null;
    heldPluginUpdates?: Record<string, unknown>;
  }>;
  // PLUGIN-UPDATE-COMPAT Фаза 2 — the hot pair's held-updates field,
  // read back by the fake below exactly as production reads it.
  let heldState: Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "drain-test-"));
    vault = new Vault(dir);
    world = new FakeWorld();
    syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    journal = new DrainJournal({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
      generateGuid: () => `guid-${Math.random().toString(36).slice(2)}`,
    });
    vaultFiles = new FakeVaultFiles();
    baselines = new Map();
    batches = [];
    removedDirs = [];
    baseCommit = null;
    discoveryOverride = null;
    progressLog = [];
    batchSeq = 0;
    hotUpdates = [];
    heldState = {};
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Default discovery: an honest tree-diff of the fake world against
  // the recorded base commit — the same semantics discovery.ts
  // provides in production.
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
        size: h?.bytes.byteLength ?? null,
        mtime: null,
        deleted: h === null,
      });
    }
    // tree: null → Layer 2 keeps using the per-path transport,
    // so every pre-existing assertion here still covers THAT path.
    return { changes: out, tree: null };
  };

  // Stage a batch the way BatchWriter would: entries + blobs in the
  // sync_store.
  const stageBatch = async (
    files: Record<string, string | null>,
    mtime = 100,
    createdAt = 0,
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
        meta: { v: 1, id, createdAt, entries },
      },
      removed: false,
    });
  };

  const makeDeps = (over?: Partial<DrainDeps>): DrainDeps => ({
    vault: vault as never,
    selfPluginId: PLUGIN_ID,
    client: world.makeClient(),
    syncStore,
    journal,
    retry: new NetworkRetry({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      sleep: async () => {},
    }),
    claimBatch: async () => {
      const next = batches.find((b) => !b.removed);
      return next ? next.claimed : null;
    },
    removeBatchDir: async (d) => {
      removedDirs.push(d);
      const b = batches.find((x) => x.claimed.dir === d);
      if (b) b.removed = true;
    },
    baselines: {
      get: async (p) => baselines.get(p),
      // §5.4 — REAL, over the same map: a hold has to rescue the
      // folder's baselines, and a stub returning [] would make the
      // rescue look like it worked while rescuing nothing.
      listUnder: async (prefix: string) =>
        [...baselines]
          .filter(([p]) => p.startsWith(prefix))
          .map(([path, b]) => ({ path, ...b })),
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
    discoverChangedFiles: (base, head) =>
      (discoveryOverride ?? honestDiscovery)(base, head),
    hot: {
      getLastSyncCommitSha: () => baseCommit,
      getLastSyncTreeSha: () => null,
      getConflictBranch: () => null,
      getHeldPluginUpdates: () => heldState as never,
      update: async (f) => {
        hotUpdates.push(f);
        if (f.heldPluginUpdates !== undefined) {
          heldState = f.heldPluginUpdates as Record<string, unknown>;
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
    deviceLabel: () => "test-device",
    commitMessage: () => "Sync at test (test-device)",
    mergeMessage: () => "Merge conflict branch (test-device)",
    now: () => 1_700_000_500_000,
    onProgress: (p) => progressLog.push([p.pushDone, p.pushTotal]),
    ...over,
  });

  // Common setup: repo at C0 with note.md, vault + baselines aligned.
  const V0 = "one\ntwo\nthree\n";
  const setupAligned = async (): Promise<void> => {
    baseCommit = await world.commitFiles({ "note.md": V0 });
    const s = await sha(V0);
    baselines.set("note.md", {
      baselineSha: s,
      mtime: 50,
      size: enc(V0).byteLength,
    });
    vaultFiles.files.set("note.md", { content: V0, mtime: 50 });
  };


  // FIELD BUG 2026-10-05 (owner's vault, "auto canonicalize" ON): a
  // file restored non-canonical, whose canonical form equals its
  // baseline, is committed for the sake of the write-back — and the
  // batch entry's sha is then EXACTLY the baseline. Layer 2 confirms the
  // remote unchanged, leaving remote.sha null; _diff3 had no rule for
  // local == base with remote == null and fetched a blob for a null sha.
  // Every drain failed on that queued batch.
  describe("a batch entry equal to its own baseline", () => {
    it("🔑 head exists and holds it: ok, and NOTHING is pushed (no empty commit)", async () => {
      await setupAligned();
      const commitsBefore = world.commits.length;
      await stageBatch({ "note.md": V0 });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(world.commits.length).toBe(commitsBefore);
      expect(baselines.get("note.md")?.baselineSha).toBe(await sha(V0));
    });

    // NB: an empty repo is SEEDED first (seedBareRepoWithFile), so a head
    // exists by the time Layer 2 runs. The short-circuit's
    // `headHash !== null` guard covers the case where seeding could not
    // happen (seed blob missing) — reachable by reasoning, not by this
    // fake; this test pins the end result: the file reaches the server.
    it("…and in an EMPTY repo the entry still reaches the server (seeded; no crash)", async () => {
      baselines.set("note.md", {
        baselineSha: await sha(V0),
        mtime: 50,
        size: enc(V0).byteLength,
      });
      vaultFiles.files.set("note.md", { content: V0, mtime: 50 });
      await stageBatch({ "note.md": V0 });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(world.headFiles().get("note.md")?.sha).toBe(await sha(V0));
    });
  });

  // ── PLUGIN-UPDATE-COMPAT Фаза 2 (§5.12) ──────────────────────────
  //
  // A plugin update meant for a newer Obsidian than this device runs
  // must not reach the disk AT ALL. The files would land correctly and
  // the plugin would then fail to load — on this restart and every
  // one after it, until the app catches up. That was the 2026-08-02
  // incident, and the sync engine was blameless in it.
  describe("holding a plugin update this Obsidian cannot load", () => {
    const ID = "templater-obsidian";
    const DIR = `.obsidian/plugins/${ID}`;
    const MAIN = `${DIR}/main.js`;
    const MANIFEST = `${DIR}/manifest.json`;

    const manifestAt = (version: string, min: string) =>
      JSON.stringify({ id: ID, version, minAppVersion: min });

    // The device runs an Obsidian OLDER than what the update wants.
    beforeEach(() => {
      setMockApiVersion("1.12.7");
    });
    afterEach(() => {
      setMockApiVersion("1.13.4");
    });

    const seedInstalled = async (): Promise<void> => {
      const oldMain = "OLD BUNDLE";
      const oldManifest = manifestAt("2.20.6", "1.0.0");
      baseCommit = await world.commitFiles({
        [MAIN]: oldMain,
        [MANIFEST]: oldManifest,
      });
      baselines.set(MAIN, {
        baselineSha: await sha(oldMain),
        mtime: 50,
        size: enc(oldMain).byteLength,
      });
      baselines.set(MANIFEST, {
        baselineSha: await sha(oldManifest),
        mtime: 50,
        size: enc(oldManifest).byteLength,
      });
      vaultFiles.files.set(MAIN, { content: oldMain, mtime: 50 });
      vaultFiles.files.set(MANIFEST, { content: oldManifest, mtime: 50 });
    };

    it("🎯 6.4.1 the MANIFEST is read, the BUNDLE is never downloaded", async () => {
      await seedInstalled();
      const newMain = "NEW BUNDLE THAT NEEDS 1.13";
      await world.commitFiles({
        [MAIN]: newMain,
        [MANIFEST]: manifestAt("2.24.3", "1.13.0"),
      });

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");

      // THE assertion. Byte-equality of the vault would be a weaker
      // claim — it stays green even when the bundle was downloaded and
      // thrown away, which on a phone is the whole cost.
      const mainSha = await sha(newMain);
      expect(world.blobReads).not.toContain(mainSha);
      expect(vaultFiles.files.get(MAIN)!.content).toBe("OLD BUNDLE");
      expect(vaultFiles.writes).not.toContain(MAIN);

      const held = heldState[ID] as {
        minAppVersion: string;
        heldVersion: string;
        baselines: Array<{ path: string }>;
      };
      expect(held.minAppVersion).toBe("1.13.0");
      expect(held.heldVersion).toBe("2.24.3");
      // 🔴 §5.4 — the baselines of the WHOLE folder are rescued into
      // the record. The hold makes every one of them ignored, and the
      // detector's Pass 2 deletes the baseline of a newly-ignored
      // path; without this copy the lift would meet Pass 1 with no
      // baselines, read the local files as new, and PUSH the old
      // version to every device.
      expect(held.baselines.map((b) => b.path).sort()).toEqual(
        [MAIN, MANIFEST].sort(),
      );
    });

    it("6.3.2 a version this Obsidian satisfies passes through untouched", async () => {
      await seedInstalled();
      await world.commitFiles({
        [MAIN]: "COMPATIBLE BUNDLE",
        [MANIFEST]: manifestAt("2.21.0", "1.10.0"),
      });

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe("COMPATIBLE BUNDLE");
      expect(heldState[ID]).toBeUndefined();
    });

    it("🔴 6.5.1 the lift brings an update whose commit is BEHIND the base", async () => {
      // The reason unfreeze cannot be "let the next drain pull it":
      // discovery answers with the base…head DELTA, and the commit
      // that updated this plugin was skipped while the hold was on —
      // it sits behind the base forever after. Only a state-against-
      // state read of the subtree can still see it.
      await seedInstalled();
      const newMain = "NEW BUNDLE THAT NEEDS 1.13";
      await world.commitFiles({
        [MAIN]: newMain,
        [MANIFEST]: manifestAt("2.24.3", "1.13.0"),
      });
      await drainOnce(makeDeps());
      expect(heldState[ID]).toBeDefined();
      // The pointer has moved past the update's commit...
      baseCommit = world.head;
      // ...and the user finally updates Obsidian.
      setMockApiVersion("1.13.4");

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe(newMain);
      expect(heldState[ID]).toBeUndefined();
      // Baselines land with the applied content, so the next scan does
      // not read the fresh files as a local change.
      expect(baselines.get(MAIN)!.baselineSha).toBe(await sha(newMain));
    });

    it("🔴 §7.1.2 a file deleted in the repo while held is deleted at the lift, not before", async () => {
      await seedInstalled();
      const styles = `${DIR}/styles.css`;
      vaultFiles.files.set(styles, { content: "css", mtime: 50 });
      baselines.set(styles, {
        baselineSha: await sha("css"),
        mtime: 50,
        size: 3,
      });
      await world.commitFiles({
        [MAIN]: "NEW BUNDLE",
        [MANIFEST]: manifestAt("2.24.3", "1.13.0"),
      });

      await drainOnce(makeDeps());
      // While held, the plugin keeps working locally — including the
      // file the repo no longer has.
      expect(vaultFiles.files.has(styles)).toBe(true);

      baseCommit = world.head;
      setMockApiVersion("1.13.4");
      await drainOnce(makeDeps());
      expect(vaultFiles.files.has(styles)).toBe(false);
    });

    it("⚠️ a truncated tree does NOT lift — absent from a partial list is not absent from the repo", async () => {
      await seedInstalled();
      await world.commitFiles({
        [MAIN]: "NEW BUNDLE",
        [MANIFEST]: manifestAt("2.24.3", "1.13.0"),
      });
      await drainOnce(makeDeps());
      expect(heldState[ID]).toBeDefined();

      baseCommit = world.head;
      setMockApiVersion("1.13.4");
      world.truncateTrees = true;
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      // The record survives: reading the partial list as deletion
      // would have wiped the plugin's folder.
      expect(heldState[ID]).toBeDefined();
      expect(vaultFiles.files.get(MAIN)!.content).toBe("OLD BUNDLE");
      world.truncateTrees = false;
    });

    it("a local edit already staged in a batch is SKIPPED, never pushed", async () => {
      // The one change we deliberately do not push (owner,
      // 2026-10-01): under a hold the only version installable by hand
      // is a COMPATIBLE, i.e. OLDER, one, and letting it travel rolls
      // the update back on every healthy device.
      await seedInstalled();
      await world.commitFiles({
        [MAIN]: "NEW BUNDLE",
        [MANIFEST]: manifestAt("2.24.3", "1.13.0"),
      });
      await drainOnce(makeDeps());
      expect(heldState[ID]).toBeDefined();

      // The user installs an older build by hand; the commit pass had
      // already staged it before the hold existed.
      await stageBatch({ [MAIN]: "HAND-INSTALLED OLDER BUILD" });
      baseCommit = world.head;
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(dec(world.headFiles().get(MAIN)!.bytes)).toBe("NEW BUNDLE");
    });
  });


  // ── 🔴 THE BASELINE MAY NOT CLAIM WHAT THE VAULT-STEP DID NOT DO ──
  //
  // Found 2026-10-02 while answering "does this affect only our own
  // plugin?". It affects ANY file.
  //
  // The Vault-step has eight places that record a `vaultStepError` and
  // `continue` — the file is NOT written. But the epilogue transfers
  // baselines from `tracked.remote` for every surviving record, so the
  // baseline then says "the vault holds the remote version" about a
  // file that still holds the old one.
  //
  // ⚠️ That lie is not inert. On the next scan the local file differs
  // from its baseline, so it reads as a LOCAL EDIT; `_diff3` then sees
  // local moved and remote unmoved, takes the local side, and PUSHES
  // the stale copy over whatever the repo has. A skip becomes a
  // silent revert of someone else's change.
  //
  // The comment above site 2043 already describes this exact failure
  // for a neighbouring branch — one instance was fixed, the rest were
  // left.
  describe("🔴 a path the Vault-step SKIPPED keeps its old baseline", () => {
    it("remote blob missing from the repo → error recorded, baseline NOT advanced", async () => {
      await setupAligned();
      await world.commitFiles({ "note.md": "REMOTE V2\n" });
      const remoteSha = await sha("REMOTE V2\n");
      // The tree names the blob, the blob is gone. Not hypothetical:
      // this project already carries an open GitHub eventual-consistency
      // bug (422 BadObjectState on a deletion entry, self-resolving
      // after ~17 min), so "the object is not there yet" is a state the
      // engine meets in the field.
      world.blobs.delete(remoteSha);

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.vaultStepErrors.map((e) => e.path)).toEqual(["note.md"]);
      // The vault was not updated...
      expect(vaultFiles.files.get("note.md")!.content).toBe(V0);
      // ...so the baseline must still describe what IS on disk.
      expect(baselines.get("note.md")!.baselineSha).toBe(await sha(V0));
    });


    it("🔑 a path named in the recheck note is ASKED ABOUT, even though no delta mentions it", async () => {
      // The stranding, end to end. The remote moved while the path was
      // being skipped; the pointer then advanced past that commit, so
      // `compare(base…head)` will never name it again. Without the
      // note the file stays old forever — silently, because locally
      // everything agrees.
      await setupAligned();
      await world.commitFiles({ "note.md": "REMOTE V2\n" });
      // We are "already synced" past the commit that changed it.
      baseCommit = world.head;
      await addRecheckPaths(
        vault.adapter as never,
        `.obsidian/plugins/${PLUGIN_ID}`,
        ["note.md"],
      );

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get("note.md")!.content).toBe("REMOTE V2\n");
      expect(baselines.get("note.md")!.baselineSha).toBe(
        await sha("REMOTE V2\n"),
      );
      // The note is consumed by a drain that finished.
      expect(
        (
          await readRecheckPaths(
            vault.adapter as never,
            `.obsidian/plugins/${PLUGIN_ID}`,
            `.obsidian/plugins/${PLUGIN_ID}`,
          )
        ).paths,
      ).toEqual([]);
    });

    it("a skip LEAVES the note, so the next drain asks", async () => {
      await setupAligned();
      await world.commitFiles({ "note.md": "REMOTE V2\n" });
      world.blobs.delete(await sha("REMOTE V2\n"));

      await drainOnce(makeDeps());
      const left = await readRecheckPaths(
        vault.adapter as never,
        `.obsidian/plugins/${PLUGIN_ID}`,
        `.obsidian/plugins/${PLUGIN_ID}`,
      );
      expect(left.paths).toEqual(["note.md"]);
    });

    it("🔑 the invariant, stated once: no errored path may carry the remote sha as its baseline", async () => {
      // Written as a property rather than a case so a NEW skip site
      // added later is covered without anyone remembering to extend a
      // list.
      await setupAligned();
      // A second aligned file, so the property has a neighbour to
      // prove the skip is per PATH and not per drain.
      const otherV0 = "other v0\n";
      await world.commitFiles({ "other.md": otherV0 });
      baselines.set("other.md", {
        baselineSha: await sha(otherV0),
        mtime: 50,
        size: enc(otherV0).byteLength,
      });
      vaultFiles.files.set("other.md", { content: otherV0, mtime: 50 });
      baseCommit = world.head;
      await world.commitFiles({
        "note.md": "REMOTE V2\n",
        "other.md": "other v1\n",
      });
      world.blobs.delete(await sha("REMOTE V2\n"));

      const r = await drainOnce(makeDeps());
      for (const { path } of r.vaultStepErrors) {
        const live = vaultFiles.files.get(path);
        const baseline = baselines.get(path);
        if (baseline === undefined) continue;
        expect(baseline.baselineSha).toBe(
          live === undefined ? baseline.baselineSha : await sha(live.content),
        );
      }
      // ...and the file that DID apply is unaffected by the neighbour's
      // failure — a skip is per path, not per drain.
      expect(vaultFiles.files.get("other.md")!.content).toBe("other v1\n");
    });
  });


  // ── §28 — a plugin-core collision is decided by SEMVER ───────────
  //
  // Until now the interim rule was pure mtime: newest wins, remote on
  // ambiguity. That is right for ordinary `.obsidian/` files and wrong
  // for a plugin bundle, where "newer" has a published meaning —
  // `manifest.json` says which version the bytes belong to, and a
  // clock says only which device wrote last.
  describe("§28 plugin-core collisions resolve by version, not by clock", () => {
    const DIR = ".obsidian/plugins/some-plugin";
    const MAIN = `${DIR}/main.js`;
    const MANIFEST = `${DIR}/manifest.json`;
    const manifestAt = (v: string) =>
      JSON.stringify({ id: "some-plugin", version: v });

    // Both sides move, and the LOCAL file is the one with the newer
    // mtime — so a clock-based rule would pick local every time.
    const bothSidesMoved = async (
      localVersion: string,
      remoteVersion: string,
    ): Promise<void> => {
      baseCommit = await world.commitFiles({
        [MAIN]: "BASE BUNDLE",
        [MANIFEST]: manifestAt("1.0.0"),
      });
      for (const [p, c] of [
        [MAIN, "BASE BUNDLE"],
        [MANIFEST, manifestAt("1.0.0")],
      ] as const) {
        baselines.set(p, {
          baselineSha: await sha(c),
          mtime: 50,
          size: enc(c).byteLength,
        });
        vaultFiles.files.set(p, { content: c, mtime: 50 });
      }
      await world.commitFiles({
        [MAIN]: "REMOTE BUNDLE",
        [MANIFEST]: manifestAt(remoteVersion),
      });
      // Local edits, with a mtime far in the FUTURE.
      vaultFiles.files.set(MAIN, { content: "LOCAL BUNDLE", mtime: 9e12 });
      vaultFiles.files.set(MANIFEST, {
        content: manifestAt(localVersion),
        mtime: 9e12,
      });
      // ⚠️ The clock the batch path compares is the BATCH entry's
      // mtime, not the vault file's — so the "local is newer" premise
      // has to be expressed where the rule will actually read it.
      await stageBatch({ [MAIN]: "LOCAL BUNDLE" }, 9e12);
    };

    it("🔑 the HIGHER remote version wins even though the local file is newer by clock", async () => {
      await bothSidesMoved("1.0.0", "2.0.0");
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe("REMOTE BUNDLE");
      expect(dec(world.headFiles().get(MAIN)!.bytes)).toBe("REMOTE BUNDLE");
    });

    it("🔑 the HIGHER local version wins and lifts to the repo", async () => {
      await bothSidesMoved("3.0.0", "1.5.0");
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe("LOCAL BUNDLE");
      expect(dec(world.headFiles().get(MAIN)!.bytes)).toBe("LOCAL BUNDLE");
    });

    it("equal versions fall back to the clock — E4's rule, kept", async () => {
      // Same version on both sides says nothing about which bundle is
      // newer, so the old tiebreak is still the honest answer.
      await bothSidesMoved("2.0.0", "2.0.0");
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe("LOCAL BUNDLE");
    });

    it("an unreadable version falls back to the clock, never to a guess", async () => {
      await bothSidesMoved("not-a-version", "2.0.0");
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get(MAIN)!.content).toBe("LOCAL BUNDLE");
    });
  });

  // ── B: rolling base / chaining ───────────────────────────────────

  // ⚠️ OUR OWN plugin's loadable files never reach the vault write
  // (owner, 2026-10-01). Every other torn write here is repaired at
  // our next onload; this one cannot be, because the repair code lives
  // inside the file that would be broken. So the drain stages, and the
  // bootloader applies at the top of the next start — the one moment
  // the file Obsidian loads can be replaced by code that is running
  // and healthy.
  it("SELF: an incoming main.js is STAGED, and the live file is not touched", async () => {
    const SELF_MAIN = `.obsidian/plugins/${PLUGIN_ID}/main.js`;
    baseCommit = await world.commitFiles({ [SELF_MAIN]: "OLD CODE" });
    const oldSha = await sha("OLD CODE");
    baselines.set(SELF_MAIN, { baselineSha: oldSha, mtime: 50, size: 8 });
    vaultFiles.files.set(SELF_MAIN, { content: "OLD CODE", mtime: 50 });
    await world.commitFiles({ [SELF_MAIN]: "NEW CODE" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");

    // The running code is still the running code.
    expect(vaultFiles.files.get(SELF_MAIN)!.content).toBe("OLD CODE");
    expect(vaultFiles.writes).not.toContain(SELF_MAIN);
    expect(r.vaultStepWrites).not.toContain(SELF_MAIN);
    // ...and the update is waiting where the bootloader looks.
    expect(vaultFiles.staged.get(SELF_MAIN)?.content).toBe("NEW CODE");
    expect(r.selfUpdateStaged).toContain(SELF_MAIN);

    // 🔴 THE TRAP, and it is silent without this line. Recording the
    // NEW sha as the baseline while the disk still holds the OLD bytes
    // makes the next findChanges read the RUNNING version as a local
    // edit — and push it. That publishes a downgrade of our own plugin
    // to every device, which is §5.9.1's scenario arriving through a
    // different door. Baseline and disk must stay consistent: both
    // OLD, until the bootloader makes both NEW.
    expect(baselines.get(SELF_MAIN)!.baselineSha).toBe(oldSha);
  });


  it("🔴 SELF: a SECOND drain over an already-staged update must not advance the baseline either", async () => {
    // The skip matrix found this one, and it is mine: the early
    // "already staged, do not re-download" short-circuit returned
    // WITHOUT dropping the tracked record, so the epilogue still wrote
    // the new sha as the baseline while the running `main.js` was
    // still the old one. The next scan would read the RUNNING version
    // as a local edit and push it — the self-downgrade the staging
    // path was built to prevent, one drain later.
    const SELF_MAIN = `.obsidian/plugins/${PLUGIN_ID}/main.js`;
    baseCommit = await world.commitFiles({ [SELF_MAIN]: "OLD CODE" });
    const oldSha = await sha("OLD CODE");
    baselines.set(SELF_MAIN, { baselineSha: oldSha, mtime: 50, size: 8 });
    vaultFiles.files.set(SELF_MAIN, { content: "OLD CODE", mtime: 50 });
    await world.commitFiles({ [SELF_MAIN]: "NEW CODE" });

    await drainOnce(makeDeps());           // stages it
    baseCommit = world.head;                // the pointer moved on
    await drainOnce(makeDeps());           // asks again, finds it staged

    // The vault still runs the old code, so the baseline must still
    // describe the old code.
    expect(vaultFiles.files.get(SELF_MAIN)!.content).toBe("OLD CODE");
    expect(baselines.get(SELF_MAIN)!.baselineSha).toBe(oldSha);
  });

  it("SELF: a staged update is not re-downloaded on the next sync", async () => {
    // The pending update outlives the drain that fetched it — on a
    // phone, re-pulling a megabyte on every sync until the user
    // restarts is the difference between waiting and paying.
    const SELF_MAIN = `.obsidian/plugins/${PLUGIN_ID}/main.js`;
    baseCommit = await world.commitFiles({ [SELF_MAIN]: "OLD CODE" });
    const oldSha = await sha("OLD CODE");
    baselines.set(SELF_MAIN, { baselineSha: oldSha, mtime: 50, size: 8 });
    vaultFiles.files.set(SELF_MAIN, { content: "OLD CODE", mtime: 50 });
    await world.commitFiles({ [SELF_MAIN]: "NEW CODE" });

    await drainOnce(makeDeps());
    const blobReadsAfterFirst = world.blobReads.length;
    // Same head, same staged bytes: the second run must not fetch.
    baseCommit = null;
    await drainOnce(makeDeps());
    expect(world.blobReads.length).toBe(blobReadsAfterFirst);
  });

  it("B.1 + B.7: chain C1..C3 with no remote changes → each D_i = C_i, three commits, base rolls, vault untouched", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    await stageBatch({ "note.md": "C2\n" });
    await stageBatch({ "note.md": "C3\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(3);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C3\n");
    // B.7: vault-step — base == remote (only local pushes) → untouched.
    expect(vaultFiles.writes).toEqual([]);
    expect(vaultFiles.files.get("note.md")!.content).toBe(V0); // as the user left it
    expect(removedDirs).toHaveLength(3);
    expect(r.layer2Corrections).toEqual([]); // P.28 happy-path sentinel
  });

  it("B.2: ONE remote change mid-chain → every step diff3s against the previous D; both sides' edits survive", async () => {
    await setupAligned();
    // Remote edits line 3; local batches edit line 1 twice.
    await world.commitFiles({ "note.md": "one\ntwo\nTHREE-remote\n" });
    await stageBatch({ "note.md": "C1-one\ntwo\nthree\n" });
    await stageBatch({ "note.md": "C2-one\ntwo\nthree\n" });
    // The batches were snapshotted FROM the vault — it holds C2 now.
    vaultFiles.files.set("note.md", {
      content: "C2-one\ntwo\nthree\n",
      mtime: 100,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(2);
    const final = dec(world.headFiles().get("note.md")!.bytes);
    expect(final).toBe("C2-one\ntwo\nTHREE-remote\n"); // last local + remote edit
    // Vault-step (II.3 ending): C_n != D_n → the vault receives the merge.
    expect(vaultFiles.files.get("note.md")!.content).toBe(
      "C2-one\ntwo\nTHREE-remote\n",
    );
  });

  it("B.3 + transaction rule: 422 mid-chain → restart re-pulls, journal re-load discards the failed batch's mutations, chain completes", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1-one\ntwo\nthree\n" });
    await stageBatch({ "note.md": "C2-one\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "C2-one\ntwo\nthree\n",
      mtime: 100,
    });

    // An external commit lands between batch 1's push and batch 2's:
    // trigger it from the SECOND pushCommitFromTree attempt.
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let pushes = 0;
    let injected = false;
    client.pushCommitFromTree = async (args) => {
      pushes += 1;
      if (pushes === 2 && !injected) {
        injected = true;
        // The external device edits line 3 of the CURRENT head (which
        // already carries C1's line-1 edit) — a mergeable divergence.
        await world.commitFiles({ "note.md": "C1-one\ntwo\nEXTERNAL\n" });
        // parent is now stale → the real push below throws 422.
      }
      return origPush(args);
    };

    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    // C1 push + failed attempt + successful merged C2 push.
    const final = dec(world.headFiles().get("note.md")!.bytes);
    expect(final).toBe("C2-one\ntwo\nEXTERNAL\n");
    expect(r.pushedCommits).toHaveLength(2); // failed attempt didn't count
    expect(removedDirs).toHaveLength(2);
  });

  it("B.4: crash after push, before persist → the restart sees its own push as remote, byte-identical drop, NO duplicate commit", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    vaultFiles.files.set("note.md", { content: "C1\n", mtime: 100 });

    // Crash: journal.persist throws right after the push. Since
    // §II.7.1 the branch-name mint is lazy, so a run with no conflict
    // never persists for it — the batch-completion persist is the
    // FIRST call, not the second. (Before that fix this was `=== 2`,
    // and the extra write it counted happened on every sync.)
    const origPersist = journal.persist.bind(journal);
    let persists = 0;
    journal.persist = async (state) => {
      persists += 1;
      if (persists === 1) {
        throw new Error("power loss before persist");
      }
      return origPersist(state);
    };
    await expect(drainOnce(makeDeps())).rejects.toThrow("power loss");
    expect(world.commits.length).toBe(2); // C0 + the pushed C1
    expect(batches[0].removed).toBe(false); // batch survived the crash

    // Restart: discovery reports our own C1 as the remote change →
    // pull-folding → short-circuit → no second push.
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0);
    expect(world.commits.length).toBe(2);
    expect(batches[0].removed).toBe(true);
  });

  // ── §VIII D — crash AFTER the claim, BEFORE any push ──────────────
  //
  // Phase 6, crash matrix. The window where a batch has been taken out
  // of the queue but nothing has left the device yet. Its whole claim
  // is negative — nothing moved, nothing was lost — and that is
  // exactly why it needs pinning: a defect here is invisible in the
  // final state of the happy path and shows up only as work that
  // quietly stopped existing.
  //
  // Note what makes it safe: `removeBatchDir` is the LAST statement of
  // the batch transaction, after both pushes and both persists. The
  // claim is therefore not a commitment — it is a lease that lapses
  // when the run dies.
  it("D: crash after the claim, before any push → nothing moved, the batch is still owed, the redo lands it whole", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    vaultFiles.files.set("note.md", { content: "C1\n", mtime: 100 });
    const commitsBefore = world.commits.length;

    // The first network call the batch makes is the Layer-2 live check
    // (§II.13), which happens before anything is built, let alone
    // pushed.
    const d1 = makeDeps();
    d1.client.getContentsMetadataAtRef = async () => {
      throw new Error("power loss after the claim");
    };
    await expect(drainOnce(d1)).rejects.toThrow("power loss");

    // THE INTERMEDIATE STATE — the claim really did happen (so the
    // crash is in the window the name says), and nothing else did.
    expect(batches).toHaveLength(1); // claimed…
    expect(batches[0].removed).toBe(false); // …and still owed
    expect(world.commits.length).toBe(commitsBefore); // nothing pushed
    expect(await journal.load()).toBeNull(); // nothing persisted

    // The redo takes the same batch and finishes it.
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(1);
    expect(world.commits.length).toBe(commitsBefore + 1);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
    // The SAME batch — not a rebuilt one. `claimBatch` hands out the
    // first entry that was never removed, so the lease lapsing and the
    // redo picking it up are one mechanism, not two.
    expect(batches).toHaveLength(1);
    expect(batches[0].removed).toBe(true);
  });

  // ── §VIII D — crashes BETWEEN the epilogue's steps ────────────────
  //
  // Phase 6, crash matrix. The epilogue is five durable writes in a
  // fixed order — baselines, conflicts, the hot anchor, the journal's
  // death, the sweep — and the gaps between them are the last places a
  // run can die. They are also the most dangerous, because by this
  // point everything has already been PUSHED: a mistake here cannot
  // lose a commit, it can only make the next run misread what the last
  // one achieved.
  //
  // ⚠️ WHAT THESE CELLS DO *NOT* PROVE, learned by probing them. The
  // obvious claim to write here is "the redo recovers the Vault-step
  // work", and it would be VACUOUS: the Vault-step runs to completion
  // BEFORE the epilogue begins, so at every gap below the vault is
  // already correct and the assertion passes without the redo doing
  // anything. The probe that exposed this made the redo ignore the
  // journal entirely — and the cells stayed green.
  //
  // So the real claims are narrower and worth stating plainly:
  //   • no epilogue gap can lose VAULT work, because there is none
  //     left to lose by then — that is a property of the ORDER, and
  //     the order is what the intermediate assertions pin;
  //   • a redo entered with a half-finished epilogue must be a NO-OP
  //     that finishes it — it must not push, must not revert, and must
  //     bury the journal;
  //   • the journal is still alive at gaps 1→2, 2→3 and 3→4 (it dies
  //     at step 4), and that presence is what stops the next run from
  //     reading a half-finished epilogue as a finished one.
  //
  // Verified by mutation: swapping steps 3 and 4 kills two of the
  // three cells on exactly the assertions that describe the order.
  //
  // 📌 And the journal's own load-bearing role — that a redo RESUMES
  // from it rather than starting blank — is pinned where it belongs,
  // not here: making the drain ignore `journal.load()` fails J.1, J.6,
  // G.8, B.3 and A1 п.24b, and none of these three. Worth knowing so
  // nobody "strengthens" these cells into a duplicate of J.1.
  describe("epilogue crash windows (§III steps 1-5)", () => {
    // ⚠️ THE SCENARIO NEEDS A PUSH, and finding that out was the point
    // of writing these cells. A PULL-ONLY drain never persists the
    // journal at all — only a completed batch does — so on a pull-only
    // run these four gaps have no journal to recover from. They are
    // safe there for a different reason: the Vault-step finishes
    // BEFORE the epilogue starts, so by step 1 there is no vault work
    // left to lose. The gaps only become interesting once a journal
    // exists, i.e. once something was pushed.
    //
    // So: one local edit (push → the journal gets persisted) plus one
    // unrelated remote file (pull → there is Vault-step work the redo
    // could drop).
    const setupPushAndPull = async (): Promise<void> => {
      await setupAligned();
      await stageBatch({ "note.md": "LOCAL\n" });
      vaultFiles.files.set("note.md", { content: "LOCAL\n", mtime: 100 });
      await world.commitFiles({ "pulled.md": "REMOTE V1\n" });
    };

    it("D: crash in the 1→2 gap (baselines written, conflicts not saved) → the redo converges", async () => {
      await setupPushAndPull();
      const d1 = makeDeps();
      let baselinesWritten = false;
      const origSet = d1.baselines.setMany;
      d1.baselines.setMany = async (entries) => {
        baselinesWritten = true;
        return origSet(entries);
      };
      // ⚠️ `d1.conflictStore` IS the shared store, not a copy — the
      // override has to be undone or it would poison the redo (and
      // the redo is the half this cell exists to check).
      const origSave = conflictStore.save.bind(conflictStore);
      conflictStore.save = async (c) => {
        // Only the EPILOGUE's save — the per-batch one has already
        // run by then, and throwing there would be a different cell.
        if (baselinesWritten) throw new Error("power loss in the 1→2 gap");
        return origSave(c);
      };
      try {
        await expect(drainOnce(d1)).rejects.toThrow("1→2 gap");
      } finally {
        conflictStore.save = origSave;
      }

      // The intermediate state: step 1 DID land…
      expect(baselinesWritten).toBe(true);
      expect(baselines.get("pulled.md")!.baselineSha).toBe(
        await sha("REMOTE V1\n"),
      );
      // …and the journal is still there, which is what makes the rest
      // recoverable rather than merely undamaged.
      expect(await journal.load()).not.toBeNull();

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(vaultFiles.files.get("pulled.md")!.content).toBe("REMOTE V1\n");
      expect(await journal.load()).toBeNull(); // step 4 finally ran
    });

    it("D: crash in the 2→3 gap (anchor not moved) → the redo re-reads the same head and converges", async () => {
      await setupPushAndPull();
      const d1 = makeDeps();
      d1.hot.update = async () => {
        throw new Error("power loss in the 2→3 gap");
      };
      await expect(drainOnce(d1)).rejects.toThrow("2→3 gap");

      // The anchor is untouched, so the next discovery asks the SAME
      // question again and must answer it the same way. This is the
      // benign direction by construction: re-reporting a remote change
      // the vault already holds folds to a no-op.
      expect(await journal.load()).not.toBeNull();

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.pushedCommits).toHaveLength(0); // nothing invented
      expect(vaultFiles.files.get("pulled.md")!.content).toBe("REMOTE V1\n");
    });

    it("🔑 D: crash in the 3→4 gap — the anchor MOVED but the journal lived; the redo is a clean no-op that buries it", async () => {
      // The sharpest of the three, because the two durable facts
      // DISAGREE: the anchor says "synced up to here", the journal
      // says "a run died mid-way". Discovery will report nothing (the
      // delta is empty by construction), so the redo runs with the
      // journal as its only description of what happened.
      //
      // The danger here is NOT losing the pull — that landed before
      // the epilogue started. It is the redo deciding to DO something
      // with a state it misreads: pushing the pulled file back as a
      // local edit, or reverting it. A no-op is the only correct
      // outcome, and "no-op" is what the assertions below spell out.
      await setupPushAndPull();
      const d1 = makeDeps();
      // A FAITHFUL fake for this cell: the real hot store persists,
      // so the moved anchor must survive into the next run. The
      // default harness records updates without applying them, which
      // would quietly turn this into the 2→3 cell.
      d1.hot.update = async (f) => {
        if (f.lastSyncCommitSha !== undefined) {
          baseCommit = f.lastSyncCommitSha;
        }
      };
      const origClear = journal.clear.bind(journal);
      journal.clear = async () => {
        throw new Error("power loss in the 3→4 gap");
      };
      try {
        await expect(drainOnce(d1)).rejects.toThrow("3→4 gap");
      } finally {
        journal.clear = origClear;
      }

      // The intermediate state that defines this window — the two
      // durable facts disagreeing, which is the whole point.
      expect(baseCommit).toBe(world.head); // anchor moved…
      expect(await journal.load()).not.toBeNull(); // …journal survived
      // And the pull had ALREADY landed: this is why no epilogue gap
      // can lose vault work, stated as an assertion rather than left
      // for the reader to infer.
      expect(vaultFiles.files.get("pulled.md")!.content).toBe("REMOTE V1\n");
      const headBefore = world.head;
      const commitsBefore = world.commits.length;

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      // A NO-OP, spelled out: nothing pushed, the head did not move,
      // the pulled file was neither reverted nor sent back as if it
      // were a local edit…
      expect(r.pushedCommits).toHaveLength(0);
      expect(world.head).toBe(headBefore);
      expect(world.commits.length).toBe(commitsBefore);
      expect(vaultFiles.files.get("pulled.md")!.content).toBe("REMOTE V1\n");
      expect(baselines.get("pulled.md")!.baselineSha).toBe(
        await sha("REMOTE V1\n"),
      );
      // …and the one thing that WAS owed is now done.
      expect(await journal.load()).toBeNull();
    });

    it("D: crash in the 4→5 gap (journal already dead, sweep never ran) → the NEXT drain's sweep reaps what was left", async () => {
      // The last gap, and the only one that cannot be reached by
      // throwing: `sweepSyncStore` swallows its own errors by design,
      // so a failure there never escapes. Dying in this window means
      // the PROCESS died, and the only thing an outside observer can
      // see afterwards is the effect — the sweep simply did not
      // happen. So the cell stages the effect, not the throw.
      //
      // §IV.2 row 12 is the claim: with the journal gone the next
      // drain's epilogue is a chain of no-ops, and the sweep is the
      // one thing it still performs. ⚠️ Since the owner cancelled the
      // onload sweep (D.22, 2026-10-02) this IS the recovery path —
      // there is no backstop behind it, so it had better work.
      //
      // 📌 What it does NOT pin, measured: the drain sweeps at BOTH
      // boundaries, and deleting the start-of-drain call leaves this
      // cell green — the end-of-drain one reaps the orphan anyway. So
      // read it as "a later drain cleans up", not as a claim about
      // which of the two points did it. S3 covers both points.
      await setupAligned();
      const orphan = await sha("orphan bytes\n");
      await syncStore.saveBlobToSyncStore(orphan, enc("orphan bytes\n"));
      const refs = { queueReferencedShas: async () => new Set<string>() };

      // Drain 1 reaches its end with the sweep never running.
      const d1 = makeDeps(refs);
      const origSweep = syncStore.sweep.bind(syncStore);
      syncStore.sweep = (async () => ({ removed: 0, kept: 0 })) as never;
      try {
        expect((await drainOnce(d1)).status).toBe("ok");
      } finally {
        syncStore.sweep = origSweep;
      }
      // The intermediate state: the journal is gone (step 4 ran) and
      // the orphan is still there (step 5 did not).
      expect(await journal.load()).toBeNull();
      expect(await syncStore.existInSyncStore(orphan)).toBe(true);

      // Drain 2: nothing to push, nothing to pull — and the sweep.
      const r = await drainOnce(makeDeps(refs));
      expect(r.status).toBe("ok");
      expect(r.pushedCommits).toHaveLength(0);
      expect(await syncStore.existInSyncStore(orphan)).toBe(false);
    });
  });

  // ── A1 п.22-25: the drain's half of the .obsidian/ mtime tiebreak ──
  //
  // The pure half lives in diff3.test.ts (the exhaustive sensitivity
  // matrix). This is the SEAM the field defect of 2026-09-23 lived in:
  // _diff3 decides 3.b.e internally and cannot fetch a mtime, Layer 2
  // (§II.13) nulls the remote one by design, and for plain .obsidian/
  // paths nothing put it back — so "newest wins" silently became
  // "remote always wins". Three tests: it works both ways, and it does
  // not start paying for paths that never compare mtimes.

  const obsidianTiebreakSetup = async (opts: {
    localMtime: number;
  }): Promise<{ deps: DrainDeps; infoCalls: string[] }> => {
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    // BOTH sides move away from base → the real collision, 3.b.e.
    world.committedAt += 5000;
    await world.commitFiles({ [OBS]: "REMOTE\n" });
    await stageBatch({ [OBS]: "LOCAL\n" }, opts.localMtime);
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: opts.localMtime });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    return { deps: makeDeps({ client }), infoCalls };
  };

  it("A1 п.22 🔑: LOCAL is newer → local wins, and the drain PAID for the mtime that proves it", async () => {
    // Before the fix this assertion was unreachable: remote.mtime was
    // null at the tiebreak, the null guard sent every such path to
    // remote, and the local edit was overwritten — exactly what the
    // owner's device log showed happening to a freshly-enforced
    // `.obsidian/.gitignore`.
    const { deps, infoCalls } = await obsidianTiebreakSetup({
      localMtime: 1_700_000_900_000, // after the remote commit
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([".obsidian/app.json"]); // fetched ONCE
    expect(vaultFiles.files.get(".obsidian/app.json")!.content).toBe("LOCAL\n");
    expect(dec(world.headFiles().get(".obsidian/app.json")!.bytes)).toBe(
      "LOCAL\n",
    );
  });

  it("A1 п.23: REMOTE is newer → remote wins — the fetch decides the winner, it does not hand it to local", async () => {
    const { deps, infoCalls } = await obsidianTiebreakSetup({
      localMtime: 1_700_000_001_000, // before the remote commit
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([".obsidian/app.json"]);
    expect(vaultFiles.files.get(".obsidian/app.json")!.content).toBe(
      "REMOTE\n",
    );
  });

  it("A1 п.24 (cost): a one-sided .obsidian change pays NOTHING — the fill is gated on the tiebreak, not on the folder", async () => {
    // The lazy fill must not become "fetch a commit for every
    // .obsidian file": enabling `Sync config` puts dozens of them in a
    // single batch, and each fetch is a full round trip. Only a
    // genuine two-sided collision compares mtimes, so only it pays.
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    // Remote stays at base; only the local side moved.
    await stageBatch({ [OBS]: "LOCAL\n" });
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: 100 });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([]); // 3.b.1.a — local wins outright
    expect(dec(world.headFiles().get(OBS)!.bytes)).toBe("LOCAL\n");
  });

  it("A1 п.24b (cost): a remote mtime the journal already carries is NOT re-fetched", async () => {
    // fillRemoteMtime is deliberately callable by any site that might
    // need a mtime, which only stays cheap while it no-ops on a known
    // one. Without that guard every caller becomes a round trip, and a
    // 422 restart re-pays for the whole batch.
    const OBS = ".obsidian/app.json";
    baseCommit = await world.commitFiles({ [OBS]: "base\n" });
    baselines.set(OBS, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    world.committedAt += 5000;
    await world.commitFiles({ [OBS]: "REMOTE\n" });
    await stageBatch({ [OBS]: "LOCAL\n" }, 1_700_000_900_000);
    vaultFiles.files.set(OBS, { content: "LOCAL\n", mtime: 1_700_000_900_000 });

    // A journal from an interrupted run that already learned the
    // remote half — sha matching head, so Layer 2 finds nothing to
    // correct and the mtime it carries survives into the tiebreak.
    const { emptyDrainState } = await import("../../src/sync2/drain-journal");
    const js = (await journal.load()) ?? emptyDrainState();
    js.trackedFiles.set(OBS, {
      base: { path: OBS, sha: await sha("base\n"), size: 5, mtime: 50, blob: null, mode: "", deviceLabel: null },
      remote: { path: OBS, sha: await sha("REMOTE\n"), size: 7, mtime: 1_700_000_005_000, blob: null, mode: "", deviceLabel: null },
      isManualConflict: false,
    });
    await journal.persist(js);

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([]); // the answer was already in hand
    // …and it was actually USED: local is newer, so local wins.
    expect(dec(world.headFiles().get(OBS)!.bytes)).toBe("LOCAL\n");
  });

  it("A1 п.25: the PLUGIN-CORE seam pays for its mtime too — E4's own fix, which had no test until now", async () => {
    // Found by probe while pinning the 3.b.e fix (2026-09-23): deleting
    // the lazy fill from the plugin-dispatch branch left the entire
    // suite green. That fill IS the gate finding E4, whose comment
    // spells out the degeneration it prevents — and nothing was holding
    // it. Same shape as the defect it was written to fix, one branch
    // over. The two sites now share one fillRemoteMtime; this pins the
    // second caller so a future consolidation cannot quietly drop it.
    const CORE = ".obsidian/plugins/somePlugin/main.js";
    baseCommit = await world.commitFiles({ [CORE]: "base\n" });
    baselines.set(CORE, {
      baselineSha: await sha("base\n"),
      mtime: 50,
      size: enc("base\n").byteLength,
    });
    world.committedAt += 5000;
    await world.commitFiles({ [CORE]: "REMOTE\n" });
    await stageBatch({ [CORE]: "LOCAL\n" }, 1_700_000_900_000);
    vaultFiles.files.set(CORE, {
      content: "LOCAL\n",
      mtime: 1_700_000_900_000,
    });

    const infoCalls: string[] = [];
    const client = world.makeClient();
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      infoCalls.push(p);
      return origInfo(p, ref);
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("ok");
    expect(infoCalls).toEqual([CORE]);
    // Local is the newer edit, so it must survive — with a null mtime
    // the tiebreak would have handed this to remote.
    expect(dec(world.headFiles().get(CORE)!.bytes)).toBe("LOCAL\n");
    expect(vaultFiles.files.get(CORE)!.content).toBe("LOCAL\n");
  });

  it("§II.7.1: an EMPTY drain costs exactly ONE request — the head read, and nothing else", async () => {
    // Field measurement 2026-09-23 (the reason §II.7.1 exists): on a
    // clean vault with an unmoved remote the drain was spending FIVE
    // sequential round trips, ~400 ms each, where the 2.x engine spent
    // one. Four carried no information this run could not already have:
    //
    //   2. getBranchHeadSha(<name minted THIS run>)  — cannot exist
    //   3. getGuardedHead() again, in FINALIZE       — unlocked by #2
    //   4. getBranchHeadSha(<the same phantom>)      — unlocked by #2
    //   5. getCommit(head) for a tree the hot pair already stored
    //
    // This is a COST test, so it counts calls rather than asserting on
    // the end state: every regression here is invisible to correctness
    // tests by construction, and a latency-bound path is exactly where
    // "one more little read" accumulates unnoticed.
    await setupAligned();
    baseCommit = world.head;
    const calls: string[] = [];
    const client = world.makeClient();
    for (const m of [
      "getGuardedHead",
      "getBranchHeadSha",
      "getCommit",
      "compareStatus",
      "getBlobFromRepo",
      "getContentsMetadataAtRef",
      "createBlob",
    ] as const) {
      const orig = (client[m] as (...a: unknown[]) => unknown).bind(client);
      (client as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        calls.push(m);
        return orig(...a);
      };
    }
    // The stored anchor already describes this very head, which is what
    // lets the epilogue skip request 5.
    const r = await drainOnce(
      makeDeps({
        client,
        hot: {
          getLastSyncCommitSha: () => baseCommit,
          getLastSyncTreeSha: () => world.commitTrees.get(world.head!)!,
          getConflictBranch: () => null,
          getHeldPluginUpdates: () => ({}),
          update: async (f) => {
            hotUpdates.push(f);
          },
        },
      }),
    );
    expect(r.status).toBe("ok");
    expect(calls).toEqual(["getGuardedHead"]);
    // …and the anchor it writes is still the honest (commit, tree)
    // pair — the saving must not come from writing a skewed one.
    const last = hotUpdates[hotUpdates.length - 1];
    expect(last.lastSyncCommitSha).toBe(world.head);
    expect(last.lastSyncTreeSha).toBe(world.commitTrees.get(world.head!)!);
  });

  it("B.5: remote-only (no batches) → zero pushes, the vault receives R_n, honest read short-circuit", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0);
    expect(vaultFiles.files.get("note.md")!.content).toBe("one\ntwo\nR1\n");
    // L/stat short-circuit: the vault copy matched the baseline pair —
    // resolving this pull required ZERO full vault reads.
    expect(vaultFiles.reads).toBe(0);
  });

  it("B.6/II.3 ending: remote change + local batch in ONE drain → merged push AND the vault gets the merged result", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nREMOTE\n" });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "LOCAL\ntwo\nthree\n",
      mtime: 100,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(1);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nREMOTE\n",
    );
    expect(vaultFiles.files.get("note.md")!.content).toBe(
      "LOCAL\ntwo\nREMOTE\n",
    );
  });

  it("B.8: vault edited DURING the drain (differs from base) + remote change → vault-step diff3 merges into the vault", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });
    // The user edits line 1 while the drain runs (stat differs → full read).
    vaultFiles.files.set("note.md", {
      content: "USER\ntwo\nthree\n",
      mtime: 77,
    });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get("note.md")!.content).toBe("USER\ntwo\nR1\n");
    expect(vaultFiles.reads).toBe(1); // the touched file paid for its read
  });

  it("B.9: file DELETED from the vault during the drain + remote EDITED → MANUAL_CONFLICT verdict, no resurrection, base not advanced", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nR1\n" });
    vaultFiles.files.delete("note.md");

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([
      { path: "note.md", site: "vault-step" },
    ]);
    expect(vaultFiles.files.has("note.md")).toBe(false); // NOT resurrected
    expect(vaultFiles.writes).toEqual([]);
  });

  it("cold start (base=null) + empty repo (head=null): the SEED births the branch; a batch bigger than the seed adds ONE sync commit", async () => {
    // No setupAligned: bare repo, no baselines, fresh vault.
    // ⚠️ RE-DERIVED at THE SWITCH gate (2026-08-31, empirically):
    // Git Data API answers 409 on a repo with no ref, so the FIRST
    // commit can only come from the Contents API seed (drain.ts
    // seedBareRepoWithFile). The seed carries one of our own batch
    // files; the sync commit follows only if the batch holds more.
    await stageBatch({ "hello.md": "first\n", "second.md": "two\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(world.head).not.toBeNull(); // branch born by the seed
    expect(r.pushedCommits).toHaveLength(1); // the remainder
    expect(dec(world.headFiles().get("hello.md")!.bytes)).toBe("first\n");
    expect(dec(world.headFiles().get("second.md")!.bytes)).toBe("two\n");
  });

  it("cold start with a SINGLE-file batch: the seed carries everything → NO redundant sync commit", async () => {
    await stageBatch({ "only.md": "solo\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toEqual([]); // empty-tree check held
    expect(dec(world.headFiles().get("only.md")!.bytes)).toBe("solo\n");
    expect(world.commits).toHaveLength(1); // the seed alone
  });

  // ── P: Layer 2 + lying discovery ─────────────────────────────────

  it("P.2/P.9/P.27: discovery omits a remotely-changed path with a local edit → Layer 2 corrects EXACTLY once, then the normal path (merge)", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // the lie: "nothing changed"
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].path).toBe("note.md");
    // No silent loss: the hidden remote edit survived the push.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nHIDDEN\n",
    );
  });

  it("P.3: the WRONG tracked sha coincides with local.sha → the correction lands BEFORE the short-circuit", async () => {
    await setupAligned();
    const localContent = "LOCAL\ntwo\nthree\n";
    const localSha = await sha(localContent);
    // Poisoned journal from a previous run: remote allegedly == local.
    const state =
      (await journal.load()) ??
      (await import("../../src/sync2/drain-journal")).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: {
        path: "note.md",
        sha: await sha(V0),
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      remote: {
        path: "note.md",
        sha: localSha,
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      isManualConflict: false,
    });
    await journal.persist(state);
    // Truth: remote actually moved to something else entirely.
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // and discovery misses it
    await stageBatch({ "note.md": localContent });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    // Without Layer 2 the short-circuit would record "synced" and the
    // TRUTH content would be clobbered on the next cycle. With it:
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nTRUTH\n",
    );
  });

  it("P.4: path deleted on the server behind discovery's back → corrected to DELETED, local edit wins (4.6.a), file restored by push", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": null }); // deleted remotely
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].actual).toBe(DELETED_SHA_HASH);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nthree\n",
    );
  });

  it("P.6: a Layer-2 correction that turns into MANUAL_CONFLICT → STEP1 verdict, remote content NOT clobbered", async () => {
    await setupAligned();
    // Remote rewrote the SAME line the local batch touches → conflict.
    await world.commitFiles({ "note.md": "CLASH\ntwo\nthree\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts.some((v) => v.site === "step1")).toBe(true);
    // The conflicted path was NOT pushed — remote keeps its content.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "CLASH\ntwo\nthree\n",
    );
  });

  it("P.7: NETWORK_ERROR during the Layer-2 call → propagates as a drain-level network-error, never swallowed", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    client.getContentsMetadataAtRef = async () => {
      throw new NetworkError("net down");
    };
    const r = await drainOnce(
      makeDeps({
        client,
        retry: new NetworkRetry({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          maxAttempts: 2,
          sleep: async () => {},
        }),
      }),
    );
    expect(r.status).toBe("network-error");
    expect(world.commits.length).toBe(1); // nothing pushed
  });

  it("P.10 (parameterized): N paths, N runs each omitting ONE from discovery → no remote content is ever lost silently", async () => {
    for (const victim of ["a.md", "b.md", "c.md"]) {
      const w = new FakeWorld();
      const store = new SyncStore({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
      });
      const j = new DrainJournal({
        vault: vault as never,
        selfPluginId: `${PLUGIN_ID}-${victim}`,
      });
      const vf = new FakeVaultFiles();
      const bl = new Map<
        string,
        { baselineSha: string; mtime: number; size: number }
      >();
      const base: Record<string, string> = {};
      for (const p of ["a.md", "b.md", "c.md"]) {
        base[p] = `${p}: one\ntwo\nthree\n`;
      }
      const c0 = await w.commitFiles(base);
      for (const p of Object.keys(base)) {
        bl.set(p, {
          baselineSha: (await sha(base[p]))!,
          mtime: 50,
          size: enc(base[p]).byteLength,
        });
        vf.files.set(p, { content: base[p], mtime: 50 });
      }
      // Remote edits ALL THREE; discovery omits the victim.
      const remote: Record<string, string> = {};
      for (const p of Object.keys(base)) {
        remote[p] = `${p}: one\ntwo\nREMOTE\n`;
      }
      await w.commitFiles(remote);
      // Local batch edits all three too (line 1).
      const localBatchEntries: BatchEntry[] = [];
      for (const p of Object.keys(base)) {
        const content = `${p}: LOCAL\ntwo\nthree\n`;
        const s = await sha(content);
        await store.saveBlobToSyncStore(s, enc(content));
        localBatchEntries.push({
          path: p,
          sha: s,
          size: enc(content).byteLength,
          mtime: 100, deletedSha: null
        });
      }
      let removed = false;
      const r = await drainOnce(
        makeDeps({
          client: w.makeClient(),
          syncStore: store,
          journal: j,
          vaultFiles: vf,
          baselines: {
            get: async (p) => bl.get(p),
            listUnder: async (prefix: string) =>
              [...bl]
                .filter(([p]) => p.startsWith(prefix))
                .map(([path, b]) => ({ path, ...b })),
            setMany: async (entries) => {
              for (const e of entries) {
                bl.set(e.path, {
                  baselineSha: e.baselineSha,
                  mtime: e.mtime,
                  size: e.size,
                });
              }
            },
            removeMany: async (paths) => {
              for (const p of paths) bl.delete(p);
            },
          },
          hot: {
            getLastSyncCommitSha: () => c0,
            getLastSyncTreeSha: () => null,
            getConflictBranch: () => null,
            getHeldPluginUpdates: () => ({}),
            update: async () => {},
          },
          conflictStore: new ConflictStoreV2({
            vault: vault as never,
            selfPluginId: `${PLUGIN_ID}-${victim}`,
          }),
          siblingTx: new SiblingTx({
            vault: vault as never,
            selfPluginId: `${PLUGIN_ID}-${victim}`,
            store: new ConflictStoreV2({
              vault: vault as never,
              selfPluginId: `${PLUGIN_ID}-${victim}`,
            }),
            computeSha: calculateGitBlobSHA,
          }),
          claimBatch: async () =>
            removed
              ? null
              : {
                  id: "b1",
                  dir: "queue/b1",
                  meta: {
                    v: 1,
                    id: "b1",
                    createdAt: 0,
                    entries: localBatchEntries,
                  },
                },
          removeBatchDir: async () => {
            removed = true;
          },
          discoverChangedFiles: async (b, h) => {
            const honest = await (async () => {
              const out: RemoteFileChange[] = [];
              for (const [p, f] of w.filesAt(h)) {
                const bf = b === null ? null : (w.filesAt(b).get(p) ?? null);
                if (bf?.sha === f.sha) continue;
                out.push({
                  path: p,
                  sha: f.sha,
                  size: f.bytes.byteLength,
                  mtime: null,
                  deleted: false,
                });
              }
              return out;
            })();
            return {
              changes: honest.filter((c) => c.path !== victim),
              tree: null,
            };
          },
        }),
      );
      expect(r.status).toBe("ok");
      expect(r.layer2Corrections.map((c) => c.path)).toEqual([victim]);
      for (const p of Object.keys(base)) {
        expect(dec(w.headFiles().get(p)!.bytes)).toBe(
          `${p}: LOCAL\ntwo\nREMOTE\n`,
        );
      }
    }
  });

  it("P.11 (subtlest, two drains): omission + sha coincidence → the SECOND drain must not clobber the truth", async () => {
    await setupAligned();
    const localContent = "LOCAL\ntwo\nthree\n";
    const localSha = await sha(localContent);
    const state = (
      await import("../../src/sync2/drain-journal")
    ).emptyDrainState();
    state.trackedFiles.set("note.md", {
      base: {
        path: "note.md",
        sha: await sha(V0),
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      remote: {
        path: "note.md",
        sha: localSha,
        size: 1,
        mtime: 1,
        blob: null,
        mode: "",
        deviceLabel: null,
      },
      isManualConflict: false,
    });
    await journal.persist(state);
    await world.commitFiles({ "note.md": "one\ntwo\nTRUTH\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": localContent });

    const r1 = await drainOnce(makeDeps());
    expect(r1.status).toBe("ok");
    // Drain 2 with an honest discovery: whatever drain 1 recorded must
    // not lead to a clobber now.
    discoveryOverride = null;
    baseCommit = world.commits[0];
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toContain("TRUTH");
  });

  it("P.12 (coverage boundary, EXPECTED): a remote-only change omitted by discovery — no batch entry → Layer 2 never sees it", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nUNSEEN\n" });
    discoveryOverride = async () => ({ changes: [], tree: null }); // omitted, and no local batch
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.layer2Corrections).toEqual([]); // documented limit, not a bug:
    expect(vaultFiles.files.get("note.md")!.content).toBe(V0); // pull lost until Layer 1 is honest
  });

  it("P.28/P.29: happy path → layer2Corrections EMPTY; the counter is run-scoped (fresh per drain)", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const r1 = await drainOnce(makeDeps());
    expect(r1.layer2Corrections).toEqual([]);
    baseCommit = world.head;
    const r2 = await drainOnce(makeDeps());
    expect(r2.layer2Corrections).toEqual([]);
    expect(r1).not.toBe(r2);
  });

  // ── L: sequential per-file + read counts ─────────────────────────

  it("L.1: files inside a batch are processed strictly sequentially, progress counts by file", async () => {
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });
    await drainOnce(makeDeps());
    expect(progressLog).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  // ── §II.16: the two progress counters ────────────────────────────

  it("§II.16: the push total GROWS batch by batch — 3, then 3+5 — because the run learns of work as it goes", async () => {
    // The user's own reading of the design, pinned: a thousand files in
    // ten batches counts 100/100 → 101/200 → … and that is correct.
    // The drain cannot know the queue's depth in files, and inventing a
    // total would be a guess dressed as knowledge. The status bar's
    // falling "↑ N" is what tells the user more batches are coming.
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });
    await stageBatch({
      "d.md": "D\n",
      "e.md": "E\n",
      "f.md": "F\n",
      "g.md": "G\n",
      "h.md": "H\n",
    });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    expect(snaps.map((p) => [p.pushDone, p.pushTotal])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 8], // the second batch arrives — the total grows, done keeps going
      [5, 8],
      [6, 8],
      [7, 8],
      [8, 8],
    ]);
  });

  it("§II.16 🔑: a 422 restart ROLLS the push counters BACK — it never inflates them", async () => {
    // Owner decision 2026-09-25, and the argument is about fear, not
    // arithmetic: someone who changed three files and sees six will
    // conclude the plugin is sending something they did not ask for.
    // A count that visibly restarts is less alarming than one that
    // doubles.
    await setupAligned();
    await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });

    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let failures = 0;
    client.pushCommitFromTree = async (args) => {
      if (failures === 0) {
        failures += 1;
        await world.commitFiles({ "other.md": "raced\n" });
        throw new ValidationError("422: head moved");
      }
      return origPush(args);
    };

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ client, onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    const pushes = snaps.map((p) => [p.pushDone, p.pushTotal]);
    // Three files, one restart: the count runs 1..3, goes back to the
    // pre-batch values, and runs 1..3 again. It NEVER reaches 4 or a
    // total of 6.
    expect(pushes).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
      [1, 3], // ← the restart put them back; it did NOT continue to 4
      [2, 3],
      [3, 3],
      [3, 3], // the Vault-step's PULL tick for the raced file, below
    ]);
    // Never inflated: neither number ever exceeded the three files the
    // user actually changed.
    expect(Math.max(...snaps.map((p) => p.pushDone))).toBe(3);
    expect(Math.max(...snaps.map((p) => p.pushTotal))).toBe(3);
    // The seventh snapshot is the other side reporting: the commit this
    // test raced in is a remote change, so it counts as one pull.
    expect(snaps[snaps.length - 1].pullDone).toBe(1);
  });

  it("§II.16: one remote change is ONE pull unit, even when the path is also in the batch", async () => {
    // _diff3 runs for ordinary paths in TWO places (the batch loop and
    // the Vault-step), and a path present in both would be counted
    // twice without the guard — the counter would overshoot its own
    // total, which is the one thing a progress display must never do.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nREMOTE\n" });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
    vaultFiles.files.set("note.md", {
      content: "LOCAL\ntwo\nthree\n",
      mtime: 100,
    });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    const last = snaps[snaps.length - 1];
    expect([last.pullDone, last.pullTotal]).toEqual([1, 1]);
  });

  it("L/stat short-circuit: only files with a REAL divergence pay for a vault read (advisor 2026-08-30 — no O(vault) re-hash)", async () => {
    // 5 aligned files; remote changes ONE; the user touches NONE.
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.md`] = `content ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    await world.commitFiles({ "f3.md": "content 3 CHANGED\n" });
    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get("f3.md")!.content).toBe("content 3 CHANGED\n");
    // The four untouched files resolved via stat alone.
    expect(vaultFiles.reads).toBe(0);
  });

  // ── E п.1-5: one wrapper test ────────────────────────────────────

  it("E: transient NetworkError on the head read is retried by the injected NetworkRetry and the drain succeeds", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    const origHead = client.getGuardedHead.bind(client);
    let failures = 0;
    client.getGuardedHead = async () => {
      if (failures < 2) {
        failures += 1;
        throw new NetworkError("flaky");
      }
      return origHead();
    };
    let sleeps = 0;
    const r = await drainOnce(
      makeDeps({
        client,
        retry: new NetworkRetry({
          vault: vault as never,
          selfPluginId: PLUGIN_ID,
          sleep: async () => {
            sleeps += 1;
          },
        }),
      }),
    );
    expect(r.status).toBe("ok");
    expect(sleeps).toBe(2); // retried, not failed through
    expect(r.pushedCommits).toHaveLength(1);
  });

  it("422-CAP (I6): five consecutive 422s with no success → clean too-many-concurrent-pushes exit, queue intact", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    client.pushCommitFromTree = async () => {
      // Every push races an external commit.
      await world.commitFiles({ "other.md": `x${world.commits.length}\n` });
      throw new ValidationError("422: head moved");
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(r.status).toBe("too-many-concurrent-pushes");
    expect(batches[0].removed).toBe(false); // the batch survives for the next run
    // D.16 extended to the durable conflicts (W1 fix, 2026-09-20): the
    // CAP exit persists none of the FAILED ATTEMPT's state. The new
    // store-then-journal pair sits at the batch END, which a CAP exit
    // never reaches — pinned here so a future "just save it
    // defensively" cannot poison the store. Since §II.7.1 the journal
    // is ABSENT entirely: the CLEAN early write this used to assert on
    // was the branch-name mint's, and a run with no conflict no longer
    // mints. Absence is the stronger form of the same invariant, so
    // the assertion reads "nothing of the failed attempt persisted",
    // whether or not a file exists.
    expect((await journal.load())?.trackedFiles.size ?? 0).toBe(0);
    expect((await conflictStore.load()).entries.size).toBe(0);
  });

  // ── §VIII K.2 — the CAP is counted in THREE places, not one ──────
  //
  // Phase 6. The test above drives the third site (the commit push).
  // The counter is also incremented, and the ceiling also checked, at
  // two earlier points — both of them a `createTree` 422 rather than a
  // commit 422:
  //
  //   1. the MID-LOOP flush, when the accumulator crosses
  //      MAX_INLINE_BYTES while files are still being added (§II.15);
  //   2. the END-of-batch flush, just before the commit.
  //
  // Each has its OWN `return result("too-many-concurrent-pushes")` and
  // its own "NO persist here (D.16)" comment. Three copies of one rule
  // is three chances for one of them to drift — most plausibly by
  // someone adding a defensive `journal.persist` to just one, which is
  // precisely the thing D.16 forbids and which no existing test would
  // have caught at two of the three sites.
  //
  // ⚠️ Why these stay UNIT and do not become integration cells: by the
  // agreed criterion an integration cell earns its cost only where the
  // fake world and real GitHub can DISAGREE. Five consecutive 422s
  // cannot be provoked from a real server on demand — an integration
  // version would synthesize the 422 responses through the fault
  // injector, i.e. fake exactly the thing under test, while paying real
  // network time for the rest. The behaviour being pinned (counting,
  // the ceiling, what is NOT written) is pure local logic.
  const capInvariants = async (r: { status: string }): Promise<void> => {
    expect(r.status).toBe("too-many-concurrent-pushes");
    expect(batches[0].removed).toBe(false); // the work survives
    // D.16: a CAP exit must look exactly like a crash just before the
    // failed batch — none of the failed attempt's state reaches disk.
    expect((await journal.load())?.trackedFiles.size ?? 0).toBe(0);
    expect((await conflictStore.load()).entries.size).toBe(0);
  };

  it("422-CAP site 2/3: the END-of-batch tree flush 422s five times → the same clean exit", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    let treeCalls = 0;
    client.createTree = async () => {
      treeCalls += 1;
      throw new ValidationError("422: base_tree moved");
    };
    const r = await drainOnce(makeDeps({ client }));
    // Exactly the ceiling, not one more: the fifth failure returns
    // instead of restarting, so a sixth attempt never happens.
    expect(treeCalls).toBe(5);
    await capInvariants(r);
  });

  it("422-CAP site 1/3: a MID-LOOP flush 422s five times → the same clean exit", async () => {
    // The accumulator flushes on its own once the inlined bytes cross
    // MAX_INLINE_BYTES (1 MB), i.e. while the per-file loop is still
    // running — a different code path from the two flushes at the end,
    // with its own restart flag (`restartFromFlush`).
    await setupAligned();
    const big = `${"x".repeat(1_100_000)}\n`;
    await stageBatch({ "big.md": big });
    vaultFiles.files.set("big.md", { content: big, mtime: 100 });
    const client = world.makeClient();
    let treeCalls = 0;
    client.createTree = async () => {
      treeCalls += 1;
      throw new ValidationError("422: head moved mid-flush");
    };
    const r = await drainOnce(makeDeps({ client }));
    expect(treeCalls).toBe(5);
    await capInvariants(r);
  });

  // ── DOT-FILES §8.0 — the seeded .gitignore as its own ancestor ────
  //
  // The engine half of the fix. `enforce()` writes the managed
  // .gitignore files BEFORE any sync, so on a cold start our own write
  // would meet the repo's version with no common base and rule 4.2
  // would call it a manual conflict the user never caused. A file that
  // is byte-identical to what we seed is marked, and the marker lets
  // that content serve as the path's own base.

  it("§8.0: a MARKED local file adopts the remote version instead of conflicting", async () => {
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", {
      baselineSha: await sha("n\n"),
      mtime: 1,
      size: 2,
    });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    // The repo already carries its own .gitignore…
    await world.commitFiles({ ".gitignore": "# repo\n*.tmp\n" });
    // …and enforce() has just seeded ours, which the commit pass
    // queued. No baseline for it: this is the first meeting.
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });
    const oursSha = await sha(OURS);

    const r = await drainOnce(
      makeDeps({
        gitignoreSeeds: { matches: (p, s2) => p === ".gitignore" && s2 === oursSha },
      }),
    );

    expect(r.status).toBe("ok");
    expect(r.conflictVerdicts).toEqual([]); // the whole point
    // Clean pull: the repo's version wins and lands in the vault.
    expect(vaultFiles.files.get(".gitignore")!.content).toBe("# repo\n*.tmp\n");
  });

  it("§8.0: the SAME state without a marker conflicts — the marker is what changes the answer", async () => {
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", { baselineSha: await sha("n\n"), mtime: 1, size: 2 });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    await world.commitFiles({ ".gitignore": "# repo\n*.tmp\n" });
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });

    const r = await drainOnce(makeDeps()); // no seeds view at all

    expect(r.status).toBe("ok");
    // Recorded at more than one site (STEP1 + the Vault-step) — the
    // point is that the path conflicts at all.
    expect([...new Set(r.conflictVerdicts.map((v) => v.path))]).toEqual([
      ".gitignore",
    ]);
  });

  it("§8.0: a marked file with NO remote counterpart is still PUSHED — the ancestor must not fire", async () => {
    // The trap: base := local with remote == null is handled by no
    // rule (2.a/2.b need matching nullness, 4.3-4.6 need
    // local.sha !== base.sha), so it would fall into the merge path
    // with a null remote. The right answer stays base == null →
    // 4.1.a → push ours.
    baseCommit = await world.commitFiles({ "note.md": "n\n" });
    baselines.set("note.md", { baselineSha: await sha("n\n"), mtime: 1, size: 2 });
    vaultFiles.files.set("note.md", { content: "n\n", mtime: 1 });
    const OURS = "# ours\n*.log\n";
    await stageBatch({ ".gitignore": OURS });
    vaultFiles.files.set(".gitignore", { content: OURS, mtime: 100 });
    const oursSha = await sha(OURS);

    const r = await drainOnce(
      makeDeps({
        gitignoreSeeds: { matches: (p, s2) => p === ".gitignore" && s2 === oursSha },
      }),
    );

    expect(r.status).toBe("ok");
    expect(dec(world.headFiles().get(".gitignore")!.bytes)).toBe(OURS);
  });

  // ── D: the epilogue (§III steps 1-4) ─────────────────────────────

  it("D.13: baseline transfer — final remote sha with the mtime:0 sentinel; deleted paths LEAVE the baselines; journal dies", async () => {
    await setupAligned();
    // Real mtimes in the batch — they must NOT leak into the baseline.
    await stageBatch({ "new.md": "N\n", "note.md": null }, 1234);

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // mtime:0 on purpose: a user edit DURING the drain with an equal
    // size must not short-circuit invisibly forever; the detector
    // self-heals with exactly one re-hash.
    expect(baselines.get("new.md")).toEqual({
      baselineSha: await sha("N\n"),
      mtime: 0,
      size: enc("N\n").byteLength,
    });
    expect(baselines.has("note.md")).toBe(false); // pushed deletion → removed
    // The journal's absence is the 'previous drain finished' signal.
    expect(await journal.load()).toBeNull();
  });

  it("D.14: placeholder guard — an idle lingering conflict (remote.sha null) transfers NOTHING; the real previous baseline survives", async () => {
    await setupAligned();
    const lockedSha = await sha("L\n");
    const durable = await conflictStore.load();
    durable.entries.set("locked.md", {
      conflictBase: {
        path: "locked.md",
        sha: lockedSha,
        size: 2,
        mtime: 10,
        blob: null,
        mode: "" as const,
        deviceLabel: "other-device",
      },
      siblings: [], // I.7: an empty siblings list is still a conflict
    });
    await conflictStore.save(durable);
    baselines.set("locked.md", { baselineSha: lockedSha, mtime: 10, size: 2 });
    await stageBatch({ "other.md": "O\n" }); // unrelated work

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // The conflict path was seeded as a placeholder tracked record
    // ({sha:null}); writing its nulls would ERASE the real baseline.
    expect(baselines.get("locked.md")).toEqual({
      baselineSha: lockedSha,
      mtime: 10,
      size: 2,
    });
  });

  it("D.15: pull-only drain → the hot anchor (commit, tree) pair is aligned via one getCommit, never a stale-tree skew", async () => {
    await setupAligned();
    const c1 = await world.commitFiles({ "note.md": "R\n" }); // remote-only

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    expect(r.pushedCommits).toHaveLength(0); // nothing pushed → tree unknown in-run
    const last = hotUpdates[hotUpdates.length - 1];
    expect(last.lastSyncCommitSha).toBe(c1);
    expect(last.lastSyncTreeSha).toBe(world.commitTrees.get(c1)!);
    expect(last.conflictBranchName).toBeNull();
    expect(await journal.load()).toBeNull();
  });

  it("D.16: a CAP exit runs NO epilogue and never persists the failed attempt's state; the redo lands the batch", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    let sabotage = true;
    client.pushCommitFromTree = async (args) => {
      if (sabotage) {
        await world.commitFiles({ "other.md": `x${world.commits.length}\n` });
        throw new ValidationError("422: head moved");
      }
      return origPush(args);
    };

    const r1 = await drainOnce(makeDeps({ client }));
    expect(r1.status).toBe("too-many-concurrent-pushes");
    // The CAP exit must look exactly like a crash BEFORE the failed
    // batch: no persist of the dirty in-memory state. Here nothing
    // completed, so no journal exists at all. (RED without the fix:
    // the poisoned journal claims base==remote==C1 → the redo
    // short-circuits the batch and C1 is silently lost.)
    const j1 = await journal.load();
    expect(j1?.trackedFiles.get("note.md")?.remote.sha ?? null).not.toBe(
      await sha("C1\n"),
    );
    expect(hotUpdates).toEqual([]); // no CONFIRMED anchor from an abort
    expect(baselines.get("note.md")!.mtime).toBe(50); // untouched

    sabotage = false;
    const r2 = await drainOnce(makeDeps({ client }));
    expect(r2.status).toBe("ok");
    expect(r2.pushedCommits).toHaveLength(1); // the redo actually lands C1
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
    expect(baselines.get("note.md")).toEqual({
      baselineSha: await sha("C1\n"),
      mtime: 0,
      size: enc("C1\n").byteLength,
    });
    expect(hotUpdates[hotUpdates.length - 1].lastSyncCommitSha).toBe(
      world.head,
    );
    expect(await journal.load()).toBeNull();
  });

  // ── S1 (Phase 5.5 step 4 prep): cancel / per-batch identity /
  //    vault-step reporting / confirmDeleted / forbidden-name port ──

  it("S1 cancel: a batch-boundary cancel exits with 'cancelled' and persists NOTHING (D.16 rule) — the redo lands the batch", async () => {
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });
    let cancelled = true;
    const deps = makeDeps({ cancelRequested: () => cancelled });

    const r1 = await drainOnce(deps);
    expect(r1.status).toBe("cancelled");
    expect(batches[0].removed).toBe(false); // queue intact
    expect(await journal.load()).toBeNull(); // nothing persisted
    expect(hotUpdates).toEqual([]); // no anchor from a cancel
    expect(baselines.get("note.md")!.mtime).toBe(50); // untouched

    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  // Owner's field report (2026-10-10, a phone's first pull, cancelled mid
  // Vault-step): the NEXT sync's commit pass found 345 "added" files — the
  // ones the cancelled drain had already written. Their baselines are only
  // written by the epilogue, which a cancel skips, so to the commit pass
  // (which runs BEFORE the resuming drain and knows no journal) they looked
  // like local additions. A file the Vault-step has already written IS in
  // sync with the remote: its baseline is settled at the cancel. The anchor
  // still does NOT move — the resume still comes from rediscovery.
  it("S1 cancel (Vault-step): the files ALREADY written get their baselines; the rest keep the old ones; no anchor", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, { baselineSha: await sha(content), mtime: 50, size: enc(content).byteLength });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2, // cancel after the 2nd written file
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    expect(r1.vaultStepWrites).toHaveLength(2);
    for (const p of r1.vaultStepWrites) {
      const content = remoteEdits[p];
      expect(baselines.get(p)?.baselineSha).toBe(await sha(content)); // settled
    }
    for (let i = 0; i < 4; i++) {
      const p = `p${i}.md`;
      if (r1.vaultStepWrites.includes(p)) continue;
      expect(baselines.get(p)?.baselineSha).toBe(await sha(files[p])); // untouched
    }
    expect(hotUpdates).toEqual([]); // the anchor stays — the resume rediscovers
  });

  // Field (2026-10-10, phone): the first pull was cancelled after it had
  // written test.md (X); meanwhile another device pushed test.md = Y. The
  // resumed drain made a CONFLICT — nothing was edited on the phone, so it
  // must be a clean pull of Y.
  it("S1 cancel (Vault-step) on a COLD START (new device) + the remote moves on → a CLEAN pull, no conflict", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(files);
    baseCommit = null; // a new device: never synced, no baselines, empty vault

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    const written = r1.vaultStepWrites[0];
    await world.commitFiles({ [written]: "REMOTE AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(written)!.content).toBe("REMOTE AGAIN\n");
  });

  // Field (2026-10-10, phone): after a cancelled first sync the next commit
  // pass re-committed the 7 local files the cancelled run had ALREADY
  // pushed. Their batch was consumed and removed at the batch end, and
  // their baselines were never written (only the epilogue writes them),
  // so the commit pass took them for new additions. A path whose outcome
  // the run already fixed (base == remote: pushed, equal to the remote,
  // or pulled) gets its baseline at the cancel, like the pulled ones.
  it("S1 cancel (Vault-step): a local file the run ALREADY PUSHED gets its baseline too", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(files);
    baseCommit = null;
    vaultFiles.files.set("local.md", { content: "LOCAL\n", mtime: 100 });
    await stageBatch({ "local.md": "LOCAL\n" });

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    expect(r1.pushedCommits).toHaveLength(1);
    expect(batches[0].removed).toBe(true); // the queue no longer holds it
    expect(baselines.get("local.md")?.baselineSha).toBe(await sha("LOCAL\n"));
    // A path the Vault-step had NOT reached is not settled.
    const notYet = Object.keys(files).find((p) => !r1.vaultStepWrites.includes(p))!;
    expect(baselines.has(notYet)).toBe(false);
  });

  // The field shape the two tests above missed: the phone's first sync
  // ALSO had local additions (its own .obsidian files). With a local batch
  // the drain persists its journal at the batch end — BEFORE the
  // Vault-step — so the journal holds test.md as "no common record"
  // (base null, a cold start). The resume restores that journal; the new
  // remote version only refreshes the remote half, the stale base null
  // survives, and the initial-download rule turns a file this device had
  // just pulled into a manual conflict.
  it("S1 cancel (Vault-step) on a COLD START with LOCAL additions + the remote moves on → a CLEAN pull, no conflict", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(files);
    baseCommit = null; // a new device: never synced, no baselines
    vaultFiles.files.set("local.md", { content: "LOCAL\n", mtime: 100 });
    await stageBatch({ "local.md": "LOCAL\n" });

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    expect(await journal.load()).not.toBeNull(); // the field shape: a journal survives
    const written = r1.vaultStepWrites.find((p) => p !== "local.md")!;
    await world.commitFiles({ [written]: "REMOTE AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(written)!.content).toBe("REMOTE AGAIN\n");
  });

  it("S1 cancel (Vault-step) WARM with LOCAL additions + the remote moves on → a CLEAN pull, no conflict", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, { baselineSha: await sha(content), mtime: 50, size: enc(content).byteLength });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);
    vaultFiles.files.set("local.md", { content: "LOCAL\n", mtime: 100 });
    await stageBatch({ "local.md": "LOCAL\n" });

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    expect(await journal.load()).not.toBeNull();
    const written = r1.vaultStepWrites.find((p) => p !== "local.md")!;
    await world.commitFiles({ [written]: "REMOTE AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(written)!.content).toBe("REMOTE AGAIN\n");
  });

  // The same hole for a DELETION the cancelled Vault-step had already
  // applied: the journal still says base = the old content, the vault no
  // longer has the file, and the remote brings it back.
  it("S1 cancel (Vault-step) WARM with LOCAL additions: an APPLIED remote deletion + the remote re-adds the file → a CLEAN pull", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, { baselineSha: await sha(content), mtime: 50, size: enc(content).byteLength });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const dels: Record<string, null> = {};
    for (let i = 0; i < 4; i++) dels[`p${i}.md`] = null;
    await world.commitFiles(dels);
    vaultFiles.files.set("local.md", { content: "LOCAL\n", mtime: 100 });
    await stageBatch({ "local.md": "LOCAL\n" });

    let removes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => removes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "remove") {
              return async (...args: unknown[]) => {
                removes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).remove(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    expect(await journal.load()).not.toBeNull();
    const removed = r1.vaultStepRemoves[0];
    expect(vaultFiles.files.has(removed)).toBe(false);
    await world.commitFiles({ [removed]: "BACK AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(removed)!.content).toBe("BACK AGAIN\n");
  });

  // The vault decides, not the journal alone: a file the cancelled run
  // had NOT reached yet still holds the OLD content, so its journal base
  // is still true — taking the journal's remote as the base there would
  // turn an untouched file into a three-way conflict.
  it("S1 cancel (Vault-step) WARM with LOCAL additions: a file NOT yet pulled keeps its old base → a CLEAN pull of the newest version", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, { baselineSha: await sha(content), mtime: 50, size: enc(content).byteLength });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);
    vaultFiles.files.set("local.md", { content: "LOCAL\n", mtime: 100 });
    await stageBatch({ "local.md": "LOCAL\n" });

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    const notYet = Object.keys(files).find((p) => !r1.vaultStepWrites.includes(p))!;
    expect(vaultFiles.files.get(notYet)!.content).toBe(files[notYet]); // still the old one
    await world.commitFiles({ [notYet]: "REMOTE AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(notYet)!.content).toBe("REMOTE AGAIN\n");
  });

  it("S1 cancel (Vault-step) + the remote moves on before the resume → a CLEAN pull, no conflict", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, { baselineSha: await sha(content), mtime: 50, size: enc(content).byteLength });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);

    let writes = 0;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => writes >= 2,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                writes++;
                return (t as unknown as Record<string, (...a: unknown[]) => unknown>).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    const written = r1.vaultStepWrites[0];
    // Another device changes the SAME already-pulled file again.
    await world.commitFiles({ [written]: "REMOTE AGAIN\n" });

    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(r2.conflictVerdicts).toEqual([]);
    expect(vaultFiles.files.get(written)!.content).toBe("REMOTE AGAIN\n");
  });

  it("S1 cancel 🔑 (Vault-step): a pull-heavy drain stops mid-loop, keeps the journal, and the NEXT drain finishes the job", async () => {
    // The gap found 2026-09-26: the Vault-step had no cancel check, and
    // it is the phase where the user actually waits on a big pull —
    // every pulled file is written here. [Cancel sync] did nothing
    // until the whole loop drained.
    //
    // The point of this test is NOT that it exits. It is that exiting
    // COSTS NOTHING: the journal survives, and a second drain lands
    // every file. If that were false, cancellation would be a way to
    // corrupt a sync, and the button would have to go.
    const files: Record<string, string> = {};
    for (let i = 0; i < 4; i++) files[`p${i}.md`] = `base ${i}\n`;
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    // Remote moves every one of them — a pure pull, so ALL the work is
    // in the Vault-step and none of it in a batch.
    const remoteEdits: Record<string, string> = {};
    for (let i = 0; i < 4; i++) remoteEdits[`p${i}.md`] = `REMOTE ${i}\n`;
    await world.commitFiles(remoteEdits);

    // Cancel once the Vault-step has written its first file.
    let cancelled = false;
    const r1 = await drainOnce(
      makeDeps({
        cancelRequested: () => cancelled,
        vaultFiles: new Proxy(vaultFiles, {
          get(t, prop, recv) {
            if (prop === "write") {
              return async (...args: unknown[]) => {
                cancelled = true; // the user clicks [Cancel sync] now
                return (
                  t as unknown as Record<string, (...a: unknown[]) => unknown>
                ).write(...args);
              };
            }
            return Reflect.get(t, prop, recv);
          },
        }) as unknown as typeof vaultFiles,
      }),
    );
    expect(r1.status).toBe("cancelled");
    // Partial by construction — that is what makes the resume the
    // interesting half.
    expect(r1.vaultStepWrites.length).toBeLessThan(4);
    // 🔑 THE invariant that makes cancelling safe here. A pure pull
    // writes no journal at all (only a completed batch does), so the
    // resume does not come from stored state — it comes from the next
    // drain REDISCOVERING the same remote changes. That only works
    // while the anchor still points at the old commit. Had the
    // epilogue run and advanced it, the next drain would believe it
    // was up to date and the unwritten files would be lost silently.
    expect(hotUpdates).toEqual([]);
    expect(await journal.load()).toBeNull(); // nothing to persist, by design

    // The resume: every file lands, and the run completes normally.
    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    for (let i = 0; i < 4; i++) {
      expect(vaultFiles.files.get(`p${i}.md`)!.content).toBe(`REMOTE ${i}\n`);
    }
    // …and THIS run did confirm itself: the anchor finally moved.
    expect(hotUpdates.length).toBeGreaterThan(0);
    expect(hotUpdates[hotUpdates.length - 1].lastSyncCommitSha).toBe(
      world.head,
    );
  });

  it("S1 cancel 🔑 (push boundary): a click during the 4-second push stretch is NOT lost", async () => {
    // Field report 2026-09-26: [Cancel sync] appeared to do nothing.
    // The per-file loop is LOCAL and finishes in milliseconds; the
    // stretch the user actually waits through is flush → commit → ref
    // move (~3-4 s on the owner's device), and it had no checkpoint at
    // all. A click landing there was silently dropped and the drain ran
    // to completion.
    await setupAligned();
    await stageBatch({ "note.md": "C1\n" });

    // The click lands WHILE the files are being processed — i.e. after
    // the loop's own check for this entry has already passed. The old
    // code then went straight into the push and ignored it entirely.
    let cancelled = false;
    const r = await drainOnce(
      makeDeps({
        onProgress: () => {
          cancelled = true;
        },
        cancelRequested: () => cancelled,
      }),
    );
    // Without the checkpoint this returns "ok" and the ref has moved.
    expect(r.status).toBe("cancelled");
    expect(r.pushedCommits).toEqual([]);
    expect(batches[0].removed).toBe(false); // the batch waits for the redo
    expect(hotUpdates).toEqual([]); // nothing confirmed

    // And the redo lands it — cancelling cost only the time already spent.
    cancelled = false;
    const r2 = await drainOnce(makeDeps());
    expect(r2.status).toBe("ok");
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  it("S1 message+author: main push carries the BATCH's createdAt (message AND author.date); merge/conflict use now()", async () => {
    await setupAligned();
    const CREATED = 1_777_000_123_000;
    await stageBatch({ "note.md": "C1\n" }, 100, CREATED);

    const messageArgs: number[] = [];
    const pushedAuthors: Array<unknown> = [];
    const client = world.makeClient();
    const origPush = client.pushCommitFromTree.bind(client);
    client.pushCommitFromTree = async (args) => {
      pushedAuthors.push((args as { author?: unknown }).author);
      return origPush(args);
    };
    const r = await drainOnce(
      makeDeps({
        client,
        commitMessage: (whenMs: number) => {
          messageArgs.push(whenMs);
          return `Sync at ${whenMs} (test-device)`;
        },
        gitAuthor: () => ({ name: "Vlad", email: "v@x" }),
      }),
    );
    expect(r.status).toBe("ok");
    expect(messageArgs).toEqual([CREATED]); // per-batch, not per-drain
    expect(pushedAuthors).toHaveLength(1);
    expect(pushedAuthors[0]).toMatchObject({ name: "Vlad", email: "v@x" });
    // author.date is the git-formatted BATCH moment (local offset
    // form) — the mtime invariant then records the EDIT moment
    // (owner decision п.1).
    expect(Date.parse((pushedAuthors[0] as { date: string }).date)).toBe(
      CREATED,
    );
  });

  it("S1 vault-step reporting: writes and removes are surfaced (pulledFiles + onPluginsAffected feed); progress carries the path", async () => {
    await setupAligned();
    // obs.md exists on remote AND locally, aligned; then the remote
    // edits note.md and deletes obs.md.
    baseCommit = await world.commitFiles({ "obs.md": "x" });
    vaultFiles.files.set("obs.md", { content: "x", mtime: 50 });
    baselines.set("obs.md", {
      baselineSha: await sha("x"),
      mtime: 50,
      size: 1,
    });
    await world.commitFiles({ "note.md": "R\n", "obs.md": null });
    await stageBatch({ "other.md": "O\n" });

    const snaps: DrainProgress[] = [];
    const r = await drainOnce(
      makeDeps({ onProgress: (p) => snaps.push({ ...p }) }),
    );
    expect(r.status).toBe("ok");
    expect(r.vaultStepWrites).toEqual(["note.md"]);
    expect(r.vaultStepRemoves).toEqual(["obs.md"]);
    // §II.16: progress names BOTH sides. `other.md` is the push (a
    // batch entry); note.md and obs.md are the pull (remote changes
    // landing in the Vault-step). Before §II.16 only the batch entry
    // reported, so the two remote paths were a silent stretch.
    expect(snaps.map((p) => p.path)).toEqual([
      "other.md",
      "note.md",
      "obs.md",
    ]);
    // …and the counters end honest: one file out, two in.
    const last = snaps[snaps.length - 1];
    expect([last.pushDone, last.pushTotal]).toEqual([1, 1]);
    expect([last.pullDone, last.pullTotal]).toEqual([2, 2]);
  });


  it("🔑 FIELD BUG 2026-10-05: a plugin that exists only on the server is simply WRITTEN — no collision, no mtime request", async () => {
    // Fresh device (no anchor, no baselines), the server holds a plugin
    // the vault never had. Before the fix every core file went through
    // the plugin-collision resolver and paid one commits-for-path
    // request (~0.5 s each on the owner's vault), logging a collision
    // that never was.
    await world.commitFiles({
      ".obsidian/plugins/cmdr/main.js": "code\n",
      ".obsidian/plugins/cmdr/manifest.json": '{"id":"cmdr","version":"0.5.5"}\n',
      ".obsidian/plugins/cmdr/styles.css": "css\n",
    });
    const client = world.makeClient();
    const mtimeAsks: string[] = [];
    const origInfo = client.getCommitInfoForPath.bind(client);
    client.getCommitInfoForPath = async (p, ref) => {
      mtimeAsks.push(p);
      return origInfo(p, ref);
    };
    const infos: string[] = [];
    const r = await drainOnce(
      makeDeps({ client, logger: { info: (m) => infos.push(m), warn: () => {} } }),
    );
    expect(r.status).toBe("ok");
    expect([...r.vaultStepWrites].sort()).toEqual([
      ".obsidian/plugins/cmdr/main.js",
      ".obsidian/plugins/cmdr/manifest.json",
      ".obsidian/plugins/cmdr/styles.css",
    ]);
    expect(vaultFiles.files.get(".obsidian/plugins/cmdr/main.js")!.content).toBe("code\n");
    expect(mtimeAsks).toEqual([]);
    expect(infos.filter((m) => m.startsWith("plugin-core collision"))).toEqual([]);
  });

  // ── "Sync done — N sent, M received": REAL changes only (owner, 2026-10-05) ──
  //
  // Field case: a fresh device committed 19 files, 18 of them already on
  // the server byte for byte; the summary said "19 sent" while commit
  // b88abf3 changed ONE file. The owner's rule: a path counts as sent
  // when ITS LOCAL SIDE WON and actually changed the server; as received
  // when the REMOTE side won and actually changed the vault; equal
  // content counts nowhere; a merge counts in both; a deletion that wins
  // counts like a file; conflicts are reported separately. `pushedPaths`
  // is filled only once the commit holding the path is CONFIRMED, so a
  // 422 restart, a network drop or a cancel can never leave a phantom.
  describe("pushedPaths — what this drain really changed on the server", () => {
    it("🔑 field case: entries identical to the server are NOT sent; only the one that differs is", async () => {
      // Fresh device: no anchor, no baselines. The server already holds
      // a.md and b.md with exactly the local content.
      await world.commitFiles({ "a.md": "A\n", "b.md": "B\n" });
      vaultFiles.files.set("a.md", { content: "A\n", mtime: 100 });
      vaultFiles.files.set("b.md", { content: "B\n", mtime: 100 });
      vaultFiles.files.set("c.md", { content: "C\n", mtime: 100 });
      await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });

      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.pushedPaths).toEqual(["c.md"]);
      expect(r.vaultStepWrites).toEqual([]); // equal content: received nowhere either
    });

    it("a local deletion that reaches the server counts as sent", async () => {
      await setupAligned();
      vaultFiles.files.delete("note.md");
      await stageBatch({ "note.md": null });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(world.headFiles().has("note.md")).toBe(false);
      expect(r.pushedPaths).toEqual(["note.md"]);
    });

    it("an auto-merge counts in BOTH: pushed to the server AND written to the vault", async () => {
      await setupAligned();
      await world.commitFiles({ "note.md": "one\ntwo\nREMOTE\n" });
      await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
      vaultFiles.files.set("note.md", { content: "LOCAL\ntwo\nthree\n", mtime: 100 });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.pushedPaths).toEqual(["note.md"]);
      expect(r.vaultStepWrites).toEqual(["note.md"]);
    });

    it("a conflict is neither sent nor received — it is reported on its own", async () => {
      await setupAligned();
      await world.commitFiles({ "note.md": "CLASH\ntwo\nthree\n" });
      await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });
      vaultFiles.files.set("note.md", { content: "LOCAL\ntwo\nthree\n", mtime: 100 });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.conflictVerdicts.length).toBeGreaterThan(0);
      expect(r.pushedPaths).toEqual([]);
      expect(r.vaultStepWrites).not.toContain("note.md");
    });

    it("the same path in two batches of one drain is ONE file", async () => {
      await setupAligned();
      await stageBatch({ "note.md": "C1\n" });
      await stageBatch({ "note.md": "C2\n" });
      vaultFiles.files.set("note.md", { content: "C2\n", mtime: 100 });
      const r = await drainOnce(makeDeps());
      expect(r.status).toBe("ok");
      expect(r.pushedCommits).toHaveLength(2);
      expect(r.pushedPaths).toEqual(["note.md"]);
    });

    it("🔑 422 on the commit: the restarted batch is counted ONCE, never twice", async () => {
      await setupAligned();
      await stageBatch({ "a.md": "A\n", "b.md": "B\n", "c.md": "C\n" });
      const client = world.makeClient();
      const origPush = client.pushCommitFromTree.bind(client);
      let failures = 0;
      client.pushCommitFromTree = async (args) => {
        if (failures === 0) {
          failures += 1;
          await world.commitFiles({ "other.md": "raced\n" });
          throw new ValidationError("422: head moved");
        }
        return origPush(args);
      };
      const r = await drainOnce(makeDeps({ client }));
      expect(r.status).toBe("ok");
      expect([...r.pushedPaths].sort()).toEqual(["a.md", "b.md", "c.md"]);
      expect(r.vaultStepWrites).toEqual(["other.md"]); // the raced file arrived
    });

    it("422-CAP exit: nothing confirmed, nothing counted", async () => {
      await setupAligned();
      await stageBatch({ "a.md": "A\n" });
      const client = world.makeClient();
      client.pushCommitFromTree = async () => {
        throw new ValidationError("422: head moved");
      };
      const r = await drainOnce(makeDeps({ client }));
      expect(r.status).toBe("too-many-concurrent-pushes");
      expect(r.pushedPaths).toEqual([]);
    });

    it("🔑 network drop on the SECOND batch: the first (confirmed) counts, the second does not", async () => {
      await setupAligned();
      await stageBatch({ "a.md": "A\n" });
      await stageBatch({ "b.md": "B\n" });
      const client = world.makeClient();
      const origPush = client.pushCommitFromTree.bind(client);
      let pushes = 0;
      client.pushCommitFromTree = async (args) => {
        pushes += 1;
        if (pushes === 2) throw new NetworkError("net down");
        return origPush(args);
      };
      const r = await drainOnce(
        makeDeps({
          client,
          retry: new NetworkRetry({
            vault: vault as never,
            selfPluginId: PLUGIN_ID,
            maxAttempts: 1,
            sleep: async () => {},
          }),
        }),
      );
      expect(r.status).toBe("network-error");
      expect(world.headFiles().has("a.md")).toBe(true);
      expect(world.headFiles().has("b.md")).toBe(false);
      expect(r.pushedPaths).toEqual(["a.md"]);
    });

    it("cancel at the push boundary (after the per-file loop, before the commit): nothing counted", async () => {
      await setupAligned();
      await stageBatch({ "a.md": "A\n" });
      // cancelRequested is asked once per entry and once at the push
      // boundary; answer "yes" only from the second question on.
      let asks = 0;
      const r = await drainOnce(
        makeDeps({ cancelRequested: () => (asks += 1) > 2 }),
      );
      expect(r.status).toBe("cancelled");
      expect(world.headFiles().has("a.md")).toBe(false);
      expect(r.pushedPaths).toEqual([]);
    });
  });

  it("S1 forbidden-name port: a remote path the platform can't materialise is written CANONICALLY; the baseline stays the honest remote truth", async () => {
    await setupAligned();
    const BAD = 'notes/we"ird?.md'; // " and ? are forbidden (cross-platform.ts)
    await world.commitFiles({ [BAD]: "remote content\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // Written under the canonical name, reported as such.
    expect(r.vaultStepWrites).toHaveLength(1);
    const canonical = r.vaultStepWrites[0];
    expect(canonical).not.toBe(BAD);
    expect(vaultFiles.files.has(canonical)).toBe(true);
    expect(vaultFiles.files.get(canonical)!.content).toBe("remote content\n");
    expect(vaultFiles.files.has(BAD)).toBe(false); // never materialised
    // The epilogue records the HONEST remote truth for the ORIGINAL
    // path — the next findChanges sees baseline-without-file and emits
    // the deletion that renames the remote (§III annotation).
    expect(baselines.get(BAD)!.baselineSha).toBe(await sha("remote content\n"));
    expect(baselines.has(canonical)).toBe(false); // detector picks it up as new
  });

  it("free-size (epilogue): a compare-born baseline carries the REAL size, never 0 — the stat short-circuit must stay usable", async () => {
    await setupAligned();
    // Remote-only change; the honest fake (like the real compare API)
    // reports NO size for it.
    discoveryOverride = async () => ({
      tree: null,
      changes: [
        {
          path: "note.md",
          sha: await sha("R\n"),
          size: null, // ← compare gives none
          mtime: null,
          deleted: false,
        },
      ],
    });
    await world.commitFiles({ "note.md": "R\n" });

    const r = await drainOnce(makeDeps());
    expect(r.status).toBe("ok");
    // The blob was fetched for the vault write, so the size is free.
    expect(baselines.get("note.md")!.size).toBe(enc("R\n").byteLength);
    expect(baselines.get("note.md")!.size).not.toBe(0);
  });

  it("S3 §12.5 sweep: an orphan sync_store blob is reaped at the drain boundaries; queue/journal/conflict-referenced blobs survive", async () => {
    await setupAligned();
    // An orphan from some previous crash…
    const orphan = await sha("orphan bytes\n");
    await syncStore.saveBlobToSyncStore(orphan, enc("orphan bytes\n"));
    // …and a batch whose blob IS referenced while queued.
    await stageBatch({ "note.md": "C1\n" });
    const batchBlob = await sha("C1\n");

    const deps = makeDeps({
      queueReferencedShas: async () => {
        const out = new Set<string>();
        for (const b of batches) {
          if (b.removed) continue;
          for (const e of b.claimed.meta.entries) {
            if (e.sha !== null) out.add(e.sha);
          }
        }
        return out;
      },
    });
    const r = await drainOnce(deps);
    expect(r.status).toBe("ok");
    // The orphan died (start sweep); the batch blob died TOO — the
    // batch completed and nothing references it anymore (end sweep).
    expect(await syncStore.existInSyncStore(orphan)).toBe(false);
    expect(await syncStore.existInSyncStore(batchBlob)).toBe(false);
    // But the push landed — hygiene never touched correctness.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe("C1\n");
  });

  it("S3b §12.5 sweep WIRING: all FOUR reference sources reach the store — the drain never sweeps on a partial view", async () => {
    // Found by mutation probe (§IX.3, 2026-09-23). F.5 pins the STORE
    // half (`sweep()` honours each source it is handed), and S3 above
    // pins reaping — but nothing pinned the LIST. Deleting the journal
    // source, the conflictStore source, or the Deleted-bin source from
    // `sweepSyncStore` left the whole suite green, and S3's title
    // ("queue/journal/conflict-referenced blobs survive") wrote a
    // cheque its body never cashed: both its blobs are expected to DIE.
    //
    // What a missing source costs is not hygiene. Source 5's own
    // comment says it plainly: the bin's captures are referenced by
    // nothing else until the deletion reaches a batch, so dropping it
    // deletes the user's only copy of a file between the delete and
    // its commit. The other two cost a crash-restart its blobs.
    //
    // Distinguishable markers, not real blobs: the assertion is about
    // WHICH sources were consulted, so the sweep's verdict on them is
    // beside the point.
    await setupAligned();
    journal.collectReferencedShas = async () => new Set(["marker-journal"]);
    conflictStore.collectReferencedShas = async () =>
      new Set(["marker-conflict"]);

    const consulted = new Set<string>();
    const realSweep = syncStore.sweep.bind(syncStore);
    syncStore.sweep = async (sources) => {
      for (const s of sources) {
        for (const sha of await s()) consulted.add(sha);
      }
      return realSweep(sources);
    };

    const r = await drainOnce(
      makeDeps({
        queueReferencedShas: async () => new Set(["marker-queue"]),
        deletedBinReferencedShas: () => new Set(["marker-bin"]),
      }),
    );
    expect(r.status).toBe("ok");
    expect([...consulted].sort()).toEqual([
      "marker-bin",
      "marker-conflict",
      "marker-journal",
      "marker-queue",
    ]);
  });

  // Owner, 2026-10-10: a skip is worse — the user never sees the file. The
  // pull side now takes the first free " (N)" name (the push side's rule),
  // so the file lands under an unusual name instead of not at all.
  it("S1 forbidden-name collision: canonical target exists → the first free \" (N)\" name, a WARN; the taken file untouched", async () => {
    await setupAligned();
    const BAD = 'we"ird.md';
    await world.commitFiles({ [BAD]: "remote content\n" });
    // The canonical name is already occupied by DIFFERENT local content.
    const { sanitizeFilename } = await import("../../src/sync2/cross-platform");
    const canonical = sanitizeFilename(BAD);
    vaultFiles.files.set(canonical, { content: "user content", mtime: 60 });
    const numbered = canonical.replace(/\.md$/, " (2).md");

    const warns: string[] = [];
    const r = await drainOnce(
      makeDeps({
        logger: { info: () => {}, warn: (m) => warns.push(m) },
      }),
    );
    expect(r.status).toBe("ok");
    expect(vaultFiles.files.get(canonical)!.content).toBe("user content"); // untouched
    expect(vaultFiles.files.get(numbered)?.content).toBe("remote content\n"); // landed, numbered
    expect(warns.some((w) => w.includes("taken"))).toBe(true);
    // The content DID land locally, so the original gets its baseline —
    // the same as a plain sanitize: the next commit pass pushes the rename.
    expect(baselines.has(BAD)).toBe(true);
  });

  // ── P.29 — Layer 2 answered from discovery's tree snapshot ────────
  //
  // The measurement that forced this (owner's bootstrap on a 63 MB
  // vault, 2026-09-01): 255 of 283 requests were per-path Layer-2
  // HEADs, 78 s of a 90 s run. On a cold start EVERY local file is a
  // batch entry, so Layer 2 fired once per file — asking the network
  // for `sha`+`size` at a PINNED commit that discovery had already
  // read in full, one request earlier.
  //
  // These tests pin the two halves that make the substitution safe:
  // it must still catch a blindspot (that is Layer 2's whole job), and
  // it must refuse to answer for any commit other than the one the
  // tree was read at.

  // Wraps the world's client so a test can count the per-path HEADs
  // and, where needed, make them explode: a call that MUST NOT happen
  // is better proven by a throw than by a counter nobody reads.
  const countingClient = (opts?: { forbidHead?: boolean }) => {
    const base = world.makeClient();
    let heads = 0;
    return {
      client: {
        ...base,
        getContentsMetadataAtRef: async (path: string, ref: string) => {
          heads += 1;
          if (opts?.forbidHead) {
            throw new Error(`unexpected Layer-2 HEAD for ${path}@${ref}`);
          }
          return base.getContentsMetadataAtRef(path, ref);
        },
      } as DrainDeps["client"],
      heads: () => heads,
    };
  };

  // An HONEST snapshot of the fake repo at its current head — the same
  // thing production discovery builds from one recursive tree read.
  const snapshotAtHead = () => ({
    atCommit: world.head as string,
    paths: new Map(
      [...world.headFiles()].map(([p, f]) => [
        p,
        { sha: f.sha, size: f.bytes.byteLength as number | null },
      ]),
    ),
  });

  it("P.29a: on a COLD START the snapshot answers everything — zero per-path requests", async () => {
    // The shape that produced the 255 HEADs: no baseline commit, so
    // discovery reads the full tree, and every local file is a batch
    // entry that Layer 2 wants to verify.
    await setupAligned();
    baseCommit = null; // cold start — .runtime/ was wiped (or is new)
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    // P.28's sentinel: nothing was hidden, so nothing to correct.
    expect(r.layer2Corrections).toEqual([]);
  });

  it("P.29a-bis: when the remote has NOT moved, discovery is skipped — so is the snapshot, and Layer 2 pays per path", async () => {
    // Documents the boundary rather than pretending it away: the drain
    // only calls discovery when head !== base, so an incremental sync
    // against an unmoved remote has no tree to answer from. Cheap
    // anyway — the batch holds only what the user just edited.
    await setupAligned();
    const c = countingClient();
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(1); // one entry, one HEAD
  });

  it("P.29b: a blindspot is corrected from the snapshot exactly as it would be from a HEAD", async () => {
    // Byte-for-byte the P.2 scenario, with the only difference being
    // where the answer came from — the outcome must be identical.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nHIDDEN\n",
    );
  });

  it("P.29c: a snapshot from a DIFFERENT commit is refused — the network answers instead", async () => {
    // The guard that keeps this from becoming the silent clobber G9
    // exists to prevent: head rolls after every batch push, and a map
    // keyed to yesterday's commit must never speak for today's.
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient();
    const stale = snapshotAtHead();
    discoveryOverride = async () => ({
      changes: [],
      tree: { ...stale, atCommit: "0".repeat(40) },
    });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBeGreaterThan(0);
    // And the correction still happens — via the transport, not the map.
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
  });

  it("P.29d: absent from a complete snapshot means DELETED, the same as a 404", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": null }); // deleted remotely
    const c = countingClient({ forbidHead: true });
    discoveryOverride = async () => ({ changes: [], tree: snapshotAtHead() });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBe(0);
    expect(r.layer2Corrections).toHaveLength(1);
    expect(r.layer2Corrections[0].actual).toBe(DELETED_SHA_HASH);
    // 4.6.a — the live local edit wins over a remote deletion.
    expect(dec(world.headFiles().get("note.md")!.bytes)).toBe(
      "LOCAL\ntwo\nthree\n",
    );
  });

  it("P.29e: no snapshot (the compare path) keeps using the per-path transport", async () => {
    await setupAligned();
    await world.commitFiles({ "note.md": "one\ntwo\nHIDDEN\n" });
    const c = countingClient();
    discoveryOverride = async () => ({ changes: [], tree: null });
    await stageBatch({ "note.md": "LOCAL\ntwo\nthree\n" });

    const r = await drainOnce(makeDeps({ client: c.client }));

    expect(r.status).toBe("ok");
    expect(c.heads()).toBeGreaterThan(0);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual(["note.md"]);
  });

  // ── §II.13.2: the drain acquires the snapshot ITSELF ─────────────
  //
  // P.29a-e above all depend on discovery HAPPENING to have read a
  // tree. It only does that on the cold path, so the everyday shape —
  // many local files, remote barely moved — fell through to per-path
  // and cost the owner ~15 s of a 23 s sync (41 requests), and 78 s of
  // 90 s on a 63 MB vault (255 requests). These pin the fix: when
  // there is no usable snapshot and the batch is worth it, read the
  // tree once. Layer 2's logic is unchanged — only where it looks.

  // A batch of N ordinary files, remote NOT moved (so discovery is
  // never called and leaves no snapshot) — the exact field shape.
  const stageNFiles = async (n: number): Promise<string[]> => {
    const paths: string[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const p = `f${i}.md`;
      paths.push(p);
      files[p] = `content ${i}\n`;
    }
    baseCommit = await world.commitFiles(files);
    for (const [p, content] of Object.entries(files)) {
      baselines.set(p, {
        baselineSha: await sha(content),
        mtime: 50,
        size: enc(content).byteLength,
      });
      vaultFiles.files.set(p, { content, mtime: 50 });
    }
    const edits: Record<string, string> = {};
    for (const p of paths) edits[p] = `EDITED ${p}\n`;
    await stageBatch(edits);
    for (const p of paths) {
      vaultFiles.files.set(p, { content: `EDITED ${p}\n`, mtime: 100 });
    }
    return paths;
  };

  it("§II.13.2 🔑 (cost): a batch of 4+ with no snapshot reads the tree ONCE — zero per-path requests", async () => {
    const paths = await stageNFiles(6);
    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1); // one bulk answer…
    expect(world.metadataReads).toEqual([]); // …and nothing per path
    // The work still happened: all six edits reached the remote.
    for (const p of paths) {
      expect(dec(world.headFiles().get(p)!.bytes)).toBe(`EDITED ${p}\n`);
    }
  });

  it("§II.13.2 (threshold=4, owner): a batch of THREE stays on the per-path transport", async () => {
    // Below the threshold a tree — potentially megabytes — costs more
    // than three round trips. The number is the owner's decision
    // (2026-09-25); this pins that a decision is being honoured at all,
    // so moving it is a deliberate act rather than a silent drift.
    await stageNFiles(3);
    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toEqual([]);
    expect(world.metadataReads).toHaveLength(3);
  });

  it("§II.13.2 ⚠️ (truncated): a capped tree is REFUSED, falls back to per-path, and is not re-requested", async () => {
    // THE trap. "Absent from the snapshot == absent from the repo"
    // holds only for a COMPLETE tree; GitHub caps at 100k entries or
    // 7 MB and says so. Building a snapshot from a truncated response
    // would read "not listed" as "deleted", push over it, and produce
    // exactly the silent clobber Layer 2 exists to prevent.
    world.truncateTrees = true;
    const paths = await stageNFiles(6);
    const warnings: string[] = [];

    const r = await drainOnce(
      makeDeps({
        logger: {
          info: () => {},
          warn: (m: string) => warnings.push(m),
        },
      }),
    );

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1); // asked ONCE, not per file
    expect(world.metadataReads).toHaveLength(6); // …then paid honestly
    expect(
      warnings.some((w) => w.includes("cut short")),
    ).toBe(true); // and said so out loud
    // Correctness is untouched by the fallback.
    for (const p of paths) {
      expect(dec(world.headFiles().get(p)!.bytes)).toBe(`EDITED ${p}\n`);
    }
  });

  it("§II.13.2 (correctness): a blindspot is corrected from the SELF-READ tree, identically to a HEAD", async () => {
    // The bulk source must be the same authority, not a cheaper guess:
    // a remote change discovery never mentioned has to be caught here
    // exactly as P.29b catches it through discovery's own snapshot.
    const paths = await stageNFiles(4);
    // A remote edit to ONE of them that discovery will not report.
    await world.commitFiles({ [paths[0]]: "HIDDEN REMOTE\n" });
    discoveryOverride = async () => ({ changes: [], tree: null });

    const r = await drainOnce(makeDeps());

    expect(r.status).toBe("ok");
    expect(world.treeReads).toHaveLength(1);
    expect(world.metadataReads).toEqual([]);
    expect(r.layer2Corrections.map((x) => x.path)).toEqual([paths[0]]);
  });
});
