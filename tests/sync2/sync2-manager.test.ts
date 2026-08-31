import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import { Sync2Manager, Sync2ManagerDeps } from "../../src/sync2/sync2-manager";
import { DrainResult, DrainStatus as DrainOutcome } from "../../src/sync2/drain";
import SyncStore from "../../src/sync2/sync-store";
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
  pushedCommits: [],
  finalizedMergeSha: null,
  vaultStepWrites: [],
  vaultStepRemoves: [],
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
  let completed: Array<{ pushedFiles: number; pulledFiles: number }>;
  let latched: Array<401 | 403>;

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
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      drainFn: async () => {
        drainCalls += 1;
        if (drainGate) await drainGate;
        return drainResult;
      },
    };
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
    expect(completed[0]).toEqual({ pushedFiles: 0, pulledFiles: 3 });
    expect(pluginReloads).toEqual([["other-plugin", "dead-plugin"]]);
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
