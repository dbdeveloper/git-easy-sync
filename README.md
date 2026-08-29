# Git Easy Sync

> Sync your Obsidian vault with a GitHub repository — no `git` binary,
> no `isomorphic-git`, identical behaviour on desktop and mobile.

Version `2.0.2-beta` · AGPL-3.0 · Fork of
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)

---

## What's new

Per-release notes live in [`CHANGELOG.md`](./CHANGELOG.md).
Latest: **2.0.2-beta** — Worker orchestra, SHA-first reconcile,
split `[Commit]` / `[Sync]` UX, cancellable in-flight uploads,
expired-token modal. See
[CHANGELOG.md](./CHANGELOG.md#202-beta--2026-05-30) for the
full list.

The full design rationale behind any release is in
[`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md).

---

## Why another GitHub sync plugin?

Most existing Obsidian-to-Git plugins either rely on the `git` CLI
being installed (which excludes mobile entirely) or bundle a heavy
JavaScript git reimplementation (`isomorphic-git`) that struggles on
mobile WebViews when vaults grow past a few hundred files.

**Git Easy Sync goes a third way**: it talks to GitHub through the
**REST API only**. No git binary on disk, no JS git engine in the
bundle. The exact same sync logic runs on macOS, Windows, Linux,
iOS, and Android — and survives vaults with thousands of files on
mid-range Android devices without OOM crashes.

### How it stacks up

| Plugin | Engine | Mobile-friendly | Best for |
|---|---|---|---|
| **Git Easy Sync** (this) | GitHub REST API only | ✅ Large vaults work | Two-way sync without git skills; phones that just need to work; conflicts resolved through plain file operations (no merge markers, no modal dialogs, full edit history preserved). |
| [`obsidian-git`](https://github.com/Vinzent03/obsidian-git) | `isomorphic-git` (or native `git`) | ⚠️ Flaky on large vaults | Full git semantics — branches, rebase, custom hosts; comfortable users who want native git conflict markers and command-line-level control. |
| [`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync) | GitHub REST API only | ✅ | The original; this plugin is a heavily-refactored fork of it. |
| [`Obsidian-GitHub-Sync`](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) | Bash scripts + `git` | ❌ Desktop only | Simple desktop-only workflows. |
| [`obsidian-github-sync-multi-platform`](https://github.com/thiter/obsidian-github-sync-multi-platform) | Mixed | Partial | Cross-platform attempts with mixed results. |

> **The differentiator** is the conflict-resolution model. Other
> plugins inherit git's native handling: conflict markers
> (`<<<<<<<` / `=======` / `>>>>>>>`) inserted into the file body,
> resolved in an editor or terminal. That works on a laptop with a
> developer at the keyboard; it degrades on mobile, on long-form
> notes whose preview pane would render the markers as literal
> text, and on binary files where it doesn't apply at all.
> Git Easy Sync 2.0.1-beta takes a different route — each
> conflict becomes an ordinary sibling file in the vault, resolved
> by the file operations every Obsidian user already knows. See
> [CHANGELOG](./CHANGELOG.md) above and
> [the design rationale](./docs/PSEUDO-MERGE-MODE.md) for details.

### What this plugin does well

- **Mobile that actually works.** The bundle has zero Node imports at
  the module-load level — Obsidian Mobile's Capacitor WebView loads
  it cleanly on Android and iOS. Verified on Android with 250+ file
  vaults.
- **No catastrophic-history risk on first setup.** "Adoption" (the
  very first sync on a non-empty vault against a non-empty remote)
  never silently overwrites local files: it mtime-checks every
  divergence and keeps local when local is newer.
- **Polling, not events — for the sync engine itself.** The plugin
  walks the vault on each sync click instead of subscribing to live
  events for sync purposes, so edits made while the plugin was
  disabled are picked up on the next click — no "missed events"
  failure mode. Vault event listeners *are* attached, but strictly
  read-only: they only refresh the pending-conflict counter (status
  bar 🔀 + ribbon badge) in real time so you see resolution
  progress immediately as you delete or rename sibling files. They
  never push, never pull, never mutate sync state.
- **Click feels instant.** The click path writes the commit batch to
  disk and returns immediately; the network work happens in the
  background. Idle syncs stay silent; only heavy ones show a progress
  notice.
- **Resume on crash.** Four layers of resume cover adoption pull,
  incremental pull, push blob upload, and the find-changes → queue
  bridge. A push interrupted mid-flight (Obsidian closed, phone
  backgrounded, network drop) finishes on the next trigger without
  duplicating commits. The conflict-resolution layer adds a
  matching guarantee for its own multi-step writes — see
  [CHANGELOG](./CHANGELOG.md).
- **Privacy-conservative defaults.** Plugin `data.json` files
  (which routinely store API tokens) and per-device configs
  (`workspace.json`, `community-plugins.json`) are blocked from
  sync by default; flipping a toggle in settings opt-ins.
- **Test-connection probe** under the credentials section: one
  click verifies token + owner/repo + branch and explains exactly
  what's wrong if anything fails.

### What this plugin deliberately doesn't do

- No rebase, no manual stash, no force-push UI, no general-purpose
  branching for user workflows. The plugin creates one private
  per-device conflict branch when conflicts arise, and merges it
  back automatically when resolution completes — that's the only
  branch the user ever sees. `main` stays the only "shared" branch.
- No non-GitHub hosts (no GitLab, Gitea, Bitbucket, etc.). The REST
  API endpoints are GitHub-specific.
- No silent overwrites on a true conflict. Auto-merge happens when
  it's safe (text three-way against the last-synced base;
  plugin-bundle semver), but binary files and overlapping text
  edits always surface as a sibling file so you see both versions
  before deciding.

---

## Installation

### Setting up GitHub

> If you already have a GitHub account, a repo, and a fine-grained
> Personal Access Token (PAT) with `Contents: Read and write` on
> that repo, skip to **Installing the plugin** below.

#### 1. Create a GitHub account

Go to [github.com](https://github.com) and sign up. Free accounts are
sufficient — private repos are now unlimited on the free tier.

#### 2. Create the sync repository

[github.com/new](https://github.com/new) → give it a name (e.g.
`my-obsidian-vault`) → choose **Private** unless you specifically
want your notes public → leave "Initialize with README" unchecked
(an empty repo is fine; the plugin will seed it on first sync).

<!-- SCREENSHOT: empty repo creation form -->

<a id="github-token-setup"></a>

#### 3. Generate a fine-grained Personal Access Token

[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)

- **Token name**: e.g. `obsidian-easy-sync`
- **Expiration**: 90 days is a reasonable default (you'll rotate
  before it expires)
- **Repository access**: **Only select repositories** → pick the one
  you created above. Don't use "All repositories" — keep the blast
  radius small.
- **Permissions** → **Repository permissions**:
  - **Contents**: Read and write
  - **Metadata**: Read-only (auto-selected when Contents is on)

Click **Generate token** and **copy the token immediately** — GitHub
shows it once.

<!-- SCREENSHOT: fine-grained PAT permissions screen -->

> Classic PATs with `repo` scope also work, but fine-grained tokens
> are strongly preferred — they're scoped to one repo and limit
> the damage if leaked.

### Installing the plugin

The plugin isn't in the Obsidian Community Plugins store yet (it's
in beta). Install via **BRAT** (Beta Reviewers Auto-update Tool).

#### 1. Install BRAT

In Obsidian → **Settings → Community plugins → Browse** → search for
**BRAT** by TfTHacker → Install → Enable.

#### 2. Add this plugin via BRAT

BRAT settings → **Add Beta Plugin** → paste this repo's URL:

```
https://github.com/dbdeveloper/git-easy-sync
```

BRAT pulls the latest release; the plugin appears under
**Settings → Community plugins → Installed plugins**. Toggle it on.

<!-- SCREENSHOT: BRAT Add Beta Plugin dialog -->

#### 3. Fill in credentials

Open the plugin settings (**Settings → Git Easy Sync**) and fill:

- **GitHub token**: the PAT you generated above
- **Owner**: your GitHub username (case-sensitive)
- **Repository**: the repo name you created
- **Repository branch**: usually `main` (check the default on the
  GitHub repo page if you're not sure)

<!-- SCREENSHOT: credentials filled in -->

> Android keyboards often append a trailing space when pasting from
> the suggestion bar. The plugin auto-trims values on save and on
> load, so paste-then-leave-field is safe.

#### 4. Test the connection

Click **Test** under the credentials. The button runs a one-shot
read-only probe against GitHub and reports back:

- **✓ All good** → ready to sync
- **✗ 401 Unauthorized** → token invalid or expired
- **✗ 403 Forbidden** → token missing required permissions
- **✗ 404 Not Found** → owner/repo typo, or fine-grained PAT
  doesn't include this repo

<!-- SCREENSHOT: test-connection result blocks (success + failure example) -->

#### 5. First sync

Click **Sync with GitHub** in the side ribbon (or run the
`Sync with GitHub` command via the command palette).

What happens on the first click depends on what's on each side:

| Local vault | Remote repo | First-click behaviour |
|---|---|---|
| Empty | Empty | Plugin seeds `.gitignore` + your invariant block on the remote |
| Has files | Empty | Plugin pushes everything on the next click |
| Empty | Has files | Plugin pulls everything into your local vault |
| Has files | Has files | **Adoption**: identical files are recorded silently; divergent files are kept according to mtime (the newer side wins); local-only files are pushed |

> **Adoption is non-destructive.** Local files with a newer mtime
> than the remote's last commit are kept verbatim, then pushed on
> the next sync. No silent overwrites.

---

## Migrating from another GitHub sync plugin

If you're switching from a different Obsidian-to-GitHub sync plugin
(`obsidian-git`, `github-gitless-sync`, `Obsidian-GitHub-Sync`, etc.),
follow this sequence. It's the least invasive, most accurate way to
switch and won't lose edits — the previous plugin does the
convergence, and Git Easy Sync just observes the converged state.

### 1. Sync your local vault and remote repo through the previous plugin

Run a full sync with the old plugin until **both sides are identical**:
no pending local edits, no remote commits the vault hasn't pulled,
no unresolved conflicts. This is the single most important step —
Git Easy Sync adopts what it sees, it does not reconstruct any
history the old plugin produced.

### 2. Disable the previous plugin

**Settings → Community plugins → Installed plugins** → toggle the old
plugin OFF. Leaving two sync plugins enabled at once produces
duplicate commits and races over `<configDir>/` files.

### 3. Install and enable Git Easy Sync

Follow [Installing the plugin](#installing-the-plugin) for the BRAT
install + enable steps.

### 4. Fill in credentials

Use **the same repository and branch** the previous plugin was
syncing to. See [Fill in credentials](#3-fill-in-credentials) for
each field (GitHub token, owner, repository, branch), and run the
**Test** button before continuing.

### 5. Click `Sync with GitHub`

In the side ribbon, or via the `Sync with GitHub` command in the
command palette. Because step 1 made both sides identical,
[adoption](#5-first-sync) matches every local file to its remote
counterpart by SHA and records them silently — no transfers, no
overwrites, no surprise convergence commit.

> **Why this path is the safest.** Git Easy Sync's adoption is
> non-destructive per-file: local files are never overwritten without
> an mtime check that says the remote is newer. So even if step 1
> was imperfect, the worst case is "the newer side wins file-by-file"
> — your edits aren't silently destroyed. Getting step 1 right just
> means the first sync is a silent no-op instead of a convergence
> commit, which is the cleanest possible handoff between plugins.
>
> If a genuine divergence remains after step 1 — say, both sides
> edited the same line of the same file — you'll see a `<note>.conflict-from-…md`
> sibling appear next to the affected file. That's pseudo-merge
> mode doing its job; see [§Conflict resolution](#conflict-resolution)
> for what to do with it.

### 6. Delete the old `.git` directory (optional, recommended on mobile)

Git Easy Sync syncs through GitHub's REST API and does **not**
need a local `.git/` folder — all version history lives on GitHub.
If your previous plugin used real `git` or `isomorphic-git`
(`obsidian-git`, `Obsidian-GitHub-Sync`), it left a hidden `.git/`
folder at your vault root. On older vaults this routinely grows to
tens or hundreds of megabytes — material weight on phones, where
storage is far more precious than on a laptop.

Once steps 1–5 are done and you've confirmed a sync works, you can
safely delete `<vault>/.git/` to reclaim that space:

- **Desktop**: enable "show hidden files" in your file manager and
  trash `.git/`, or run `rm -rf <vault>/.git` in a terminal.
- **Android**: use a file manager that shows hidden folders (e.g.
  Material Files, Solid Explorer) and delete `.git/` from the vault.
- **iOS**: the stock Files app hides dotfiles — easiest is to delete
  `.git/` from a desktop where the vault is mirrored (iCloud,
  Syncthing, etc.).

> The actual commit history is preserved on GitHub — only the local
> object store is removed. Git Easy Sync's own state lives under
> `<configDir>/plugins/git-easy-sync/` and is not affected.
> If you migrated from `github-gitless-sync` (REST-API-only, like
> this plugin), there's no `.git/` to clean up — skip this step.

### Alternative for mobile: bootstrap from GitHub repository

If you're setting up the mobile side of the migration from scratch,
you can skip the `.git/` cleanup entirely by **starting the mobile
vault empty** and letting Git Easy Sync pull everything from the
remote:

1. On your desktop, finish steps 1–5 above so the GitHub repo holds
   the authoritative latest state of the vault.
2. On mobile, create a **new empty Obsidian vault**.
3. Install only Git Easy Sync via BRAT (see
   [Installing the plugin](#installing-the-plugin)) — you don’t need 
   an y previous plugins for syncing with GitHub.
4. [Fill in credentials](#3-fill-in-credentials) pointing at the same
   repository and branch as desktop.
5. Click `Sync with GitHub`. The plugin sees `Empty local + Has-files
   remote` and pulls the entire vault from GitHub
   (see [First sync](#5-first-sync)).

Because nothing was ever copied from the desktop vault, no `.git/`
directory appears on the phone — only the files you actually need.
This is especially attractive on Android and iOS, where finding and
deleting a hidden folder is far more cumbersome than on desktop.

> This approach assumes step 1 captured everything from your old
> mobile setup too (if the old plugin was also installed on the
> phone). Any local-only edits on mobile that never reached GitHub
> won't survive — they'd be on the old phone vault, which you're
> replacing.

### Bonus: cloning plugins (and their settings) to the new device

After bootstrapping a fresh mobile vault from GitHub, you don't have
to re-install every community plugin by hand — sync can do most of
it for you.

**With `Sync configs` ON on both devices** (Settings → GitHub Easy
Sync → `Sync configs`): the entire `<vault>/.obsidian/` directory is
part of the sync, including each plugin's bundled code (`main.js`,
`manifest.json`, `styles.css`). After the first pull, every plugin
folder from desktop is already on the phone. To activate the ones
you want on mobile:

1. Obsidian → **Settings → Community plugins → Installed plugins**.
2. Hit the reload/refresh icon at the top of the installed list
   (or restart Obsidian) — the plugins folder is rescanned.
3. Toggle on the plugins you want to use on this device.

**Plugin updates propagate the same way.** With `Sync configs` ON,
you only need to update community plugins on **one** device
(typically desktop, via BRAT or the Community Plugins store). The
fresh `main.js` / `manifest.json` ride the next sync to the phone.
To actually load the new version on the receiving device after the
pull: hit the reload icon in **Installed plugins**, or close and
reopen Obsidian — until then, the previous version stays loaded in
memory.

**With `Push plugins data.json` ALSO ON on both devices**: plugin
settings travel with the plugin code, so each plugin lands on mobile
already configured identically to desktop — no per-plugin
reconfiguration needed.

> **When NOT to enable `Push plugins data.json`.**
> - A plugin stores **secrets** in its `data.json` — API tokens,
>   account credentials, license keys. Pushing those into a GitHub
>   repo (even a private one) is a risk you usually don't want.
> - You want **different settings per device** (different hotkeys,
>   plugin tuning, sync targets, etc.). With this toggle on,
>   whichever device pushed last wins, so per-device preferences
>   ping-pong on every sync.
>
> If either applies, leave `Push plugins data.json` **OFF** and
> reconfigure those mobile plugins by hand — a one-time cost that
> avoids leaking secrets or overwriting preferences.

> **What happens if both devices changed the same plugin's
> `data.json` between syncs.** It conflicts like any other file.
> The plugin writes a sibling next to `data.json` and the affected
> plugin keeps loading whichever version is at the canonical path;
> you resolve via [§Conflict resolution](#conflict-resolution).
> No special handling is needed for config files — they're under
> the same pseudo-merge model as your notes.

Combined with the empty-vault bootstrap above, this is the fastest
way to spin up a new device during a migration: empty vault →
credentials → one Sync click → reload → done.

---

## Settings reference

Settings tab layout matches what you'll see in Obsidian under
**Settings → Git Easy Sync**.

### Remote Repository

- **GitHub token** — fine-grained PAT or classic token with
  read+write Contents access on the repository.
- **Owner / Repository / Repository branch** — case-sensitive
  identifiers.
- **Test connection** — one-shot read-only probe that verifies all
  four fields above at once and reports back exactly what's wrong
  if anything fails (see [Test the connection](#4-test-the-connection)).

### Sync

- **Device label** — text appended to every commit message produced
  by the plugin, in the lowercase trailing-parenthesis form
  (`sync (MyMacBook)`, `resolve conflict (MyMacBook)`, etc.). Helps
  tell which device produced which commit when you have several
  devices syncing to the same repo. Also used in
  conflict-resolution sibling filenames
  (`<note>.conflict-from-MyMacBook-<timestamp>.md`). Default
  `Obsidian`.
- **Sync strategy** — `Manually` (default) or `On interval`.
  *Manually* means the plugin only acts when you click; *on
  interval* runs a sync automatically every N minutes.
- **Sync interval** — minutes between automatic syncs when strategy
  is `On interval`. Default 5 min.
- **Sync on startup** — when on, runs one sync as soon as Obsidian
  finishes loading. Off by default; the plugin is otherwise silent
  on enable.
- **Auto-commit on interval sync** — governs both interval ticks
  and the startup pulse. When **ON**, every tick does a full commit
  pass (same as a manual click) — your local edits go up
  automatically. When **OFF** (default), ticks only pull and retry
  pending pushes; your local edits stay uncommitted until you click
  Sync yourself.
- **Auto-canonicalize text files** — when on, text files (`.md`,
  `.txt`, …) get rewritten locally to LF / no-BOM / trailing-NL on
  pull and on enqueue. Off by default. Turn on if you want
  canonical text on disk and don't mind a one-commit convergence
  push on first setup against a CRLF-history repo.
- **Accumulate offline syncs into one commit** — when on, Sync
  clicks that arrive while a previous push is still in flight are
  folded into a single larger commit. Off by default (each click
  is its own commit, which preserves more granular history).
- **Sync configs (Obsidian + plugins)** — when on, files under
  `<vault>/.obsidian/` are also synced (theme settings, community
  plugin install state, plugin bundles, etc.). Off by default;
  multi-device users typically don't want one machine's layout
  overwriting another's. See
  [Bonus: cloning plugins](#bonus-cloning-plugins-and-their-settings-to-the-new-device).
- **Push plugins data.json to GitHub** — when on, the `data.json`
  files of *other* community plugins are also synced. Off by
  default — these files frequently store API tokens, account
  credentials, and license keys. Our own `data.json` is **always**
  blocked regardless of this toggle. This setting is stored in
  `<configDir>/.gitignore` rather than per-device data.json, so
  toggling it on one device propagates to every other device on
  the next sync (no per-device drift).

### Interface

- **Show status bar item** — shows a `GitHub` indicator in
  Obsidian's status bar (plus the `🔀 N` conflict counter when
  there are pending conflicts). On by default.
- **Show sync ribbon button** — shows a refresh-cw button in the
  side ribbon that triggers a full sync on click. On by default.

### Logging

- **Enable logging** — appends every operation to
  `<vault>/git-easy-sync.log`. Off by default. The log lives at
  the vault root so you can open it directly in Obsidian. `*.log`
  is gitignored at the vault root by default — remove that rule if
  you want the log to sync to GitHub (useful for analysing mobile
  logs from desktop, but multi-device writes will collide on the
  same filename).
- **Clean logs** — truncates the log file to 0 bytes (visible only
  while logging is on).

### Danger zone

- **Reset plugin** — wipes credentials, snapshot, push queue,
  conflict store. Type `RESET` to confirm. Local vault files are
  **not** deleted. Any pending `<note>.conflict-from-*` sibling
  files are renamed to `<note>.unresolved-<original-timestamp>.<ext>`
  so they won't collide if you re-enable the plugin later. Use
  after a suspected token leak or to start clean.

### Settings removed in 2.0.1-beta

A handful of settings present in earlier releases are gone in
2.0.1-beta. They're listed here so a returning user doesn't waste
time looking for them:

- **Commit message template** (the field with `{date}`, `{time}`,
  `{filename}`, `{path}` placeholders) — **removed**. Commit
  messages are now hardcoded, with `(deviceLabel)` as the only
  user-tunable part. Five fixed formats: `sync (label)` for a
  manual sync click, `resolve conflict (label)` when the plugin
  publishes a closed conflict's content to `main`, `conflict
  (label)` for intermediate commits on the per-device conflict
  branch, `final state (label)` for the marker commit immediately
  before the branch merges back, `merge conflict-branch (label)`
  for the merge-commit itself, plus `init (label)` for the one-off
  commit that seeds a brand-new bare repo. Date and time already
  live in git commit metadata (author / committer timestamps);
  duplicating them in the message body added no information.
- **"Sync with GitHub (custom message)…" command** and
  **"Sync current file with GitHub (custom message)…" command** —
  **removed**. Same reason as above: hardcoded messages mean
  there's nothing left to customise per-click. Two commands remain:
  `Sync with GitHub` and `Sync current file with GitHub`.
- **Pending-conflicts list in the settings tab** — **removed**.
  Visibility for unresolved conflicts now lives in three places:
  the status bar `🔀 N` indicator, the side-ribbon badge, and the
  pre-sync confirmation modal. The settings tab was a fourth
  surface that didn't pull its weight — users with an active
  conflict clicked the status bar or ribbon to open the sibling,
  not the settings tab.

---

## Conflict resolution

A conflict happens when the same file changed on both sides since
the last sync — for example, you edited a note on your phone, then
edited the same note on your laptop, then clicked Sync on the
laptop. **Full design rationale and worked examples in
[docs/PSEUDO-MERGE-MODE.md](./docs/PSEUDO-MERGE-MODE.md).** The
user-facing summary:

### Auto-merge happens first

Before any conflict surfaces, the plugin tries to reconcile the two
sides on its own. The strategy depends on the file type:

| File type | Auto-merge strategy | Surfaces as a conflict only when… |
|---|---|---|
| Text (`.md`, `.txt`, …) | Three-way merge against the last-synced base. | Edits overlap on the same line. |
| Plugin bundle (`<plugin>/main.js`, `<plugin>/manifest.json`) | Higher semantic version from `manifest.json` wins; mtime tie-break. | Identical version **and** identical mtime. |
| Binary (`.png`, `.pdf`, attachments) | None — binary always surfaces. | Always (no silent overwrites of edited images). |
| Local deleted, remote modified | Auto-resolves in favour of the modification (the more recent intent wins; the file resurrects on remote). | Never. |
| Local modified, remote deleted | Surfaces as a conflict — your edit is preserved as a sibling. | Always. |

When auto-merge succeeds, the merged result goes straight to GitHub
and you're never notified — there was nothing for you to decide.

### When a conflict surfaces

The plugin writes the remote version into the vault next to your
file, named:

```
<note>.conflict-from-<remote-device>-<isoTimestamp>.md
```

The original file (your local version) is **not** touched. Both
files are visible in the Obsidian file explorer, openable in the
editor, indistinguishable from any other Markdown / binary file.
The status bar shows `🔀 N` for the count; the ribbon icon carries
a matching badge.

### Resolution — entirely through native Obsidian file operations

> **A dedicated side-by-side diff-edit GUI is planned for the next
> release.** In this release, conflict resolution is done with the
> native Obsidian operations you already use every day: open the
> files in the editor, delete a file from the file explorer, rename
> a file by long-press (mobile) or right-click → rename (desktop).

The three resolution moves and what they mean:

- **Delete the sibling** (`<note>.conflict-from-…md`) → keep your
  local version. On the next sync the local content is published to
  GitHub.
- **Rename the sibling onto the base** (`<note>.conflict-from-…md`
  → `<note>.md`, overwriting your local version) → accept the
  remote version.
- **Edit the base file by hand**, copying the parts you want from
  the sibling, then **delete the sibling** → publish your
  hand-merged result.

A file may carry several siblings if multiple devices contributed
conflicting versions — they're distinguished by the device-label
segment in the filename. The conflict on that path is closed only
when **every** sibling is gone (or matches the base byte-for-byte).

While a file is in conflict, **you can keep editing the base
file**. Those edits flow to a private branch on GitHub that no
other device sees until you finalise. The conflict doesn't block
you; other devices stay protected from your half-resolved state.

The `*.conflict-from-*` filename pattern is gitignored by default —
siblings stay strictly local. If you want them to sync across
devices, edit `<vault>/.gitignore` and remove the
`*.conflict-from-*` line.

---

## Commands and integrations

The plugin registers two commands (both available via the command
palette and assignable to hotkeys):

- `Sync with GitHub` — full vault sync
- `Sync current file with GitHub` — pushes just the active file

### Vim mode integration

<!-- TODO: add example after testing -->

If you use Obsidian's Vim mode, you can bind these commands to
your normal-mode commands via the `obsidian-vimrc-support` plugin.
Example (`.obsidian.vimrc`):

```vim
" Sync current file with one keystroke
exmap syncFile obcommand git-easy-sync:sync-current-file
nmap <leader>gs :syncFile<CR>
```

<!-- SCREENSHOT: vim-mode binding in action -->

---

## Troubleshooting

When something doesn't behave the way you expect:

1. **Turn on logging** in plugin settings (`Enable logging`).
2. **Reproduce** the issue.
3. **Copy the log** from the settings page (there's a copy button).
4. **Open an issue** at
   [github.com/dbdeveloper/git-easy-sync/issues](https://github.com/dbdeveloper/git-easy-sync/issues)
   and paste the log along with:
   - Platform (macOS / Windows / Linux / iOS / Android)
   - Obsidian version
   - Plugin version (from the settings page)
   - What you expected to happen vs. what actually happened
5. **Turn logging off** afterwards — log files grow over time and
   sync with the vault if `Sync configs` is on.

### Common gotchas

- **Sync is "paused" and everything GitHub-related is red** — the
  plugin detected an expired/invalid token (GitHub `401`) or one
  missing the required permissions (`403`), and it deliberately
  **stops touching GitHub until you fix the credentials**. You'll
  see: the **GitHub** status-bar word and the **Sync** ribbon icon
  turn red (tooltip "Token expired"), **Sync All** / **Pull from
  repo…** are greyed in the status menu, the **GitHub sync status**
  box in Settings explains what happened, automatic (interval /
  startup) syncs flash **"Sync skipped: token expired"** instead of
  "Sync done", and file history shows a **"TOKEN EXPIRED!"** notice.
  The state is **sticky on purpose** — an expired token won't start
  working again on its own, so the plugin won't silently retry. To
  clear it, do one of: paste a new token (or change owner/repo) in
  **Settings → Remote Repository**, or run a successful **Test
  connection**. Clicking the red Sync icon opens a recovery dialog
  with links to the GitHub token page, the setup guide, and
  Settings.
- **"Sync done" notice right after enabling the plugin** — that's
  the plugin draining a pending batch left over from a previous
  failed session. Happens when a previous push didn't finish
  cleanly (network drop, Obsidian quit mid-push). Normal recovery.
- **404 Not Found despite a valid-looking token** — almost always
  a fine-grained PAT whose "Repository access" list doesn't
  include your sync repo. Either add it, or generate a new PAT
  with the right scope. The **Test connection** button identifies
  this case specifically.
- **Settings field paste-with-trailing-space** — the plugin trims
  values on save, but if you somehow got a whitespace-poisoned
  value in before this fix (or if it came from another source),
  the plugin self-heals on next restart.
- **Large initial adoption on Android** — keep Obsidian in the
  foreground until the progress notice clears. Android suspends
  the JS runtime aggressively in the background; a paused
  adoption resumes safely on the next foreground click, but the
  one-shot flow is faster.
- **"Where did my sibling file go after I resolved the conflict?"**
  — if you accepted the remote version by renaming the sibling
  *onto* the base (`<note>.conflict-from-…md` → `<note>.md`,
  overwriting the local version), the sibling appears to vanish
  because it *became* the base. That's expected — the conflict is
  now closed and the status-bar `🔀` counter will drop on the next
  sync. Same outcome if you accepted yours by deleting the
  sibling: counter drops on the next sync, and the next push lifts
  your version to GitHub.
- **`<file>.unresolved-<timestamp>.<ext>` files lying around the
  vault** — these are leftovers from a previous `Reset` action.
  Reset renames any pending `*.conflict-from-*` siblings to this
  form so they don't collide if you re-enable the plugin. They're
  safe to delete by hand; the plugin doesn't read or otherwise
  manage them after the rename.

---

## Acknowledgements

This plugin is a heavily-refactored fork of
[`github-gitless-sync`](https://github.com/silvanocerza/github-gitless-sync)
by **Silvano Cerza**. The original gave us:

- The core idea of syncing through GitHub's REST API instead of
  shipping a git binary or `isomorphic-git`.
- The initial `GithubClient` REST wrapper (`src/github/client.ts`).
- The plugin scaffolding (settings tab structure, lifecycle hooks,
  logger).

About 8% of the current source code (~824 lines across 6 files) is
preserved from the original. Every source file that contains
Silvano's code carries an attribution header in its first three
lines.

Thanks for the foundation — without it this fork wouldn't exist.

The current sync engine, conflict resolution, adoption flow, resume
strategies, integration test suite, and mobile compatibility work
were rebuilt from scratch under the AGPL-3.0 license (carried over
unchanged from upstream).

---

## License

[AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.en.html) — same as
upstream. If you redistribute a modified version, you must keep the
source available; if you run a modified version as a network
service, that source-availability obligation extends to your users.
See [LICENSE](./LICENSE) for the full text.
