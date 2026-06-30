// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import {
  App,
  EventRef,
  MarkdownView,
  Menu,
  Platform,
  Plugin,
  WorkspaceLeaf,
  Notice,
  setTooltip,
} from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import Logger from "./logger";
import { describeError } from "./utils";
import GithubClient from "./github/client";
import GI from "./gi";
import SnapshotStore from "./sync2/snapshot-store";
import { AtomicWriteRecovery } from "./sync2/atomic-write";
import ChangeDetector from "./sync2/change-detector";
import PushQueue from "./sync2/push-queue";
import TreeBuilder from "./sync2/tree-builder";
import GitignoreInvariants from "./sync2/gitignore-invariants";
import { Sync2Manager } from "./sync2/sync2-manager";
import { IntervalScheduler } from "./sync2/interval-scheduler";
import ConflictStore from "./sync2/conflict-store";
import PendingDeletionsStore from "./sync2/pending-deletions-store";
import { ConflictCounter } from "./sync2/conflict-counter";
import { ConflictWatcher } from "./sync2/conflict-watcher";
import {
  buildStatusMenu,
  diffTooltip,
  statusBarSuffix,
  statusMenuState,
  syncTooltip,
  type MenuActionKey,
} from "./status-bar-model";
import WorkerClient from "./worker/worker-client";
import { PreSyncConflictModal } from "./sync2/views/pre-sync-conflict-modal";
import { TrashStore } from "./diff2/trash-store";
import { TrashWatcher } from "./diff2/trash-watcher";
import { sweepOnload as trashSweepOnload } from "./diff2/trash-recovery";
import { recoverAutosaveDirs } from "./diff2/onload-recovery";
import { setAutosaveRoot } from "./diff2/autosave-store";
import { DiffEditView, DIFF2_EDIT_VIEW_TYPE, type DiffEditViewDeps } from "./diff2/diff-edit-view";
import { DiffEditorView, DIFF2_EDITOR_VIEW_TYPE } from "./diff2/diff-editor-view";
import {
  alignOpenDescs,
  openDescFor,
  openGuard,
  type EditorTabState,
} from "./diff2/editor-tabs";
import { EditorBusyModal } from "./diff2/recovery-dialog";
import {
  autosaveIdForEntry,
  findAllConflicts,
  type ConflictEntry,
} from "./diff2/synthetic-detector";
import { TokenExpiredModal } from "./sync2/views/token-expired-modal";
import { CancelSyncModal } from "./sync2/views/cancel-sync-modal";
import { AuthError } from "./errors";
import { TokenExpiredFlag } from "./token-expired-flag";
import {
  runSelfUpdateBootloader,
  extractAffectedPluginId,
} from "./sync2/plugin-update-bootloader";
import manifest from "../manifest.json";

// How long the brief local-phase notices stay visible. 700ms is the
// sweet spot — long enough to read "Commit 3 files" without rushing,
// short enough that consecutive Sync clicks don't stack notices.
const BRIEF_NOTICE_MS = 700;

// Delay before the startup sync fires after layout-ready. Long enough for
// (a) an outgoing instance's drain teardown to settle across a disable+enable
// plugin reload, AND (b) Obsidian's own startup config-write storm to FINISH —
// at launch Obsidian rewrites .obsidian/app.json / appearance.json /
// core-plugins.json (loading core plugins, applying appearance), and a sync that
// races it reads transient versions → spurious "modified" detections + the
// ENOENT vanish window (SYNC2 §7.7). A field log on Android showed the storm
// still active ~1.9 s after onload, so 1500 ms wasn't enough; 5 s clears it with
// margin while staying imperceptible-enough for a startup sync. Manual [Sync]
// is unaffected (fires immediately). See the onLayoutReady startup-sync block.
const STARTUP_SYNC_DELAY_MS = 5000;

// Internal Obsidian plugin-manager surface we touch for the
// BRAT-style auto-reload (§20/§21). None of these are in the public
// typings; we feature-detect each.
interface ObsidianPluginManager {
  enabledPlugins?: Set<string>;
  reloadPlugin?: (id: string) => Promise<void>;
  disablePlugin?: (id: string) => Promise<void>;
  enablePlugin?: (id: string) => Promise<void>;
}

function pluginManagerOf(app: App): ObsidianPluginManager | undefined {
  return (app as unknown as { plugins?: ObsidianPluginManager }).plugins;
}

// True when SOME reload mechanism is available — `reloadPlugin`
// (desktop) OR the `disablePlugin` + `enablePlugin` pair (universal,
// including Obsidian Mobile, where `reloadPlugin` does NOT exist —
// the field-reported 2026-05-31 bug).
function canReloadPlugins(pm: ObsidianPluginManager | undefined): boolean {
  if (!pm) return false;
  if (typeof pm.reloadPlugin === "function") return true;
  return (
    typeof pm.disablePlugin === "function" &&
    typeof pm.enablePlugin === "function"
  );
}

// Reload a plugin by id. Prefers the single-call `reloadPlugin` when
// present; otherwise falls back to disable-then-enable, which is what
// BRAT uses and what works on Obsidian Mobile. For self-reload the
// caller schedules this on a timeout so the current stack unwinds
// before `disablePlugin(self)` tears the running instance down; the
// new code is already on disk (the marker swap completed), so
// `enablePlugin` loads it.
async function reloadPluginById(app: App, id: string): Promise<void> {
  const pm = pluginManagerOf(app);
  if (!pm) throw new Error("app.plugins unavailable");
  if (typeof pm.reloadPlugin === "function") {
    await pm.reloadPlugin(id);
    return;
  }
  if (
    typeof pm.disablePlugin === "function" &&
    typeof pm.enablePlugin === "function"
  ) {
    await pm.disablePlugin(id);
    await pm.enablePlugin(id);
    return;
  }
  throw new Error("no reload mechanism available (reloadPlugin / disable+enable)");
}

// Plugin entry point. Orchestrates Sync2Manager + ConflictStore;
// commands, ribbons, settings tab, and IntervalScheduler wiring live
// here.
export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  // Sync2Manager + ConflictStore are constructed once during onload
  // and live for the plugin's lifetime. No more nullable engine
  // pointers — the runtime is single-engine.
  sync2Manager!: Sync2Manager;
  conflictStore!: ConflictStore;
  pendingDeletions!: PendingDeletionsStore;
  conflictWatcher!: ConflictWatcher;
  conflictCounter!: ConflictCounter;
  // diff2 trash subsystem (see docs/DIFF2_IMPLEMENTATION_PLAN.md §R3).
  // TrashStore is the data layer; TrashWatcher monkey-patches
  // vault.delete/trash to feed user-driven deletes into the store.
  // Both live for the plugin's lifetime; the watcher is uninstalled
  // in onunload to restore the original vault methods.
  trashStore!: TrashStore;
  private trashWatcher: TrashWatcher | null = null;
  logger!: Logger;
  // E1 (TODO §5) — persistent ".token_expired" marker; in-memory authoritative,
  // file best-effort. Set/cleared per-drain (note()) + on the settings probe;
  // read by the §7 status-bar menu (isExpiredCached) + Settings.
  tokenExpiredFlag: TokenExpiredFlag | null = null;
  // Shared Worker orchestra controller — lazy-init at onload, kept
  // alive for the plugin lifetime, terminated on onunload. Stage 4
  // routes hot-path CPU operations (SHA computation, base64 decode,
  // 3-way merge) through this orchestra. Threshold-gated: small
  // inputs run inline on the main thread; only large ones round-trip
  // to the worker pool.
  workerClient!: WorkerClient;
  // Exposed for the settings tab's "Push plugins data.json" toggle,
  // which reads/writes the allow line directly via this owner.
  invariants!: GitignoreInvariants;
  // Cached value of the toggle for synchronous use in the settings
  // tab. Refreshed at onload from invariants.getPushPluginsDataJson()
  // and after every successful set from the tab's onChange. Settings
  // tab must NOT call toggle.setValue() from an async context — for
  // reasons we don't fully understand, doing so triggers an infinite
  // re-entry inside Obsidian's settings pipeline and freezes the
  // renderer. Synchronous read of this cache sidesteps the issue.
  pushPluginsDataJsonCached: boolean = false;

  // Stage 7 / token-expiry UX. We throttle the
  // "GitHub token expired" modal to at most once per hour so a
  // background-drain failure every 5 minutes doesn't spam the
  // user. Set to 0 (never shown) on plugin onload; updated to
  // Date.now() each time the modal opens.
  private lastAuthModalShownMs = 0;

  // UI elements that come and go with toggle settings.
  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  // E2 (TODO §6): the conflict count is folded into the single "GitHub"
  // status-bar item (statusBarItem) — the separate 🔀 indicator was removed.
  // SYNC2 §4.3: the ribbon sync-icon's badge now shows
  // push-queue depth (count of pending batches in .push-queue/),
  // not the unresolved-conflict count. Fed by Sync2Manager's
  // onQueueDepthChanged callback.
  ribbonPendingBatchesBadge: HTMLElement | null = null;
  // 2.0.2-beta2: parallel badge for the [Commit] ribbon icon. The
  // badge follows whichever icon is visible — when [Sync] is
  // hidden but [Commit] is shown, the user still sees the queue
  // depth on the icon they CAN see. See refreshRibbonPendingBatchesBadge.
  commitRibbonPendingBatchesBadge: HTMLElement | null = null;
  // E3 (R2.7.4) — separate diff-panel ribbon icon + its own conflict-count
  // badge (red; unresolved conflicts). Independent of the sync/commit badge
  // routing — green=outgoing commits, red=conflicts needing attention.
  diffRibbonIcon: HTMLElement | null = null;
  diffRibbonConflictBadge: HTMLElement | null = null;
  // 2.0.2-beta2: latest known queue depth, kept here so a settings
  // toggle that hides one icon and shows another can repaint the
  // badge without re-querying the on-disk queue.
  private currentQueueDepth: number = 0;

  // Vault listeners — sibling-file delete/rename closes the matching
  // conflict record. Refs kept so we can offref them on unload.
  vaultDeleteListener: EventRef | null = null;
  vaultRenameListener: EventRef | null = null;

  // Auto-sync timer id (Window.setInterval handle). Retained for the
  // registerInterval() bookkeeping Obsidian wants on unload; the
  // tick + startup logic itself lives in IntervalScheduler.
  private syncIntervalId: number | null = null;
  private intervalScheduler!: IntervalScheduler;
  // Pending startup-sync timer (set in onLayoutReady, cleared on fire
  // or in onunload). Delaying the startup sync avoids racing a prior
  // instance's drain teardown across a plugin reload.
  private startupSyncTimer: number | null = null;

  // 2.0.2-beta2: ribbon "syncing" affordance. A drain-status
  // subscription toggles a CSS class on the ribbon icons while a
  // drain runs (spin + accent tint). `drainRunning` caches the
  // latest state so an icon created AFTER a drain starts (layout
  // ready races, settings toggles) picks up the right look.
  private drainStatusRibbonUnsub: (() => void) | null = null;
  private drainRunning = false;

  async onUserEnable(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Go to settings to configure syncing");
    }
  }

  async onload(): Promise<void> {
    const startedAt = Date.now();
    try {
      // 2.0.2-beta2 self-update bootloader. Runs BEFORE loadSettings,
      // before logger init, before anything else — handles pending
      // sync-tmp + marker pairs for OUR plugin's main.js /
      // manifest.json / styles.css left by a previous self-update
      // that crashed mid-protocol. If the bootloader applies any
      // swap, it schedules reloadPlugin and we ABORT the rest of
      // onload (we'll be re-entered with the NEW code in ~500ms).
      try {
        const bootloaderResult = await runSelfUpdateBootloader({
          adapter: this.app.vault.adapter,
          pluginDir: `${this.app.vault.configDir}/plugins/${manifest.id}`,
          pluginLabel: manifest.id,
          reloadPlugin: () => {
            void reloadPluginById(this.app, manifest.id).catch((err) => {
              try {
                console.error(
                  "[github-easy-sync] self-reload failed",
                  err,
                );
              } catch {
                // ignore
              }
            });
          },
          notice: (msg, durationMs) => new Notice(msg, durationMs),
        });
        if (bootloaderResult.action === "applied") {
          // Reload is scheduled. Don't continue onload — old code
          // would just run briefly then get torn down.
          return;
        }
      } catch (err) {
        // Bootloader is best-effort. If it throws, fall through to
        // normal onload — the next drain may recover.
        try {
          console.error(
            "[github-easy-sync] Self-update bootloader threw, continuing normal onload",
            err,
          );
        } catch {
          // ignore
        }
      }

      await this.loadSettings();
      this.logger = new Logger(
        this.app.vault,
        manifest.id,
        this.settings.enableLogging,
      );
      await this.logger.init();
      // E1 — seed the persistent token-expired marker from disk (one exists()).
      this.tokenExpiredFlag = new TokenExpiredFlag(
        this.app.vault,
        `${this.app.vault.configDir}/plugins/${manifest.id}`,
      );
      await this.tokenExpiredFlag.init();
      this.logger.info("Plugin onload start", {
        version: manifest.version,
        deviceLabel: this.settings.deviceLabel,
        enableLogging: this.settings.enableLogging,
        syncStrategy: this.settings.syncStrategy,
        configured: this.isConfigured(),
      });
      // Stage 7: surface the manual-migration notice once Logger
      // is initialised. Visible via the plugin log file AND as a
      // long-duration Notice so the user can act without trawling
      // the log.
      if (this.settingsMigrationNotice !== null) {
        this.logger.info(this.settingsMigrationNotice);
        try {
          new Notice(this.settingsMigrationNotice, 30000);
        } catch {
          // Notice may not be available in some environments
        }
      }

      this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));
      this.logger.info("Plugin onload: settings tab registered");

      await this.initSync2();
      this.logger.info("Plugin onload: initSync2 done");

      this.app.workspace.onLayoutReady(() => {
        if (this.settings.showStatusBarItem) this.showStatusBarItem();
        if (this.settings.showSyncRibbonButton) this.showSyncRibbonIcon();
        if (this.settings.showCommitRibbonButton)
          this.showCommitRibbonIcon();
        if (this.settings.showDiffRibbonButton ?? true)
          this.showDiffRibbonIcon();

        // Delay BOTH the interval scheduler AND the startup sync past the
        // STARTUP_SYNC_DELAY_MS window — so NO timer (periodic tick, watchdog,
        // or the one-shot startup pulse) can race Obsidian's startup
        // config-write storm (SYNC2 §7.7) or a prior instance's drain teardown
        // (disable+enable reload). The interval start is unconditional (it runs
        // even with syncOnStartup off — interval cadence / 5-min watchdog);
        // the startup pulse only fires when opted in + configured. Tracked so
        // onunload can cancel the whole thing if we unload before it fires.
        this.startupSyncTimer = window.setTimeout(() => {
          this.startupSyncTimer = null;
          this.startSyncInterval();
          this.logger.info("Plugin onload: interval scheduler started");
          if (this.settings.syncOnStartup && this.isConfigured()) {
            void this.runStartupSync();
          }
        }, STARTUP_SYNC_DELAY_MS);
      });

      // 2.0.2-beta2 command surface — 5 actions, each hotkey-bindable.
      //
      //   commit-all  : commit every modified non-ignored file
      //                 (the ribbon [Commit] button calls this too).
      //   commit-file : commit the file in the active tab; if
      //                 in .gitignore, surface a Notice so the user
      //                 understands the no-op (single-file action
      //                 deserves explicit feedback, unlike bulk).
      //   pull-push   : drain only — pulls remote changes AND
      //                 pushes pending batches, but never adds a
      //                 new commit. Silent no-op if drain already
      //                 running (the existing drain's tail re-check
      //                 catches any in-flight batch).
      //   sync        : same as the [Sync with GitHub] ribbon button.
      //                 Master-toggle aware: "commit + pull-push"
      //                 when syncStartsWithCommit is true,
      //                 "pull-push" only when false. The ribbon
      //                 variant adds a confirmation modal on second
      //                 click during an in-flight sync.
      //   cancel-sync : abort the currently-running drain; silent
      //                 no-op if nothing is running.
      this.addCommand({
        id: "commit-all",
        name: "Commit all changed files",
        icon: "git-commit",
        callback: this.commit.bind(this),
      });
      this.addCommand({
        id: "commit-file",
        name: "Commit active file",
        icon: "file-plus",
        callback: this.commitFile.bind(this),
      });
      this.addCommand({
        id: "pull-push",
        name: "Pull from repo and push stored commits",
        icon: "arrow-down-up",
        callback: this.uploadOnly.bind(this),
      });
      this.addCommand({
        id: "sync",
        name: "Sync with GitHub",
        icon: "refresh-cw",
        callback: this.sync.bind(this),
      });
      this.addCommand({
        id: "cancel-sync",
        name: "Cancel sync",
        icon: "x-circle",
        callback: this.cancelSync.bind(this),
      });

      // Diff-Edit widget — Phase 1 (conflicts list + sub-tabs + stub
      // detail view). Registers the view type so workspace can
      // instantiate it; dependencies (vault, conflictStore,
      // conflictCounter) passed via closure since the view needs
      // them to populate the list and react to changes.
      // Panel host (singleton, list↔detail) and the multi-tab editor host
      // (one per base:sibling pair, S3) share the SAME dependency object.
      this.registerView(
        DIFF2_EDIT_VIEW_TYPE,
        (leaf) => new DiffEditView(leaf, this.diffViewDeps()),
      );
      this.registerView(
        DIFF2_EDITOR_VIEW_TYPE,
        (leaf) => new DiffEditorView(leaf, this.diffViewDeps()),
      );
      this.addCommand({
        id: "open-diff-edit",
        name: "Open Diff-Edit",
        icon: "git-merge",
        callback: () => this.activateDiffEditView(),
      });
      // Stub commands — Phase 8 (Compare) and Phase 7 (History) replace
      // these with real picker / version-list flows. Phase 0 just routes
      // into the empty view so the commands are discoverable in the
      // palette from day one.
      this.addCommand({
        id: "diff-edit-compare-two",
        name: "Compare two files…",
        callback: () => this.activateDiffEditView(),
      });
      this.addCommand({
        id: "diff-edit-compare-active",
        name: "Compare active file with…",
        callback: () => this.activateDiffEditView(),
      });
      this.addCommand({
        id: "diff-edit-show-history",
        name: "Show history of active file",
        callback: () => this.activateDiffEditView(),
      });

      this.logger.info(
        `Plugin onload complete (duration=${Date.now() - startedAt}ms)`,
      );
    } catch (err) {
      // Best-effort crash log. Writes to a fixed-name file at the
      // vault root so a Mac/Android user can grab it via adb / Files
      // even when the plugin failed before Logger was ready. Always
      // attempts logger.error first (works if we got past
      // logger.init); falls back to direct adapter.write otherwise.
      const stack = (err as Error)?.stack ?? "";
      const message = `Plugin onload FAILED: ${err}`;
      console.error(message, err);
      try {
        if (this.logger) {
          this.logger.error(message, { stack });
        }
      } catch {}
      try {
        await this.app.vault.adapter.append(
          `${manifest.id}-crash.log`,
          `[${new Date().toISOString()}] ${message}\n${stack}\n\n`,
        );
      } catch {}
      try {
        new Notice(`${manifest.id} failed to start: ${err}`, 30000);
      } catch {}
      throw err;
    }
  }

  async onunload(): Promise<void> {
    // 2.0.2-beta2 hardening (SYNC2-TODO "drain overlap spanning a
    // plugin reload"). Abort any in-flight drain on THIS (outgoing)
    // instance before teardown completes, so it can't keep pushing
    // while the incoming instance's startup sync fires. Without this,
    // the disable+enable reload path could leave two drains running —
    // the old instance's and the new one's — racing to push the same
    // deterministic commit, which is what produced the ref-update 422
    // hang on desktop. cancelDrain is a no-op when nothing is running;
    // the drain loop checks abortRequested between batches/files and
    // bails cleanly. stopSyncInterval() below clears the timer so no
    // fresh tick starts a drain during teardown.
    try {
      this.sync2Manager?.cancelDrain();
    } catch (err) {
      this.logger?.warn("onunload: cancelDrain failed", { err: `${err}` });
    }
    // Cancel a still-pending startup sync so it can't fire on an
    // unloaded instance (e.g. a reload during the startup delay).
    if (this.startupSyncTimer !== null) {
      window.clearTimeout(this.startupSyncTimer);
      this.startupSyncTimer = null;
    }
    // Drop the ribbon drain-status subscription.
    this.drainStatusRibbonUnsub?.();
    this.drainStatusRibbonUnsub = null;
    this.stopSyncInterval();
    if (this.vaultDeleteListener) {
      this.app.vault.offref(this.vaultDeleteListener);
      this.vaultDeleteListener = null;
    }
    if (this.vaultRenameListener) {
      this.app.vault.offref(this.vaultRenameListener);
      this.vaultRenameListener = null;
    }
    this.conflictWatcher?.stop();
    // Restore vault.delete/trash to whatever they were when our
    // install() ran. Other plugins that patched on top of us stay
    // untouched (LIFO unwrap — see TrashWatcher class doc).
    if (this.trashWatcher) {
      try {
        this.trashWatcher.uninstall();
      } catch (err) {
        this.logger?.warn("TrashWatcher uninstall failed", { err: `${err}` });
      }
      this.trashWatcher = null;
    }
    // Detach any open Diff-Edit / Diff-Editor view leaves so they don't
    // linger in a broken state after the plugin disables. Obsidian would
    // eventually GC them but explicit cleanup keeps the workspace
    // state-store tidy. (1A: editors are ephemeral — detaching here removes
    // them from the serialized layout so they don't restore empty on reload;
    // 1B drops the editor detach and adds getState-restore.)
    this.app.workspace.detachLeavesOfType(DIFF2_EDIT_VIEW_TYPE);
    this.app.workspace.detachLeavesOfType(DIFF2_EDITOR_VIEW_TYPE);
    // Terminate Worker pool — each Worker holds Blob URLs + a thread
    // that the OS would otherwise keep alive until process exit.
    this.workerClient?.terminate();
  }

  // ── settings ────────────────────────────────────────────────────────

  // Stage 7 migration notice — populated by loadSettings when an
  // old key name is detected in data.json. The text is buffered
  // here because loadSettings runs BEFORE Logger init in onload;
  // onload prints this once Logger is up.
  private settingsMigrationNotice: string | null = null;

  async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

    // §2.2.14 — diffEditorTouchMode has a PLATFORM-DEPENDENT default (desktop=false,
    // mobile=true) that a static DEFAULT_SETTINGS can't express. Apply + persist it the
    // first time the setting is created (absent from data.json — fresh install or the
    // pre-feature data.json). Once written, the stored value (incl. a user toggle) wins.
    if (this.settings.diffEditorTouchMode === undefined) {
      this.settings.diffEditorTouchMode = Platform.isMobile;
      await this.saveSettings();
    }

    // Stage 7 manual data.json migration detection. The user base
    // is currently one person with two devices; the maintainer
    // updates data.json by hand on each device. loadSettings
    // detects the OLD key names if present and stages a log line
    // for onload to surface — no runtime migration code path,
    // just a one-time observation.
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      const renames: Array<[string, string]> = [
        ["autoCommitOnSync", "syncStartsWithCommit"],
        ["accumulateOfflineSyncs", "consolidateCommits"],
      ];
      const found: Array<[string, string, unknown]> = [];
      for (const [oldName, newName] of renames) {
        if (oldName in rec) {
          found.push([oldName, newName, rec[oldName]]);
        }
      }
      if (found.length > 0) {
        const lines = found.map(
          ([o, n, v]) => `  • ${o} (currently ${JSON.stringify(v)}) → ${n}`,
        );
        this.settingsMigrationNotice =
          "Stage 7 settings rename detected — update each device's data.json:\n" +
          lines.join("\n") +
          "\nThe OLD keys are still loaded for now but no longer read by the engine. " +
          "Removing them is safe; see docs/tasks/SYNC2-WORKER-REORG.md §7.";
      }
    }
    // One-pass sanitize for GitHub identity fields: Android's
    // paste-with-suggestion-bar appends trailing whitespace silently,
    // and a single trailing space in any of these makes the entire
    // REST API answer 404 for the affected token (GitHub returns 404
    // rather than 401 for "valid token, repo outside scope" — which
    // covers the trailing-space case since `owner/repo` no longer
    // matches anything). Rewrite once on load so existing installs
    // self-heal without forcing the user to re-type each field.
    const before = JSON.stringify({
      t: this.settings.githubToken,
      o: this.settings.githubOwner,
      r: this.settings.githubRepo,
      b: this.settings.githubBranch,
    });
    this.settings.githubToken = (this.settings.githubToken ?? "").trim();
    this.settings.githubOwner = (this.settings.githubOwner ?? "").trim();
    this.settings.githubRepo = (this.settings.githubRepo ?? "").trim();
    this.settings.githubBranch = (this.settings.githubBranch ?? "").trim();
    const after = JSON.stringify({
      t: this.settings.githubToken,
      o: this.settings.githubOwner,
      r: this.settings.githubRepo,
      b: this.settings.githubBranch,
    });
    if (before !== after) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    return !!(
      this.settings.githubToken &&
      this.settings.githubOwner &&
      this.settings.githubRepo &&
      this.settings.githubBranch
    );
  }

  // "Reset" button in Settings. Panic button: wipes credentials,
  // snapshot, push-queue, conflict-store. Use cases:
  //   - token rotation after a suspected leak (kill any pending push
  //     before the new owner of the token can intercept it),
  //   - clean slate before reconfiguring against a different repo,
  //   - troubleshooting "something feels wrong" without uninstalling.
  //
  // Irreversible — the settings tab gates this behind a confirmation
  // modal. Settings are restored to DEFAULT_SETTINGS; the user has to
  // re-enter the GitHub token, owner, repo, branch before the next
  // sync will reach a remote.
  async resetPluginState(): Promise<void> {
    if (this.sync2Manager) {
      const store = (this.sync2Manager as unknown as { store: SnapshotStore })
        .store;
      const queue = (this.sync2Manager as unknown as { queue: PushQueue })
        .queue;
      store.clear();
      await store.save();
      await queue.clearAll();
    }
    if (this.conflictStore) {
      // Rename vault sibling files BEFORE dropping the record index,
      // so a future re-enable doesn't collide with the user's
      // leftover conflict-from artifacts.
      await this.conflictStore.renameVaultSiblingsToUnresolved();
      await this.conflictStore.clearAll();
    }
    if (this.pendingDeletions) {
      // SYNC2 §4.2 Reset semantics — pending-deletions
      // queue is plugin-managed state and gets wiped along with the
      // snapshot, conflict store, and push queue. No user data is
      // lost (the queue records intents to delete remote paths; on
      // Reset the user explicitly opts out of those intents).
      await this.pendingDeletions.clear();
    }
    if (this.trashStore) {
      // Same reset semantics as pending-deletions above: trash is
      // plugin-managed state; Reset explicitly opts out of pending
      // recovery for any previously-trashed files. See R3.5
      // closing-paragraph note on Reset uniformity.
      await this.trashStore.clearAll();
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    await this.saveSettings();
  }

  // One-pass migration from 2.0.1-beta2/beta3 phantom-snapshot entries
  // into the new pending-deletions queue (SYNC2 §4.2).
  // A phantom entry is a SnapshotStore row with mtime === 0 AND
  // size === 0 — the signature pull-side sanitize wrote when
  // recording "delete this forbidden GitHub path on next push"
  // intents before this refactor. Each such entry is moved to the
  // queue and removed from the snapshot; subsequent loads find
  // nothing to migrate (idempotent).
  //
  // No `observedAtCommit` is available in the phantom signature
  // (we never recorded it). We use `store.getLastSyncCommitSha()`
  // as the best approximation — it's the most recent commit this
  // device synced against and is therefore the latest point at
  // which the phantom's `remoteSha` was plausibly correct.
  // Empty string when lastSync is null (fresh install); in
  // practice that combination doesn't happen because phantoms only
  // exist after a sync that observed the forbidden path.
  private async migratePhantomSnapshotsToPendingDeletions(
    store: SnapshotStore,
    pendingDeletions: PendingDeletionsStore,
  ): Promise<void> {
    const observedAtCommit = store.getLastSyncCommitSha() ?? "";
    const migrated: string[] = [];
    for (const path of store.paths()) {
      const snap = store.get(path);
      if (!snap) continue;
      if (snap.mtime === 0 && snap.size === 0) {
        await pendingDeletions.add(path, {
          source: "migration-from-snapshot",
          observedAtCommit,
          remoteSha: snap.remoteSha,
        });
        store.remove(path);
        migrated.push(path);
      }
    }
    if (migrated.length > 0) {
      await store.save();
      this.logger.info(
        `Sync2 migration: phantom-snapshot → pending-deletions queue`,
        { count: migrated.length, paths: migrated },
      );
    }
  }

  // ── engine init ─────────────────────────────────────────────────────

  private async initSync2(): Promise<void> {
    // Keep the diff-editor autosave WITH the plugin's other data
    // (`<configDir>/plugins/<id>/.diff2-autosave/`) instead of cluttering the
    // vault root — and inside the plugin's gitignored area so it never syncs.
    // MUST run before recoverAutosaveDirs (and any startSession) below.
    setAutosaveRoot(`${this.app.vault.configDir}/plugins/${manifest.id}`);
    const vaultRoot =
      (this.app.vault.adapter as unknown as { basePath?: string }).basePath ??
      "";
    // Stage 6: construct WorkerClient BEFORE GithubClient so the
    // network worker handles every GitHub HTTP call. Same shared
    // workerClient is passed into Sync2Manager + PushQueue below.
    this.workerClient = new WorkerClient();
    const client = new GithubClient(
      this.settings,
      this.logger,
      this.workerClient,
    );
    const store = new SnapshotStore(this.app.vault);
    await store.load();
    this.logger.info("initSync2: SnapshotStore loaded", {
      lastSyncCommitSha: store.getLastSyncCommitSha(),
      paths: store.paths().length,
    });
    // AtomicWriteRecovery sweep runs AFTER ConflictStore.load (see
    // block below) so the sweep can resolve `.sync-tmp` staging
    // files owned by conflict records via record.theirsBlobSha
    // SHA-verify, not just snapshot-based reasoning.
    const gi = new GI(vaultRoot);
    const queue = new PushQueue({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      autoCanonicalize: () => this.settings.autoCanonicalizeTextFiles ?? false,
      workerClient: this.workerClient,
    });
    const detector = new ChangeDetector({
      vault: this.app.vault,
      store,
      gi,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      vaultRoot,
      syncConfigDir: () => this.settings.syncConfigDir ?? true,
      queue,
    });
    const builder = new TreeBuilder({
      vault: this.app.vault,
      queue,
      client,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    this.invariants = new GitignoreInvariants({
      vault: this.app.vault,
      store,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    // Prime the toggle cache once, here, so the settings tab can
    // read it synchronously without re-entering Obsidian via an
    // async setValue (see field doc above).
    try {
      this.pushPluginsDataJsonCached =
        await this.invariants.getPushPluginsDataJson();
    } catch {
      this.pushPluginsDataJsonCached = false;
    }
    const deviceLabel = this.settings.deviceLabel ?? "Obsidian";
    const conflictStore = new ConflictStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    await conflictStore.load();
    this.conflictStore = conflictStore;

    // Pending-deletions queue (SYNC2 §4.2). Replaces
    // the 2.0.1-beta2 phantom-snapshot trick: pull-side sanitize
    // records "delete this forbidden GitHub path on next push"
    // intent in this queue rather than as a phantom SnapshotStore
    // entry. On first plugin load after the 2.0.1-beta4 upgrade,
    // any leftover phantom entries in the snapshot get migrated
    // into the queue and removed from the snapshot.
    const pendingDeletions = new PendingDeletionsStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    await pendingDeletions.load();
    this.pendingDeletions = pendingDeletions;
    await this.migratePhantomSnapshotsToPendingDeletions(store, pendingDeletions);

    // diff2 TrashStore — captures user-driven deletes for one-drain-
    // cycle recovery (R3.4 + R3.5). Instantiated and recovery-swept
    // BEFORE Sync2Manager so the engine starts on a consistent trash
    // state. See docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.8–R3.11.
    const trashStore = new TrashStore({
      vault: this.app.vault,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
    });
    this.trashStore = trashStore;
    try {
      await trashSweepOnload({
        vault: this.app.vault,
        configDir: this.app.vault.configDir,
        selfPluginId: manifest.id,
        trashStore,
        logger: this.logger,
      });
    } catch (err) {
      this.logger.error("Trash recovery sweep failed", `${err}`);
    }
    // diff2 [←]-commit recovery (DIFF-EDITOR.md §5.0.a / §4.2). MUST run
    // BEFORE AtomicWriteRecovery.sweep below: commit7Step stages the resolved
    // base+sibling via the SAME .sync-tmp/.sync-bak suffixes the naive sweep
    // scans, and only recoverCommit's done.json-coordinated dispatch can
    // restore the PAIR atomically. Filesystem-driven (id = dir name), so a
    // tracked conflict whose record vanished mid-crash still recovers. No-op
    // until startSession is wired at mount (no autosave dirs exist yet).
    try {
      const r = await recoverAutosaveDirs(this.app.vault);
      if (r.dirs > 0) {
        this.logger.info("initSync2: diff2 autosave recovery", {
          dirs: r.dirs,
          swept: r.swept,
          recovered: r.recovered,
          results: r.results.map((x) => ({
            id: x.conflictId,
            kind: x.recover.kind,
          })),
        });
      }
    } catch (err) {
      this.logger.error("diff2 autosave recovery failed", `${err}`);
    }
    // Crash-recovery sweep for atomic-write artifacts AND for
    // ConflictStore vault-level `.sync-tmp` staging siblings. Runs BEFORE the
    // engine starts touching the vault so any leftover staging from a
    // previous crash is reconciled against the snapshot + conflict
    // stores before findChanges or drain sees them.
    try {
      const recovery = new AtomicWriteRecovery(
        this.app.vault,
        store,
        conflictStore,
      );
      const result = await recovery.sweep();
      this.logger.info("initSync2: AtomicWriteRecovery sweep", result);
      // 2.0.2-beta2: if the sweep forward-completed any write that
      // landed under <configDir>/plugins/<id>/<file>, the affected
      // plugin's in-memory code is now older than its on-disk code
      // (Obsidian loaded the OLD bytes before the sweep ran). Walk
      // appliedPaths through the same plugin-id detector the
      // drain-end reload path uses; trigger reloadPlugin for each.
      if (result.appliedPaths.length > 0) {
        const pluginIds = new Set<string>();
        for (const p of result.appliedPaths) {
          const id = extractAffectedPluginId(p, this.app.vault.configDir);
          if (id !== null) pluginIds.add(id);
        }
        if (pluginIds.size > 0) {
          this.handlePluginsAffectedReload(Array.from(pluginIds));
        }
      }
    } catch (err) {
      this.logger.error("Atomic-write recovery sweep failed", `${err}`);
    }
    // ConflictCounter owns the count formula + debounced recompute;
    // ConflictWatcher just calls counter.markDirty() on relevant
    // vault events; the counter notifies UI surfaces via
    // subscribe(). See docs/PSEUDO-MERGE-MODE.md §5 for the layer
    // separation.
    const conflictCounter = new ConflictCounter({
      vault: this.app.vault,
      store: conflictStore,
      // TODO #7 — count EXACTLY what the diff-panel lists (tracked + synthetic
      // siblings) so the ribbon badge / status bar / menu can't undercount. Same
      // source as the panel (findAllConflicts); main.ts bridges sync2's counter
      // to diff2's detector so neither module imports across the layer boundary.
      countConflicts: () =>
        findAllConflicts(this.app.vault, conflictStore).entries.length,
    });
    conflictCounter.subscribe(() => this.refreshConflictUI());
    this.conflictCounter = conflictCounter;
    // Seed the counter with whatever conflicts persisted from the
    // last session. markDirty + flush so the UI badge reflects
    // current state on first paint.
    conflictCounter.markDirty();
    await conflictCounter.flush();
    const conflictWatcher = new ConflictWatcher({
      vault: this.app.vault,
      store: conflictStore,
      counter: conflictCounter,
    });
    conflictWatcher.start();
    this.conflictWatcher = conflictWatcher;

    this.sync2Manager = new Sync2Manager({
      vault: this.app.vault,
      store,
      detector,
      queue,
      builder,
      client,
      logger: this.logger,
      invariants: this.invariants,
      configDir: this.app.vault.configDir,
      selfPluginId: manifest.id,
      workerClient: this.workerClient,
      // Label read live from settings so the user can change it in
      // the settings tab and the next sync picks up the new value —
      // no plugin reload needed. Commit messages themselves are
      // hardcoded in src/sync2/commit-message.ts.
      deviceLabel: () => this.settings.deviceLabel ?? "Obsidian",
      // Optional git author identity (SYNC2.md §4.4). Live getter.
      // The NAME defaults to the GitHub Owner when the dedicated
      // field is empty (the Owner is almost always the committing
      // user), so enabling the author stamp usually only needs the
      // email. Returns null — no override — only when no usable name
      // OR no email is available.
      gitAuthor: () => {
        const name =
          this.settings.gitAuthorName?.trim() ||
          this.settings.githubOwner?.trim();
        const email = this.settings.gitAuthorEmail?.trim();
        return name && email ? { name, email } : null;
      },
      // Remote identity read live so the manager catches a mid-session
      // settings change (user edits the repo coords in the settings
      // tab between two Sync clicks).
      remoteIdentity: () => ({
        owner: this.settings.githubOwner,
        repo: this.settings.githubRepo,
        branch: this.settings.githubBranch,
      }),
      conflictStore,
      conflictWatcher,
      conflictCounter,
      pendingDeletions,
      // diff2 trash hooks (R3.4 + R3.5). sync2 fires captureForDelete
      // before pull-side adapter.remove, confirmDeleted/confirmResolved
      // after push success, sweepOlderThan at drain end on full success.
      trashHooks: trashStore.asHooks(),
      consolidateCommits: this.settings.consolidateCommits ?? false,
      autoCanonicalize: () => this.settings.autoCanonicalizeTextFiles ?? false,
      maxAutoMergeSizeBytes: () =>
        this.settings.maxAutoMergeSizeBytes ?? 1_000_000,
      // Hooked to Obsidian's link-aware rename so the pre-sync
      // filename-sanitizer rewrites containing wiki-links automatically.
      // `getAbstractFileByPath` returns null when the path vanished
      // between the scanner's read and this callback's call (e.g. a
      // concurrent external delete) — the manager logs and continues.
      renameFile: async (oldPath: string, newPath: string): Promise<void> => {
        const file = this.app.vault.getAbstractFileByPath(oldPath);
        if (!file) return;
        await this.app.fileManager.renameFile(file, newPath);
      },
      onProgress: (initial: string) => {
        // Long-lived notice during the network phase — stays visible
        // until processQueue calls handle.hide(). The text is the
        // "Syncing with GitHub…" / "Syncing commit N/M …" string the
        // manager passes in.
        const notice = new Notice(initial, 0);
        return {
          update: (msg: string) => notice.setMessage(msg),
          hide: () => notice.hide(),
        };
      },
      // Local-commit ack — fires once `enqueueOrMerge` materialises
      // the batch on disk. We deliberately do NOT pop a separate
      // Notice here, and the same logic applies to onNoLocalChanges
      // below. Both used to surface their own brief toast, but the
      // user reported seeing them stack ON TOP OF the long-lived
      // "Syncing with GitHub…" progress notice ("Syncing with
      // GitHub…" + "Commit 2 files" side-by-side). The progress
      // notice's NEXT phase update ("Uploading N/M files…") already
      // implies the local commit happened and the manager is
      // talking to the network. Single-notice UX: only the progress
      // notice during the sync, and a single brief summary at the
      // end via onSyncCompleted.
      //
      // Click-time local-commit ack: brief flash right after the
      // batch is materialised on disk, before drain starts. Independent
      // notice (separate handle from the drain-level Pull/Push notice,
      // so users see them stacked naturally when both fire).
      onLocalCommitted: (count: number) => {
        new Notice(
          count === 1 ? "Commit 1 file" : `Commit ${count} files`,
          BRIEF_NOTICE_MS,
        );
      },
      onNoLocalChanges: () => {
        new Notice("Nothing to commit", BRIEF_NOTICE_MS);
      },
      // Observability hook only. The three user-visible notices in
      // sync2's new UX contract are handled elsewhere:
      //   - "Commit N files" via onLocalCommitted (click-time ack)
      //   - "Nothing to commit" via onNoLocalChanges (click on idle vault)
      //   - "Sync done" via the drain's own progress handle (replaces
      //     the Pull/Push notice on heavy syncs; brief flash on light
      //     syncs that did real work).
      // Left as a no-op so tests + future wiring can still depend on
      // the callback existing in the deps surface.
      onSyncCompleted: () => {},
      // SYNC2 §4.3: push-queue depth changes drive the ribbon
      // sync-icon's badge. Fired by Sync2Manager after every
      // persistent .push-queue/ mutation (enqueueOrMerge add,
      // processBatch delete, etc).
      onQueueDepthChanged: (depth: number) => {
        this.refreshRibbonPendingBatchesBadge(depth);
      },
      // 2.0.2-beta2 BRAT-style auto-reload. Fires at end of a
      // successful drain with the IDs of plugins whose top-level
      // files (main.js / manifest.json / styles.css / data.json)
      // were just written. For each enabled affected plugin, call
      // reloadPlugin(id) via setTimeout (500ms unwind for the
      // in-flight drain stack frame) so the NEW code takes effect
      // immediately instead of waiting for the user to disable +
      // re-enable by hand.
      onPluginsAffected: (ids: string[]) => {
        this.handlePluginsAffectedReload(ids);
      },
      // 2.0.2-beta2 zero-byte restore guard (SYNC2 §2.9). The engine
      // restored an accidentally-emptied file from its last good
      // version instead of pushing the 0-byte copy. Surface it so the
      // recovery is never silent — the user should know their vault
      // changed and why.
      onZeroByteRestored: (path: string) => {
        new Notice(
          `Restored "${path}" — the local copy was empty (likely ` +
            `corruption). The empty version was NOT uploaded.`,
          10000,
        );
        this.logger?.info("Zero-byte file restored by guard", { path });
      },
    });

    // 2.0.2-beta2: drive the ribbon "syncing" look from drain status.
    // The icon (refresh-cw) spins + tints accent while a drain runs.
    this.drainStatusRibbonUnsub = this.sync2Manager.setDrainStatusListener(
      (s) => this.applyRibbonSyncingState(s.state === "running"),
    );

    // Conflict resolution events (sibling delete, edit, rename) are
    // observed by ConflictWatcher above — no separate vault.on
    // wiring needed here.

    // Deliberately NO drain on enable. Users running with "Sync
    // strategy: manual" + "Sync on startup: false" expect to be in
    // control: a click triggers sync, otherwise the plugin stays
    // silent. Auto-draining on enable — even for the pending-batches
    // case — surprised users with a "Sync done" toast right after
    // toggling the plugin off and on. Orphaned push-queue batches
    // from a previous failed session still get retried, just later:
    //   • Manual click → syncAll → drain picks them up.
    //   • Watchdog tick (5 min, fires only when queue is non-empty)
    //     → backgroundDrain → drain picks them up.
    // Neither path startles the user on enable.
    // (Pre-stage-5 deviceLabel was used here; preserved for symmetry
    // with the later stage-9 widget pass.)
    void deviceLabel;

    // diff2 TrashWatcher — monkey-patches vault.delete/trash so
    // user-driven UI deletes route through TrashStore.intercept.
    // Installed AFTER Sync2Manager wire-up so any throw during
    // engine init doesn't leave the vault with patched methods.
    // The watcher's uninstall (run from onunload) restores the
    // originals captured at install time, preserving any upper-layer
    // patch another plugin may have applied between install and
    // unload. See R3.2.
    try {
      const watcher = new TrashWatcher(this.app.vault, this.trashStore, this.logger);
      watcher.install();
      this.trashWatcher = watcher;
    } catch (err) {
      this.logger.error("TrashWatcher install failed", `${err}`);
    }
  }

  // ── sync triggers ───────────────────────────────────────────────────

  // forceCommit (E2 §7 menu "Sync All") — always commit + drain, ignoring the
  // syncStartsWithCommit toggle. The command + ribbon callers pass no arg, so
  // they keep honouring the toggle.
  async sync(forceCommit = false): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    // 2.0.2-beta2: second click during in-flight drain opens the
    // CancelSyncModal. The previous behaviour ("silently ignore
    // the click") was confusing in field testing — users couldn't
    // tell whether the click registered, and the only path to
    // stop a stuck sync was Settings → [Stop sync]. The modal
    // gives an in-place [Cancel sync] / [Keep going] choice.
    // The `sync` command (vs the ribbon button) still silently
    // ignores — keystroke shortcuts shouldn't open modals.
    if (this.sync2Manager.getDrainStatus().state === "running") {
      const modal = new CancelSyncModal(this.app, () => {
        this.sync2Manager.cancelDrain();
        new Notice("Sync cancellation requested.", 4000);
      });
      modal.open();
      return;
    }
    if (!(await this.confirmPendingConflictsBeforeSync())) return;
    try {
      // Stage 7: master toggle controls semantic
      //   true  (default) → commit + drain (syncAll)
      //   false           → drain only (resumeQueue)
      // The [Commit] ribbon button is the user's separate path
      // for enqueueing when the master toggle is false.
      if (forceCommit || (this.settings.syncStartsWithCommit ?? true)) {
        await this.sync2Manager.syncAll();
        this.tokenExpiredFlag?.note(null); // E1: syncAll always pulls → auth OK
      } else {
        await this.sync2Manager.resumeQueue();
        // E1: resumeQueue is drain-only — an empty queue makes NO authed call
        // (drain only does bootstrapIfNeeded, O(1) no-op once adopted), so a
        // success here does NOT prove auth. Never clear on a drain-only path,
        // or an empty interval tick would wipe a real expired marker.
      }
    } catch (err) {
      // Log BEFORE the Notice so the user-visible toast and the
      // logged record always agree. Without this, the only artifact
      // a failed click left behind was the transient Notice; the
      // log showed nothing, making bug reports actionable only when
      // the user happened to screenshot the toast in time.
      this.logger.error("syncAll click failed", { err: describeError(err) });
      // Stage 7: surface in the Settings drain-status section so
      // the user sees "Last error: …" without opening the log.
      this.sync2Manager.recordDrainError(err);
      this.tokenExpiredFlag?.note(err); // E1: auth outcome → marker (AuthError → set)
      this.maybeShowTokenExpiredModal(err);
      new Notice(`Error syncing. ${err}`);
    }
    // Drain may have mutated ConflictStore (Phase A SHA-match
    // cleanup, Phase B path-close drops) without firing the vault
    // listeners that normally drive the counter. Mark dirty so the
    // counter recomputes and the subscribe → refreshConflictUI()
    // path fires when the badge value actually changes.
    this.conflictCounter?.markDirty();
  }

  // Background drain — entry point for the interval timer when
  // syncStartsWithCommit is off. Errors are swallowed + logged because
  // network blips during a background tick are common and shouldn't
  // surface a toast.
  async backgroundDrain(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      await this.sync2Manager.resumeQueue();
      // E1: drain-only path — never CLEAR here (an empty queue makes no authed
      // call; see sync()'s resumeQueue branch). SET on an auth error below.
    } catch (err) {
      void this.logger.error("Interval drain failed", `${err}`);
      this.sync2Manager.recordDrainError(err);
      this.tokenExpiredFlag?.note(err); // E1: auth outcome → marker (set on AuthError)
      this.maybeShowTokenExpiredModal(err);
    }
  }

  async syncCurrentFile(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) {
      new Notice("No active file to sync");
      return;
    }
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (!(await this.confirmPendingConflictsBeforeSync())) return;
    try {
      await this.sync2Manager.syncFile(path);
      this.tokenExpiredFlag?.note(null); // E1: authed sync succeeded → clear
    } catch (err) {
      // Log BEFORE the Notice — see sync() rationale above.
      this.logger.error("syncFile click failed", { path, err: describeError(err) });
      this.tokenExpiredFlag?.note(err); // E1: auth outcome → marker
      new Notice(`Error syncing. ${err}`);
    }
    // See markDirty rationale in sync() above.
    this.conflictCounter?.markDirty();
  }

  // ── stage 10 — pre-sync conflict gate + UI refresh ──────────────────

  // Show the pre-sync conflict modal when ConflictStore has any
  // active records. Returns true if sync should proceed (no conflicts
  // OR user picked "Sync anyway"). Returns false when sync should be
  // aborted (user picked "Cancel" or "Resolve"; the latter opens the
  // first sibling in the editor as a courtesy).
  private async confirmPendingConflictsBeforeSync(): Promise<boolean> {
    if (!this.conflictStore) return true;
    const records = this.conflictStore.getAll();
    if (records.length === 0) return true;
    const paths = Array.from(
      new Set(records.map((r) => r.vaultPath)),
    ).sort();
    const decision = await new PreSyncConflictModal(this.app, paths).prompt();
    if (decision === "sync-anyway") return true;
    if (decision === "resolve") {
      // Open the first sibling file in the editor so the user can act
      // on it immediately. workspace.openLinkText accepts a vault-
      // relative path; the second arg ("") is the source path the
      // resolver would use to resolve relative links, which doesn't
      // matter for absolute paths.
      const firstSibling = records[0].siblingPath;
      try {
        await this.app.workspace.openLinkText(firstSibling, "", false);
      } catch (err) {
        void this.logger.error(
          "Failed to open first sibling from pre-sync modal",
          `${err}`,
        );
      }
      return false;
    }
    return false;
  }

  // Refresh every visibility surface (status bar, ribbon badge)
  // from the current ConflictCounter value. The counter formula
  // (excludes records with !siblingExists and records where
  // siblingSha == baseSha) reflects what the user actually still
  // has to resolve, not the raw record count.
  // Conflict-count changed (ConflictCounter.subscribe, line ~866). E2: the
  // count now lives in the single "GitHub" status-bar item (the "M ⁇" suffix),
  // so a count change just repaints that item. The ribbon sync-icon badge is
  // push-queue depth, NOT conflicts (SYNC2 §4.3); the optional diff ribbon icon
  // (E3, R2.7.4) will carry the conflict badge.
  refreshConflictUI(): void {
    this.updateStatusBarItem();
    this.refreshDiffRibbonBadge();
  }

  // Subtle absolute-positioned numeric pill in a ribbon icon's
  // corner. 2.0.2-beta2: routing rule — the badge follows
  // whichever ribbon icon is visible.
  //
  //   [Sync] visible              → badge on [Sync].
  //   [Sync] hidden + [Commit] on → badge on [Commit].
  //   Both hidden                  → no badge anywhere (fully
  //                                  automatic OR hotkey-only UX).
  //
  // Pending count is independent of the ribbon icon's PURPOSE
  // (network upload near Sync vs local enqueue near Commit) —
  // what matters is the user can SEE the count somewhere as long
  // as they kept any sync-related icon visible.
  private refreshRibbonPendingBatchesBadge(depth: number): void {
    this.currentQueueDepth = depth;
    this.applyPendingBatchesBadge();
    // E2: the status-bar "↑ N" rides the same depth signal — repaint it too.
    this.updateStatusBarItem();
  }

  // 2.0.2-beta2: reflect drain activity in the UI while a drain runs.
  // The [Sync] ribbon icon spins + tints accent (network activity is a
  // Sync concept — the [Commit] icon does NOT spin, it never touches
  // the network). The status-bar "GitHub" label also flips to a
  // syncing look. Caches the state so an icon created mid-drain picks
  // it up (see showSyncRibbonIcon).
  private applyRibbonSyncingState(running: boolean): void {
    this.drainRunning = running;
    this.syncRibbonIcon?.toggleClass(
      "github-easy-sync-ribbon-syncing",
      running,
    );
    this.updateStatusBarItem();
  }

  // 2.0.2-beta2: paints the badge on whichever ribbon icon the
  // current settings + cached depth dictate. Idempotent — safe to
  // call on every settings toggle.
  private applyPendingBatchesBadge(): void {
    const depth = this.currentQueueDepth;
    // E3 (§8) — keep the sync icon's tooltip showing the commit count (same N as
    // the badge), so hovering explains the number. Runs on every depth change.
    if (this.syncRibbonIcon) setTooltip(this.syncRibbonIcon, syncTooltip(depth));
    // Pick the target icon per the routing rule. The chosen icon
    // owns the badge; the other gets cleared.
    let target: HTMLElement | null = null;
    let targetField: "sync" | "commit" | null = null;
    if (this.syncRibbonIcon) {
      target = this.syncRibbonIcon;
      targetField = "sync";
    } else if (this.commitRibbonIcon) {
      target = this.commitRibbonIcon;
      targetField = "commit";
    }
    // Clear the non-target field's badge.
    if (targetField !== "sync" && this.ribbonPendingBatchesBadge) {
      this.ribbonPendingBatchesBadge.remove();
      this.ribbonPendingBatchesBadge = null;
    }
    if (targetField !== "commit" && this.commitRibbonPendingBatchesBadge) {
      this.commitRibbonPendingBatchesBadge.remove();
      this.commitRibbonPendingBatchesBadge = null;
    }
    if (target === null || depth <= 0) {
      // Nothing to render.
      if (this.ribbonPendingBatchesBadge) {
        this.ribbonPendingBatchesBadge.remove();
        this.ribbonPendingBatchesBadge = null;
      }
      if (this.commitRibbonPendingBatchesBadge) {
        this.commitRibbonPendingBatchesBadge.remove();
        this.commitRibbonPendingBatchesBadge = null;
      }
      return;
    }
    // Get or create the badge on the target icon.
    const existing =
      targetField === "sync"
        ? this.ribbonPendingBatchesBadge
        : this.commitRibbonPendingBatchesBadge;
    const badge =
      existing ?? this.createRibbonBadgeOn(target);
    if (targetField === "sync") {
      this.ribbonPendingBatchesBadge = badge;
    } else {
      this.commitRibbonPendingBatchesBadge = badge;
    }
    badge.setText(String(depth));
    badge.setAttribute(
      "aria-label",
      `${depth} push batch${depth === 1 ? "" : "es"} pending`,
    );
  }

  // 2.0.2-beta2: build the absolute-positioned numeric pill node.
  // Style stays inline here so the same look applies whether the
  // host is [Sync] or [Commit].
  private createRibbonBadgeOn(
    parent: HTMLElement,
    bg = "var(--color-green, #16a34a)",
  ): HTMLElement {
    const el = parent.createSpan({
      cls: "github-easy-sync-ribbon-pending-batches-badge",
    });
    el.style.position = "absolute";
    el.style.top = "2px";
    el.style.right = "2px";
    el.style.minWidth = "14px";
    el.style.height = "14px";
    el.style.padding = "0 3px";
    el.style.borderRadius = "7px";
    el.style.background = bg;
    el.style.color = "white";
    el.style.fontSize = "10px";
    el.style.lineHeight = "14px";
    el.style.textAlign = "center";
    el.style.pointerEvents = "none";
    parent.style.position = "relative";
    return el;
  }

  // ── status bar ──────────────────────────────────────────────────────

  showStatusBarItem(): void {
    if (this.statusBarItem) return;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.style.cursor = "pointer";
    // white-space: pre keeps the leading space in " (↑ N)" from collapsing
    // against the "GitHub" label in the flex status-bar item.
    this.statusBarItem.addClass("github-easy-sync-statusbar");
    // E2 (TODO §7) — the single "GitHub" item is clickable → the status menu.
    this.statusBarItem.addEventListener("click", (evt) =>
      this.showStatusBarMenu(evt),
    );
    this.updateStatusBarItem();
    // Seed the push-queue depth so "↑ N" is correct on first paint even when the
    // sync ribbon (which also seeds it) is hidden — pre-existing batches from an
    // offline session / crash recovery would otherwise show no ↑ until the next
    // queue mutation.
    void this.seedPendingBatchesDepth();
  }

  hideStatusBarItem(): void {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem(): void {
    const el = this.statusBarItem;
    if (!el) return;
    // E2 (TODO §6): "GitHub (↑ N | M ⁇)". NO spinner — during a drain the WHOLE
    // item greens (the `-syncing` class on el: "GitHub" + the "( | )" brackets/
    // pipe), while the "↑ N" decreases live as batches push (onQueueDepthChanged
    // → here). The suffix segments override with their own colours: "↑ N" green
    // (same either way), "M ⁇" red (overrides the syncing-green). Rebuilt each
    // call (cheap).
    el.empty();
    el.toggleClass("github-easy-sync-statusbar-syncing", this.drainRunning);
    el.createSpan({ text: "GitHub" });
    const conflicts = this.conflictCounter?.getValue() ?? 0;
    for (const seg of statusBarSuffix(this.currentQueueDepth, conflicts)) {
      const span = el.createSpan({ text: seg.text });
      if (seg.cls === "up") span.addClass("github-easy-sync-statusbar-up");
      else if (seg.cls === "conflict")
        span.addClass("github-easy-sync-statusbar-conflict");
    }
  }

  // E2 (TODO §7) — the clickable status-bar menu. Three states (uninitialized /
  // token-expired / normal) + count-aware labels come from the pure
  // buildStatusMenu; this is just the Obsidian Menu wiring.
  private showStatusBarMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const items = buildStatusMenu({
      state: statusMenuState(
        this.isConfigured(),
        this.tokenExpiredFlag?.isExpiredCached() ?? false,
      ),
      pluginName: manifest.name,
      queueDepth: this.currentQueueDepth,
      conflictCount: this.conflictCounter?.getValue() ?? 0,
    });
    for (const item of items) {
      if (item.separatorBefore) menu.addSeparator();
      menu.addItem((mi) => {
        mi.setTitle(item.label);
        if (item.key === null) {
          mi.setDisabled(true);
          return;
        }
        const key = item.key;
        mi.onClick(() => this.dispatchStatusMenuAction(key));
      });
    }
    menu.showAtMouseEvent(evt);
  }

  private dispatchStatusMenuAction(key: MenuActionKey): void {
    switch (key) {
      case "sync-all":
        void this.sync(true); // §7: always commit + drain, ignoring the toggle
        break;
      case "commit-all":
        void this.commit();
        break;
      case "commit-current":
        void this.commitFile();
        break;
      case "pull-push":
        void this.uploadOnly();
        break;
      case "open-diff":
        void this.activateDiffEditView();
        break;
      case "settings":
        this.openSettings();
        break;
    }
  }

  private openSettings(): void {
    const setting = (
      this.app as unknown as {
        setting: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    try {
      setting.open();
      setting.openTabById(manifest.id);
    } catch {
      // Best effort — older Obsidian may not expose openTabById.
    }
  }

  // ── sync ribbon ─────────────────────────────────────────────────────

  showSyncRibbonIcon(): void {
    if (this.syncRibbonIcon) return;
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      // Wrap (not .bind): addRibbonIcon invokes the callback with the click
      // MouseEvent, which would leak into sync()'s new `forceCommit` param and
      // make the ribbon always commit+drain regardless of syncStartsWithCommit.
      () => void this.sync(),
    );
    // Seed the badge with the current push-queue depth so the icon
    // reflects on-disk state on first paint — covers the case where
    // the plugin loads with pre-existing batches (offline session,
    // crash recovery, etc.).
    void this.seedPendingBatchesDepth();
    // Reflect an already-running drain (icon created mid-sync).
    if (this.drainRunning) {
      this.syncRibbonIcon.toggleClass(
        "github-easy-sync-ribbon-syncing",
        true,
      );
    }
  }

  // Seed the cached push-queue depth from disk so both the ribbon badge and the
  // E2 status-bar "↑ N" are correct on first paint (pre-existing batches from an
  // offline session / crash recovery). Called by show{SyncRibbonIcon,
  // StatusBarItem}; refreshRibbonPendingBatchesBadge repaints both surfaces.
  private async seedPendingBatchesDepth(): Promise<void> {
    try {
      const queue = (this.sync2Manager as unknown as { queue: PushQueue })
        .queue;
      const ids = await queue.list();
      this.refreshRibbonPendingBatchesBadge(ids.length);
    } catch {
      // ignored — startup race, the next sync click refreshes anyway
    }
  }

  hideSyncRibbonIcon(): void {
    this.ribbonPendingBatchesBadge?.remove();
    this.ribbonPendingBatchesBadge = null;
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
    // 2.0.2-beta2: the badge may now move to [Commit] if it's
    // still visible. Repaint with the cached depth.
    this.applyPendingBatchesBadge();
  }

  // ── commit ribbon (Stage 7) ─────────────────────────────────────────

  // Independent of the Sync ribbon icon. When the user enables
  // `showCommitRibbonButton`, a separate [Commit] icon appears.
  // Clicking it triggers change-detection + enqueue ONLY — never
  // touches the network. In split mode (master toggle false) this
  // is the only way to add commits to .push-queue.
  commitRibbonIcon: HTMLElement | null = null;

  showCommitRibbonIcon(): void {
    if (this.commitRibbonIcon) return;
    this.commitRibbonIcon = this.addRibbonIcon(
      "git-commit",
      "Commit local changes",
      this.commit.bind(this),
    );
    // 2.0.2-beta2: if [Sync] is currently hidden, the depth badge
    // moves to this newly-shown [Commit] icon.
    this.applyPendingBatchesBadge();
  }

  hideCommitRibbonIcon(): void {
    this.commitRibbonPendingBatchesBadge?.remove();
    this.commitRibbonPendingBatchesBadge = null;
    this.commitRibbonIcon?.remove();
    this.commitRibbonIcon = null;
    // 2.0.2-beta2: ensure no stale badge sticks around.
    this.applyPendingBatchesBadge();
  }

  // ── diff-panel ribbon (E3, R2.7.4 / TODO §9) ─────────────────────────

  // Separate ribbon icon (NOT the sync icon) — always-available entry to the
  // diff-panel (Conflicts / Deleted / Compare), independent of whether there
  // are conflicts. Carries a red conflict-count badge + a count-aware tooltip.
  showDiffRibbonIcon(): void {
    if (this.diffRibbonIcon) return;
    this.diffRibbonIcon = this.addRibbonIcon(
      "git-merge", // distinct from the sync icon's refresh-cw
      diffTooltip(this.conflictCounter?.getValue() ?? 0),
      () => void this.activateDiffEditView(),
    );
    // Seed badge + tooltip on creation (correct on a cold onload AND when the
    // settings toggle creates this icon mid-session — ConflictCounter is live).
    this.refreshDiffRibbonBadge();
  }

  hideDiffRibbonIcon(): void {
    this.diffRibbonConflictBadge?.remove();
    this.diffRibbonConflictBadge = null;
    this.diffRibbonIcon?.remove();
    this.diffRibbonIcon = null;
  }

  // Repaint the diff icon's conflict badge + tooltip. The ICON stays visible at
  // 0 conflicts (its value is Deleted/Compare access, R2.7.4) — only the badge
  // is removed. Called from refreshConflictUI (ConflictCounter subscribe).
  private refreshDiffRibbonBadge(): void {
    const icon = this.diffRibbonIcon;
    if (!icon) return;
    const count = this.conflictCounter?.getValue() ?? 0;
    setTooltip(icon, diffTooltip(count)); // tooltip tracks the count even at 0
    if (count <= 0) {
      this.diffRibbonConflictBadge?.remove();
      this.diffRibbonConflictBadge = null;
      return;
    }
    if (!this.diffRibbonConflictBadge) {
      this.diffRibbonConflictBadge = this.createRibbonBadgeOn(
        icon,
        // red — conflicts need attention (mirrors the pending badge's
        // --color-green; --color-red is the background-intent token + hex fallback).
        "var(--color-red, #dc2626)",
      );
    }
    this.diffRibbonConflictBadge.setText(String(count));
  }

  // Click handler for [Commit]: enqueue local changes to .push-queue
  // without triggering drain. Uses Sync2Manager.commitOnly() which
  // runs the change-detection + enqueue path and stops there.
  async commit(): Promise<void> {
    try {
      await this.sync2Manager.commitOnly();
    } catch (err) {
      this.logger?.error("Commit ribbon click failed", {
        error: String(err),
      });
      new Notice(`Commit failed: ${err}`, 10000);
    }
  }

  // Stage 7: pure drain entry point — uploads pending commits to
  // GitHub without first running change-detection / enqueue. Mirrors
  // backgroundDrain() but as a user-facing command so the toast +
  // log path goes through the same error-handling shape as sync().
  async uploadOnly(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    // 2.0.2-beta2: silently ignore if a drain is already running.
    // The existing drain's tail re-check loop will catch any
    // batches that landed since it started; we don't need to
    // queue another drain attempt. The Settings drain-status
    // section + the [Cancel sync] command remain available for
    // direct control.
    if (this.sync2Manager.getDrainStatus().state === "running") {
      this.logger?.info(
        "uploadOnly command: drain already running, ignoring",
      );
      return;
    }
    if (!(await this.confirmPendingConflictsBeforeSync())) return;
    try {
      await this.sync2Manager.resumeQueue();
      // E1: drain-only path — never CLEAR here (an empty queue makes no authed
      // call; see sync()'s resumeQueue branch). SET on an auth error below.
    } catch (err) {
      this.logger?.error("Upload-only command failed", {
        err: describeError(err),
      });
      this.sync2Manager.recordDrainError(err);
      this.tokenExpiredFlag?.note(err); // E1: auth outcome → marker (set on AuthError)
      this.maybeShowTokenExpiredModal(err);
      new Notice(`Upload failed: ${err}`, 10000);
    }
    this.conflictCounter?.markDirty();
  }

  // 2.0.2-beta2: commit a single file (typically the file in the
  // active tab). Surfaces an explicit Notice when the path is in
  // .gitignore so the user understands why their explicit commit
  // was a no-op.
  async commitFile(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    const path = this.activeFilePath();
    if (path === null) {
      new Notice("No active file to commit", 5000);
      return;
    }
    try {
      const outcome = await this.sync2Manager.commitFile(path);
      if (outcome.kind === "ignored") {
        new Notice("File is in git-ignore list", 6000);
      } else if (outcome.kind === "no-change") {
        new Notice("File was not changed", 3000);
      } else if (outcome.kind === "committed") {
        new Notice(`File committed`, BRIEF_NOTICE_MS);
      }
    } catch (err) {
      this.logger?.error("commit-file command failed", {
        err: describeError(err),
        path,
      });
      new Notice(`Commit failed:\n${err}`, 10000);
    }
  }

  // 2.0.2-beta2 BRAT-style auto-reload handler. Called by Sync2Manager
  // at end of a successful drain with the IDs of plugins whose files
  // were just written. For each enabled affected plugin, reload it via
  // `reloadPluginById` (reloadPlugin on desktop; disable+enable on
  // Mobile, where reloadPlugin does NOT exist — the field-reported
  // 2026-05-31 bug). Scheduled on a 500ms timeout so the drain stack
  // frame unwinds before a self-reload tears this instance down.
  private handlePluginsAffectedReload(ids: string[]): void {
    const plugins = pluginManagerOf(this.app);
    if (!canReloadPlugins(plugins)) {
      this.logger?.warn(
        "BRAT-style reload requested but no reload mechanism is available " +
          "(neither app.plugins.reloadPlugin nor disablePlugin+enablePlugin)",
        { ids },
      );
      return;
    }
    const enabled = plugins?.enabledPlugins;
    const willReload: string[] = [];
    for (const id of ids) {
      // Skip disabled plugins — reload would just enable them, which
      // is surprising. Self (github-easy-sync) is treated the same as
      // any other plugin: the new main.js is already on disk (the
      // marker swap completed), so disable+enable loads the new code.
      if (enabled !== undefined && !enabled.has(id)) {
        this.logger?.info(
          "BRAT-style reload skipped: plugin not enabled",
          { id },
        );
        continue;
      }
      willReload.push(id);
    }
    if (willReload.length === 0) return;
    for (const id of willReload) {
      setTimeout(() => {
        reloadPluginById(this.app, id)
          .then(() => {
            this.logger?.info("BRAT-style reload done", { id });
          })
          .catch((err) => {
            this.logger?.error("reloadPlugin failed", {
              id,
              err: describeError(err),
            });
          });
      }, 500);
    }
    const label =
      willReload.length === 1
        ? `Plugin "${willReload[0]}" updated`
        : `${willReload.length} plugins updated`;
    new Notice(label, 3000);
    this.logger?.info("BRAT-style reload scheduled", { ids: willReload });
  }

  // 2.0.2-beta2: cancel the currently-running drain. Silently
  // no-ops if nothing is running — a single keystroke shouldn't
  // surface a toast for the "nothing to cancel" case.
  async cancelSync(): Promise<void> {
    if (this.sync2Manager.getDrainStatus().state !== "running") {
      return;
    }
    this.sync2Manager.cancelDrain();
    new Notice("Sync cancellation requested.", 4000);
  }

  // Detects AuthError (401 / 403) — typically an expired
  // fine-grained PAT — and opens the TokenExpiredModal with
  // step-by-step recovery guidance. Throttled to at most once per
  // hour so a 5-minute background drain doesn't spam the user.
  private maybeShowTokenExpiredModal(err: unknown): void {
    if (!(err instanceof AuthError)) return;
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    if (now - this.lastAuthModalShownMs < ONE_HOUR) return;
    this.lastAuthModalShownMs = now;
    try {
      const modal = new TokenExpiredModal(this.app, () => {
        // Reveal the plugin's settings tab. Obsidian's
        // setting.open + openTabById API gives us the deep link.
        const setting = (
          this.app as unknown as {
            setting: {
              open(): void;
              openTabById(id: string): void;
            };
          }
        ).setting;
        try {
          setting.open();
          setting.openTabById(manifest.id);
        } catch {
          // Best effort — older Obsidian versions may not expose
          // openTabById. The modal still ran, the user can open
          // settings manually.
        }
      });
      modal.open();
    } catch (modalErr) {
      this.logger?.warn("TokenExpiredModal open failed", {
        err: String(modalErr),
      });
    }
  }

  // ── auto-sync interval ──────────────────────────────────────────────

  startSyncInterval(): void {
    if (this.syncIntervalId !== null) return;
    // The tick + startup decisions all live in IntervalScheduler so
    // the three branches (interval-tick, watchdog, startup) can be
    // unit-tested without spinning up a real Obsidian. main.ts only
    // wires the settings predicates, the Sync2Manager ops, and the
    // OS-level setInterval handle.
    this.intervalScheduler = new IntervalScheduler({
      isConfigured: () => this.isConfigured(),
      intervalEnabled: () => this.settings.syncStrategy === "interval",
      intervalMinutes: () => this.settings.syncInterval,
      syncStartsWithCommit: () => this.settings.syncStartsWithCommit ?? true,
      hasPendingBatches: () => this.sync2Manager.hasPendingBatches(),
      // Background drain skips the pre-sync confirmation modal —
      // interval timers and the startup pulse are not user-driven,
      // so a blocking dialog would surprise the user. Detection
      // still runs; conflicts still land as siblings in the vault.
      drain: () => this.backgroundDrain(),
      fullSync: () => this.sync(),
      logError: (label, err) => {
        void this.logger.error(label, err);
      },
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id),
    });
    this.intervalScheduler.start();
    const active = this.intervalScheduler.getTimerId();
    if (active !== null) {
      this.syncIntervalId = active;
      this.registerInterval(active);
    }
  }

  // Startup hook for `syncOnStartup: true`. Same autoCommit gate as
  // interval, but with one extra step in the off-case: drain pending
  // queue batches that survived the previous Obsidian session
  // (offline pushes that never went through). The user explicitly
  // opted into "sync on startup" — pushing whatever they had queued
  // last time is the obvious right thing.
  private async runStartupSync(): Promise<void> {
    await this.intervalScheduler.runStartup();
  }

  stopSyncInterval(): void {
    if (this.intervalScheduler) this.intervalScheduler.stop();
    this.syncIntervalId = null;
  }

  restartSyncInterval(): void {
    this.stopSyncInterval();
    this.startSyncInterval();
  }

  // Opens the Diff-Edit view in a workspace tab, reusing an existing
  // leaf if one is already open (single-view model — R2.0). Standard
  // Obsidian pattern: query workspace.getLeavesOfType, fall back to
  // getLeaf("tab") + setViewState. Returns once the leaf is revealed.
  async activateDiffEditView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(DIFF2_EDIT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: DIFF2_EDIT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // The dependency object both diff2 hosts take. Live-reads settings via thunks so
  // a deviceLabel / Touch-mode / diff-mode change is picked up on the next view
  // open (same pattern Sync2Manager uses for commit messages).
  private diffViewDeps(): DiffEditViewDeps {
    return {
      vault: this.app.vault,
      conflictStore: this.conflictStore,
      conflictCounter: this.conflictCounter,
      // §5.0.e one-side-silent exit logs here instead of a Notice.
      logger: this.logger,
      localDeviceLabel: () => this.settings.deviceLabel ?? "Obsidian",
      // §2.2.14 — live-read the Touch mode setting at each view open.
      touchOnly: () => this.settings.diffEditorTouchMode ?? false,
      // Diff highlight mode: "words" → word-level, else char-level (default).
      diffWordLevel: () => this.settings.diffEditorDiffMode === "words",
      // §2.2.15 Auto-focus default (toggleable per-document in the toolbar).
      autoFocus: () => this.settings.diffEditorAutoFocus ?? true,
      // S4 — the panel's conflicts-list routes a row-click here instead of its own
      // (now-bypassed, S6-deleted) detail-mode.
      openEditor: (entry) => void this.openEditorForPair(entry),
    };
  }

  // Pairs whose `openEditorForPair` is mid-flight. `getLeavesOfType` can't see an
  // in-flight leaf until its awaited `setViewState` resolves, so a fast double-click
  // on a row would otherwise pass the guard twice → two editors on one autosave dir
  // (the §3 write-race). Keyed on the SAME autosaveId the guard uses so the two
  // layers agree.
  private readonly openingPairs = new Set<string>();

  // Open a `diff2-editor-view` tab for one conflict pair, behind the write-set
  // open-guard (SPLIT-PANEL-EDITOR-FEASIBILITY.md §3 R-B):
  //   - same pair already open → focus it (no new tab, no dialog);
  //   - a DIFFERENT pair sharing a file → EditorBusyModal [Switch]/[Cancel];
  //   - otherwise → a fresh tab.
  // The descriptor array MUST stay index-aligned with `getLeavesOfType` so the
  // guard's `which` resolves to the right leaf — `alignOpenDescs` enforces that
  // (never `.filter`). Both the request and every open descriptor route through
  // `openDescFor` so the overlap compare only ever sees normalized write-sets.
  async openEditorForPair(entry: ConflictEntry): Promise<void> {
    const autosaveId = autosaveIdForEntry(entry);
    // Synchronous re-entrancy guard closing the check-then-act window across the
    // `setViewState` await (double-click → two tabs → write-race).
    if (this.openingPairs.has(autosaveId)) return;
    this.openingPairs.add(autosaveId);
    try {
      const { workspace } = this.app;
      const leaves = workspace.getLeavesOfType(DIFF2_EDITOR_VIEW_TYPE);
      const open = alignOpenDescs(
        leaves.map((l) => (l.view instanceof DiffEditorView ? l.view.openDesc() : null)),
      );
      const req = openDescFor("conflict", entry.basePath, entry.siblingPath, autosaveId);
      const result = openGuard(open, req);

      if (result.action === "focus") {
        this.revealAndFocusEditor(leaves[result.which]);
        return;
      }
      if (result.action === "dialog") {
        const choice = await new EditorBusyModal(this.app, result.busyFile).prompt();
        // Between building `open[]` and the click the target leaf could be closed;
        // revealLeaf on a detached leaf is a benign Obsidian no-op.
        if (choice === "switch") this.revealAndFocusEditor(leaves[result.which]);
        return;
      }

      // result.action === "open"
      const leaf = workspace.getLeaf("tab");
      const state: EditorTabState = {
        origin: "conflict",
        basePath: entry.basePath,
        siblingPath: entry.siblingPath,
      };
      await leaf.setViewState({
        type: DIFF2_EDITOR_VIEW_TYPE,
        state: state as unknown as Record<string, unknown>,
        active: true,
      });
      workspace.revealLeaf(leaf);
    } finally {
      this.openingPairs.delete(autosaveId);
    }
  }

  // Reveal an already-open editor leaf AND put the caret back in its text. revealLeaf
  // alone activates the tab but leaves the editor un-focused (the user would have to
  // click the text) — focusEditor defers the CM6 focus past Obsidian's own reveal
  // focus handling.
  private revealAndFocusEditor(leaf: WorkspaceLeaf): void {
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof DiffEditorView) leaf.view.focusEditor();
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private activeFilePath(): string | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.path ?? null;
  }
}
