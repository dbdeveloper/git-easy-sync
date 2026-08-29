import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import SnapshotStore, {
  SYNC2_MANIFEST_FILE_NAME,
} from "../../src/sync2/snapshot-store";
import { Vault } from "../../mock-obsidian";

const CONFIG_DIR = ".obsidian";

function makeVault(): { root: string; vault: Vault; manifestAbs: string } {
  const root = path.join(
    os.tmpdir(),
    `snapshot-store-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const manifestAbs = path.join(
    root,
    CONFIG_DIR,
    SYNC2_MANIFEST_FILE_NAME,
  );
  return { root, vault, manifestAbs };
}

function newStore(vault: Vault): SnapshotStore {
  return new SnapshotStore(vault as unknown as import("obsidian").Vault);
}

describe("SnapshotStore", () => {
  let root: string;
  let vault: Vault;
  let manifestAbs: string;

  beforeEach(() => {
    ({ root, vault, manifestAbs } = makeVault());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts empty when file doesn't exist", async () => {
    const store = newStore(vault);
    await store.load();
    expect(store.getLastSyncCommitSha()).toBeNull();
    expect(store.getLastSyncTreeSha()).toBeNull();
    expect(store.paths()).toEqual([]);
  });

  it("round-trips per-file snapshots", async () => {
    const a = newStore(vault);
    await a.load();
    a.set("Notes/x.md", {
      path: "Notes/x.md",
      remoteSha: "abc123",
      mtime: 1700000000000,
      size: 42,
    });
    a.set("attachments/img.png", {
      path: "attachments/img.png",
      remoteSha: "deadbeef",
      mtime: 1700000001000,
      size: 4096,
    });
    await a.save();

    const b = newStore(vault);
    await b.load();
    expect(b.paths().sort()).toEqual([
      "Notes/x.md",
      "attachments/img.png",
    ]);
    expect(b.get("Notes/x.md")).toEqual({
      path: "Notes/x.md",
      remoteSha: "abc123",
      mtime: 1700000000000,
      size: 42,
    });
  });

  it("round-trips lastSyncCommitSha/lastSyncTreeSha", async () => {
    const a = newStore(vault);
    await a.load();
    a.setLastSync("c0ffee", "deadbeef");
    await a.save();

    const b = newStore(vault);
    await b.load();
    expect(b.getLastSyncCommitSha()).toBe("c0ffee");
    expect(b.getLastSyncTreeSha()).toBe("deadbeef");
  });

  it("remove drops a path", async () => {
    const store = newStore(vault);
    await store.load();
    store.set("x.md", {
      path: "x.md",
      remoteSha: "abc",
      mtime: 1,
      size: 1,
    });
    expect(store.get("x.md")).toBeDefined();
    store.remove("x.md");
    expect(store.get("x.md")).toBeUndefined();
    expect(store.paths()).toEqual([]);
  });

  it("migrates legacy schema: sha → remoteSha, drops dirty/justDownloaded", async () => {
    const legacy = {
      lastSync: 12345,
      files: {
        "Notes/x.md": {
          path: "Notes/x.md",
          sha: "legacysha",
          dirty: true,
          justDownloaded: false,
          lastModified: 999,
          mtime: 1700000000000,
          size: 100,
        },
      },
      firstSyncFromRemoteInProgress: false,
    };
    fs.writeFileSync(manifestAbs, JSON.stringify(legacy));

    const store = newStore(vault);
    await store.load();
    expect(store.get("Notes/x.md")).toEqual({
      path: "Notes/x.md",
      remoteSha: "legacysha",
      mtime: 1700000000000,
      size: 100,
    });
  });

  it("migrates: drops file entries without any SHA (never pushed)", async () => {
    const legacy = {
      files: {
        "Notes/never-pushed.md": {
          path: "Notes/never-pushed.md",
          sha: null,
          dirty: true,
          mtime: 0,
          size: 0,
        },
      },
    };
    fs.writeFileSync(manifestAbs, JSON.stringify(legacy));

    const store = newStore(vault);
    await store.load();
    expect(store.paths()).toEqual([]);
  });

  it("migrates: tolerates totally invalid JSON", async () => {
    fs.writeFileSync(manifestAbs, "{not valid json");

    const store = newStore(vault);
    await store.load();
    expect(store.getLastSyncCommitSha()).toBeNull();
    expect(store.paths()).toEqual([]);
  });

  it("migrates: tolerates missing files key", async () => {
    fs.writeFileSync(
      manifestAbs,
      JSON.stringify({ lastSyncCommitSha: "abc" }),
    );
    const store = newStore(vault);
    await store.load();
    expect(store.getLastSyncCommitSha()).toBe("abc");
    expect(store.paths()).toEqual([]);
  });

  it("setLastSync overwrites prior values", async () => {
    const store = newStore(vault);
    await store.load();
    store.setLastSync("old", "oldT");
    store.setLastSync("new", "newT");
    expect(store.getLastSyncCommitSha()).toBe("new");
    expect(store.getLastSyncTreeSha()).toBe("newT");
  });

  it("remoteIdentity: starts null, round-trips through save+load", async () => {
    const store = newStore(vault);
    await store.load();
    expect(store.getRemoteIdentity()).toBeNull();
    store.setRemoteIdentity({
      owner: "alice",
      repo: "vault",
      branch: "main",
    });
    await store.save();

    const reloaded = newStore(vault);
    await reloaded.load();
    expect(reloaded.getRemoteIdentity()).toEqual({
      owner: "alice",
      repo: "vault",
      branch: "main",
    });
  });

  it("remoteIdentity: tolerates missing/malformed values in raw JSON", async () => {
    // Pre-write a manifest with a partial remoteIdentity (missing repo).
    // migrate() must drop it as malformed rather than throw.
    fs.writeFileSync(
      manifestAbs,
      JSON.stringify({
        lastSyncCommitSha: "abc",
        files: {},
        remoteIdentity: { owner: "alice" /* repo + branch missing */ },
      }),
    );
    const store = newStore(vault);
    await store.load();
    expect(store.getRemoteIdentity()).toBeNull();
    // Other fields still loaded fine.
    expect(store.getLastSyncCommitSha()).toBe("abc");
  });

  it("conflictBranch: starts null, round-trips through save+load", async () => {
    const store = newStore(vault);
    await store.load();
    expect(store.getConflictBranch()).toBeNull();
    store.setConflictBranch({
      name: "git-easy-sync-conflicts-Obsidian-20260520143022-847",
      head: "deadbeef".repeat(5),
    });
    await store.save();

    const reloaded = newStore(vault);
    await reloaded.load();
    expect(reloaded.getConflictBranch()).toEqual({
      name: "git-easy-sync-conflicts-Obsidian-20260520143022-847",
      head: "deadbeef".repeat(5),
    });
  });

  it("conflictBranch: clearConflictBranch resets to null", async () => {
    const store = newStore(vault);
    await store.load();
    store.setConflictBranch({ name: "git-easy-sync-conflicts-X-1-001", head: "sha" });
    store.clearConflictBranch();
    expect(store.getConflictBranch()).toBeNull();
  });

  it("conflictBranch: tolerates missing/malformed values in raw JSON", async () => {
    fs.writeFileSync(
      manifestAbs,
      JSON.stringify({
        lastSyncCommitSha: "abc",
        files: {},
        conflictBranch: { name: "git-easy-sync-conflicts-X-1-001" /* head missing */ },
      }),
    );
    const store = newStore(vault);
    await store.load();
    expect(store.getConflictBranch()).toBeNull();
    expect(store.getLastSyncCommitSha()).toBe("abc");
  });

  it("conflictBranch: unknown type → null on load", async () => {
    fs.writeFileSync(
      manifestAbs,
      JSON.stringify({
        files: {},
        conflictBranch: "not-an-object",
      }),
    );
    const store = newStore(vault);
    await store.load();
    expect(store.getConflictBranch()).toBeNull();
  });

  it("clear() drops conflictBranch too (panic-button reset)", async () => {
    const store = newStore(vault);
    await store.load();
    store.setConflictBranch({ name: "git-easy-sync-conflicts-X-1-001", head: "sha" });
    store.clear();
    expect(store.getConflictBranch()).toBeNull();
  });

  it("clear() drops remoteIdentity too (panic-button reset)", async () => {
    const store = newStore(vault);
    await store.load();
    store.setLastSync("c", "t");
    store.setRemoteIdentity({
      owner: "alice",
      repo: "vault",
      branch: "main",
    });
    store.clear();
    expect(store.getLastSyncCommitSha()).toBeNull();
    expect(store.getRemoteIdentity()).toBeNull();
  });

  it("save() serialises concurrent writes", async () => {
    const store = newStore(vault);
    await store.load();
    store.setLastSync("a", "ta");
    const p1 = store.save();
    store.setLastSync("b", "tb");
    const p2 = store.save();
    await Promise.all([p1, p2]);

    const reloaded = newStore(vault);
    await reloaded.load();
    expect(reloaded.getLastSyncCommitSha()).toBe("b");
  });
});
