import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import HotMetadataStore from "../../src/sync2/hot-metadata";
import FileBaselinesStore, {
  bucketIdForPath,
} from "../../src/sync2/file-baselines";
import InvariantStateStore from "../../src/sync2/invariant-state";
import {
  hasResetMarker,
  removeResetMarker,
  resetRuntimeState,
  wipeRuntimeDir,
  RESET_MARKER_NAME,
} from "../../src/sync2/reset";

// RESET-PLUGIN core (Phase 1.6). The load-bearing test is GHOST
// RESURRECTION: the spec §1's motivating bug is that write-through /
// ping-pong stores can silently re-persist pre-reset state from RAM
// after the wipe — a fresh seq:0 slot losing to a surviving high-seq
// slot, a cached bucket flushing old entries back. Reset must make
// that impossible via the in-memory re-init step.

const PLUGIN_ID = "git-easy-sync";

describe("reset (RESET-PLUGIN Phase 1.6)", () => {
  let dir: string;
  let vault: Vault;
  let hot: HotMetadataStore;
  let baselines: FileBaselinesStore;
  let invariantState: InvariantStateStore;

  const pluginDir = (): string =>
    path.join(dir, ".obsidian", "plugins", PLUGIN_ID);
  const runtimeAbs = (): string => path.join(pluginDir(), ".runtime");
  const markerAbs = (): string => path.join(pluginDir(), RESET_MARKER_NAME);

  const deps = (drain?: {
    running: () => boolean;
    onCancel?: () => void;
  }) => ({
    vault: vault as never,
    selfPluginId: PLUGIN_ID,
    cancelDrain: () => drain?.onCancel?.(),
    isDrainRunning: () => drain?.running() ?? false,
    reinitStores: async () => {
      await hot.load();
      await baselines.clear();
      await invariantState.load();
    },
  });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "reset-test-"));
    vault = new Vault(dir);
    hot = new HotMetadataStore({ vault: vault as never, selfPluginId: PLUGIN_ID });
    await hot.load();
    baselines = new FileBaselinesStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    invariantState = new InvariantStateStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await invariantState.load();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seedEverything = async (): Promise<void> => {
    await hot.update({
      lastSyncCommitSha: "GHOST_COMMIT",
      lastSyncTreeSha: "GHOST_TREE",
      lastCommitMtime: 42,
      remoteIdentity: { owner: "o", repo: "r", branch: "b" },
      conflictBranch: { name: "cb", head: "h" },
    });
    await baselines.set("Notes/ghost.md", {
      baselineSha: "GHOST_SHA",
      mtime: 1,
      size: 1,
    });
    await invariantState.set("rootGitignore", { mtime: 7, hash: "GHOST_HASH" });
    // A stray file no store knows about — D1's whole point.
    fs.writeFileSync(
      path.join(runtimeAbs(), "some-future-artifact.json"),
      "{}",
    );
  };

  it("D1: wipes .runtime entirely, including files no store knows about", async () => {
    await seedEverything();
    expect(fs.existsSync(runtimeAbs())).toBe(true);

    const outcome = await resetRuntimeState(deps());
    expect(outcome).toBe("done");
    expect(fs.existsSync(runtimeAbs())).toBe(false);
    // The marker survives resetRuntimeState — it dies last, after the
    // caller's settings cleanup.
    expect(fs.existsSync(markerAbs())).toBe(true);
    await removeResetMarker(vault as never, PLUGIN_ID);
    expect(fs.existsSync(markerAbs())).toBe(false);
  });

  it("GHOSTS DO NOT RESURRECT: post-reset write-through persists no pre-reset value", async () => {
    await seedEverything();
    await resetRuntimeState(deps());
    await removeResetMarker(vault as never, PLUGIN_ID);

    // In-memory state is clean...
    expect(hot.getLastSyncCommitSha()).toBeNull();
    expect(hot.getConflictBranch()).toBeNull();
    expect(await baselines.get("Notes/ghost.md")).toBeUndefined();
    expect(invariantState.get()).toEqual({});

    // ...and operations that trigger write-through re-persist NOTHING
    // from before the reset.
    await hot.update({ lastCommitMtime: 100 });
    await baselines.set("Notes/new.md", {
      baselineSha: "NEW_SHA",
      mtime: 2,
      size: 2,
    });
    await invariantState.set("configDirGitignore", { mtime: 9, hash: "NEW" });

    const everything: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else everything.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(runtimeAbs());
    const blob = everything.join("\n");
    expect(blob).not.toContain("GHOST_COMMIT");
    expect(blob).not.toContain("GHOST_TREE");
    expect(blob).not.toContain("GHOST_SHA");
    expect(blob).not.toContain("GHOST_HASH");
    expect(blob).not.toContain("ghost.md");
    // The hot pair restarted from seq 0 — a surviving high-seq slot
    // would have beaten the fresh state (the spec §1 bug).
    const slotA = JSON.parse(
      fs.readFileSync(path.join(runtimeAbs(), "metadata-a.json"), "utf8"),
    );
    expect(slotA.seq).toBe(0);
    expect(slotA.lastSyncCommitSha).toBeNull();
  });

  it("D4 (reversed): vault files — including conflict-from siblings — are untouched", async () => {
    const note = path.join(dir, "Notes", "x.md");
    const sibling = path.join(
      dir,
      "Notes",
      "x.conflict-from-Phone-2026-05-08T15-30-00Z.md",
    );
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "user content\n");
    fs.writeFileSync(sibling, "theirs content\n");
    await seedEverything();

    await resetRuntimeState(deps());
    await removeResetMarker(vault as never, PLUGIN_ID);

    expect(fs.readFileSync(note, "utf8")).toBe("user content\n");
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.readFileSync(sibling, "utf8")).toBe("theirs content\n");
  });

  it("O3: a drain that never stops → 'drain-stuck', nothing wiped, no marker", async () => {
    await seedEverything();
    let cancelCalled = 0;
    const outcome = await resetRuntimeState(
      deps({ running: () => true, onCancel: () => cancelCalled++ }),
      { drainWaitMs: 300, pollMs: 50 },
    );
    expect(outcome).toBe("drain-stuck");
    expect(cancelCalled).toBe(1);
    expect(fs.existsSync(runtimeAbs())).toBe(true); // untouched
    expect(fs.existsSync(markerAbs())).toBe(false); // marker never written
    // The seeded state is still alive.
    const fresh = new HotMetadataStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    await fresh.load();
    expect(fresh.getLastSyncCommitSha()).toBe("GHOST_COMMIT");
  });

  it("O3: a drain that stops after cancel → reset proceeds", async () => {
    await seedEverything();
    let running = true;
    const outcome = await resetRuntimeState(
      deps({ running: () => running, onCancel: () => (running = false) }),
      { drainWaitMs: 1000, pollMs: 10 },
    );
    expect(outcome).toBe("done");
    expect(fs.existsSync(runtimeAbs())).toBe(false);
  });

  it("O6: interrupted-reset primitives — marker detected, wipe + removal idempotent", async () => {
    await seedEverything();
    await resetRuntimeState(deps());
    // Simulate a crash BEFORE the caller removed the marker.
    expect(await hasResetMarker(vault as never, PLUGIN_ID)).toBe(true);

    // Next-load catch-up: wipe (idempotent — .runtime already gone),
    // then marker removal.
    await wipeRuntimeDir(vault as never, PLUGIN_ID);
    await removeResetMarker(vault as never, PLUGIN_ID);
    expect(await hasResetMarker(vault as never, PLUGIN_ID)).toBe(false);
    expect(fs.existsSync(runtimeAbs())).toBe(false);

    // Double-run of everything is safe.
    await wipeRuntimeDir(vault as never, PLUGIN_ID);
    await removeResetMarker(vault as never, PLUGIN_ID);
    const again = await resetRuntimeState(deps());
    expect(again).toBe("done");
    await removeResetMarker(vault as never, PLUGIN_ID);
    expect(fs.existsSync(markerAbs())).toBe(false);
  });

  it("O4: reset creates nothing — .runtime reappears only on the first store write", async () => {
    await seedEverything();
    await resetRuntimeState(deps());
    await removeResetMarker(vault as never, PLUGIN_ID);
    expect(fs.existsSync(runtimeAbs())).toBe(false);

    await baselines.set("a.md", { baselineSha: "s", mtime: 1, size: 1 });
    const bucket = path.join(
      runtimeAbs(),
      "file-baselines",
      `${bucketIdForPath("a.md")}.json`,
    );
    expect(fs.existsSync(bucket)).toBe(true);
  });
});
