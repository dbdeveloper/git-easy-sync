// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Plugin settings shape. Older data.json files may contain fields
// no longer declared here; Object.assign loads them into memory but
// nothing reads them, and saving normalises back to the shape below.
export interface GitHubSyncSettings {
  // GitHub repo coordinates.
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;

  // Auto-sync.
  syncStrategy: "manual" | "interval";
  syncInterval: number; // minutes
  syncOnStartup: boolean;
  // Stage 7 semantic master toggle. Replaces the old
  // `syncStartsWithCommit` (which only governed interval/startup);
  // the new flag unifies behaviour across manual click, interval,
  // and startup surfaces.
  //
  //   - true (default): every Sync surface (manual click, interval,
  //                     startup) performs commit + drain. Matches
  //                     today's manual-click semantics; no surprise
  //                     for new users.
  //   - false:          Sync surfaces only drain the existing
  //                     `.push-queue` (or pull when empty). Commit
  //                     is the user's separate action via the
  //                     `[Commit]` ribbon button (showCommitRibbonButton
  //                     should also be on for usability — the
  //                     settings tab warns when both are off).
  //
  // Migration: old `syncStartsWithCommit` field is honored if present
  // (true → syncStartsWithCommit:true, false → false). On first
  // load with the old key present, loadSettings emits a log line
  // describing the rename so the user can update data.json by
  // hand on each device. See docs/tasks/SYNC2-WORKER-REORG.md §7
  // "Settings migration — none. Manual data.json update."
  syncStartsWithCommit?: boolean;

  // UI affordances.
  showStatusBarItem: boolean;
  showSyncRibbonButton: boolean;
  // Stage 7: independent of syncStartsWithCommit. When true, shows a
  // separate `[Commit]` ribbon icon. Combinations:
  //   - syncStartsWithCommit:true  + this:false → default UX (one
  //     Sync button does commit+drain).
  //   - syncStartsWithCommit:true  + this:true  → Sync still does
  //     commit+drain; user can also pre-stage extra commits via
  //     [Commit] before clicking Sync.
  //   - syncStartsWithCommit:false + this:true  → classic "split
  //     mode" — Commit enqueues, Sync drains.
  //   - syncStartsWithCommit:false + this:false → unusable shape;
  //     Settings tab surfaces a warning.
  showCommitRibbonButton?: boolean;
  // E3 (R2.7.4) — separate diff-panel ribbon icon (conflict-count badge +
  // always-available Conflicts/Deleted/Compare entry). Default ON.
  showDiffRibbonButton?: boolean;
  // §2.2.14 — diff-editor "Touch mode" default: open conflict views read-only
  // (resolve via buttons only; edits/typing blocked; mobile soft keyboard suppressed;
  // selection + copy + undo/redo still work). Default OFF.
  diffEditorTouchMode?: boolean;

  enableLogging: boolean;

  // No commit-message template field. Commit messages are hardcoded
  // via formatX helpers in src/sync2/commit-message.ts; `deviceLabel`
  // below is the only user-tunable component (the trailing suffix).

  // Stage 7 rename of `consolidateCommits`. The flag now
  // applies in two places:
  //   - When sync2 is offline (last push failed) and a new Sync
  //     click comes in, the new changes fold into the latest
  //     pending batch instead of stacking. Eventual replay is
  //     one commit. (Original behaviour.)
  //   - In `syncStartsWithCommit:false` split mode, when the user
  //     clicks [Commit] several times in a row without an
  //     intervening drain, the consecutive commits collapse into
  //     one batch. (New in Stage 7.)
  //
  // Migration: old `consolidateCommits` field is honored if
  // present; loadSettings emits a rename note on first load. See
  // docs/tasks/SYNC2-WORKER-REORG.md §7 for the manual data.json
  // update path.
  consolidateCommits?: boolean;

  // Per-device label baked into commit messages (as the trailing
  // suffix) and conflict-resolver sibling-file names. Same source
  // for both surfaces — change once, both update. Default
  // "Obsidian" reads naturally even for a single-device user
  // ("Sync at <date> (Obsidian)" — synced from Obsidian, the app).
  // Multi-device users override per machine ("Phone", "Desktop"…).
  deviceLabel?: string;

  // Optional git author identity, like `git config user.name` /
  // `user.email`. When BOTH are set, the engine passes them — plus
  // the local commit timestamp — as the commit's `author` and
  // `committer`, so git's metadata date records when you actually
  // committed (not when the batch later pushed). When either is
  // empty, no override happens: GitHub stamps the authenticated
  // token's user + push time, exactly as before. The email must be
  // verified on your GitHub account for commits to be attributed to
  // you (same rule as real git); an unverified email still commits,
  // just without contribution-graph credit. See SYNC2.md §4.4.
  gitAuthorName?: string;
  gitAuthorEmail?: string;

  // Per-device gate for paths under `<configDir>/`. When OFF, the
  // sync engine treats every configDir path as ignored EXCEPT the
  // two invariant gitignores (`<configDir>/.gitignore` and
  // `<configDir>/plugins/<self>/.gitignore`) — those propagate
  // regardless, because they encode shared rules every device must
  // agree on (including the "Push plugins data.json" toggle line).
  //
  // Stored here (per-device data.json) rather than the gitignore
  // because, by design, devices may disagree: one machine syncs its
  // Obsidian configs and the other doesn't. data.json is hard-blocked
  // from sync, so there's no propagation channel for this preference.
  //
  // Default `false`: explicit opt-in. Obsidian configs include
  // workspace state, theme settings, and plugin install state — many
  // users (especially multi-device users) don't want one machine's
  // layout to overwrite another's. The two invariant gitignores
  // still sync regardless so shared rules (denylist, plugin-folder
  // allowlist) converge across devices.
  syncConfigDir?: boolean;

  // Pull-side + click-time text canonicalization (CRLF→LF, BOM strip,
  // trailing-NL). Default `true` — the engine rewrites non-canonical
  // text bytes both locally on pull AND when copying the user's edits
  // into a batch on click. Set `false` if you have a real reason to
  // preserve byte-exact text round-trips with GitHub (e.g., a repo
  // shared with Windows users whose tooling expects CRLF, or files
  // whose trailing-newline matters). With this off, plugin treats
  // text the same as binary at the byte level.
  autoCanonicalizeTextFiles?: boolean;

  // ── Performance ─────────────────────────────────────────────────
  // Stage 7: maximum input size for the reconcile-time 3-way auto
  // merge, in BYTES. Above this size the engine skips the
  // attemptAutoMerge dance and pushes the local bytes as-is —
  // documented loss of automated 3-way merge for big files, in
  // exchange for sidestepping (a) the node-diff3 scaling cliff
  // (~85 s at 4.6 MB on mobile) and (b) the multi-MB base64 decode
  // bridge stalls observed in the May 2026 field investigation.
  //
  // Defaults to 1_000_000 (1 MB), matching the Stage 8 perf-test
  // recommendation. Conservative on purpose — the Stage 4 Worker
  // offload keeps the UI responsive during merge, but the
  // wall-clock at 5 MB on a phone is still 30-80 s extrapolated
  // from Node baselines. Tune up only if the corpus genuinely
  // needs auto-merge above 1 MB AND you've measured the wall-clock
  // on the slowest device.
  //
  // Stored in bytes (not KB / MB) so the wire format never has a
  // decimal-point ambiguity (e.g., "1.5" vs "1500000"). Settings UI
  // surfaces the input in KB for readability and converts.
  maxAutoMergeSizeBytes?: number;
}

// NOTE: "Push plugins data.json to GitHub" is NOT a per-device
// setting field. Its source of truth is the presence of the line
// `!plugins/*/data.json` in `<configDir>/.gitignore`. The
// settings-tab checkbox reads/writes that file via
// GitignoreInvariants.getPushPluginsDataJson / setPushPluginsDataJson.
// Storing it here would have to either (a) duplicate state with the
// gitignore (drift risk) or (b) propagate cross-device differently
// from the gitignore itself (ping-pong on devices that disagree).
// Letting the gitignore be the single source keeps both devices
// converging on the same policy as soon as one of them pushes the
// gitignore.

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  syncStrategy: "manual",
  syncInterval: 5,
  syncOnStartup: false,
  syncStartsWithCommit: true,
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showCommitRibbonButton: false,
  showDiffRibbonButton: true,
  // diffEditorTouchMode is intentionally ABSENT here — its default is platform-dependent
  // (desktop=false, mobile=true), applied in main.ts loadSettings when unset.
  enableLogging: false,
  consolidateCommits: false,
  deviceLabel: "Obsidian",
  syncConfigDir: false,
  // Off by default: a "true" default surprised first-time users by
  // turning their initial adoption into a "convergence push" (we
  // canonicalize remote bytes on pull, skip recordSync because bytes
  // changed, then findChanges emits the file as modified and pushes
  // canonical bytes back). For repos with CRLF/BOM history that's
  // tens to hundreds of phantom commits on first setup. Opt-in keeps
  // the safe behavior and lets users who actually want canonical
  // text on disk turn it on knowingly.
  autoCanonicalizeTextFiles: false,
  maxAutoMergeSizeBytes: 1_000_000,
};
