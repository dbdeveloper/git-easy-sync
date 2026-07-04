// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import {
  PluginSettingTab,
  App,
  Setting,
  TextComponent,
  Notice,
  Modal,
  requestUrl,
} from "obsidian";
import GitHubSyncPlugin from "src/main";
import { logFileNameFor } from "src/logger";
import { formatSyncMessage } from "src/sync2/commit-message";
import { renderTokenHelpBox } from "src/sync2/views/token-help";
import manifest from "../../manifest.json";

// Sync2-only settings tab. Mirrors the shape of GitHubSyncSettings —
// every input here writes to one field and persists via saveSettings.
export default class GitHubSyncSettingsTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Stage 7 drain-status subscription. Held across renders so the
  // [Stop drain] button + timer survive re-display() calls (e.g.,
  // when the user toggles a setting that re-renders the page).
  private drainStatusUnsubscribe: (() => void) | null = null;
  private drainStatusTickTimer: ReturnType<typeof setInterval> | null = null;

  // Token-help affordance near the connection probe. The box appears
  // proactively when any required credential field is empty (so a
  // newcomer is pointed at the token page + README before they even
  // click Test), and after a Test that returned 401/403. `slot` is
  // the container the box renders into; `authError` latches a
  // probe-time auth failure so the box stays up until the fields
  // change. Both reset on each display().
  private tokenHelpSlot: HTMLElement | null = null;
  private tokenHelpAuthError = false;

  hide(): void {
    // Inherited from PluginSettingTab; runs when the user leaves
    // the page. Clean up the subscription so we don't leak.
    this.drainStatusUnsubscribe?.();
    this.drainStatusUnsubscribe = null;
    if (this.drainStatusTickTimer !== null) {
      clearInterval(this.drainStatusTickTimer);
      this.drainStatusTickTimer = null;
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // TODO §10 — at the very top: the plugin name + version (+ a small repo
    // link), so the user can see WHOSE settings these are and which version is
    // installed. Values come from manifest.json.
    const m = this.plugin.manifest;
    const titleEl = containerEl.createEl("div", {
      cls: "github-easy-sync-settings-title",
    });
    titleEl.createSpan({ text: `${m.name} ${m.version}` });
    if (m.authorUrl) {
      titleEl.appendText(" ");
      const link = titleEl.createEl("a", {
        text: "(repo)",
        href: m.authorUrl,
        cls: "github-easy-sync-settings-repo",
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }

    // Visibility for unresolved conflicts lives in three places:
    // status bar, pre-sync modal, ribbon badge. The settings tab
    // does NOT carry a conflict list — users with a conflict click
    // the status bar or ribbon to open the sibling, not the
    // settings tab.

    // ── Drain status (Stage 7) ───────────────────────────────────────
    // Shown at the top of the page so it's instantly visible. While
    // a drain is running: live timer + current path + [Stop drain].
    // When idle: passive "Last sync: …" + last error if any.
    this.renderDrainStatusSection(containerEl);

    // ── Remote repository ────────────────────────────────────────────
    new Setting(containerEl).setName("Remote Repository").setHeading();

    let tokenInput: TextComponent;
    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "A personal access token or fine-grained token with read+write access to your repository.",
      )
      .addButton((button) =>
        button.setIcon("eye-off").onClick(() => {
          if (tokenInput.inputEl.type === "password") {
            tokenInput.inputEl.type = "text";
            button.setIcon("eye");
          } else {
            tokenInput.inputEl.type = "password";
            button.setIcon("eye-off");
          }
        }),
      )
      .addText((text) => {
        text
          .setPlaceholder("Token")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (value) => {
            // Android paste reliably appends trailing whitespace; trim
            // here so a paste-then-leave-field sequence doesn't save a
            // token that 401s against GitHub for "no apparent reason".
            this.plugin.settings.githubToken = value.trim();
            await this.plugin.saveSettings();
            this.refreshTokenHelp();
          });
        text.inputEl.type = "password";
        // Select the whole (old) token whenever the field gains focus, so a click +
        // Ctrl/Cmd+V (or right-click → Paste) replaces it in one go — the common token-
        // renewal flow. Deferred past the focusing click's OWN caret placement (which
        // fires after `focus` and would otherwise collapse the selection to the click
        // point). A second click while ALREADY focused doesn't re-fire `focus`, so the
        // user can still position a caret to hand-edit. Works regardless of the eye
        // toggle (select() applies to a password field too).
        text.inputEl.addEventListener("focus", () => {
          requestAnimationFrame(() => text.inputEl.select());
        });
        tokenInput = text;
      });

    new Setting(containerEl)
      .setName("Owner")
      .setDesc("Owner of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Owner")
          .setValue(this.plugin.settings.githubOwner)
          .onChange(async (value) => {
            this.plugin.settings.githubOwner = value.trim();
            await this.plugin.saveSettings();
            this.refreshTokenHelp();
          }),
      );

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("Name of the repository to sync")
      .addText((text) =>
        text
          .setPlaceholder("Repository")
          .setValue(this.plugin.settings.githubRepo)
          .onChange(async (value) => {
            this.plugin.settings.githubRepo = value.trim();
            await this.plugin.saveSettings();
            this.refreshTokenHelp();
          }),
      );

    new Setting(containerEl)
      .setName("Repository branch")
      .setDesc("Branch to sync")
      .addText((text) =>
        text
          .setPlaceholder("Branch name")
          .setValue(this.plugin.settings.githubBranch)
          .onChange(async (value) => {
            this.plugin.settings.githubBranch = value.trim();
            await this.plugin.saveSettings();
            this.refreshTokenHelp();
          }),
      );

    // ── Connection probe ─────────────────────────────────────────────
    // Lightweight standalone check: GET /repos/{owner}/{repo}, then if
    // that passes and a branch is set, GET /repos/.../branches/{branch}.
    // Deliberately uses requestUrl directly instead of going through
    // GithubClient so the probe doesn't touch Sync2Manager state
    // (snapshot, push-queue, conflict-store) — a misconfigured click
    // should never mutate anything.
    const probeResultEl = containerEl.createDiv({
      attr: {
        style:
          "margin: 0 0 1.5em 0; padding: 0.5em 0.75em; border-radius: 4px; " +
          "font-family: var(--font-monospace); font-size: 0.85em; " +
          "white-space: pre-wrap; display: none;",
      },
    });
    const setProbeResult = (kind: "ok" | "err" | "info", text: string) => {
      probeResultEl.style.display = "block";
      probeResultEl.style.background =
        kind === "ok"
          ? "var(--background-modifier-success)"
          : kind === "err"
            ? "var(--background-modifier-error)"
            : "var(--background-secondary)";
      probeResultEl.style.color =
        kind === "ok"
          ? "var(--text-on-accent)"
          : kind === "err"
            ? "var(--text-on-accent)"
            : "var(--text-normal)";
      probeResultEl.setText(text);
    };
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc(
        "One-shot lightweight probe against GitHub. Verifies token, " +
          "owner/repo accessibility, and branch existence. Reads only — " +
          "never writes or mutates plugin state.",
      )
      .addButton((button) =>
        button
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            const { githubToken, githubOwner, githubRepo, githubBranch } =
              this.plugin.settings;
            // Fresh probe — clear any latched auth flag; the branches
            // below re-set it on a 401/403. The token-help box still
            // shows for empty fields via refreshTokenHelp's field check.
            this.tokenHelpAuthError = false;
            if (!githubToken || !githubOwner || !githubRepo) {
              setProbeResult(
                "err",
                "✗ Fill in token, owner, and repo first.",
              );
              this.refreshTokenHelp();
              return;
            }
            setProbeResult("info", "Probing…");
            button.setDisabled(true);
            try {
              const repoRes = await requestUrl({
                url: `https://api.github.com/repos/${githubOwner}/${githubRepo}`,
                method: "GET",
                headers: {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${githubToken}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                throw: false,
              });
              if (repoRes.status === 401) {
                setProbeResult(
                  "err",
                  "✗ 401 Unauthorized — token invalid or expired.\n" +
                    "Generate a new token on GitHub → Settings → Developer settings.",
                );
                this.tokenHelpAuthError = true;
                this.plugin.tokenExpiredFlag?.set(); // E1: probe confirmed expired
                return;
              }
              if (repoRes.status === 403) {
                setProbeResult(
                  "err",
                  "✗ 403 Forbidden — token lacks the required scope.\n" +
                    "Fine-grained PAT needs: Contents (R/W), Metadata (R).\n" +
                    "Classic PAT needs: repo.",
                );
                this.tokenHelpAuthError = true;
                this.plugin.tokenExpiredFlag?.set(); // E1: probe confirmed expired
                return;
              }
              if (repoRes.status === 404) {
                setProbeResult(
                  "err",
                  `✗ 404 Not Found — \`${githubOwner}/${githubRepo}\` ` +
                    "is unreachable for this token.\n" +
                    "Likely causes:\n" +
                    "  • Typo in owner or repo (case-sensitive on REST API).\n" +
                    "  • Fine-grained PAT doesn't include this repo in its " +
                    "Repository access list.\n" +
                    "  • Repo is private and token belongs to a different user.",
                );
                return;
              }
              if (repoRes.status >= 500) {
                const reqId = repoRes.headers?.["X-GitHub-Request-Id"] ?? "";
                setProbeResult(
                  "err",
                  `✗ ${repoRes.status} GitHub server error. Retry later.\n` +
                    (reqId ? `Request ID: ${reqId}` : ""),
                );
                return;
              }
              if (repoRes.status < 200 || repoRes.status >= 400) {
                setProbeResult(
                  "err",
                  `✗ Unexpected status ${repoRes.status}.\n` +
                    String(repoRes.text ?? "").slice(0, 200),
                );
                return;
              }
              const repoJson = repoRes.json ?? {};
              const visibility = repoJson.private ? "private" : "public";
              const defaultBranch = repoJson.default_branch ?? "?";
              const fullName = repoJson.full_name ?? `${githubOwner}/${githubRepo}`;
              if (!githubBranch) {
                setProbeResult(
                  "ok",
                  `✓ Repo \`${fullName}\` accessible (${visibility}).\n` +
                    `Default branch: ${defaultBranch}.\n` +
                    "Branch field is empty — no branch check performed.",
                );
                this.plugin.tokenExpiredFlag?.clear(); // E1: probe confirmed auth OK
                return;
              }
              const branchRes = await requestUrl({
                url: `https://api.github.com/repos/${githubOwner}/${githubRepo}/branches/${encodeURIComponent(githubBranch)}`,
                method: "GET",
                headers: {
                  Accept: "application/vnd.github+json",
                  Authorization: `Bearer ${githubToken}`,
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                throw: false,
              });
              if (branchRes.status === 404) {
                setProbeResult(
                  "err",
                  `✗ Repo OK, but branch \`${githubBranch}\` not found.\n` +
                    `Default branch on this repo: ${defaultBranch}.\n` +
                    "Check for typos or create the branch on GitHub first.",
                );
                return;
              }
              if (branchRes.status < 200 || branchRes.status >= 400) {
                setProbeResult(
                  "err",
                  `✗ Branch check failed: status ${branchRes.status}.`,
                );
                return;
              }
              const branchSha =
                String(branchRes.json?.commit?.sha ?? "").slice(0, 7) || "?";
              setProbeResult(
                "ok",
                `✓ All good. Repo \`${fullName}\` (${visibility}), ` +
                  `branch \`${githubBranch}\` exists, HEAD ${branchSha}.\n` +
                  "Plugin is ready to sync.",
              );
              this.plugin.tokenExpiredFlag?.clear(); // E1: probe confirmed auth OK
            } catch (err) {
              setProbeResult(
                "err",
                "✗ Network error: " +
                  String((err as Error)?.message ?? err).slice(0, 200),
              );
            } finally {
              button.setDisabled(false);
              // Re-evaluate the token-help box after every probe
              // outcome: shown if 401/403 latched the auth flag above
              // OR any credential field is still empty; hidden when
              // everything checks out.
              this.refreshTokenHelp();
            }
          }),
      );
    // Mount the result div right after the Setting row.
    containerEl.appendChild(probeResultEl);

    // Token-help slot — sits directly UNDER the probe result so any
    // auth box appears beneath the red text. Reset the auth latch on
    // each display(); refreshTokenHelp() (called below + from the
    // credential-field onChanges + from Test) decides whether the box
    // is shown. On first launch all fields are empty, so the box is
    // visible the moment the user opens Settings — the two key links
    // (GitHub token page + README) are right there.
    this.tokenHelpSlot = containerEl.createDiv();
    this.tokenHelpAuthError = false;
    this.refreshTokenHelp();

    // ── Device identity ─────────────────────────────────────────────
    new Setting(containerEl).setName("Sync").setHeading();

    // No commit-message template input. Hardcoded formats live in
    // src/sync2/commit-message.ts; the device label is the only
    // user-tunable component, appearing as the trailing " (label)"
    // suffix on every sync2 commit. The live preview below shows
    // the user what that looks like.
    const previews: Array<() => void> = [];
    const renderDeviceLabelPreview = (): string =>
      // Illustrative — current time stands in for a batch's createdAt.
      formatSyncMessage(this.plugin.settings.deviceLabel ?? "Obsidian", Date.now());

    const deviceLabelSetting = new Setting(containerEl)
      .setName("Device label")
      .setDesc(
        "Label for this machine. Baked into commit messages as a trailing " +
          '" (label)" suffix and into conflict-resolution sibling-file names. ',
      )
      .addText((text) =>
        text
          .setPlaceholder("Obsidian")
          .setValue(this.plugin.settings.deviceLabel ?? "Obsidian")
          .onChange(async (value) => {
            this.plugin.settings.deviceLabel = value.trim() || "Obsidian";
            await this.plugin.saveSettings();
            for (const refresh of previews) refresh();
          }),
      );
    const deviceLabelPreview = makePreviewElement(deviceLabelSetting.infoEl);
    const updateDeviceLabelPreview = (): void => {
      deviceLabelPreview.setText(`Sync commit example: "${renderDeviceLabelPreview()}"`);
    };
    updateDeviceLabelPreview();
    previews.push(updateDeviceLabelPreview);

    // Optional git author identity (SYNC2.md §4.4). When BOTH are
    // filled, commits carry this name/email + the local commit time
    // as git's author/committer, so the GitHub commit date reflects
    // when you committed rather than when it pushed. Empty = no
    // override (GitHub uses the token's user + push time).
    new Setting(containerEl)
      .setName("Git author name (optional)")
      .setDesc(
        "Like `git config user.name`. Defaults to the `Owner` property above " +
          "when empty, so usually you only need to fill the email " +
          "below to stamp commits with your identity + local commit " +
          "time. Leave both empty to use the token's GitHub account.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Defaults to Owner")
          .setValue(this.plugin.settings.gitAuthorName ?? "")
          .onChange(async (value) => {
            this.plugin.settings.gitAuthorName = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("Git author email (optional)")
      .setDesc(
        "Like `git config user.email`. Must be a VERIFIED email on " +
          "your GitHub account for commits to be attributed to you " +
          "(otherwise they still commit, just without contribution-" +
          "graph credit — same as plain git).",
      )
      .addText((text) =>
        text
          .setPlaceholder("you@example.com")
          .setValue(this.plugin.settings.gitAuthorEmail ?? "")
          .onChange(async (value) => {
            this.plugin.settings.gitAuthorEmail = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Sync strategy ───────────────────────────────────────────────
    const syncStrategies = {
      manual: "Manually",
      interval: "On Interval",
    };
    const uploadStrategySetting = new Setting(containerEl)
      .setName("Sync strategy")
      .setDesc("How to sync files with the remote repository");

    let syncInterval = "5";
    if (this.plugin.settings.syncInterval) {
      syncInterval = this.plugin.settings.syncInterval.toString();
    }
    const intervalSettings = new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Interval in minutes between automatic syncs (default 5)")
      .addText((text) =>
        text
          .setPlaceholder("Interval in minutes")
          .setValue(syncInterval)
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = parseInt(value) || 5;
            await this.plugin.saveSettings();
            this.plugin.restartSyncInterval();
          }),
      );
    // "Sync interval" only makes sense for the interval strategy — HIDE it (not just
    // grey it out) under "Manually", and reveal it when "On Interval" is chosen (or was
    // already set). Toggled here on initial render + in the strategy dropdown's onChange.
    const setIntervalVisible = (show: boolean) => {
      intervalSettings.settingEl.style.display = show ? "" : "none";
    };
    setIntervalVisible(this.plugin.settings.syncStrategy === "interval");

    uploadStrategySetting.addDropdown((dropdown) =>
      dropdown
        .addOptions(syncStrategies)
        .setValue(this.plugin.settings.syncStrategy)
        .onChange(async (value: keyof typeof syncStrategies) => {
          setIntervalVisible(value === "interval");
          this.plugin.settings.syncStrategy = value;
          await this.plugin.saveSettings();
          if (value === "interval") {
            this.plugin.startSyncInterval();
          } else {
            this.plugin.stopSyncInterval();
          }
        }),
    );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Trigger a sync as soon as Obsidian finishes loading.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync starts with commit")
      .setDesc(
        "Master toggle. When ON, every Sync action " +
          "(manual click, interval, startup) first commits your " +
          "local changes, then uploads them to GitHub. When OFF, " +
          "do only pull from repo and push already staged commits; committing " +
          "becomes a separate action via the [Commit] ribbon button.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncStartsWithCommit ?? true)
          .onChange(async (value) => {
            this.plugin.settings.syncStartsWithCommit = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-canonicalize text files")
      .setDesc(
        "When ON, the plugin rewrites your vault's text files locally to " +
          "LF line endings, strips UTF-8 BOM, and ensures a trailing " +
          "newline — both on pull (after fetching from GitHub) and on " +
          "commit (before snapshotting your edits into the queue). " +
          "Applies ONLY to files you edit; Obsidian's own config under " +
          ".obsidian/ is left byte-exact. " +
          "Turn OFF to preserve byte-exact text round-trips (e.g., for " +
          "a Windows-shared repo that expects CRLF, or files whose " +
          "exact trailing-newline matters).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoCanonicalizeTextFiles ?? false)
          .onChange(async (value) => {
            this.plugin.settings.autoCanonicalizeTextFiles = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Consolidate commits into one (if possible)")
      .setDesc(
        "Fold consecutive commits into a single batch when no " +
          "upload has happened in between. Covers two cases: " +
          "(1) Offline accumulate — when an upload is pending and " +
          "new Sync clicks arrive, they merge into the stuck batch " +
          "so eventual replay is one commit; (2) Split-mode " +
          "[Commit] taps — clicking [Commit] several times in a " +
          "row without an intervening [Sync] collapses into one batch.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.consolidateCommits ?? false)
          .onChange(async (value) => {
            this.plugin.settings.consolidateCommits = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync configs (.obsidian/ folder)")
      .setDesc(
        "Sync everything under your vault's config folder (Obsidian settings, " +
          "installed plugins, snippets). This setting is per-device and never " +
          "propagates: one machine can sync configs while another doesn't. " +
          "When OFF, only the two invariant gitignores under the config folder " +
          "still sync (they carry shared rules every device must agree on, " +
          "including the toggle below). The data.json for THIS plugin is " +
          "ALWAYS blocked regardless.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncConfigDir ?? true)
          .onChange(async (value) => {
            this.plugin.settings.syncConfigDir = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Sync plugins data.json (global .gitignore rule!)")
      .setDesc(
        "ENABLE WITH CAUTION! Plugin data.json files may contain " +
        "sensitive data (API tokens, credentials, license keys) that you " +
        "usually don't want to make public. " +
        "The data.json file for THIS plugin is ALWAYS blocked from syncing (it contains " +
        "a GitHub token); this toggle never affects that.",
      )
      .addToggle((toggle) => {
        // Read the cached state synchronously — calling setValue from
        // an async .then() resolution triggers an infinite re-entry
        // inside Obsidian's settings pipeline that freezes the
        // renderer. The cache is primed once at onload in initSync2()
        // and kept in sync on every successful toggle change below.
        toggle.setValue(this.plugin.pushPluginsDataJsonCached);
        const inv = this.plugin.invariants;
        if (inv) {
          toggle.onChange(async (value) => {
            try {
              await inv.setPushPluginsDataJson(value);
              this.plugin.pushPluginsDataJsonCached = value;
            } catch (err) {
              // Don't call toggle.setValue here to revert — it's an
              // async setValue and we proved that triggers the
              // Obsidian re-entry hang. The visual toggle may show
              // the wrong state until the user re-opens settings;
              // the Notice tells them the persisted state didn't
              // change.
              new Notice(`Could not update gitignore: ${err}`);
            }
          });
        }
      });

    // ── Interface ───────────────────────────────────────────────────
    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar item")
      .setDesc(
        "Show the 'GitHub' status-bar item — it displays the pending-commit " +
          "count (↑ N) and the open-conflict count (N ⁇), and clicking it opens " +
          "a menu (Sync / Commit / Open diff-panel / Settings).",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showStatusBarItem)
          .onChange(async (value) => {
            this.plugin.settings.showStatusBarItem = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showStatusBarItem();
            else this.plugin.hideStatusBarItem();
          });
      });

    new Setting(containerEl)
      .setName("Show sync ribbon button")
      .setDesc(
        "Display the [Sync with GitHub] ribbon button (action depends on the " +
          "`Sync starts with commit` master toggle above). The icon's " +
          "badge shows the count of unsent commits in the commit queue.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSyncRibbonButton)
          .onChange(async (value) => {
            this.plugin.settings.showSyncRibbonButton = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showSyncRibbonIcon();
            else this.plugin.hideSyncRibbonIcon();
          });
      });

    new Setting(containerEl)
      .setName("Show Diff-Panel ribbon button")
      .setDesc(
        "Display a separate [Diff-Panel] ribbon button (distinct from Sync). " +
          "It opens the conflict / deleted / compare views and carries a badge " +
          "with the number of unresolved conflicts.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showDiffRibbonButton ?? true)
          .onChange(async (value) => {
            this.plugin.settings.showDiffRibbonButton = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showDiffRibbonIcon();
            else this.plugin.hideDiffRibbonIcon();
          });
      });

    new Setting(containerEl)
      .setName("Show commit ribbon button")
      .setDesc(
        "Independent of the master toggle. When ON, shows a " +
          "separate [Commit] ribbon button that enqueues changed files " +
          "to the local commit queue without touching the network. " +
          "Most useful in split mode (`Sync starts with commit` " +
          "OFF) where it's the only way to add commits.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showCommitRibbonButton ?? false)
          .onChange(async (value) => {
            this.plugin.settings.showCommitRibbonButton = value;
            await this.plugin.saveSettings();
            if (value) this.plugin.showCommitRibbonIcon();
            else this.plugin.hideCommitRibbonIcon();
          });
      });

    new Setting(containerEl)
      .setName("Spin the sync icon while syncing")
      .setDesc(
        "Rotate the sync ribbon icon while a sync is in progress. It's a clear, " +
          "at-a-glance cue, but purely cosmetic. Turn OFF to stop the rotation " +
          "(the icon still tints to the accent colour while syncing) — handy to " +
          "reduce motion or save a little battery.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.spinSyncIcon ?? true)
          .onChange(async (value) => {
            this.plugin.settings.spinSyncIcon = value;
            await this.plugin.saveSettings();
            this.plugin.applySyncIconSpin();
          });
      });

      // ── Diff Editor ─────────────────────────────────────────────────
      new Setting(containerEl).setName("Diff Editor").setHeading();

      new Setting(containerEl)
          .setName("Touch mode (read-only resolve)")
          .setDesc(
              "Open the conflict diff-editor read-only: resolve each conflict with the " +
              "on-screen buttons only — typing/editing is disabled and the mobile soft " +
              "keyboard is suppressed. Selection, copy and undo/redo still work. " +
              "Convenient on small touch screens.",
          )
          .addToggle((toggle) => {
              toggle
                  .setValue(this.plugin.settings.diffEditorTouchMode ?? false)
                  .onChange(async (value) => {
                      this.plugin.settings.diffEditorTouchMode = value;
                      await this.plugin.saveSettings();
                  });
          });

      new Setting(containerEl)
          .setName("Diff highlight mode")
          .setDesc(
              "How the changed parts INSIDE a conflict line are highlighted: " +
              "'Characters' marks only the differing characters (precise); 'Words' " +
              "marks whole changed words. Large diff-groups always fall back to word-level " +
              "(per-character is too slow on big blocks).",
          )
          .addDropdown((dd) => {
              dd.addOption("characters", "Characters")
                  .addOption("words", "Words")
                  .setValue(this.plugin.settings.diffEditorDiffMode ?? "characters")
                  .onChange(async (value) => {
                      this.plugin.settings.diffEditorDiffMode = value === "words" ? "words" : "characters";
                      await this.plugin.saveSettings();
                  });
          });

      // TODO §17 — per-mode auto-focus default (conflict ON, history/deleted OFF). Each is
      // still toggleable per-document in the diff-editor toolbar.
      const autoFocusModes: Array<{
          mode: "conflict" | "history" | "deleted";
          name: string;
          def: boolean;
      }> = [
          { mode: "conflict", name: "Auto-focus conflicts", def: true },
          { mode: "history", name: "Auto-focus history", def: false },
          { mode: "deleted", name: "Auto-focus deleted", def: false },
      ];
      for (const { mode, name, def } of autoFocusModes) {
          new Setting(containerEl)
              .setName(name)
              .setDesc(
                  "On open/each resolve, scroll the diff-editor to the FIRST remaining " +
                  "difference (cursor at its start). Toggleable per-document in the toolbar. " +
                  "(§2.2.15 / §17)",
              )
              .addToggle((toggle) => {
                  toggle
                      .setValue(this.plugin.settings.diffEditorAutoFocus?.[mode] ?? def)
                      .onChange(async (value) => {
                          const cur = this.plugin.settings.diffEditorAutoFocus ?? {};
                          this.plugin.settings.diffEditorAutoFocus = { ...cur, [mode]: value };
                          await this.plugin.saveSettings();
                      });
              });
      }

      // ── Performance ─────────────────────────────────────────────────
      new Setting(containerEl).setName("Performance").setHeading();

      new Setting(containerEl)
          .setName("Maximum auto-merge file size (KB)")
          .setDesc(
              "Skip the 3-way text auto-merge for files larger than this. " +
              "Above the threshold the engine just uploads your local " +
              "bytes (no automated merge) — useful to sidestep multi-MB " +
              "merge slowdowns. Default 1024 KB (1 MB). Increasing past " +
              "~2 MB may cause noticeable hangs even with worker offload.",
          )
          .addText((text) => {
              const current = Math.round(
                  (this.plugin.settings.maxAutoMergeSizeBytes ?? 1_000_000) / 1024,
              );
              text
                  .setPlaceholder("1024")
                  .setValue(String(current))
                  .onChange(async (value) => {
                      const kb = Number((value ?? "").trim());
                      if (!Number.isFinite(kb) || kb <= 0) {
                          // Invalid input — fall back to default. Don't surface
                          // a modal; the placeholder + description tell the user
                          // what's expected.
                          this.plugin.settings.maxAutoMergeSizeBytes = 1_000_000;
                      } else {
                          this.plugin.settings.maxAutoMergeSizeBytes = Math.round(
                              kb * 1024,
                          );
                      }
                      await this.plugin.saveSettings();
                  });
          });

    // ── Logging ─────────────────────────────────────────────────────
    new Setting(containerEl).setName("Logging").setHeading();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(
        `Persist logs to <vault>/${logFileNameFor(manifest.id)}. Useful for bug reports. ` +
        "To view this log file, make sure that Settings (Options) > Files and links > Show all file types is enabled. " +
        "Turning logging off deletes the file from the vault.",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableLogging = value;
            if (value) await this.plugin.logger.enable();
            else await this.plugin.logger.disable();
            await this.plugin.saveSettings();
            // The "Clean logs" Setting below is gated on
            // enableLogging — re-render the whole tab so the
            // button appears / disappears in sync with the toggle.
            this.display();
          });
      });

    // "Clean logs" is meaningful only while logging is on — once
    // it's off, the file is gone (logger.disable() removed it) and
    // there's nothing to clean. Hide the row entirely so the
    // settings panel doesn't carry dead UI.
    if (this.plugin.settings.enableLogging) {
      new Setting(containerEl)
        .setName("Clean logs")
        .setDesc("Truncate the log file to 0 bytes.")
        .addButton((button) => {
          button.setButtonText("Clean").onClick(async () => {
            await this.plugin.logger.clean();
          });
        });
    }

    // ── Danger zone ─────────────────────────────────────────────────
    new Setting(containerEl).setName("Danger zone").setHeading();

    new Setting(containerEl)
      .setName("Reset plugin")
      .setDesc(
        "Wipe ALL plugin state: GitHub token, repository settings, sync " +
          "history, pending push queue, pending conflicts. Local vault " +
          "files are untouched. Use this when rotating a leaked token, " +
          "when troubleshooting, or to fully sever the link to a " +
          "repository before pointing the plugin at a different one. " +
          "Irreversible.",
      )
      .addButton((button) => {
        button
          .setButtonText("Reset")
          .setWarning()
          .onClick(() => {
            new ResetConfirmModal(this.app, async () => {
              try {
                await this.plugin.resetPluginState();
                new Notice(
                  "Plugin reset complete. Re-enter your GitHub settings.",
                  10000,
                );
                this.display();
              } catch (err) {
                new Notice(`Reset failed: ${err}`, 10000);
              }
            }).open();
          });
      });
  }

  // Stage 7: live "Drain status" section. Subscribes to the
  // Sync2Manager's drainStateChanged events and re-paints the
  // timer + path + last error + [Stop drain] button. Survives
  // re-display() via the saved unsubscribe handle.
  // Show or hide the token-help box near the connection probe. Shown
  // when ANY required credential field is empty (proactive onboarding
  // — newcomers see the GitHub-token + README links the instant they
  // open Settings) OR when the last Test returned 401/403. Idempotent:
  // re-renders the box only when its visibility flips.
  private refreshTokenHelp(): void {
    const slot = this.tokenHelpSlot;
    if (!slot) return;
    const { githubToken, githubOwner, githubRepo, githubBranch } =
      this.plugin.settings;
    const anyEmpty =
      !githubToken || !githubOwner || !githubRepo || !githubBranch;
    const shouldShow = anyEmpty || this.tokenHelpAuthError;
    const isShown = slot.childElementCount > 0;
    if (shouldShow && !isShown) {
      renderTokenHelpBox(slot);
    } else if (!shouldShow && isShown) {
      slot.empty();
    }
  }

  private renderDrainStatusSection(parent: HTMLElement): void {
    // Tear down any previous subscription before we re-render.
    this.drainStatusUnsubscribe?.();
    this.drainStatusUnsubscribe = null;
    if (this.drainStatusTickTimer !== null) {
      clearInterval(this.drainStatusTickTimer);
      this.drainStatusTickTimer = null;
    }

    new Setting(parent).setName("GitHub sync status").setHeading();

    const card = parent.createDiv();
    card.style.padding = "0.75em 1em";
    card.style.margin = "0 0 1.5em 0";
    card.style.borderRadius = "4px";
    card.style.background = "var(--background-secondary)";
    card.style.fontFamily = "var(--font-monospace)";
    card.style.fontSize = "0.85em";
    card.style.whiteSpace = "pre-wrap";

    const statusLine = card.createDiv();
    const errorLine = card.createDiv();
    errorLine.style.marginTop = "0.5em";
    errorLine.style.color = "var(--text-error)";
    // Slot for the token-help box, shown under the error line when the
    // last drain error was a 401/403. Distinct from the probe's
    // token-help slot — this one tracks the live drain status.
    const drainTokenHelpSlot = card.createDiv();
    const stopBtnWrap = card.createDiv();
    stopBtnWrap.style.marginTop = "0.5em";
    const stopBtn = stopBtnWrap.createEl("button", { text: "Stop sync" });
    stopBtn.style.padding = "0.4em 0.9em";
    stopBtn.style.background = "var(--background-modifier-error)";
    stopBtn.style.color = "var(--text-on-accent)";
    stopBtn.style.border = "none";
    stopBtn.style.borderRadius = "4px";
    stopBtn.style.cursor = "pointer";
    stopBtn.addEventListener("click", () => {
      this.plugin.sync2Manager.cancelDrain();
      new Notice("Sync cancellation requested.", 4000);
    });

    const render = (status: ReturnType<
      typeof this.plugin.sync2Manager.getDrainStatus
    >): void => {
      if (status.state === "running") {
        const elapsed = status.startedAt
          ? Math.round((Date.now() - status.startedAt) / 1000)
          : 0;
        const pathLabel = status.currentPath ?? "(initialising)";
        const counter =
          status.totalFiles > 0
            ? `${status.currentFile} / ${status.totalFiles}`
            : "—";
        statusLine.setText(
          `🌀 Syncing with GitHub for ${elapsed}s\n` +
            `Currently: ${pathLabel}\n` +
            `File: ${counter}`,
        );
        stopBtn.style.display = "inline-block";
        if (this.drainStatusTickTimer === null) {
          this.drainStatusTickTimer = setInterval(() => render(
            this.plugin.sync2Manager.getDrainStatus(),
          ), 1000);
        }
      } else {
        statusLine.setText("⏸ Sync idle");
        stopBtn.style.display = "none";
        if (this.drainStatusTickTimer !== null) {
          clearInterval(this.drainStatusTickTimer);
          this.drainStatusTickTimer = null;
        }
      }
      if (status.lastError !== null) {
        const ago = Math.round(
          (Date.now() - status.lastError.whenMs) / 1000,
        );
        errorLine.setText(
          `⚠ Last error (${ago}s ago): ${status.lastError.message}`,
        );
      } else {
        errorLine.setText("");
      }
      // Token-help box under the error line for 401/403 failures, so a
      // user who doesn't recognise "401" still gets the actionable
      // links. Re-render only when visibility flips.
      const wantHelp = status.lastError?.isAuthError === true;
      const hasHelp = drainTokenHelpSlot.childElementCount > 0;
      if (wantHelp && !hasHelp) {
        renderTokenHelpBox(drainTokenHelpSlot);
      } else if (!wantHelp && hasHelp) {
        drainTokenHelpSlot.empty();
      }
    };

    this.drainStatusUnsubscribe = this.plugin.sync2Manager.setDrainStatusListener(
      (s) => render(s),
    );
  }
}

// Two-step confirmation for the Reset button. Requires the user to
// type a fixed phrase before "Confirm reset" becomes clickable —
// stops the user from one-clicking a destructive action by accident.
class ResetConfirmModal extends Modal {
  private readonly onConfirm: () => Promise<void> | void;
  private readonly phrase = "RESET";

  constructor(app: App, onConfirm: () => Promise<void> | void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Reset plugin?");

    contentEl.createEl("p", {
      text:
        "This will wipe the GitHub token, repository settings, sync " +
        "history, pending push queue, and pending conflicts. Local " +
        "vault files are NOT touched. This cannot be undone.",
    });
    contentEl.createEl("p", {
      text: `Type ${this.phrase} below to confirm.`,
    });

    let confirmButton: HTMLButtonElement | null = null;
    const inputEl = contentEl.createEl("input", {
      attr: {
        type: "text",
        placeholder: this.phrase,
      },
    });
    inputEl.style.width = "100%";
    inputEl.style.padding = "8px";
    inputEl.style.marginBottom = "12px";
    inputEl.addEventListener("input", () => {
      if (confirmButton) {
        confirmButton.disabled = inputEl.value.trim() !== this.phrase;
      }
    });

    const buttonRow = contentEl.createDiv();
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "flex-end";

    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());

    confirmButton = buttonRow.createEl("button", { text: "Confirm reset" });
    confirmButton.disabled = true;
    confirmButton.classList.add("mod-warning");
    confirmButton.addEventListener("click", async () => {
      this.close();
      await this.onConfirm();
    });

    inputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// Build the live-preview element placed under each commit-message
// input, INSIDE the Setting row's info column so it inherits the
// row's background (themes that draw a rounded grey zone keep the
// preview inside it). Styled as a quiet caption — italic, dimmer
// text, small top margin to break from the description.
function makePreviewElement(parent: HTMLElement): HTMLElement {
  const el = parent.createDiv({ cls: "sync2-template-preview" });
  el.style.fontSize = "0.85em";
  el.style.color = "var(--text-muted)";
  el.style.fontStyle = "italic";
  el.style.marginTop = "10px";
  el.style.userSelect = "text"; // let users copy the rendered preview
  return el;
}

