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
// The §8.1.5a gitignore gate's modal. Same hoisting reason as below.
const giModal = vi.hoisted(() => ({
  opts: null as null | {
    title: string;
    body: string[];
    paths?: string[];
    resolveLabel?: string;
    dismissLabel: string;
  },
  constructed: 0,
  decision: "dismiss" as "resolve" | "dismiss",
}));
// §8.1.5b — only the "has it finished?" question is faked; the rest of the
// migration module stays real, so a change to it still reaches this file.
// Defaults to DONE: every other block in this file is about the conflict
// gate, and the §8.1.5b wait sits in front of it. Only the wait tests turn
// it off.
const migration = vi.hoisted(() => ({ done: true }));
vi.mock("../src/sync2/gitignore-migration", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/sync2/gitignore-migration")
  >()),
  isMigrationDone: async () => migration.done,
}));

// The §8.1.5b analysis wait. Its `prompt()` resolves only when the test
// says so, which is what lets a test drive the RACE deliberately instead
// of hoping about timing.
const waitModal = vi.hoisted(() => ({
  constructed: 0,
  finished: 0,
  resolve: null as null | ((o: "finished" | "cancelled") => void),
}));
vi.mock("../src/sync2/views/gitignore-analysis-modal", () => ({
  GitignoreAnalysisModal: class {
    constructor() {
      waitModal.constructed++;
    }
    finish() {
      waitModal.finished++;
      waitModal.resolve?.("finished");
    }
    prompt() {
      return new Promise((r) => {
        waitModal.resolve = r as (o: "finished" | "cancelled") => void;
      });
    }
  },
}));
vi.mock("../src/sync2/views/gitignore-modal", () => ({
  GitignoreDecisionModal: class {
    constructor(_app: unknown, opts: never) {
      giModal.opts = opts;
      giModal.constructed++;
    }
    prompt() {
      return Promise.resolve(giModal.decision);
    }
  },
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
  confirmPendingConflictsBeforeSync(origin?: "user" | "auto"): Promise<boolean>;
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
    // The §8.1.5a gate logs a WARN before it blocks; without it here the
    // stub threw and the catch's own warn threw again, so the gate looked
    // broken when only the harness was.
    logger: { error: errorSpy, warn: vi.fn(), info: vi.fn() },
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


describe("§8.1.5a the .gitignore gate is a MODAL and blocks unconditionally", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    fx = fixture();
    await fx.store.load();
    giModal.opts = null;
    giModal.constructed = 0;
    giModal.decision = "dismiss";
    modal.constructed = 0;
  });
  afterEach(() => {
    if (fs.existsSync(fx.root)) fs.rmSync(fx.root, { recursive: true, force: true });
  });

  const PROPOSAL =
    ".gitignore.conflict-from-Old gitignore files-2026-09-28T10-00-00Z";

  it("🔑 blocks even when the user dismisses — there is no 'sync anyway'", async () => {
    // The whole point of the hard gate. A dismissal is "not now", never
    // "go ahead": these rules decide what gets synced at all.
    writeFile(fx.root, ".gitignore", ".*\n");
    writeFile(fx.root, PROPOSAL, "proposed\n");
    const { plugin, activateSpy } = makeGate(fx.vault, fx.store);

    giModal.decision = "dismiss";
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(false);
    expect(giModal.constructed).toBe(1);
    // Dismiss must NOT drag the user into the panel they just declined.
    expect(activateSpy).not.toHaveBeenCalled();
    // …and the ordinary conflict modal never gets a turn: the gate
    // returned first.
    expect(modal.constructed).toBe(0);
  });

  it("🔑 'Solve conflict' opens the panel, and still does not sync", async () => {
    writeFile(fx.root, ".gitignore", ".*\n");
    writeFile(fx.root, PROPOSAL, "proposed\n");
    const { plugin, activateSpy } = makeGate(fx.vault, fx.store);

    giModal.decision = "resolve";
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(false);
    expect(activateSpy).toHaveBeenCalledTimes(1);
  });

  it("names the file and offers both buttons", async () => {
    // The user is asked to judge a specific file; a modal that does not
    // say which one is asking them to guess.
    writeFile(fx.root, ".gitignore", ".*\n");
    writeFile(fx.root, PROPOSAL, "proposed\n");
    const { plugin } = makeGate(fx.vault, fx.store);
    await plugin.confirmPendingConflictsBeforeSync();

    expect(giModal.opts?.paths).toEqual([".gitignore"]);
    expect(giModal.opts?.resolveLabel).toBe("Solve conflict");
    expect(giModal.opts?.dismissLabel).toBe("Cancel");
  });

  it("🔑 a BACKGROUND tick never opens a dialog — it skips quietly", async () => {
    // The contract was already written, in PreSyncConflictModal's own
    // header: "Background drains (interval tick, watchdog, onload
    // startup) skip the modal — they're not user-driven and a blocking
    // dialog would surprise the user." Nothing enforced it, for either
    // gate, so an interval tick popped a modal at whatever the user
    // happened to be doing.
    writeFile(fx.root, ".gitignore", ".*\n");
    writeFile(fx.root, PROPOSAL, "proposed\n");
    const { plugin, activateSpy } = makeGate(fx.vault, fx.store);

    expect(await plugin.confirmPendingConflictsBeforeSync("auto")).toBe(false);
    expect(giModal.constructed).toBe(0);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("…and the TRACKED gate is quiet on background too", async () => {
    // Same defect one layer down: §24's modal fronted every path,
    // background included.
    writeFile(fx.root, "note.md", "ours");
    await createTracked(fx, "note.md", "Phone");
    const { plugin } = makeGate(fx.vault, fx.store);

    expect(await plugin.confirmPendingConflictsBeforeSync("auto")).toBe(false);
    expect(modal.constructed).toBe(0);
  });

  it("the OUTCOME is unchanged — background was already being skipped", async () => {
    // Removing a dialog must not quietly start letting syncs through:
    // the modal's default decision was "cancel", so a background tick
    // with conflicts was refused before this change too.
    writeFile(fx.root, "note.md", "ours");
    await createTracked(fx, "note.md", "Phone");
    const { plugin } = makeGate(fx.vault, fx.store);
    modal.decision = "cancel";
    expect(await plugin.confirmPendingConflictsBeforeSync("user")).toBe(false);
  });

  it("a clean vault never shows it, and the ordinary gate still runs", async () => {
    // Without this, a gate that fired unconditionally would pass every
    // test above while blocking every sync in the product.
    writeFile(fx.root, ".gitignore", ".*\n");
    const { plugin } = makeGate(fx.vault, fx.store);
    expect(await plugin.confirmPendingConflictsBeforeSync()).toBe(true);
    expect(giModal.constructed).toBe(0);
  });
});


const ANALYSIS_QUIET_MS = 3000; // mirrors main.ts

describe("§8.1.5b the analysis wait", () => {
  let fx: ReturnType<typeof fixture>;

  beforeEach(async () => {
    vi.useFakeTimers();
    fx = fixture();
    await fx.store.load();
    waitModal.constructed = 0;
    waitModal.finished = 0;
    waitModal.resolve = null;
    giModal.constructed = 0;
    giModal.decision = "dismiss";
  });
  afterEach(() => {
    vi.useRealTimers();
    if (fs.existsSync(fx.root)) fs.rmSync(fx.root, { recursive: true, force: true });
  });

  // A gate instance whose analysis is under the test's control.
  function makeWaitingGate(done: boolean) {
    const { plugin, activateSpy } = makeGate(fx.vault, fx.store);
    let release: ((r: unknown) => void) | null = null;
    const analysis = new Promise<unknown>((r) => {
      release = r;
    });
    migration.done = done;
    Object.assign(plugin, {
      migrationDeps: () => ({}),
      startMigrationAnalysis: () => analysis,
      analysisDirs: 7,
    });
    return {
      plugin,
      activateSpy,
      // `conflictPath` is what decides whether the sync continues.
      release: (conflictPath: string | null = null) =>
        release?.({ kind: "migrated", sources: [], conflictPath }),
    };
  }

  it("🔑 [Back] CANCELS the sync — it is not 'wait longer'", async () => {
    // The owner was explicit: the click is undone. Anything else would
    // leave a user who dismissed a dialog wondering whether a sync ran.
    const { plugin, release } = makeWaitingGate(false);
    const gate = plugin.confirmPendingConflictsBeforeSync("user");
    await vi.advanceTimersByTimeAsync(ANALYSIS_QUIET_MS + 10);
    waitModal.resolve?.("cancelled");
    expect(await gate).toBe(false);
    release(null);
  });

  it("🔑 finishing with NO proposal CONTINUES the click — the sync runs", async () => {
    const { plugin, release } = makeWaitingGate(false);
    const gate = plugin.confirmPendingConflictsBeforeSync("user");
    await vi.advanceTimersByTimeAsync(ANALYSIS_QUIET_MS + 10);
    release(null);
    expect(await gate).toBe(true);
    // Closed from the outside rather than left on screen.
    expect(waitModal.finished).toBeGreaterThan(0);
  });

  it("🔑 a proposal STOPS the sync, and does NOT add a second window", async () => {
    // The owner was explicit: after the analysis it is the SCAN-RESULT
    // window that speaks — the one the background pass shows — not the
    // "Sync paused" one, which is for a LATER click against a conflict
    // that already exists. Two windows for one event is the bug.
    const { plugin, release } = makeWaitingGate(false);
    const gate = plugin.confirmPendingConflictsBeforeSync("user");
    await vi.advanceTimersByTimeAsync(ANALYSIS_QUIET_MS + 10);
    release("proposal-path");
    expect(await gate).toBe(false);
    expect(giModal.constructed).toBe(0);
  });

  it("🔑 a click inside the QUIET window shows no dialog at all", async () => {
    // Desktop finishes the whole walk in ~300 ms, so a click almost always
    // lands here. Flashing a dialog for a third of a second would be worse
    // than the wait it announces.
    const { plugin, release } = makeWaitingGate(false);
    const gate = plugin.confirmPendingConflictsBeforeSync("user");
    await vi.advanceTimersByTimeAsync(100);
    release(null);
    expect(await gate).toBe(true);
    expect(waitModal.constructed).toBe(0);
  });

  it("a BACKGROUND tick never opens the wait — it just skips", async () => {
    const { plugin, release } = makeWaitingGate(false);
    expect(await plugin.confirmPendingConflictsBeforeSync("auto")).toBe(false);
    expect(waitModal.constructed).toBe(0);
    release(null);
  });

  it("once the marker is down the wait never appears again", async () => {
    // Without this, "always wait" would satisfy every test above while
    // making every sync in the product stop for a dialog.
    const { plugin } = makeWaitingGate(true);
    expect(await plugin.confirmPendingConflictsBeforeSync("user")).toBe(true);
    expect(waitModal.constructed).toBe(0);
  });
});
