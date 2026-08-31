// @vitest-environment happy-dom
//
// Direct coverage for the plugin's PRE-SYNC CONFLICT GATE
// (GitHubSyncPlugin.confirmPendingConflictsBeforeSync) — the private method that
// decides whether a Sync proceeds when conflicts still exist. This closes the gap
// noted while fixing the "already-resolved conflict re-appears in the sync modal" bug:
// the gate's source-of-truth is pinned at the helper level by synthetic-detector.test.ts
// (pendingConflictSummary), but the METHOD itself — its modal wiring + the sync-anyway /
// cancel / resolve branches — lives in main.ts, which no unit test exercised.
//
// Harness strategy: the plugin class is huge (full onload graph), so we do NOT run its
// constructor. `Object.create(GitHubSyncPlugin.prototype)` gives a real instance with the
// real prototype methods and ZERO construction side effects; we then assign only the three
// fields the gate reads (`app`, `conflictStore`, `logger`). The PreSyncConflictModal is
// vi.mock'd to a stub that records the paths it was handed and returns a per-test decision.
// Everything else in the gate — pendingConflictSummary → findAllConflicts over the live
// vault — runs for real against an fs-backed mock vault + a real ConflictStore.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// vi.hoisted → the shared spy state exists BEFORE the mock factory (which runs during the
// main.ts import) touches it, avoiding the TDZ that a module-scope `let` would hit.
const modal = vi.hoisted(() => ({
  paths: null as string[] | null,
  conflictCount: null as number | null,
  constructed: 0,
  decision: "cancel" as "resolve" | "sync-anyway" | "cancel",
}));
vi.mock("../src/sync2/views/pre-sync-conflict-modal", () => ({
  PreSyncConflictModal: class {
    constructor(_app: unknown, paths: string[], conflictCount: number) {
      modal.paths = paths;
      modal.conflictCount = conflictCount;
      modal.constructed++;
    }
    prompt() {
      return Promise.resolve(modal.decision);
    }
  },
}));

import GitHubSyncPlugin from "../src/main";
import ConflictStoreV2, {
  emptyConflictsState,
  type ConflictsState,
} from "../src/sync2/conflict-store-v2";
import { buildSiblingFilePath } from "../src/sync2/conflict-siblings";
import { emptyFileInfo } from "../src/sync2/diff3";
import { Vault } from "../mock-obsidian";

// The gate is a PRIVATE method — casting to `GitHubSyncPlugin & {method}` reduces to `never`
// (private-in-one-constituent). This structural handle exposes exactly the surface the test
// drives (the three fields it assigns + the method); the prototype provides the real impl.
interface GateHandle {
  app: unknown;
  conflictStoreV2: unknown;
  logger: unknown;
  confirmPendingConflictsBeforeSync(): Promise<boolean>;
}
function bareInstance(): GateHandle {
  return Object.create(GitHubSyncPlugin.prototype) as unknown as GateHandle;
}

const CONFIG_DIR = ".obsidian";
const SELF_PLUGIN_ID = "git-easy-sync";

function fixture() {
  const root = path.join(os.tmpdir(), `presync-gate-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const vault = new Vault(root);
  const store = new ConflictStoreV2({
    vault: vault as unknown as import("obsidian").Vault,
    selfPluginId: SELF_PLUGIN_ID,
  });
  const state: ConflictsState = emptyConflictsState();
  return { root, vault, store, state };
}

function writeFile(root: string, rel: string, content = "x"): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// Build a gate-ready plugin instance WITHOUT running the constructor. Assigns only the
// fields confirmPendingConflictsBeforeSync reads. openLinkText is a spy so the "resolve"
// branch is observable; logger.error is a spy for the catch branch.
function makeGate(
  vault: Vault,
  store: ConflictStoreV2,
  // §24 — "Resolve" now activates the diff conflicts PANEL (not openLinkText on a sibling);
  // this thunk lets a test make that activation reject to drive the catch branch.
  activateDiffEditView: () => Promise<void> = () => Promise.resolve(),
) {
  const plugin = bareInstance();
  const openSpy = vi.fn(() => Promise.resolve());
  const activateSpy = vi.fn(activateDiffEditView);
  const errorSpy = vi.fn(() => Promise.resolve());
  Object.assign(plugin, {
    app: {
      vault,
      workspace: { openLinkText: openSpy },
    },
    conflictStoreV2: store,
    logger: { error: errorSpy },
    activateDiffEditView: activateSpy,
  });
  return { plugin, openSpy, activateSpy, errorSpy };
}

// Register a TRACKED sibling the v2 way: entry + sibling file at the
// derived disk name; save() rebuilds the store's cached indexes.
let trackedMtime = Date.UTC(2026, 6, 4, 9, 0, 0, 0);
async function createTracked(
  fx: ReturnType<typeof fixture>,
  vaultPath: string,
  device: string,
): Promise<{ siblingPath: string }> {
  const whenMs = (trackedMtime += 1000);
  let entry = fx.state.entries.get(vaultPath);
  if (!entry) {
    entry = {
      conflictBase: { ...emptyFileInfo(), path: vaultPath, sha: "cb" },
      siblings: [],
    };
    fx.state.entries.set(vaultPath, entry);
  }
  entry.siblings.push({
    ...emptyFileInfo(),
    path: vaultPath,
    mtime: whenMs,
    deviceLabel: device,
    sha: `theirs-${vaultPath}-${device}`,
  });
  const siblingPath = buildSiblingFilePath(vaultPath, whenMs, device);
  writeFile(fx.root, siblingPath, `theirs-${vaultPath}-${device}`);
  await fx.store.save(fx.state);
  return { siblingPath };
}

describe("confirmPendingConflictsBeforeSync (pre-sync conflict gate)", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
    modal.paths = null;
    modal.conflictCount = null;
    modal.constructed = 0;
    modal.decision = "cancel";
  });
  afterEach(() => {
    if (fs.existsSync(fx.root)) fs.rmSync(fx.root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("no ConflictStore → proceeds without a modal", async () => {
    const plugin = bareInstance();
    Object.assign(plugin, { app: { vault: fx.vault }, conflictStoreV2: undefined });
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.constructed).toBe(0);
  });

  it("no live conflicts → proceeds without a modal", async () => {
    writeFile(fx.root, "note.md", "regular");
    const { plugin } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.constructed).toBe(0);
  });

  // §24 — a SYNTHETIC conflict (a *.conflict-from-* sibling with NO ConflictStore record —
  // a local leftover) has no cross-device consequence, so the gate must NOT block or show a
  // modal over it. pendingConflictSummary returns null for a synthetic-only vault → proceed.
  it("§24 synthetic-only conflicts → proceeds silently, no modal", async () => {
    writeFile(fx.root, "note.md", "ours");
    writeFile(fx.root, "note.conflict-from-Phone-2026-05-26T10-30-00Z.md", "theirs");
    const { plugin } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.constructed).toBe(0);
  });

  // §24 — one file with MULTIPLE tracked conflicts (a sibling per remote device): the modal
  // lists the single base path once, but conflictCount reflects all tracked siblings so the
  // intro copy can say "tracked conflicts … resolve them" instead of "a conflict … it".
  it("§24 single file, multiple tracked conflicts → one path listed, conflictCount counts siblings", async () => {
    writeFile(fx.root, "busy.md", "ours");
    await createTracked(fx, "busy.md", "Phone");
    await createTracked(fx, "busy.md", "Laptop");
    modal.decision = "sync-anyway";

    const { plugin } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.paths).toEqual(["busy.md"]); // one file
    expect(modal.conflictCount).toBe(2); // two tracked conflicts
  });

  // §24 — a base with a synthetic sibling alongside a tracked one is still gated, but the
  // modal lists ONLY the tracked base(s), never the synthetic leftover.
  it("§24 mixed tracked + synthetic → modal lists only the tracked base", async () => {
    writeFile(fx.root, "leftover.md", "ours");
    writeFile(fx.root, "leftover.conflict-from-OldPhone-2026-05-26T10-30-00Z.md", "theirs");
    writeFile(fx.root, "real.md", "ours");
    await createTracked(fx, "real.md", "Laptop");
    modal.decision = "sync-anyway";

    const { plugin } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.constructed).toBe(1);
    expect(modal.paths).toEqual(["real.md"]); // synthetic "leftover.md" excluded
  });

  it('live conflict + "sync-anyway" → proceeds, modal shown with the base path', async () => {
    writeFile(fx.root, "live.md", "ours");
    await createTracked(fx, "live.md", "Phone");
    modal.decision = "sync-anyway";

    const { plugin, openSpy } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(modal.constructed).toBe(1);
    expect(modal.paths).toEqual(["live.md"]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('live conflict + "cancel" → aborts sync', async () => {
    writeFile(fx.root, "live.md", "ours");
    await createTracked(fx, "live.md", "Phone");
    modal.decision = "cancel";

    const { plugin, openSpy } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('live conflict + "resolve" → aborts sync AND opens the diff conflicts panel (§24, NOT the sibling .md)', async () => {
    writeFile(fx.root, "live.md", "ours");
    await createTracked(fx, "live.md", "Phone");
    modal.decision = "resolve";

    const { plugin, openSpy, activateSpy } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(false);
    expect(activateSpy).toHaveBeenCalledTimes(1); // diff panel activated
    expect(openSpy).not.toHaveBeenCalled(); // NOT the raw markdown sibling
  });

  it('"resolve" with panel activation throwing → logs the error and still aborts (no throw)', async () => {
    writeFile(fx.root, "live.md", "ours");
    await createTracked(fx, "live.md", "Phone");
    modal.decision = "resolve";

    const { plugin, errorSpy } = makeGate(fx.vault, fx.store, () =>
      Promise.reject(new Error("boom")),
    );
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // THE REGRESSION (bug: already-resolved conflict re-appears in the sync modal). A
  // conflict resolved in diff2 leaves its ConflictStore record behind until the next
  // drain's evaluateConflictState drops it (Phase A: !siblingExists → accept-ours). The
  // gate must NOT surface it — it must show ONLY conflicts whose sibling is still live.
  it("EXCLUDES a resolved conflict (sibling deleted, record lingers); modal lists only the live one", async () => {
    // Resolved: tracked record exists, but the user's resolution deleted the sibling.
    writeFile(fx.root, "resolved.md", "merged");
    const resolved = await createTracked(fx, "resolved.md", "Phone");
    fs.rmSync(path.join(fx.root, resolved.siblingPath)); // diff2 removed the sibling on resolve

    // Live: still-unresolved, sibling on disk.
    writeFile(fx.root, "live.md", "ours");
    await createTracked(fx, "live.md", "Laptop");

    // The stale entry is still in the store (process_conflicts hasn't pruned) — the OLD
    // gate read raw records and re-surfaced "resolved.md".
    expect([...fx.store.getCachedState().entries.keys()].sort()).toEqual([
      "live.md",
      "resolved.md",
    ]);

    modal.decision = "cancel";
    const { plugin } = makeGate(fx.vault, fx.store);
    await plugin.confirmPendingConflictsBeforeSync();

    // The modal was handed ONLY the live conflict — the resolved phantom is gone.
    expect(modal.constructed).toBe(1);
    expect(modal.paths).toEqual(["live.md"]);
  });
});
