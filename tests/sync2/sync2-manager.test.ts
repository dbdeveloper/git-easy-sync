import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import { Sync2Manager, Sync2ManagerDeps } from "../../src/sync2/sync2-manager";
import { DrainResult, DrainStatus as DrainOutcome } from "../../src/sync2/drain";
import SyncStore, { PIN_OWNER_COMMIT } from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import BatchWriter from "../../src/sync2/batch-writer";
import HotMetadataStore from "../../src/sync2/hot-metadata";
import FileBaselinesStore from "../../src/sync2/file-baselines";
import ChangeDetector from "../../src/sync2/change-detector";
import GI from "../../src/gi";
import { FileChange } from "../../src/sync2/types";
import { calculateGitBlobSHA } from "../../src/utils";
import { mergeText } from "../../src/sync2/three-way-merge";
import { AuthError } from "../../src/errors";
import manifest from "../../manifest.json";

// THE SWITCH shell (Phase 5.5 step 4): the manager is a thin
// composition over drainOnce — these tests pin the SHELL's own
// session-scoped behavior with a FAKE engine (drainFn seam): the R3a
// commit singleton + bell, the H3 drain collapse, the status/latch
// mapping, the vault-step→UI signal derivation, the zero-byte guard,
// and the ≤100 batch slicing. The ENGINE's behavior is pinned by the
// drain suites; the real composition by the integration gate.

const PLUGIN_ID = manifest.id;
const CONFIG_DIR = ".obsidian";

const okResult = (over?: Partial<DrainResult>): DrainResult => ({
  status: "ok",
  layer2Corrections: [],
  conflictVerdicts: [],
  vaultStepErrors: [],
  cancelledConflicts: [],
  pushedCommits: [],
  finalizedMergeSha: null,
  vaultStepWrites: [],
  vaultStepRemoves: [],
  selfUpdateStaged: [],
  pushedPaths: [],
  ...over,
});

describe("Sync2Manager (THE SWITCH shell)", () => {
  let dir: string;
  let vault: Vault;
  let deps: Sync2ManagerDeps;
  let manager: Sync2Manager;
  let drainCalls: number;
  let drainResult: DrainResult;
  let drainGate: Promise<void> | null;
  let findChangesResult: FileChange[];
  let detectorCalls: number;
  let writtenBatches: FileChange[][];
  let notices: { committed: number[]; noChanges: number };
  let pluginReloads: string[][];
  let cancelledConflicts: string[];
  let completed: Array<{
    pushedFiles: number;
    pulledFiles: number;
    conflicts: number;
    ok: boolean;
    cancelled: boolean;
  }>;
  let latched: Array<401 | 403>;
  let hotMetaRef: HotMetadataStore;
  let baselinesRef: FileBaselinesStore;

  const put = (p: string, content: string): void => {
    const abs = path.join(dir, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  const modified = (p: string, size = 1): FileChange => ({
    kind: "modified",
    path: p,
    size,
    mtime: 0,
    previousRemoteSha: "prev",
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mgr-shell-test-"));
    fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
    vault = new Vault(dir);
    const syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const journal = new DrainJournal({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await conflictStore.load();
    const siblingTx = new SiblingTx({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      store: conflictStore,
      computeSha: calculateGitBlobSHA,
      generateGuid: () => "g",
    });
    const hotMeta = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await hotMeta.load();
    const baselines = new FileBaselinesStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const gi = new GI(dir);
    const detector = new ChangeDetector({
      vault: vault as never,
      hotMeta,
      baselines,
      gi,
      configDir: CONFIG_DIR,
      selfPluginId: PLUGIN_ID,
      vaultRoot: dir,
      syncConfigDir: () => true,
    });
    // The shell suite fakes findChanges — detector mechanics have
    // their own suite.
    detectorCalls = 0;
    findChangesResult = [];
    detector.findChanges = async () => {
      detectorCalls += 1;
      return findChangesResult;
    };
    const realWriter = new BatchWriter({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => false,
      logger: { info: () => {}, warn: () => {} },
    });
    writtenBatches = [];
    const batchWriter = {
      writeBatch: async (changes: FileChange[]) => {
        writtenBatches.push(changes);
        return realWriter.writeBatch(changes);
      },
      consolidateIntoTail: async () => null,
    } as unknown as BatchWriter;

    drainCalls = 0;
    drainResult = okResult();
    drainGate = null;
    notices = { committed: [], noChanges: 0 };
    pluginReloads = [];
    cancelledConflicts = [];
    completed = [];
    latched = [];

    deps = {
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      configDir: CONFIG_DIR,
      client: {} as never,
      worker: {
        computeGitBlobSHA: calculateGitBlobSHA,
        decodeBase64: async (b64) =>
          Uint8Array.from(Buffer.from(b64, "base64")).buffer as ArrayBuffer,
        mergeText: async (o, b, t) => mergeText(o, b, t),
      },
      hotMeta,
      baselines,
      detector,
      batchWriter,
      syncStore,
      journal,
      conflictStore,
      siblingTx,
      isSyncable: () => true,
      // §8.0: no markers in the shell suite — the rule simply doesn't
      // fire, which is what the pre-§8.0 behaviour was.
      gitignoreSeeds: { matches: () => false },
      mainBranch: () => "main",
      deviceLabel: () => "shell-test",
      maxAutoMergeFileSize: () => 1_000_000,
      accumulateOfflineSyncs: () => false,
      tokenExpired: async () => false,
      onTokenExpired: (s) => latched.push(s),
      onLocalCommitted: (n) => notices.committed.push(n),
      onNoLocalChanges: () => (notices.noChanges += 1),
      onSyncCompleted: (s) => completed.push(s),
      onPluginsAffected: (ids) => pluginReloads.push(ids),
      onConflictCancelled: (p) => cancelledConflicts.push(p),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      drainFn: async () => {
        drainCalls += 1;
        if (drainGate) await drainGate;
        return drainResult;
      },
    };
    hotMetaRef = hotMeta;
    baselinesRef = baselines;
    manager = new Sync2Manager(deps);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── H3: drain re-entrancy collapse ─────────────────────────────────

  it("H3: a second entry point arriving MID-DRAIN collapses into the running drain", async () => {
    let release!: () => void;
    drainGate = new Promise<void>((r) => (release = r));
    const p1 = manager.syncAll();
    // Wait until p1's drain is genuinely in flight, THEN try again.
    while (drainCalls === 0) await new Promise((r) => setTimeout(r, 1));
    expect(manager.isDrainRunning()).toBe(true);
    const p2 = manager.resumeQueue(); // collapses — returns without a 2nd engine call
    await p2;
    expect(drainCalls).toBe(1);
    release();
    await p1;
    expect(drainCalls).toBe(1); // still one
    expect(manager.isDrainRunning()).toBe(false);
  });

  // ── invariants run before EVERY operation (owner, 2026-09-20) ──────
  //
  // "цей .gitignore повинен завжди повертатись до свого констатного
  // виду, наприклад перед кожним commit та drain". Until now enforce()
  // ran only on the commit path, so with `syncStartsWithCommit=false`
  // the interval tick, the startup pulse and the watchdog all pushed
  // without checking the invariants at all — and a foreign copy of
  // <self>/.gitignore pulled from another device stayed in force until
  // someone happened to commit. (What enforce() then DOES to that file
  // is pinned by the gitignore-invariants suite; this pins that it is
  // called at all.)

  it("a DRAIN-ONLY entry point enforces the invariants first", async () => {
    let enforced = 0;
    deps.invariants = {
      enforce: async () => {
        enforced += 1;
      },
    };
    await manager.resumeQueue();
    expect(drainCalls).toBe(1);
    expect(enforced).toBe(1);
  });

  it("a COMMIT pass enforces the invariants BEFORE detecting changes — so a file enforce() fixes rides in THAT commit", async () => {
    // Probed 2026-09-23 while answering "does the syncConfigDir toggle
    // need its own enforce() call?": removing this call outright, or
    // moving it after change detection, left the entire suite green.
    // Both the call AND its position were unpinned.
    //
    // The position is the whole answer to that question. Because
    // enforce() runs FIRST, a user who flips a setting and then hits
    // [commit] gets the .gitignore rewrite in that very commit — no
    // separate toggle-time call needed, and no lone commit afterwards.
    // Move it one line down and the rewrite misses the scan, surfacing
    // a commit later: exactly the detached commit the owner objected
    // to. So this asserts ORDER, not just that it was called.
    const order: string[] = [];
    deps.invariants = {
      enforce: async () => {
        order.push("enforce");
      },
    };
    deps.detector.findChanges = async () => {
      order.push("detect");
      return [modified("a.md")];
    };
    await manager.commitOnly();
    expect(order).toEqual(["enforce", "detect"]);
  });

  it("§II.16 🔑: a new drain starts with a CLEARED progress snapshot — no stale counters from the last run", async () => {
    // Field bug 2026-09-26: a sync with nothing to do painted
    // "Pushing 1 of 1" — counters from a drain that had finished
    // minutes earlier. The status object outlives a drain, so anything
    // left in it is read as current by whatever paints next.
    const seen: Array<unknown> = [];
    manager.setDrainStatusListener((s) => seen.push(s.progress));
    deps.drainFn = async (d) => {
      d.onProgress?.({
        pullDone: 0,
        pullTotal: 0,
        pushDone: 1,
        pushTotal: 1,
        conflicts: 0,
        path: "a.md",
      });
      return okResult();
    };
    await manager.syncAll();
    expect(manager.getDrainStatus().progress).not.toBeNull(); // it reported

    // A second run that reports NOTHING must not inherit the first's numbers.
    deps.drainFn = async () => okResult();
    seen.length = 0;
    await manager.syncAll();
    expect(seen[0]).toBeNull(); // the "running" emit cleared it
    expect(manager.getDrainStatus().progress).toBeNull();
  });

  it("🔑 the commit acknowledges FIRST, then plan → one counter over stages 2 and 3 → settles", async () => {
    // COMMIT-PASS-PERF §3.1 (owner, 2026-10-05). The acknowledgement
    // comes before anything is knowable; the plan (M = candidates +
    // deletions) before any read; then ONE counter: every stage-2 check,
    // then stage 3's deletions as their batches land; the settled number
    // last.
    const order: string[] = [];
    deps.onCommitStarted = (full) => order.push(`started:${full}`);
    deps.onCommitPlan = (_p, total) => order.push(`plan:${total}`);
    deps.onCommitChecked = (d, t) => order.push(`checked:${d}/${t}`);
    deps.onLocalCommitted = (n) => order.push(`committed:${n}`);
    const changes: FileChange[] = [
      modified("a.md"),
      modified("b.md"),
      { kind: "deleted", path: "gone.md", previousRemoteSha: "x" },
    ];
    put("a.md", "a");
    put("b.md", "b");
    deps.detector.findChanges = async (hooks) => {
      hooks?.onPlan?.({ checks: 2, checkBytes: 2, unhashedAdds: 0, deletions: 1 });
      hooks?.onChecked?.(1, 2);
      hooks?.onChecked?.(2, 2);
      return changes;
    };

    await manager.commitOnly();

    expect(order).toEqual([
      "started:true",
      "plan:3",
      "checked:1/3",
      "checked:2/3",
      "checked:3/3", // stage 3: the deletion's batch landed
      "committed:3",
    ]);
  });

  it("a single-file commit says it is not a full scan, and carries no plan", async () => {
    const order: string[] = [];
    deps.onCommitStarted = (full) => order.push(`started:${full}`);
    deps.onCommitPlan = () => order.push("plan");
    put("one.md", "x");
    await manager.commitFile("one.md");
    expect(order[0]).toBe("started:false");
    expect(order).not.toContain("plan");
  });

  it("🔑 a commit that produces NO result still closes its notice section", async () => {
    // Field report 2026-10-03: "Committing…" hung on screen after
    // "Sync done" and stayed until the next sync.
    //
    // ⚠️ The cause is structural, not cosmetic: the section is opened
    // by a call that ALWAYS happens (`onCommitStarted`, first line of
    // the pass) and was closed by calls that only SOMETIMES do. Two
    // reachable paths produce neither:
    //   • the R3a bell — a trigger landing mid-pass returns 0 at once;
    //   • no local changes WITH a non-empty queue — `onNoLocalChanges`
    //     is deliberately silent there.
    // So the closing half is now a `finally`, like every other
    // "this must always happen" in this file.
    const events: string[] = [];
    deps.onCommitStarted = () => events.push("started");
    deps.onCommitFinished = () => events.push("finished");
    deps.onLocalCommitted = () => events.push("committed");
    deps.onNoLocalChanges = () => events.push("nothing");

    // Path 1: the R3a bell. A commit is already running, so this one
    // rings and returns without touching anything.
    findChangesResult = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      findChangesResult = [modified("a.md")];
      const p1 = manager.commitOnly();
      await gate;
      return p1;
    })();
    await manager.commitOnly(); // may or may not collapse; either way:
    release();
    await slow;

    // Whatever the interleaving, every `started` has its `finished`.
    expect(
      events.filter((e) => e === "started").length,
      "every opened section must be closed",
    ).toBe(events.filter((e) => e === "finished").length);
  });

  it("🔑 …including the no-changes-with-a-queued-batch path", async () => {
    // The second path that may say nothing, isolated: the scan finds
    // nothing but the queue is NOT empty. The manager now REPORTS that
    // (owner 2026-10-05) and the notice layer decides — silent inside a
    // sync, "Nothing to commit" for a standalone commit — so the
    // `finally` must still close the section either way.
    const events: string[] = [];
    deps.onCommitStarted = () => events.push("started");
    deps.onCommitFinished = () => events.push("finished");
    deps.onNoLocalChanges = (queued) => events.push(`nothing queued=${queued}`);

    // Leave a batch in the queue, then commit with nothing to find.
    findChangesResult = [modified("queued.md")];
    await manager.commitOnly();
    expect((await manager.queueDepth()) > 0).toBe(true);

    events.length = 0;
    findChangesResult = [];
    await manager.commitOnly();

    expect(events).toContain("started");
    expect(events).toContain("finished");
    expect(events, "reported WITH the queue state, for the notice layer to decide").toContain(
      "nothing queued=true",
    );
  });

  it("🔴 a repo switch must not sync with baselines from the PREVIOUS repo", async () => {
    // The guard the surviving comment in hot-metadata.ts already
    // promises: "(owner, repo, branch) the metadata was built against.
    // The manager compares this to current settings at the start of
    // every syncAll; a mismatch means the user pointed the plugin at a
    // different remote and the local baseline is no longer
    // authoritative."
    //
    // ⚠️ The FIELD IS WRITTEN AND READ BY NOBODY — `reconcileRemoteIdentity`
    // was deleted at THE SWITCH and its storage survived. What the
    // comment describes does not exist.
    //
    // Why it matters is pinned separately in
    // `repo-substitution-data-loss.test.ts`: with foreign baselines, an
    // empty repo reads as "everything was deleted remotely", and rule
    // 4.3 turns that into a clean pull — i.e. the vault is emptied. The
    // owner only escaped because §II.7.1 skipped discovery entirely.
    await hotMetaRef.update({
      remoteIdentity: { owner: "me", repo: "repo-A", branch: "main" },
      lastSyncCommitSha: "commit-from-repo-A",
    });
    await baselinesRef.setMany([
      { path: "a.md", baselineSha: "sha-a", mtime: 0, size: 1 },
      { path: "b.md", baselineSha: "sha-b", mtime: 0, size: 1 },
    ]);
    // The user retyped owner/repo in Settings — a different remote.
    (deps as never as { remoteIdentity: () => unknown }).remoteIdentity =
      () => ({ owner: "me", repo: "repo-B", branch: "main" });

    await manager.syncAll();

    // The local baseline is no longer authoritative, so it must be gone
    // BEFORE anything compares the vault against the new remote.
    expect(
      await baselinesRef.allPaths(),
      "baselines built against repo-A may not describe repo-B",
    ).toEqual([]);
    expect(
      hotMetaRef.getLastSyncCommitSha(),
      "an anchor from repo-A is meaningless in repo-B",
    ).toBeNull();
    expect(hotMetaRef.getRemoteIdentity()).toEqual({
      owner: "me",
      repo: "repo-B",
      branch: "main",
    });
  });

  it("🔑 the FIRST observation records the identity and wipes NOTHING", async () => {
    // ⚠️ The branch that makes this safe to ship. Every install that
    // upgrades from a build without `remoteIdentity` arrives here with
    // `recorded === null`, and treating that as a mismatch would wipe
    // the baselines of EVERY existing user once — a full re-adoption
    // for nothing.
    //
    // Added after a probe: deleting the `recorded === null` branch left
    // all 28 tests green, so the condition was implemented and
    // unchecked — the same shape as the defect this whole guard exists
    // to fix.
    await baselinesRef.setMany([
      { path: "a.md", baselineSha: "sha-a", mtime: 0, size: 1 },
      { path: "b.md", baselineSha: "sha-b", mtime: 0, size: 1 },
    ]);
    expect(hotMetaRef.getRemoteIdentity()).toBeNull(); // the upgrade state
    (deps as never as { remoteIdentity: () => unknown }).remoteIdentity =
      () => ({ owner: "me", repo: "repo-A", branch: "main" });

    await manager.syncAll();

    expect(
      (await baselinesRef.allPaths()).sort(),
      "an upgrade must not cost the user their baselines",
    ).toEqual(["a.md", "b.md"]);
    expect(hotMetaRef.getRemoteIdentity()).toEqual({
      owner: "me",
      repo: "repo-A",
      branch: "main",
    });
  });

  it("the SAME identity is a no-op — no wipe on an ordinary sync", async () => {
    await hotMetaRef.update({
      remoteIdentity: { owner: "me", repo: "repo-A", branch: "main" },
    });
    await baselinesRef.setMany([
      { path: "a.md", baselineSha: "sha-a", mtime: 0, size: 1 },
    ]);
    (deps as never as { remoteIdentity: () => unknown }).remoteIdentity =
      () => ({ owner: "me", repo: "repo-A", branch: "main" });

    await manager.syncAll();

    expect(await baselinesRef.allPaths()).toEqual(["a.md"]);
  });

  it("🔑 §II.16: the progress snapshot is cleared at the SYNC start, not at the drain start", async () => {
    // FIELD REPORT 2026-10-03 — the owner glimpsed "258" in the notice
    // on a sync that did nothing, and said it confused them. The log
    // showed the engine idle: `nothing to commit`, every counter zero.
    // The numbers were the PREVIOUS run's, painted by the notice.
    //
    // ⚠️ THE EXISTING RESET IS IN THE WRONG PLACE, and the test above
    // cannot see it: `lastProgress = null` happens when the DRAIN
    // starts, while main.ts arms the 2 s progress timer at
    // `onSyncStarted` — deliberately, so the wait is measured from the
    // CLICK ("a slow commit pass is silence too"). Between those two
    // points sits the commit pass, which took ~3 s over 264 files. The
    // timer fired inside that gap and read a snapshot nobody had
    // cleared yet.
    //
    // So the assertion has to be taken AT `onSyncStarted`, which is the
    // first instant the notice can paint. Checking after `syncAll`
    // returns — what the neighbouring test does — passes either way.
    deps.drainFn = async (d) => {
      d.onProgress?.({
        pullDone: 0,
        pullTotal: 0,
        pushDone: 258,
        pushTotal: 258,
        conflicts: 0,
        path: "a.md",
      });
      return okResult();
    };
    await manager.syncAll();
    expect(manager.getDrainStatus().progress).not.toBeNull(); // armed

    const atSyncStart: Array<unknown> = [];
    deps.onSyncStarted = () => {
      atSyncStart.push(manager.getDrainStatus().progress);
    };
    deps.drainFn = async () => okResult();
    await manager.syncAll();
    expect(
      atSyncStart[0],
      "the notice must not be able to read the previous run's counters",
    ).toBeNull();

    // syncFile is the same entry shape and the same window.
    atSyncStart.length = 0;
    deps.drainFn = async (d) => {
      d.onProgress?.({
        pullDone: 0,
        pullTotal: 0,
        pushDone: 7,
        pushTotal: 7,
        conflicts: 0,
        path: "b.md",
      });
      return okResult();
    };
    await manager.syncAll();
    atSyncStart.length = 0;
    deps.drainFn = async () => okResult();
    await manager.syncFile("b.md");
    expect(atSyncStart[0], "syncFile too").toBeNull();
  });

  it("§II.17: a CANCELLED sync does not report success — the summary must not say 'Sync done'", async () => {
    // A cancelled drain returns normally (it is not an error), so the
    // summary's `ok` flag would have been true and the user would have
    // been told the sync finished — right after they stopped it.
    deps.drainFn = async () => okResult({ status: "cancelled" });
    await manager.syncAll();
    expect(completed).toHaveLength(1);
    expect(completed[0].ok).toBe(false);
    // …and it is distinguishable from an ERROR, because the two get
    // different words: a cancel is confirmed ("Sync canceled"), an
    // error already has its own notice.
    expect(completed[0].cancelled).toBe(true);
  });

  it("§II.17: an ordinary successful sync still reports ok — the cancel flag does not leak between runs", async () => {
    deps.drainFn = async () => okResult({ status: "cancelled" });
    await manager.syncAll();
    deps.drainFn = async () => okResult();
    await manager.syncAll();
    expect(completed[1].ok).toBe(true);
    expect(completed[1].cancelled).toBe(false);
  });

  it("§II.16: the queue depth is reported as EACH batch lands, not once at the end", async () => {
    // Found 2026-09-25 while wiring the progress notice: fireQueueDepth
    // ran once after the WHOLE drain, so a four-batch run showed a
    // frozen "↑ 4" and then jumped to zero. That matters more now than
    // it did: the push counter legitimately restarts per batch
    // ("100 of 100" → "101 of 200"), and the falling badge is what
    // tells the user those restarts mean "more to come" rather than
    // "something went wrong".
    const depths: number[] = [];
    deps.onQueueDepthChanged = (d) => depths.push(d);
    // A drain that removes two batch dirs, as the engine would.
    deps.drainFn = async (d) => {
      await d.removeBatchDir("queue/b1");
      await d.removeBatchDir("queue/b2");
      return okResult();
    };
    await manager.resumeQueue();
    // At least one report PER removal — the point is that the depth
    // moves during the run, not only after it.
    expect(depths.length).toBeGreaterThanOrEqual(2);
  });

  it("a failing enforce() never blocks the sync — hygiene, not a gate", async () => {
    deps.invariants = {
      enforce: async () => {
        throw new Error("disk full");
      },
    };
    await manager.resumeQueue();
    expect(drainCalls).toBe(1); // the drain still ran
  });

  // ── §5.2.1 retention: the bin is bounded by the drain ─────────────

  it("a fully successful drain prunes the bin with its OWN start time", async () => {
    const pruned: string[] = [];
    deps.deletedBin = {
      referencedShas: () => new Set<string>(),
      pruneBefore: async (iso) => {
        pruned.push(iso);
      },
    };
    await manager.resumeQueue();
    expect(pruned).toHaveLength(1);
    // The boundary is the drain's own start, so anything captured
    // WHILE it ran (a pull-delete, say) survives to be seen.
    expect(Date.parse(pruned[0])).toBeLessThanOrEqual(Date.now());
  });

  it("a drain that did NOT finish cleanly leaves the bin alone", async () => {
    const pruned: string[] = [];
    deps.deletedBin = {
      referencedShas: () => new Set<string>(),
      pruneBefore: async (iso) => {
        pruned.push(iso);
      },
    };
    drainResult = okResult({ status: "network-error" as DrainOutcome });
    // The shell surfaces a failed drain by throwing — the point here is
    // what happened to the bin before it did.
    await expect(manager.resumeQueue()).rejects.toThrow();
    expect(pruned).toEqual([]);
  });

  // ── R3a: commit singleton + coalescing bell ────────────────────────

  it("R3a: a commit trigger during a running pass rings the bell — the RUNNER loops once more, the second caller returns 0", async () => {
    put("a.md", "x");
    findChangesResult = [modified("a.md")];
    let releaseFirstScan!: () => void;
    const firstScanGate = new Promise<void>((r) => (releaseFirstScan = r));
    let scans = 0;
    deps.detector.findChanges = async () => {
      scans += 1;
      if (scans === 1) await firstScanGate;
      return scans <= 2 ? [modified("a.md")] : [];
    };

    const first = manager.commitOnly();
    // Second trigger while the first pass is mid-scan.
    const second = manager.commitOnly();
    releaseFirstScan();
    await Promise.all([first, second]);
    // The bell made the RUNNER do a second pass (scans >= 2); the
    // coalesced trigger itself never ran a pass of its own.
    expect(scans).toBeGreaterThanOrEqual(2);
  });

  it("R3a: a THROWING pass releases the singleton (no deadlock) and does NOT auto-restart", async () => {
    let scans = 0;
    deps.detector.findChanges = async () => {
      scans += 1;
      throw new Error("scan boom");
    };
    await expect(manager.commitOnly()).rejects.toThrow("scan boom");
    expect(scans).toBe(1); // no blind restart on error (I6)
    // The singleton was released — the next commit runs.
    deps.detector.findChanges = async () => [];
    await manager.commitOnly();
    expect(notices.noChanges).toBe(1);
  });

  // COMMIT-PASS-PERF Крок 2: the detector pins blobs it stores before
  // any metafile names them; the pass must release those pins when it
  // ends — on success AND on a throw — or they outlive their purpose
  // and the sweep can never reap a blob the pass then abandoned.
  it("in-flight pins are released when the commit pass ends — the next sweep can reap an abandoned blob", async () => {
    const sha = await calculateGitBlobSHA(
      new TextEncoder().encode("abandoned").buffer as ArrayBuffer,
    );
    deps.detector.findChanges = async () => {
      await deps.syncStore.retain(
        PIN_OWNER_COMMIT,
        sha,
        async () => new TextEncoder().encode("abandoned").buffer as ArrayBuffer,
      );
      return []; // e.g. the zero-byte guard dropped the change
    };
    await manager.commitOnly();
    await deps.syncStore.sweep([async () => new Set()]);
    expect(await deps.syncStore.existInSyncStore(sha)).toBe(false);
  });

  it("in-flight pins are released by a THROWING pass too", async () => {
    const sha = await calculateGitBlobSHA(
      new TextEncoder().encode("half-done").buffer as ArrayBuffer,
    );
    deps.detector.findChanges = async () => {
      await deps.syncStore.retain(
        PIN_OWNER_COMMIT,
        sha,
        async () => new TextEncoder().encode("half-done").buffer as ArrayBuffer,
      );
      throw new Error("scan boom");
    };
    await expect(manager.commitOnly()).rejects.toThrow("scan boom");
    await deps.syncStore.sweep([async () => new Set()]);
    expect(await deps.syncStore.existInSyncStore(sha)).toBe(false);
  });

  // R3b at the commit pass (SYNC2-FIX §6; owner, 2026-10-04: one of the
  // short commit↔drain interaction points resolved on the spot). With
  // "Consolidate commits into one (if possible)" ON, a commit folds into
  // the queue TAIL — unless the drain has already claimed that tail
  // (`.attempted`). Then the commit must NOT wait and must NOT write into
  // it: it appends a NEW batch, which the running drain's loop claims
  // next. BatchWriter's back-off is pinned in its own suite; this pins
  // the requirement end to end through the pass.
  describe("consolidate ON + a tail the drain already claimed", () => {
    const queueDirs = (): string[] => {
      const root = path.join(dir, CONFIG_DIR, "plugins", PLUGIN_ID, ".runtime", "push-queue");
      return fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d{17}$/.test(d)).sort() : [];
    };
    const metaShas = (id: string): Record<string, string | null> => {
      const raw = fs.readFileSync(
        path.join(dir, CONFIG_DIR, "plugins", PLUGIN_ID, ".runtime", "push-queue", id, "meta.json"),
        "utf8",
      );
      return Object.fromEntries(
        (JSON.parse(raw).entries as Array<{ path: string; sha: string | null }>).map((e) => [e.path, e.sha]),
      );
    };
    const sha = (t: string): Promise<string> =>
      calculateGitBlobSHA(new TextEncoder().encode(t).buffer as ArrayBuffer);

    const setup = async (drainClaimedTail: boolean): Promise<string> => {
      const writer = new BatchWriter({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
        syncStore: deps.syncStore,
        autoCanonicalize: () => false,
        logger: { info: () => {}, warn: () => {} },
      });
      put("a.md", "v1\n");
      const tail = (await writer.writeBatch([modified("a.md")]))!;
      if (drainClaimedTail) {
        fs.writeFileSync(
          path.join(dir, CONFIG_DIR, "plugins", PLUGIN_ID, ".runtime", "push-queue", tail, ".attempted"),
          "",
        );
      }
      deps.batchWriter = writer;
      deps.accumulateOfflineSyncs = () => true;
      put("a.md", "v2\n");
      findChangesResult = [modified("a.md")];
      return tail;
    };

    it("control — tail NOT claimed: the commit folds into it (the setting really is on)", async () => {
      const tail = await setup(false);
      await manager.commitOnly();
      expect(queueDirs()).toEqual([tail]);
      expect(metaShas(tail)["a.md"]).toBe(await sha("v2\n"));
    });

    it("🔑 tail claimed by the drain: a NEW batch is appended; the claimed tail is untouched", async () => {
      const tail = await setup(true);
      await manager.commitOnly();
      const dirs = queueDirs();
      expect(dirs).toHaveLength(2);
      expect(dirs[0]).toBe(tail);
      expect(metaShas(tail)["a.md"]).toBe(await sha("v1\n"));
      expect(metaShas(dirs[1])["a.md"]).toBe(await sha("v2\n"));
    });
  });

  // COMMIT-PASS-PERF (2026-10-05): one timing line per commit pass, so a
  // device run says which phase is slow; syncAll also times the remote
  // identity check that sits before the pass.
  it("each commit pass logs its phases (and the detector's breakdown for a full scan); syncAll logs the identity check", async () => {
    const lines: Array<{ m: string; d: unknown }> = [];
    deps.logger = { ...deps.logger, info: (m: string, d?: unknown) => lines.push({ m, d }) };
    put("x.md", "x");
    findChangesResult = [modified("x.md")];
    await manager.syncAll();
    const identity = lines.find((l) => l.m === "Sync2 syncAll: remote identity checked");
    expect(identity).toBeDefined();
    const timing = lines.find((l) => l.m === "Sync2 commit pass timing")?.d as Record<string, unknown>;
    expect(timing).toBeDefined();
    expect(timing.changes).toBe(1);
    for (const k of ["totalMs", "enforceMs", "sanitizeMs", "queueIndexMs", "detectMs", "zeroByteGuardMs", "writeBatchesMs"]) {
      expect(typeof timing[k], k).toBe("number");
    }
  });

  it("…a pass with nothing to commit logs its timing too", async () => {
    const lines: Array<{ m: string; d: unknown }> = [];
    deps.logger = { ...deps.logger, info: (m: string, d?: unknown) => lines.push({ m, d }) };
    findChangesResult = [];
    await manager.commitOnly();
    const timing = lines.find((l) => l.m === "Sync2 commit pass timing")?.d as Record<string, unknown>;
    expect(timing).toBeDefined();
    expect(timing.changes).toBe(0);
    expect(typeof timing.detectMs).toBe("number");
  });

  describe("COMMIT-PASS-PERF 3a: commit statistics", () => {
    it("the timing line carries the stats summary, and the stats are flushed after the pass", async () => {
      const lines: Array<{ m: string; d: unknown }> = [];
      deps.logger = { ...deps.logger, info: (m: string, d?: unknown) => lines.push({ m, d }) };
      let flushed = 0;
      deps.commitStats = {
        summary: () => ({ hash: { overheadMs: 1, mbPerSec: 50 } }),
        flush: async () => {
          flushed += 1;
        },
      };
      findChangesResult = [];
      await manager.commitOnly();
      const timing = lines.find((l) => l.m === "Sync2 commit pass timing")?.d as Record<string, unknown>;
      expect(timing.stats).toEqual({ hash: { overheadMs: 1, mbPerSec: 50 } });
      expect(flushed).toBe(1);
    });

    it("a THROWING pass still flushes", async () => {
      let flushed = 0;
      deps.commitStats = { summary: () => ({}), flush: async () => void (flushed += 1) };
      deps.detector.findChanges = async () => {
        throw new Error("scan boom");
      };
      await expect(manager.commitOnly()).rejects.toThrow("scan boom");
      expect(flushed).toBe(1);
    });

    it("a failing flush is a warning, never a failed commit", async () => {
      const warns: string[] = [];
      deps.logger = { ...deps.logger, warn: (m: string) => warns.push(m) };
      deps.commitStats = {
        summary: () => ({}),
        flush: async () => {
          throw new Error("disk full");
        },
      };
      findChangesResult = [];
      await manager.commitOnly(); // must not throw
      expect(warns.some((w) => w.includes("commit stats: flush failed"))).toBe(true);
    });
  });

  it("R3a bell escalation: a FULL-scan trigger during a single-file pass re-loops as a FULL scan, never the runner's file", async () => {
    put("a.md", "x");
    put("b.md", "y");
    let releaseSingle!: () => void;
    const singleGate = new Promise<void>((r) => (releaseSingle = r));
    const scans: Array<string | null> = [];
    deps.detector.findChangeForPath = async (p: string) => {
      scans.push(p);
      await singleGate; // hold the single-file pass mid-flight
      return modified(p);
    };
    deps.detector.checkSyncable = async () => true;
    deps.detector.findChanges = async () => {
      scans.push(null);
      return [];
    };

    const single = manager.commitFile("a.md");
    // Wait until the single-file pass is genuinely mid-scan…
    while (scans.length === 0) await new Promise((r) => setTimeout(r, 1));
    // …then land the FULL-scan trigger — without the escalation the
    // runner would re-loop "a.md" and the full request would be
    // silently swallowed (advisor catch).
    const full = manager.commitOnly();
    releaseSingle();
    await Promise.all([single, full]);
    expect(scans[0]).toBe("a.md"); // the runner's own pass
    expect(scans).toContain(null); // the escalated FULL re-loop ran
  });

  // ── commit pass mechanics ──────────────────────────────────────────

  it("slices >100 changes into ≤100-entry batches (MAX_BATCH_ENTRIES)", async () => {
    const changes: FileChange[] = [];
    for (let i = 0; i < 205; i++) {
      const p = `f${String(i).padStart(3, "0")}.md`;
      put(p, `c${i}`);
      changes.push(modified(p));
    }
    findChangesResult = changes;
    await manager.commitOnly();
    expect(writtenBatches.map((b) => b.length)).toEqual([100, 100, 5]);
    expect(notices.committed).toEqual([205]);
  });

  it("zero-byte guard: a 0-byte 'modified' whose baseline was non-empty is RESTORED from sync_store and dropped from the commit", async () => {
    // Baseline says 5 bytes; the blob is in sync_store; the vault
    // file collapsed to 0 bytes (the mobile corruption shape).
    const good = new TextEncoder().encode("good\n").buffer as ArrayBuffer;
    const sha = await calculateGitBlobSHA(good);
    await deps.syncStore.saveBlobToSyncStore(sha, good);
    await deps.baselines.setMany([
      { path: "note.md", baselineSha: sha, mtime: 10, size: 5 },
    ]);
    put("note.md", "");
    findChangesResult = [modified("note.md", 0)];

    await manager.commitOnly();
    expect(writtenBatches).toEqual([]); // change dropped
    expect(fs.readFileSync(path.join(dir, "note.md"), "utf8")).toBe("good\n");
  });

  it("a genuinely-new 0-byte file (no baseline) commits normally — the guard only fires on a collapse", async () => {
    put("fresh.md", "");
    findChangesResult = [
      { kind: "added", path: "fresh.md", size: 0, mtime: 0 },
    ];
    await manager.commitOnly();
    expect(writtenBatches).toHaveLength(1);
  });

  // ── drain status/result mapping ────────────────────────────────────

  it("ok drain: lastError cleared, vaultStepWrites/Removes feed pulledFiles + onPluginsAffected", async () => {
    manager.recordDrainError(new Error("old error"));
    expect(manager.getDrainStatus().lastError).not.toBeNull();
    drainResult = okResult({
      vaultStepWrites: [
        "note.md",
        `${CONFIG_DIR}/plugins/other-plugin/main.js`,
      ],
      vaultStepRemoves: [`${CONFIG_DIR}/plugins/dead-plugin/styles.css`],
    });
    await manager.syncAll();
    expect(manager.getDrainStatus().lastError).toBeNull();
    // §II.16 widened the summary: `ok` so the notice never claims
    // success over an error, and `conflicts` (tracked BASE paths, not
    // sibling files) for its third clause.
    expect(completed[0]).toEqual({
      pushedFiles: 0,
      pulledFiles: 3,
      conflicts: 0,
      ok: true,
      cancelled: false,
    });
    expect(pluginReloads).toEqual([["other-plugin", "dead-plugin"]]);
  });

  // Owner, 2026-10-05: "sent" is what the drain REALLY changed on the
  // server, never the commit pass's queued count. Field case: 19 queued,
  // 18 of them already on the server byte for byte → "1 sent".
  it("🔑 sent comes from the drain's confirmed pushes, NOT from the commit count", async () => {
    for (const p of ["a.md", "b.md", "c.md"]) put(p, `${p}\n`);
    findChangesResult = ["a.md", "b.md", "c.md"].map((p) => ({
      kind: "added" as const,
      path: p,
      size: 5,
      mtime: 1,
    }));
    drainResult = okResult({ pushedPaths: ["c.md"] });
    await manager.syncAll();
    expect(writtenBatches).toHaveLength(1); // three were queued…
    expect(completed[0].pushedFiles).toBe(1); // …one changed the server
  });

  it("received counts our own staged self-update too; a path is one file however often it is touched", async () => {
    drainResult = okResult({
      vaultStepWrites: ["note.md", "note.md"],
      selfUpdateStaged: [`${CONFIG_DIR}/plugins/${PLUGIN_ID}/main.js`],
      pushedPaths: ["x.md", "x.md"],
    });
    await manager.syncAll();
    expect(completed[0].pulledFiles).toBe(2);
    expect(completed[0].pushedFiles).toBe(1);
  });

  it("the counts start from zero for every sync", async () => {
    drainResult = okResult({ pushedPaths: ["x.md"], vaultStepWrites: ["y.md"] });
    await manager.syncAll();
    drainResult = okResult();
    await manager.syncAll();
    expect(completed[1]).toMatchObject({ pushedFiles: 0, pulledFiles: 0 });
  });

  // REGRESSION (owner, 2026-10-05): "Раніше оновлення відбувалось
  // динамічно в автоматичному (BRAT) режимі і для нашого плагіну!" Since
  // 86c808e (2026-10-01) our own loadable files are STAGED, not written —
  // the bootloader alone replaces the live file, at the top of onload. But
  // the reload that RUNS that onload was derived from the written paths
  // only, so a staged self-update sat on disk until the user restarted
  // Obsidian by hand. The design (bcc2cbe: "We treat self the same as any
  // other plugin") reloads us, and the bootloader applies the stage.
  it("🔑 a STAGED self-update triggers our own BRAT-style reload (the bootloader then applies it)", async () => {
    drainResult = okResult({
      selfUpdateStaged: [
        `${CONFIG_DIR}/plugins/${PLUGIN_ID}/main.js`,
        `${CONFIG_DIR}/plugins/${PLUGIN_ID}/manifest.json`,
      ],
    });
    await manager.syncAll();
    expect(pluginReloads).toEqual([[PLUGIN_ID]]);
  });

  it("staged self-update + another plugin written in the same drain → both reloaded, each once", async () => {
    drainResult = okResult({
      vaultStepWrites: [`${CONFIG_DIR}/plugins/cmdr/main.js`],
      selfUpdateStaged: [`${CONFIG_DIR}/plugins/${PLUGIN_ID}/main.js`],
    });
    await manager.syncAll();
    expect(pluginReloads).toHaveLength(1);
    expect([...pluginReloads[0]].sort()).toEqual(["cmdr", PLUGIN_ID].sort());
  });

  // ── Which vault-step failures the USER hears about ────────────────
  //
  // Owner's rule, 2026-10-02: «там де є сподівання, що наступна
  // ітерація виправить помилку — можна просто писати в лог. Якщо ж це
  // зміна поведінки, яку користувач не очікує — писати хоча б щось».
  //
  // The two tests below are that rule's two halves, and they are a
  // PAIR on purpose: the second is what stops the first from being
  // satisfied by notifying about everything.
  describe("vault-step failures: log vs tell", () => {
    it("🔑 an ordinary skip is SILENT — the next sync retries it", async () => {
      // The commonest cause of this class is GitHub's own eventual
      // consistency (the open 422 BadObjectState note), which clears
      // in minutes; the path is also written into `.recheck-paths`, so
      // the next sync asks about it again without being told to. A
      // notice here would be noise that teaches the user to ignore the
      // channel — which costs us the one below.
      drainResult = okResult({
        vaultStepErrors: [
          { path: "note.md", error: "remote blob abc not in repo" },
        ],
      });
      await manager.syncAll();
      expect(cancelledConflicts).toEqual([]);
    });

    it("🔑 a CANCELLED conflict is told — nothing will retry it", async () => {
      // The other half: the engine deleted a conflict record on
      // purpose (so a later restore cannot resurrect it), and what
      // disappeared is something the user was looking at. No mechanism
      // brings it back, so silence here is the engine changing its
      // mind behind their back.
      drainResult = okResult({
        vaultStepErrors: [
          { path: "a.md", error: "remote blob abc not in repo" },
          { path: "b.md", error: "conflict content vanished from the repo" },
        ],
        cancelledConflicts: ["b.md"],
      });
      await manager.syncAll();
      // ONLY the cancelled one — the neighbour stays a log line.
      expect(cancelledConflicts).toEqual(["b.md"]);
    });

    it("reported even when the drain later FAILED — the cancel already happened", async () => {
      // Status-independent by design: the record was deleted and saved
      // before the abort, so a later failure does not un-cancel it.
      // Reporting only on `ok` would hide exactly the runs that went
      // worst.
      drainResult = okResult({
        status: "network-error" as DrainOutcome,
        cancelledConflicts: ["b.md"],
      });
      // The manager turns this status into a throw — which is exactly
      // the path the report must survive, so the rejection is part of
      // the scenario rather than something to work around.
      await expect(manager.syncAll()).rejects.toThrow(/network/i);
      expect(cancelledConflicts).toEqual(["b.md"]);
    });
  });

  it("token-expired drain: onTokenExpired fires with the 401/403 class AND an AuthError is thrown for the caller's note()", async () => {
    drainResult = { ...okResult(), status: "token-expired" as DrainOutcome, authErrorStatus: 403 };
    await expect(manager.resumeQueue()).rejects.toBeInstanceOf(AuthError);
    expect(latched).toEqual([403]);
  });

  it("cancelled drain: returns quietly (no throw, no error recorded); running flag drops", async () => {
    drainResult = { ...okResult(), status: "cancelled" as DrainOutcome };
    await manager.resumeQueue();
    expect(manager.getDrainStatus().lastError).toBeNull();
    expect(manager.getDrainStatus().state).toBe("idle");
  });

  it("too-many-concurrent-pushes surfaces as a thrown Error (main shows the Notice)", async () => {
    drainResult = {
      ...okResult(),
      status: "too-many-concurrent-pushes" as DrainOutcome,
    };
    await expect(manager.resumeQueue()).rejects.toThrow(/intensive/i);
  });

  it("cancelDrain flips status to 'cancelling' while running and is a no-op when idle", async () => {
    manager.cancelDrain(); // idle — no-op
    expect(manager.getDrainStatus().state).toBe("idle");
    let release!: () => void;
    drainGate = new Promise<void>((r) => (release = r));
    const p = manager.resumeQueue();
    expect(manager.getDrainStatus().state).toBe("running");
    manager.cancelDrain();
    expect(manager.getDrainStatus().state).toBe("cancelling");
    release();
    await p;
    expect(manager.getDrainStatus().state).toBe("idle");
  });

  // ── queue surfaces ─────────────────────────────────────────────────

  it("hasPendingBatches/queueDepth read the new-format queue dirs; peekLatestPathSha serves the detector", async () => {
    expect(await manager.hasPendingBatches()).toBe(false);
    put("a.md", "content");
    findChangesResult = [modified("a.md")];
    await manager.commitOnly();
    expect(await manager.hasPendingBatches()).toBe(true);
    expect(await manager.queueDepth()).toBe(1);
    expect(await manager.peekLatestPathSha("a.md")).toBe(
      await calculateGitBlobSHA(
        new TextEncoder().encode("content").buffer as ArrayBuffer,
      ),
    );
    expect(await manager.peekLatestPathSha("other.md")).toBeNull();
  });
});
