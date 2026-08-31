import { describe, it, expect } from "vitest";
import {
  MainHeadGuard,
  makeDrainClient,
  buildDrainDeps,
  DrainGithubClient,
} from "../../src/sync2/drain-deps";
import { NotFoundError, ConflictError } from "../../src/errors";
import { parseDeviceSuffix } from "../../src/sync2/commit-message";
import { Vault } from "../../mock-obsidian";
import SyncStore from "../../src/sync2/sync-store";
import DrainJournal from "../../src/sync2/drain-journal";
import ConflictStoreV2 from "../../src/sync2/conflict-store-v2";
import SiblingTx from "../../src/sync2/sibling-tx";
import { calculateGitBlobSHA } from "../../src/utils";
import { mergeText } from "../../src/sync2/three-way-merge";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

// Phase 5.5 step 2c — the production DrainDeps composition. These
// tests pin the ADAPTER semantics (the mappings the fake-world drain
// suites can't see): the §7.10 monotonic-head guard port, the
// bare-repo null translation, the blobSink wiring, and the hot-anchor
// schema mapping with its vestigial `head`.

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");

// A throwing stub for every client method a test doesn't expect to be
// called — silent fallthrough would hide a wiring bug.
const unusedClient = (): DrainGithubClient =>
  new Proxy({} as DrainGithubClient, {
    get(_t, prop) {
      return () => {
        throw new Error(`unexpected client call: ${String(prop)}`);
      };
    },
  });

describe("MainHeadGuard (SYNC2 §7.10 port)", () => {
  const makeGuard = () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const guard = new MainHeadGuard({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { guard, sleeps, advance: (ms: number) => (clock += ms) };
  };

  it("a read matching a SUPERSEDED confirmed head is replica lag → backoff + re-read until fresh", async () => {
    const { guard, sleeps } = makeGuard();
    guard.noteConfirmedHead("c1");
    guard.noteConfirmedHead("c2"); // c1 is now superseded
    const reads = ["c1", "c1", "c2"];
    const got = await guard.guardedRead(async () => reads.shift()!);
    expect(got).toBe("c2");
    expect(sleeps).toEqual([500, 1000]); // exponential backoff
  });

  it("the LATEST confirmed head and a NEVER-confirmed head are both accepted immediately", async () => {
    const { guard, sleeps } = makeGuard();
    guard.noteConfirmedHead("c1");
    guard.noteConfirmedHead("c2");
    expect(await guard.guardedRead(async () => "c2")).toBe("c2"); // our latest
    expect(await guard.guardedRead(async () => "external")).toBe("external"); // genuine remote move
    expect(sleeps).toEqual([]);
  });

  it("past the window a still-behind read is accepted as reality (append-only assumption)", async () => {
    const { guard } = makeGuard();
    guard.noteConfirmedHead("c1");
    guard.noteConfirmedHead("c2");
    // Reads never advance; the loop must give up at the window, not spin.
    const got = await guard.guardedRead(async () => "c1");
    expect(got).toBe("c1");
  });

  it("confirmed heads outside the window are pruned — an OLD sha stops counting as superseded", async () => {
    const { guard, advance, sleeps } = makeGuard();
    guard.noteConfirmedHead("c1");
    guard.noteConfirmedHead("c2");
    advance(20_000); // both records fall out of the 10s window
    expect(await guard.guardedRead(async () => "c1")).toBe("c1");
    expect(sleeps).toEqual([]); // no backoff — the record is gone
  });
});

describe("makeDrainClient — adapter semantics", () => {
  const noopGuard = () =>
    new MainHeadGuard({ now: () => 0, sleep: async () => {} });

  const make = (over: Partial<DrainGithubClient>) =>
    makeDrainClient({
      client: { ...unusedClient(), ...over },
      mainBranch: () => "main",
      headGuard: noopGuard(),
      decodeBase64: async (s) =>
        Uint8Array.from(Buffer.from(s, "base64")).buffer,
      blobSink: { has: async () => false, save: async () => {} },
    });

  it("getGuardedHead: 404 AND 409 are the bare-repo null, anything else propagates", async () => {
    const c404 = make({
      getBranchHeadSha: async () => {
        throw new NotFoundError("no ref");
      },
    });
    expect(await c404.getGuardedHead()).toBeNull();

    const c409 = make({
      getBranchHeadSha: async () => {
        throw new ConflictError("Git Repository is empty");
      },
    });
    expect(await c409.getGuardedHead()).toBeNull();

    const cBoom = make({
      getBranchHeadSha: async () => {
        throw new Error("network down");
      },
    });
    await expect(cBoom.getGuardedHead()).rejects.toThrow("network down");
  });

  it("BOTH movers of main feed the guard: after pushCommitFromTree and updateMainRef, a replica-lagged read re-reads", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const guard = new MainHeadGuard({
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const reads = ["push1", "push1", "merge1"];
    const client = makeDrainClient({
      client: {
        ...unusedClient(),
        pushCommitFromTree: async () => ({ sha: "push1", committedAt: 1 }),
        updateReference: async () => {},
        getBranchHeadSha: async () => reads.shift()!,
      },
      mainBranch: () => "main",
      headGuard: guard,
      decodeBase64: async () => new ArrayBuffer(0),
      blobSink: { has: async () => false, save: async () => {} },
    });
    await client.pushCommitFromTree({ treeSha: "t", parent: null, message: "m" });
    await client.updateMainRef("merge1"); // FINALIZE's move
    // "push1" is now SUPERSEDED by "merge1" → the stale reads get
    // re-read until the replica serves the merge head.
    expect(await client.getGuardedHead()).toBe("merge1");
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("getContentsMetadataAtRef: passes the blobSink through and strips the blob field", async () => {
    let sunkSink: unknown = null;
    const client = make({
      getContentsMetadataAtRef: async (args) => {
        sunkSink = args.blobSink;
        return { sha: "s1", size: 7, blob: new ArrayBuffer(3) };
      },
    });
    expect(await client.getContentsMetadataAtRef("a.md", "ref1")).toEqual({
      sha: "s1",
      size: 7,
    });
    expect(sunkSink).not.toBeNull(); // §II.13 — inline bytes go to sync_store

    const missing = make({ getContentsMetadataAtRef: async () => null });
    expect(await missing.getContentsMetadataAtRef("a.md", "r")).toBeNull();
  });

  it("getBlobFromRepo: base64-decodes via the worker seam; 404 → null (GC'd blob)", async () => {
    const client = make({
      getBlob: async () => ({ content: b64("hello"), encoding: "base64" }),
    });
    const bytes = await client.getBlobFromRepo("sha1");
    expect(new TextDecoder().decode(bytes!)).toBe("hello");

    const gone = make({
      getBlob: async () => {
        throw new NotFoundError("no blob");
      },
    });
    expect(await gone.getBlobFromRepo("sha2")).toBeNull();
  });

  it("createMergeCommit keeps the POSITIONAL parent pair; updateMainRef and deleteBranch hit heads/<name>", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = make({
      createCommit: async (args) => {
        calls.push(["createCommit", args.parents]);
        return "m1";
      },
      updateReference: async (args) => {
        calls.push(["updateReference", args.ref]);
      },
      deleteReference: async (args) => {
        calls.push(["deleteReference", args.ref]);
      },
    });
    const r = await client.createMergeCommit({
      treeSha: "t",
      parents: ["main1", "conf1"],
      message: "m",
    });
    expect(r).toEqual({ sha: "m1" });
    await client.updateMainRef("m1");
    await client.deleteBranch("cb-name");
    expect(calls).toEqual([
      ["createCommit", ["main1", "conf1"]], // main FIRST — §4.3
      ["updateReference", "heads/main"],
      ["deleteReference", "heads/cb-name"],
    ]);
  });

  it("getBranchHeadSha (by name) and compareStatus delegate with retry", async () => {
    const client = make({
      getBranchHeadShaByName: async ({ branch }) =>
        branch === "cb" ? "cbhead" : null,
      compare: async () => ({ status: "ahead", files: [] }),
    });
    expect(await client.getBranchHeadSha("cb")).toBe("cbhead");
    expect(await client.getBranchHeadSha("other")).toBeNull();
    expect(await client.compareStatus("a", "b")).toBe("ahead");
  });
});

describe("buildDrainDeps — hot-anchor schema mapping + message contracts", () => {
  const PLUGIN_ID = "git-easy-sync";

  const build = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drain-deps-test-"));
    const vault = new Vault(dir);
    const syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const conflictStore = new ConflictStoreV2({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const hotUpdates: unknown[] = [];
    let storedBranch: { name: string } | null = { name: "carried" };
    const deps = buildDrainDeps({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      client: unusedClient(),
      mainBranch: () => "main",
      headGuard: new MainHeadGuard({ now: () => 0, sleep: async () => {} }),
      worker: {
        computeSha: calculateGitBlobSHA,
        decodeBase64: async (s) =>
          Uint8Array.from(Buffer.from(s, "base64")).buffer,
        mergeText: async (o, b, t) => mergeText(o, b, t),
      },
      syncStore,
      journal: new DrainJournal({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
      }),
      conflictStore,
      siblingTx: new SiblingTx({
        vault: vault as never,
        selfPluginId: PLUGIN_ID,
        store: conflictStore,
        computeSha: calculateGitBlobSHA,
        generateGuid: () => "g",
      }),
      hotMeta: {
        getLastSyncCommitSha: () => "anchor1",
        getConflictBranch: () => storedBranch,
        update: async (f) => {
          hotUpdates.push(f);
          storedBranch = f.conflictBranch;
        },
      },
      baselines: {
        get: async () => undefined,
        setMany: async () => {},
        removeMany: async () => {},
        allPaths: async () => [],
        getMany: async () => new Map(),
      },
      tokenExpired: async () => false,
      isSyncable: () => true,
      deviceLabel: () => "test-device",
      maxAutoMergeFileSize: () => 1000,
      now: () => 1_700_000_000_000,
    });
    return { deps, hotUpdates, dir };
  };

  it("hot adapter: name-only view outward, vestigial head:'' inward (§II.7 — the conflict head is never persisted)", async () => {
    const { deps, hotUpdates, dir } = build();
    try {
      expect(deps.hot.getLastSyncCommitSha()).toBe("anchor1");
      expect(deps.hot.getConflictBranch()).toEqual({ name: "carried" }); // no head leaks out

      await deps.hot.update({
        lastSyncCommitSha: "c9",
        lastSyncTreeSha: "t9",
        conflictBranchName: "cb-9",
      });
      expect(hotUpdates[0]).toEqual({
        lastSyncCommitSha: "c9",
        lastSyncTreeSha: "t9",
        conflictBranch: { name: "cb-9", head: "" },
      });

      await deps.hot.update({
        lastSyncCommitSha: "c10",
        lastSyncTreeSha: "t10",
        conflictBranchName: null,
      });
      expect(hotUpdates[1]).toMatchObject({ conflictBranch: null });
      expect(deps.hot.getConflictBranch()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commit and merge messages keep the trailing '(deviceLabel)' contract parseDeviceSuffix relies on", () => {
    const { deps, dir } = build();
    try {
      expect(parseDeviceSuffix(deps.commitMessage(1_700_000_000_000))).toBe(
        "test-device",
      );
      expect(parseDeviceSuffix(deps.mergeMessage(1_700_000_000_000))).toBe(
        "test-device",
      );
      expect(deps.mergeMessage(1_700_000_000_000)).toContain(
        "Merge conflict-branch",
      );
      // Per-batch contract (§4.4): different createdAt → different message.
      expect(deps.commitMessage(1_700_000_000_000)).not.toBe(
        deps.commitMessage(1_700_000_060_000),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
