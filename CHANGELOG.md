# Changelog

All notable changes to **Git Easy Sync** are documented in this
file. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project tracks [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it leaves the `2.0.x-beta` line.

For the full design rationale behind any change below, see
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

---

## Unreleased

Dot-space scope: what the plugin syncs outside your notes is now
one explicit decision instead of several implicit ones. Since then
(2026-09-23 → 2026-10-11): a sync that can be stopped at any moment
and resumes cleanly after anything — a Cancel, a kill, a dead
battery — a log viewer, a proper `.gitignore` editor, plugin updates
that cannot break Obsidian, and GitHub's real file-size limit.

### ⚠️ Read before upgrading

- **A `.gitignore` in a subfolder is no longer obeyed where it
  is.** Only three locations are read: the vault root,
  `.obsidian/`, and one level under `.obsidian/plugins/`. The
  plugin does not drop such rules silently: on its first run it
  finds every `.gitignore` elsewhere, translates the rules into
  root-anchored form (`notes/private/.gitignore` with `*` becomes
  `notes/private/`) and offers them as a change to the root
  `.gitignore`. **Syncing is refused until you accept, edit or
  discard that change**, so nothing those rules excluded can slip
  out in the meantime. The originals are renamed to `.bak`.
- **The markers around the managed blocks changed**, so a block
  written by an earlier version is no longer recognised and is left
  in place untouched. It does no harm — the new blocks are written
  alongside it and the bottom one wins — but it is litter, and the
  plugin will not remove text it no longer recognises as its own.
  **Delete the old block by hand, once**: it is the section between
  `# ===== git-easy-sync invariants — DO NOT EDIT =====` (with a
  long dash) and `# ===== end of invariants =====`. Do this in
  `<vault>/.gitignore` and in `<vault>/.obsidian/.gitignore`.
- **Expect one `.gitignore` commit after every upgrade.** The
  first line of each managed block now carries the version of the
  plugin that wrote it (`# ===== git-easy-sync invariants
  v2.0.2-beta - DO NOT EDIT =====`), so the first sync after an
  upgrade rewrites those files. That is what lets an older device
  leave alone the rules a newer one wrote — it is not a defect.
- **Root dot-files other than `.gitignore` stop syncing.** Earlier
  versions picked up every dot-file at the vault root
  (`.gitattributes`, `.editorconfig`, …) whether or not you asked
  for it. They now wait for a `!`-rule — e.g. `!/.gitattributes`.
  Nothing is deleted: the files stay on disk, the copies already
  on GitHub stay there, and the plugin simply stops touching them
  in either direction.

### Changed

- **Everything starting with a dot is invisible to sync by
  default**, and becomes visible only through the root
  `.gitignore` (a `!`-rule naming a concrete path), the
  per-device *Sync configs* setting, or by being the root
  `.gitignore` itself. Rules that name a *shape* rather than a
  path — globs, unanchored folder rules like `!.myconfig/` —
  grant nothing, on purpose: a rule that permitted a file the
  plugin could not find would make it look deleted on the next
  sync, and that delete would travel to your other devices.
- **`Push plugins data.json` is now per-device** and renamed
  *Sync plugins data.json*. It used to live in the shared
  `.gitignore`, so switching it on one machine switched it on for
  all of them; now you can share plugin settings between two
  devices out of ten. A plugin can overrule the switch from a
  `.gitignore` in its own folder, in either direction.
- **The managed `.gitignore` blocks are now two**, and the
  difference is deliberate: the block at the TOP is a default your
  own rules override, the block at the BOTTOM is not. Conflict
  siblings and the plugin's temporary files live in the bottom
  one, so they can no longer be un-ignored by accident.
- **The conflict badge counts tracked conflicts only.** It used to
  include purely local leftovers; those now surface in the
  conflicts panel, which is the only place they can be acted on.
  The badge and the pre-sync prompt now agree with each other.
- **Files over 40 MB stay out of sync.** GitHub's API refuses a
  file of 40 MiB or more — measured; its documentation says
  100 MB. Such a file is left on the device and everything else
  syncs. A manual Commit or Sync, and the startup sync, show a
  notice per file; the periodic sync skips it silently, and the
  log records it once per session.
- **An automatic sync no longer stops at an open conflict.** It
  goes ahead as "Sync anyway" would — edits of the conflicted file
  go to its conflict branch, everything else to `main`. A manual
  Sync still asks. Only a `.gitignore` conflict stops every sync.
- **The badge counts files in conflict**, not conflict copies, and
  the conflicts panel lists tracked conflicts first, in red.
- **A new device adopts the vault's settings.** A file under
  `.obsidian/` that both sides created on their own (no common
  history) now takes the repository's version, not the newer one —
  a new phone used to overwrite the repo's `core-plugins.json`
  with its defaults.
- **`core-plugins.json` is per-device**, like `workspace.json` and
  `community-plugins.json`.
- **`*.log` sits in the top managed block of the root
  `.gitignore`**, so the plugin's own log stays local in every vault,
  not only in vaults whose `.gitignore` the plugin created. A
  `!`-rule still lets it sync.
- **A plugin collision is decided by the plugin's published
  version**, not by whichever copy was edited last.
- **A deletion arriving from the server never removes our own
  plugin, our managed `.gitignore` files, or files directly in
  `.obsidian/`.** The next commit puts them back on GitHub.
- **Commits carry your name, email and the moment you
  committed.** The git author is learned from your GitHub account
  on the first sync (Settings → *Git author name / email*), and the
  commit date is the local commit time, not the push time.
- **Notices say what is happening in plain words**:
  `Pulling / Pushing N of M`, `Committing…` / `Checking N of M
  files` when a commit is forecast to be slow, and a summary such as
  `Sync done — 3 sent, 10 received` plus `2 plugins updated`. A
  quick sync shows only the summary; a commit inside a sync no
  longer adds its own line.
- **Faster syncing.** An empty sync costs one request again (it had
  grown to five). A commit hashes files in a background worker, with
  a WebAssembly SHA-1, and reads each changed file once instead of
  three times. Uploads use a native base64 encoder — 100 MB in a
  fraction of a second on a phone, where Obsidian's own encoder
  failed above 128 MB.

### Added

- **Conflicts in dot-space are visible at last.** A conflict on a
  file inside `.obsidian/` or an opted-in dot-folder used to be
  invisible in the conflicts panel even though the engine had
  registered it. The panel now lists it, and so does the pre-sync
  prompt.
- **`Ctrl`/`Cmd`+`R` in the conflicts panel** re-scans the list.
  The panel paints what it already knows immediately and fills in
  findings from dot-folders a moment later, rather than blocking
  on a directory walk.
- **A control file can be kept to one machine.** Writing
  `/.gitignore` among your own rules takes the root `.gitignore`
  out of sync while it keeps governing that device — useful when
  one machine needs its own `.editorconfig`. Documented in the
  README, including the cost.
- **Cancel stops a sync at any moment**, including mid-upload: the
  request in flight is aborted, retries stop, and `Sync canceled`
  appears. It works during the pull and during the commit part
  too (the commit finishes, nothing is sent). Settings → *GitHub
  sync status* → `Stop sync` does the same, and so does the `Cancel
  sync` command.
- **A log viewer** (Settings → Logging → *View log*): the log as a
  table with a column filter (`|` between pieces), search and copy;
  new entries appear live. Its own window on desktop, full screen on
  a phone. *Clean logs* shows the live log size.
- **A proper editor for the root `.gitignore`** (Settings →
  .gitignore → *Open*), behind a short warning shown every time. It
  saves only a real change and refuses to overwrite a version a sync
  brought in while it was open. *History* opens the file's versions.
- **Nested `.gitignore` files are collected into the root one.** On
  first run (and on *Check now*) their rules are translated to
  root-anchored form and offered as a change to review; the
  originals are renamed to `.bak`. Sync waits for the check; the
  vault does not.
- **Plugins updated by a sync reload themselves**, each with a toast
  naming the new version, and a plugin a sync removed is unloaded at
  once. An update that this Obsidian version cannot load is held
  back and never reaches the disk, so a sync can no longer leave a
  plugin broken until the next Obsidian upgrade.
- **History shows deletions as versions.** Opening one shows an
  empty side; taking it whole deletes the file (its old content
  goes to the Deleted bin). Open History tabs refresh after every
  sync.
- **New commands**: `Commit all changed files`, `Commit active
  file`, `Pull from repo and push stored commits`, `Cancel sync`.

### Fixed

- **The `Push plugins data.json` switch did nothing when on.** The
  allow-rule sat above the plugin's own catch-all and lost to it,
  so the setting had no effect in any vault whose
  `.obsidian/.gitignore` the plugin had created — i.e. the common
  case.
- **A stale allow-rule from an older install could silently turn
  the switch back on**, letting other plugins' `data.json` travel
  while the settings tab showed it off.
- **A conflict sibling from a device whose label contains a space**
  ("Home iMac") was not recognised by one of the two layers that
  keep siblings local. It was still held back by the other, but the
  gap is closed.
- **A repository with every file deleted no longer breaks syncing.**
  GitHub answers 404 for an empty tree, which the plugin read as
  "this commit does not exist" and gave up. It can also reach that
  state by itself — delete every note and sync — so the next sync
  used to fail with nothing to explain it.
- **An interrupted sync resumes cleanly, however it was
  interrupted.** A Cancel, a killed app or a dead battery in the
  middle of writing pulled files used to leave the next sync
  reporting false conflicts, or re-sending what had already
  arrived. Each finished file is now recorded on disk as it lands,
  so the next sync knows exactly where the last one stopped. A
  large file whose upload had completed is not uploaded again.
- **A file too large for GitHub no longer breaks every sync.** It
  was retried forever, and every sync after it failed.
- **Switching to another repository** could carry the old
  repository's unfinished sync into the new one. Every sync and
  every commit now checks which repository it is talking to first.
- **With *Auto-canonicalize* on**, files differing from the
  repository only in line endings or a BOM were treated as changed.
  The vault and the repository are now compared in the form you
  see.
- **`Sync canceled` did not appear** after a Cancel, from any of the
  places a sync can be stopped.
- **Worker threads piled up** — five more after every plugin reload
  (each self-update is one).
- **The conflict badge** did not update after an automatic sync.
- **The Diff-Panel ribbon icon jumped to the top** of the ribbon
  whenever the conflict count changed between restarts.
- **After a Reset the old GitHub token kept being used** until
  Obsidian restarted.
- **A repository switch could empty the vault**: the check that
  tells two repositories apart had stopped being read.
- **A file whose name contains a character some systems forbid**
  (`:`, `?`, `*`, `|`, …) and whose safe local name was already
  taken was skipped on every sync; it now lands under the next free
  `name (N)`. *Commit active file* makes such a name safe too.
- **A conflict copy could be merged against the wrong ancestor**
  when the server moved on while it was open.
- **A file a sync could not write** was recorded as if it had
  arrived, so the next commit could send the old version back over
  the newer one. It is now asked about again on the next sync.
- **The sync could stop with an internal error** on a file that
  *Auto-canonicalize* had rewritten in place.
- **Notices**: a progress box you tapped away comes back with the
  next update; the "sync in progress" window closes itself when the
  sync ends; a standalone Commit no longer makes the next Sync flash
  `Syncing with GitHub`; a nearly empty vault no longer blinks
  `Checking all files…`; the summary's "sent" counts what really
  changed on the server.
- **Errors**: every error you are shown is also written to the log,
  and a failed HTTP request is logged at the level its status
  deserves.
- **Clicking a file in the file tree while a Diff-Panel tab was
  active** opened the right sidebar or did nothing; it now focuses
  the tab that already shows the file.

---

## 2.0.2-beta — 2026-05-30

Major architectural rework, no breaking changes for the default
configuration. The engine now runs CPU- and network-heavy work in
a small Web Worker orchestra so the UI stays responsive even
during multi-megabyte syncs on Obsidian Mobile. New optional
split between **Commit** (stage changes locally) and **Sync**
(upload to GitHub) for users who want to batch commits offline
and push only on WiFi. A new **Settings → GitHub sync status**
section gives a live view of the current upload + the cancel
button. Expired GitHub tokens now surface as a step-by-step modal
instead of silent 5-minute retry loops.

If you're a single-device user with `Sync starts with commit:
true` (the default) and `Show commit ribbon button: false` (also
the default), nothing about your day-to-day workflow changes —
the **Sync with GitHub** button still commits + pushes in one
click. Everything below is additive.

### Added

- **Worker orchestra (Stages 3-6).** A small pool of Web Workers
  now handles 3-way text merge, SHA computation, base64 decode,
  and every GitHub API call. The main thread stays free for the
  editor; "click Sync, keep editing" works as a hard guarantee
  even at multi-megabyte file sizes. Threshold-gated so small
  operations stay inline (no postMessage overhead). The CORS
  feasibility was validated on Capacitor Android (Pixel 6 Pro) —
  worker `fetch` against `api.github.com` round-trips in
  ~800 ms.
- **SHA-first reconcile (Stage 5).** Reconcile now fetches GitHub
  metadata (sha + size) before pulling blob content. ~75 % of
  paths resolve from SHAs alone (no remote change / ours wins /
  already in sync) — no blob fetch, no base64 decode, no merge.
  Saves multi-MB of redundant downloads on every multi-device
  sync.
- **Split Commit / Sync (Settings → "Sync starts with commit",
  default ON).** Turning the master toggle OFF means the
  **Sync** button only uploads what's already staged; committing
  becomes a separate **[Commit]** ribbon button (also a
  command-palette entry and a hotkey-bindable action). Useful
  for staging commits offline and pushing only on WiFi.
- **Show commit ribbon button toggle (Settings, default OFF).**
  Independent of the master toggle. Lets the user surface a
  **[Commit]** ribbon icon even when Sync still commits + uploads
  in one click.
- **"Upload pending commits to GitHub (no new commit)" command.**
  Pure-drain hotkey for users who hide all ribbon icons.
  Independent of the master toggle.
- **Settings → GitHub sync status section.** Top of the page,
  always visible. Shows: live timer while a sync is running, the
  file being processed (N of M counter), last error (with
  elapsed time prefix), and a `[Stop sync]` button to cancel an
  in-flight upload.
- **`Sync2Manager.cancelDrain()` API.** Cancellation propagates
  via an abort flag the reconcile loop checks between files.
- **Maximum auto-merge file size (Settings → Performance, default
  1024 KB).** Exposes the previously-hardcoded
  `RECONCILE_AUTO_MERGE_LIMIT`; tune up if your corpus needs
  auto-merge on bigger files (validate on the slowest device
  first — see `tests/perf/README.md`).
- **Expired-token modal.** When GitHub returns 401 ("Bad
  credentials") the plugin now opens a guided recovery modal:
  intro + the three steps + buttons to open the GitHub token
  page, the README walkthrough, and the plugin's own settings
  tab. Throttled to once per hour. Catches the common
  "fine-grained PAT hit its 366-day cap and the daily 5-minute
  interval drain silently fails" scenario.
- **Modify-in-place crash safety (Stage 7).** When the engine
  writes to a file that's currently open in an editor, it now
  uses `vault.modifyBinary` to preserve the editor's cursor and
  scroll position — instead of the rename-aside strategy that
  closes the view. Backed by a marker-file protocol that
  forward-completes any interrupted modify on next plugin
  onload.
- **CPU micro-benchmarks under `tests/perf/perf-cpu-*`.** Diff3
  timing matrix, base64 decode, git-blob SHA, WorkerClient
  dispatch overhead. Baselines documented in
  `tests/perf/README.md`.

### Changed

- **`Sync2Manager.timed()` HTTP wrapper routes through the
  network worker** when `WorkerClient` is provided. Existing
  `requestUrl` path stays as fallback for the Settings-tab
  connection probe and unit tests.
- **Reconcile loop reads ours bytes FIRST**, then fetches base +
  theirs metadata. Together with the SHA-first decision tree
  this means the cheap local read happens before any network
  round-trip, and the expensive byte-fetches only happen for
  paths that truly need them.
- **`setTimeout(0)` yields between reconcile path iterations.**
  Prevents the macrotask queue from starving during long drains.
- **`PushQueue.readFile` uses `fetch(getResourcePath(...))`.**
  Documented part of Obsidian's `DataAdapter` API; on mobile
  this resolves to a `http://localhost/_capacitor_file_/...`
  URL that bypasses the JS↔native bridge. Faster and noticeably
  more reliable than `adapter.readBinary` for multi-MB files.

### Renamed

The following data.json keys were renamed. Existing values are
still loaded transparently and a one-time log line + 30-second
Notice on first run instructs you to copy the new shape
manually. The OLD keys keep working (loaded but no longer read).

- `autoCommitOnSync` → `syncStartsWithCommit` (also unifies
  manual / interval / startup behaviour under one toggle —
  default `true` to preserve today's manual-click semantics)
- `accumulateOfflineSyncs` → `consolidateCommits`
- "Push plugins data.json to GitHub" (UI label) → "Sync plugins
  data.json"

### Removed

- The 9 mobile-diagnostic buttons under Settings → "Mobile
  diagnostics" (added during the May 2026 field investigation).
  The empirically-validated learnings landed as proper engine
  changes; the diagnostic surface is now redundant.

### Fixed

- **Open file no longer closes when a remote change lands.**
  Was caused by the atomic-rename strategy (renames the live
  file aside, then renames new bytes over the slot — Obsidian
  sees the file disappear and unloads the editor). Replaced with
  `vault.modifyBinary` for existing TFiles; the rename strategy
  still runs for brand-new files where there's no open editor
  to preserve.

### Internal

- 49 commits on `sync2-worker-reorg`, 51 if you count the merge
  commit. Branch cut from `main` at `fead510` (2.0.1-beta5).
- 679 unit tests + 114 integration tests + 24 perf baselines.
  All green at merge.

---

## 2.0.1-beta5 — 2026-05-29

Hotfix release. Fixes a critical sync bug that could overwrite
remote files larger than 1 MB with truncated local copies.

### Fixed

- **Files larger than 1 MB now sync correctly.** GitHub's Contents
  API truncates inline content for files above ~1 MB; previous
  releases decoded the truncated response as 0 bytes, then ran the
  3-way reconcile against `remote = ∅` and (incorrectly) chose the
  local side. The fix transparently fetches the actual bytes via
  the Blobs API when the Contents API reports a large file. Affects
  every user with any single file above 1 MB; see
  [§16.6 of the design doc](./docs/PSEUDO-MERGE-MODE.md) for the
  full postmortem.

### Unchanged

- **No behaviour change for files at or below 1 MB.** The fast
  path is unchanged; the Blobs-API roundtrip only runs when the
  Contents response shows `size > 0` with empty inline content.

### Recovery if you were affected

If you suspect a recent sync replaced one of your notes on GitHub
with much smaller content, the previous versions of every file
remain in your repo's history — restore via `git revert <commit>`
from a clone, or copy from a previous commit on GitHub Web.

---

## 2.0.1-beta4 — 2026-05-25

Sync engine rebuilt from the ground up — both the
conflict-resolution layer and the push pipeline. Full mechanics in
[§Conflict resolution](./README.md#conflict-resolution); full
design rationale in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

### Added

- **Resolve conflicts with plain file operations.** No modal
  dialogs, no `<<<<<<<` markers in your notes. Each conflict
  becomes an ordinary sibling file you handle with delete / rename
  / edit. *(A dedicated diff-edit GUI is planned for the next
  release; this release uses only the native Obsidian operations
  you already know.)*
- **Keep typing on a conflicted file.** Your in-progress edits
  flow to a private GitHub branch invisible to other devices until
  you finalise; the conflict doesn't block you.
- **Full edit history preserved on GitHub — forever.** Every commit
  the plugin produces — including every iteration during a
  conflict-resolution session — stays reachable in the Network
  graph. Nothing is silently squashed or discarded.
- **Three visibility surfaces for pending conflicts.** Status bar
  `🔀 N`, ribbon badge, pre-sync confirmation modal listing every
  pending file.
- **Push-queue depth visible on the ribbon.** The `[Sync with
  GitHub]` icon shows `(N)` when batches are waiting to drain —
  click feedback you can see, offline accumulations you can count,
  reconnection progress that decrements in front of you.

### Changed

- **Auto-merge first.** Text three-way merge, plugin-bundle
  semver, modify-vs-delete favours the modification. Only
  genuinely irreconcilable cases surface as siblings.
- **Crash-tolerant atomic writes.** Multi-step disk operations
  have a documented recovery sweep on plugin load; an interruption
  leaves the vault in either the pre- or post-state, never
  half-applied.
- **Multi-file conflict sessions resolve one file at a time.** Each
  per-file resolution lands on `main` as a regular commit; the
  conflict branch merges back only when the last file is settled.
- **`Reset` cleanly relabels siblings.** A wiped plugin state
  renames `*.conflict-from-*` files to
  `<file>.unresolved-<original-ts>.<ext>` so a future re-enable
  starts clean.
- **Cross-platform filename safety.** Files named with
  Windows-forbidden characters (`< > : " | ? * \`) or
  Obsidian-wiki-forbidden characters (`# ^ [ ]`) are automatically
  rewritten to canonical Unicode replacements on both push and
  pull. A vault authored on one platform stays usable from any
  other; see
  [§11 of the design doc](./docs/PSEUDO-MERGE-MODE.md).
- **Pre-flight validation on every push.** Stale deletion entries
  (a path another device already removed) are detected before the
  tree-create request is sent and dropped silently — no more 422
  `GitRPC::BadObjectState` failures from multi-device race
  conditions; see
  [§12.1 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta3 — earlier 2026-05

Pre-flight validation hotfix (PUSH-REORGANIZATION Phase 1).
Detects stale deletion entries that another device already removed
on GitHub before issuing the `createTree` request, preventing
intermittent 422 `GitRPC::BadObjectState` failures. Now superseded
by the broader push-pipeline rework in `beta4`; see
[§12.1 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta2 — earlier 2026-05

Cross-platform filename sync hotfix. Files named with
Windows-forbidden characters created on macOS / Linux desktop now
arrive correctly on Obsidian Android (which previously refused them
with `FILE_NOTCREATED`). Sanitization runs on both push and pull
sides so a vault converges on the canonical Unicode form after one
round-trip. Now part of the broader cross-platform contract in
`beta4`; see
[§11 of the design doc](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.1-beta — 2026-05-23

Initial release of **pseudo-merge mode** — the
sibling-file-based conflict-resolution model that this plugin is
built around. Full rationale in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

---

## 2.0.0-beta — 2026-05-15

**Rename and refocus.** The plugin was renamed from
`github-gitless-sync` to **`github-easy-sync`** to reflect a deep
architectural rework: the original synchronous, single-pass
REST-API sync was replaced by an asynchronous, queue-based,
mobile-first, crash-tolerant engine, with conflict resolution
promoted to a first-class concern. The fork started from
`github-gitless-sync@1.0.7` (see entry below); 96 commits later
this version landed.

### Engine — `sync2` rewrite

- **State machine for first sync**, with a user-facing modal only
  when the divergence is truly ambiguous. No more silent
  overwrites at adoption time; the engine mtime-checks every
  divergence and keeps local when local is newer.
- **Manifest as a first-class invariant.** A separate JSON file
  tracks the last-synced commit + per-path SHA snapshot;
  ChangeDetector walks the vault on each sync click instead of
  subscribing to live events, so edits made while the plugin was
  disabled are picked up on the next click — no "missed events"
  failure mode.
- **Atomic bare-repo bootstrap.** A brand-new GitHub repo (no
  commits yet) is seeded via the Contents API; subsequent writes
  retry on the documented 409 race.
- **Crash-resume across four layers** — adoption pull,
  incremental pull, push blob upload, and the find-changes →
  queue bridge. A sync interrupted mid-flight (Obsidian closed,
  phone backgrounded, network drop) finishes on the next trigger
  without duplicating commits.
- **Single network entry point.** `drain` (formerly
  `processQueue`) handles every pull + push combination; the
  legacy `SyncManager` is gone.
- **Reconcile handles all conflict types.** Delete-vs-modify
  promotes to a real conflict; auto-resolution short-circuits
  when both sides match; mtime-based "atomic conflicts" resolve
  without prompting.

### Conflict resolution — first complete UI

- **`DiffPane` widget** with per-chunk `[Theirs] / [Both] /
  [Ours]` action bar (CM6 widget decorations), keyboard
  navigation, and a status footer.
- **Vim-mappable chunk operations** exposed as Obsidian commands
  so power users can resolve from the keyboard alone.
- **"Resolve now" auto-opens the diff editor** for the affected
  file rather than dumping the user at a generic conflicts list.
- **Conflict sibling labelling.** Siblings carry the **GitHub
  author** of the incoming version, not the local device name —
  multi-device users can tell at a glance whose change is
  pending.
- **`ConflictStore` orphan cleanup on load.** A previous session
  that crashed mid-resolve leaves no dangling sibling rows.

### Filtering, settings, and per-device hygiene

- **Sync filtering moved to user-managed `.gitignore` files.** A
  unified `isSyncable` rule set drives every push and pull
  decision; users edit one well-known file instead of toggling
  thirty plugin settings.
- **`community-plugins.json` stops syncing by default** — it's
  per-device state, not vault content.
- **"Push plugins data.json to GitHub" toggle.** Off by default
  (most `data.json` files store API tokens); flip-on opt-in
  routes them through the same `.gitignore` machinery.
- **`syncConfigDir` default → false.** A first-time install no
  longer pushes the entire `.obsidian/` tree; opt in per device.
- **Auto-detect repo / owner / branch change** in settings, with
  a `[Reset]` button that wipes the local manifest cleanly when
  the user re-points the plugin at a new GitHub repo.
- **Settings UX polish.** Live preview under both commit-message
  templates; the `{date}` placeholder split into separate
  `{date}` and `{time}`; clearer labelling on Auto-commit and
  Sync-interval; default interval bumped 1 → 5 minutes.

### Notices and progress

- **Live N/M file counter** during push AND pull (text + binary
  both count toward the same denominator).
- **Click-time notice** confirms the sync started; **"Sync done"
  finale** summarises file counts updated from GitHub. Single-
  notice UX replaces the previous stacked-toast spam.
- **Bytes-based progress threshold + lazy notice.** Quick syncs
  stay silent; only the runs that take real time get a progress
  notice.

### Test infrastructure

- **Integration suite (~20 min, real GitHub)** with structured
  bucket series A through K plus the bootstrap suite. Buckets
  cover: bootstrap (A), adoption (B), resume after crash (C),
  incremental + delete races (D), edge cases (E), special chars
  + content (F), multi-device convergence (G), out-of-band drift
  (H), settings lifecycle (I), API failures (J), manifest
  corruption / recovery (K).
- **P-series performance baselines** (opt-in via
  `npm run test:perf`) for upload throughput.
- **Test-only `RequestFaultInjector`** lets J / K tests feed
  deterministic 429 / 5xx / network-drop responses into the retry
  loop without burning real PAT quota.

### Mobile robustness

- **Android first-sync crash fixed** — large initial syncs now
  use per-file Contents API calls instead of a single tree-blob
  download that OOM'd Capacitor.
- **Adoption-time path trimming and canonicalisation** so a vault
  bootstrapped on desktop arrives on Android without
  `FILE_NOTCREATED` errors.

### Developer tooling

- **`OBSIDIAN_PLUGIN_DIR` env var** (with `~` expansion fixed for
  IDE-set values) mirrors `main.js` / `manifest.json` /
  `styles.css` straight into a vault on every `pnpm dev` build —
  no more manual `cp` between rebuilds.

For the canonical engine spec, see
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md);
the design rationale article was written immediately after this
release to capture the model in one place.

---

## github-gitless-sync 1.0.7 — 2025-05-22 (fork point)

The version of the upstream
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)
plugin from which this fork was taken. Authored by
[Silvano Cerza](https://silvanocerza.com); the fork inherits
that work, the AGPL-3.0 licence, and the original
"vault-to-GitHub via REST API only" idea.

### Carried forward into the fork

- **GitHub REST API only.** No `git` binary, no `isomorphic-git`
  — the architectural decision that lets the same code run on
  desktop and on Obsidian Mobile.
- **Commit-message templating** with placeholders.
- **`Sync now` command + ribbon + status bar** entry points.
- **Settings tab** with token / owner / repo / branch
  configuration and a connection-test probe.

### Notable fixes shipped in upstream's 1.0.7 itself

- **Sync correctly handles deleted, moved, and renamed files.**
  Previously a delete or rename on either side could leave the
  vault and remote tree mismatched.

For the upstream changelog and earlier versions of the
gitless-sync line, see
[silvanocerza/github-gitless-sync](https://github.com/silvanocerza/github-gitless-sync).
