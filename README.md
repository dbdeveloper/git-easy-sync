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
  never silently overwrites your notes: a file that exists on both
  sides with different content becomes a conflict, with both versions
  kept, for you to decide. The one exception is Obsidian's own
  settings under `.obsidian/`: there the repository's version wins,
  so a new device adopts the vault's settings instead of imposing its
  fresh defaults.
- **Polling, not events — for the sync engine itself.** The plugin
  walks the vault on each sync click instead of subscribing to live
  events for sync purposes, so edits made while the plugin was
  disabled are picked up on the next click — no "missed events"
  failure mode. Vault event listeners *are* attached, but strictly
  read-only: they only refresh the pending-conflict counter (status
  bar `N ⁇` + ribbon badge) in real time so you see resolution
  progress immediately as you delete or rename sibling files. They
  never push, never pull, never mutate sync state.
- **Click feels instant, and never silent.** The click path writes the
  commit batch to disk and returns immediately; the network work happens
  in the background. A single notice carries the whole operation — what
  was committed, live progress if it runs longer than two seconds, then
  the result. A sync that finishes quickly shows no progress bar, only
  the outcome.
- **Resume on crash.** Four layers of resume cover adoption pull,
  incremental pull, push blob upload, and the find-changes → queue
  bridge. A push interrupted mid-flight (Obsidian closed, phone
  backgrounded, network drop) finishes on the next trigger without
  duplicating commits. The conflict-resolution layer adds a
  matching guarantee for its own multi-step writes — see
  [CHANGELOG](./CHANGELOG.md).
- **Privacy-conservative defaults.** Plugin `data.json` files
  (which routinely store API tokens) and per-device configs
  (`workspace.json`, `workspace-mobile.json`, `community-plugins.json`,
  `core-plugins.json`) are blocked from
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
- **No vaults beyond roughly 20 000 files.** To sync safely the plugin
  has to know what the repository holds, and it learns that from
  GitHub's tree API — which caps a single answer at 7 MB. Measured:
  ~278 bytes per file, so a 20 000-file repository already sits at
  ~80% of the cap, and non-ASCII or deeply nested paths reach it
  sooner. Past that the first sync fails with a clear message rather
  than syncing part of your vault. There are ways around the cap, but
  they add a whole layer of machinery for a case this plugin has
  chosen not to serve — if your vault is that large, use a tool built
  for it.
- **No files over 40 MB, and no Git LFS.** GitHub's API refuses a
  single file of 40 MiB or more (measured — its documentation says
  100 MB), so the plugin keeps any file over 40 000 000 bytes out of
  sync instead of letting it fail every sync. Such a file stays on
  this device untouched; everything else syncs as usual. A manual
  Commit or Sync, and the sync at startup, show a notice for each
  such file (`File "…" is too large for the repo (… MB, max 40 MB).
  Add it to .gitignore (Settings).`); the periodic sync skips it
  silently, and the log records it once per session. Adding the file
  (or a pattern like `*.mp4`) to the root `.gitignore` silences the
  notice for good. Video and other large media belong in a tool
  built for them.

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
  by the plugin, in the trailing-parenthesis form
  (`Sync at 2026-10-03 04:46:29.192+02:00 (MyMacBook)`,
  `Merge conflict-branch at … (MyMacBook)`, etc.). Helps
  tell which device produced which commit when you have several
  devices syncing to the same repo. Also used in
  conflict-resolution sibling filenames
  (`<note>.conflict-from-MyMacBook-<timestamp>.md`). Default
  `Obsidian`.
- **Git author name** / **Git author email** — like `git config
  user.name` / `user.email`. Filled in from your GitHub account on
  the first sync; change them if you prefer something else. Use a
  verified email of that account if you want commits credited to
  you. They are never left blank (a `@users.noreply.github.com`
  address derived from the Owner is the fallback), because the
  commit date travels with them: without a name and email GitHub
  records the push time instead of when you edited.
- **Sync strategy** — `Manually` (default) or `On Interval`.
  *Manually* means the plugin only acts when you click; *On
  Interval* runs a sync automatically every N minutes.
- **Sync interval** — minutes between automatic syncs. Shown only
  for `On Interval`. Default 5.
- **Sync on startup** — when on, runs one sync as soon as Obsidian
  finishes loading. Off by default; the plugin is otherwise silent
  on enable.
- **Sync starts with commit** — the master switch. When **ON**
  (default), every sync — your click, the interval, the startup
  sync — first commits your local changes, then exchanges with
  GitHub. When **OFF**, a sync only pulls and sends commits that are
  already queued; committing becomes a separate action through the
  `[Commit]` ribbon button.
- **Auto-canonicalize text files** — when on, text files (`.md`,
  `.txt`, …) get rewritten locally to LF / no-BOM / trailing newline,
  both on pull and on commit, and the plugin compares your files
  with the repository in that same form. Obsidian's own files under
  `.obsidian/` stay byte-exact. Off by default. Turn on if you want
  canonical text on disk and don't mind a one-commit convergence
  push on first setup against a CRLF-history repo.
- **Consolidate commits into one (if possible)** — folds consecutive
  commits into one when nothing was sent in between: Sync clicks
  made while an earlier push is still waiting (offline), or several
  `[Commit]` clicks in a row with no Sync between them. Off by
  default (each click is its own commit, which keeps a finer
  history).
- **Sync configs (.obsidian/ folder)** — when on, files under
  `<vault>/.obsidian/` are also synced (Obsidian settings, installed
  plugins, snippets). Off by default, and **per-device**: one
  machine can sync configs while another doesn't. Files that
  describe one device's state — `workspace.json`,
  `workspace-mobile.json`, `community-plugins.json`,
  `core-plugins.json` — never sync either way. See
  [Bonus: cloning plugins](#bonus-cloning-plugins-and-their-settings-to-the-new-device).
- **Sync plugins data.json** — when on, the `data.json` files of
  *other* community plugins are also synced. Off by default —
  these files frequently store API tokens, account credentials,
  and license keys. Our own `data.json` is **always** blocked
  regardless of this toggle.
  **Requires *Sync configs* above.** Turning that off switches this
  off too and greys it out — with the config folder silenced, this
  setting cannot do anything anyway, and a switch that looks ON
  while doing nothing is the worst possible answer to "are my
  secrets being published?". Turning *Sync configs* back on makes
  this one available again but leaves it **off**: resuming the
  publication of credentials is your decision to make again, not
  something that should happen as a side effect.
  **Per-device**, like *Sync configs*: turning it on here leaves
  your other machines alone, so you can share plugin settings
  between two devices out of ten. A plugin can still overrule the
  switch from a `.gitignore` in its own folder — in either
  direction — which is the intended escape hatch for "share
  everything except this one".

### Interface

**What a sync tells you.** One notice carries the whole operation and
changes as it goes. A sync shows live progress *only if it is still
running after two seconds*, then a summary that disappears after a
moment:

```
Syncing with GitHub
Pulling 2 of 10
Pushing 3 of 5
⚠ 2 files need resolving
```

```
Sync done — 3 sent, 10 received
2 plugins updated
```

Both counters run at once because this plugin sends and receives in the
same pass rather than in separate phases, and their totals can GROW
mid-sync: the plugin genuinely learns of more work as it goes (another
batch of local changes, another answer from the server) and would rather
show that than a total it guessed. A quick sync shows no progress at
all — only the summary.

A commit that is forecast to take a while says so first —
`Committing…`, then `Checking N of M files` (the first commit after
setup or a Reset, with nothing to forecast from, shows `Checking all
files…`). A
`[Commit]` click on its own ends with `Committed N files` or
`Nothing to commit`; inside a sync the summary speaks for both.

**Stopping a sync.** Clicking the sync button while one is running
offers `Cancel sync`; Settings → *GitHub sync status* has the same
action as `Stop sync`. It takes effect within moments, even in the
middle of a large upload — the request in flight is aborted, not
waited out — and you see `Sync canceled`. A Cancel that lands while
the sync is still committing lets the commit finish and starts no
exchange with GitHub. Nothing is left half-done: the next sync picks
up where this one stopped, and a large file whose upload had already
completed is not sent again.

- **Show status bar item** — shows a `GitHub` item in Obsidian's
  status bar with the number of commits waiting to be sent and the
  number of files in conflict — `GitHub (↑ 3 | 2 ⁇)`. Clicking it
  opens a menu (Sync / Commit / Open diff-panel / Settings). On by
  default.
- **Show sync ribbon button** — the `[Sync with GitHub]` ribbon
  button; its badge counts the commits not yet sent. What a click does
  depends on *Sync starts with commit*. On by default.
- **Show Diff-Panel ribbon button** — a separate ribbon button that
  opens the conflicts / deleted / compare views; its badge counts the
  files in conflict. On by default.
- **Show commit ribbon button** — a `[Commit]` button that queues your
  changed files without touching the network. Off by default; most
  useful with *Sync starts with commit* OFF, where it is the only way
  to commit.
- **Spin the sync icon while syncing** — purely cosmetic; when off,
  the icon only changes colour while a sync runs. On by default.

### Diff Editor

- **Editor mode (enable editing)** — open the conflict editor with
  typing enabled. When off it is read-only: you resolve with the
  on-screen buttons, and the phone keyboard stays down. Default: on
  for desktop, off for mobile; each document has its own `Edit`
  switch in the toolbar.
- **Diff highlight mode** — `Characters` (default) marks only the
  differing characters inside a changed line, `Words` marks whole
  words. Large blocks always use words.
- **Auto-focus conflicts / history / deleted** — on opening, and after
  each resolve, scroll to the first remaining difference. On for
  conflicts, off for history and deleted by default; also switchable
  per document.

### Performance

- **Maximum auto-merge file size (KB)** — the three-way text
  auto-merge is skipped above this size: a file changed on both sides
  becomes a conflict for you to resolve instead. Default 1024 KB;
  well above ~2 MB a merge can hang noticeably.

### `.gitignore`

This plugin reads the `.gitignore` in your vault's **root** and no other. Plain git
reads one in every folder, so rules written deeper in the tree would apply for git and
be invisible here — which is why the plugin offers to collect them into the root file
instead.

The first time it runs it checks the whole vault for `.gitignore` files outside the
root. If it finds any, their rules are translated into root-anchored form and offered
as a **change to the root `.gitignore`**, which you accept, edit or discard in the
normal conflict editor. The originals are renamed to `.bak` — nothing is deleted.

While that check is running the vault stays fully editable; only **syncing** waits,
because those rules decide which files are synced at all. Press Sync during the check
and you get a small window with a running count and a **Back** button; Back cancels
that sync, and pressing Sync again brings the window back until the check is done.

Three buttons live in Settings under **.gitignore**:

- **Check now** — run the same check again, for a `.gitignore` you added by hand later.
  It always reports, even when there is nothing to do.
- **Open** — edit the root `.gitignore`. Obsidian hides files whose name starts with a
  dot, so this is the way to reach it from inside the app. Every time, a short warning
  comes first, with a link to git's own description of the rules: `[Cancel]` or
  `[I know .gitignore rules]`. The editor opens in its own window on desktop and full
  screen on a phone. `[Save]` writes only a real change, and refuses to overwrite the
  file if a sync changed it while the editor was open — your text stays in the editor.
- **History** — the file's version history, the same view as for any note.

> **Syncing is refused while any `.gitignore` conflict is unresolved**, with no
> "sync anyway". These rules decide what travels, so syncing while they disagree could
> publish files you meant to keep private, or hide files you meant to keep.

### Logging

- **Enable logging** — appends every operation to
  `<vault>/git-easy-sync.log`. Off by default. Turning it off deletes
  the file. Logs do not sync: `*.log` sits in the top managed block
  of the root `.gitignore`. To sync this log anyway — handy for
  reading a phone's log on a desktop, though several devices then
  write the same file — add `!/git-easy-sync.log` among your own
  rules.
- **View log** — opens the log as a table: filter by column (`|`
  separates the pieces, left to right), search, copy. New entries
  appear as they are written. Its own window on desktop, full screen
  on a phone. Shown only while logging is on.
- **Clean logs** — empties the log; the description shows its live
  size. Shown only while logging is on.

### Danger zone

- **Reset plugin** — wipes ALL plugin state: GitHub token,
  repository settings, sync history, the queue of unsent commits,
  pending conflicts. Type `RESET` to confirm. Your vault is **not**
  touched — notes stay, and `<note>.conflict-from-*` copies stay in
  place, to be picked up as local conflicts if you set the plugin up
  again. Use after a suspected token leak or to start clean.

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
  there's nothing left to customise per-click. (Today's commands are
  listed under [Commands and integrations](#commands-and-integrations).)
- **Pending-conflicts list in the settings tab** — **removed**.
  Visibility for unresolved conflicts now lives in three places:
  the status bar `N ⁇` indicator, the side-ribbon badge, and the
  pre-sync confirmation modal. The settings tab was a fourth
  surface that didn't pull its weight — users with an active
  conflict clicked the status bar or ribbon to open the sibling,
  not the settings tab.

---

## What syncs, and what stays invisible

Everything whose name starts with a dot — `.editorconfig`,
`.obsidian/`, `notes/.drafts/` — is **invisible to sync by
default**. Obsidian itself does not show those files, so syncing
them without being asked would move things you never see; and some
of them (editor state, caches, credentials dropped by other tools)
are the last things that should land in a shared repo.

Ordinary files are the opposite: visible by default, unless a
`.gitignore` rule hides them.

### Three ways to make a dot-path visible

1. **The root `.gitignore` itself** always syncs — it is the file
   that decides everything else, so both machines need it.
2. **The config folder**, `.obsidian/`, via the **Sync configs**
   setting. That one is deliberately **per-device**: "do I share my
   config" is a decision each machine makes for itself, so it lives
   in the plugin's own settings rather than in the shared
   `.gitignore`.
3. **A `!`-rule you write in the root `.gitignore`**, naming the
   file or folder you want back:

   ```gitignore
   !/.editorconfig        # this one file
   !/.myconfig/           # this folder, and its ordinary contents
   ```

### Rules that look right but do nothing

These are real gitignore semantics, not plugin quirks — but they
catch people out, so:

| You write | What happens |
|---|---|
| `!/.myconfig/foo.md` | **Nothing.** git cannot re-include a file inside a hidden folder. Un-hide the folder: `!/.myconfig/` |
| `!.myconfig/` (no leading `/`) | **Nothing here.** It matches a folder of that name at *any* depth, so the plugin cannot tell which one you meant. Anchor it: `!/.myconfig/` |
| `!.editorconfig` (no leading `/`) | Works, but in git it also matches `sub/.editorconfig`. For the root one only, write `!/.editorconfig` |
| `!**/.foo`, `!*.conf` | **Nothing.** A pattern is not a path; the plugin only un-hides things it can name |
| `!notes/.secret` | **Nothing** — a dot-*file* buried in an ordinary folder is not supported (a dot-*folder* there is: `!notes/.secret/`) |

The reason the "nothing" cases are nothing rather than
half-working: a rule that granted permission without giving the
plugin a way to *find* the file would leave it looking deleted on
the next sync, and that delete would travel to your other devices.
A rule that does nothing is safe; a rule that half-works is not.

**Un-hiding a folder does not un-hide dot-paths inside it.**
`!/.myconfig/` brings back `.myconfig/note.md` and
`.myconfig/deep/note.md`, but not `.myconfig/.hidden` — name that
separately if you want it.

### The two blocks the plugin manages

Your root `.gitignore` gets two managed sections, and the
difference between them is deliberate:

```gitignore
# ===== git-easy-sync invariants v2.0.2-beta - DO NOT EDIT =====
.*                       ← hide dot-space
.*/
!/.gitignore
*.log                    ← logs, the plugin's own included
# ===== end of git-easy-sync invariants =====

...your rules go here, and they OVERRIDE the block above...

# ===== git-easy-sync final v2.0.2-beta - DO NOT EDIT =====
!/.obsidian/             ← these cannot be overridden
*.conflict-from-*
*.ges-tmp*
*.ges-bak*
# ===== end of git-easy-sync final =====
```

*(Abridged — the real blocks carry explanatory comments between these
lines. The rules themselves are exactly as shown. `v2.0.2-beta` stands for
the version of the plugin that wrote the block.)*

The **top** block is a default you are invited to change — your
rules sit below it and win. The **bottom** block is not: it holds
conflict-sibling files and the plugin's own temporary files, and a
rule resurrecting those would break syncing rather than customise
it. Both blocks are rewritten to their canonical form on every
sync; everything between them is yours and is never touched.

### Keeping a control file to one machine

Because your rules override the top block, you can write
`/.gitignore` among them. That takes the root `.gitignore` itself
out of sync: the machine keeps using it, but stops sharing it.
Useful when one device needs its own `.editorconfig` while the
others share one.

The price is real, so decide knowingly: that machine's rules stop
reaching the others, and if *every* machine does this there is no
copy of your rules in the repo at all.

### Where the plugin deliberately differs from git

If you ever run `git status` in your vault, expect it to disagree
with the plugin in one place: **a `.gitignore` in an arbitrary
subfolder is read by git and ignored by the plugin.** Only three
locations are honoured — the vault root, `.obsidian/`, and one
level under `.obsidian/plugins/`.

This is a choice, not an oversight. It keeps what-syncs-where
answerable by looking at one file, and it keeps the plugin from
obeying a control file it would then refuse to sync — which would
leave your other devices governed by rules they never received. A
`.gitignore` outside those three places is, for the plugin, a file
you did not write.

### Upgrading from an earlier version

Two changes are worth knowing about, because both are silent:

- **Root dot-files other than `.gitignore` stop syncing.** Earlier
  versions synced every dot-file at the vault root
  (`.gitattributes`, `.editorconfig`, …) whether or not you asked.
  They now wait for a `!`-rule. Nothing is deleted: the files stay
  on disk, the copies already on GitHub stay there, and the plugin
  simply stops touching them in either direction. Add
  `!/.gitattributes` to keep one syncing.
- ⚠️ **A `.gitignore` in a subfolder stops being obeyed — check
  what it was hiding.** If `notes/private/.gitignore` contained
  `*`, those notes were excluded and now **will sync**. Move the
  rule to the root file with its path in front
  (`notes/private/`) *before* your next sync if that folder was
  private.

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
| Text above *Maximum auto-merge file size* (default 1 MB) | None — merging is skipped. | Both sides changed it (a change on one side still syncs normally). |
| Plugin bundle (`<plugin>/main.js`, `<plugin>/manifest.json`) | Higher version from `manifest.json` wins; when the versions cannot decide, the newer edit wins. | Never. |
| Other files under `.obsidian/` | The side that changed wins; if both changed, the newer edit wins — and the repository's version when there is no common history (a new device's first sync). | Never. |
| Binary (`.png`, `.pdf`, attachments) | None — binary always surfaces. | Both sides changed it (no silent overwrites of edited images). |
| Local modified, remote deleted | Your edit wins — the file comes back on GitHub. | Never. |
| Local deleted, remote modified | None — only you can tell whether the deletion still stands. | Always: the remote version is kept as a conflict copy. |
| Same new file created on both sides with different content | None — there is no common version to merge against. | Always. |

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
The status bar shows `N ⁇` — the number of files in conflict — and
the Diff-Panel ribbon icon carries a matching badge.

### Resolution — entirely through native Obsidian file operations

> **There are two ways to resolve, and both are supported.** The
> side-by-side diff editor (the `git-merge` ribbon icon, or a
> conflicted file's *Resolve conflict* menu entry) shows the two
> versions with per-change buttons. Everything below still works
> exactly as described and needs no special UI: conflicts are
> ordinary files, so you can open them in the editor, delete one from
> the file explorer, or rename one over the other — by long-press on
> mobile, right-click → rename on desktop. Neither way is a fallback
> for the other; pick whichever suits the change in front of you.

> **One conflict can disappear on its own, and the plugin will say
> so.** If the other version vanishes from the repository — someone
> force-pushed over it, or history was rewritten — the conflict is
> cancelled, because the thing it was comparing against no longer
> exists. You get a notice naming the file and stating that your local
> copy is untouched. This is the ONLY sync hiccup the plugin
> interrupts you about: everything else it skips is retried on the
> next sync without a word, which is what keeps this notice worth
> reading.

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

The same holds for syncing. A Sync you start by hand while a conflict
is open asks first — `Resolve` (opens the conflicts panel), `Sync
anyway` or `Cancel`. An automatic sync (on interval or at startup) has
nobody to ask, so it goes ahead as `Sync anyway` would: one open
conflict never stops the rest of your vault from syncing. Only an
unresolved `.gitignore` conflict stops every sync, automatic ones
included.

Sibling files never sync: the `*.conflict-from-*` pattern sits in
the plugin's **final** `.gitignore` block, which is restored to
canonical on every sync, so removing the line does not make them
travel. That is deliberate — a sibling is one device's unfinished
business, and copying it to the others would spread a
half-resolved state instead of a resolution.

---

## Commands and integrations

The plugin registers these commands (all available via the command
palette and assignable to hotkeys):

- `Sync with GitHub` — a full sync; with *Sync starts with commit* on
  it commits your changes first.
- `Commit all changed files` — queue every changed file, no network.
- `Commit active file` — queue just the file in front of you.
- `Pull from repo and push stored commits` — exchange with GitHub
  without committing anything new.
- `Cancel sync` — stop the running sync; does nothing when none runs.
- `Open Diff-Edit` — the conflicts / deleted / compare panel.
- `Open history of active file` — the file's versions on GitHub (also
  in a file's right-click menu).
- `Compare two files…`, `Compare active file with…` — for now these
  open the Diff-Edit panel.

### Vim mode integration

<!-- TODO: add example after testing -->

If you use Obsidian's Vim mode, you can bind these commands to
your normal-mode commands via the `obsidian-vimrc-support` plugin.
Example (`.obsidian.vimrc`):

```vim
" Sync the vault with one keystroke
exmap syncVault obcommand git-easy-sync:sync
nmap <leader>gs :syncVault<CR>
```

<!-- SCREENSHOT: vim-mode binding in action -->

---

## Troubleshooting

When something doesn't behave the way you expect:

1. **Turn on logging** in plugin settings (`Enable logging`).
2. **Reproduce** the issue.
3. **Get the log**: Settings → Logging → *View log* lets you filter
   and copy what matters, or attach `<vault>/git-easy-sync.log`
   itself.
4. **Open an issue** at
   [github.com/dbdeveloper/git-easy-sync/issues](https://github.com/dbdeveloper/git-easy-sync/issues)
   and paste the log along with:
   - Platform (macOS / Windows / Linux / iOS / Android)
   - Obsidian version
   - Plugin version (from the settings page)
   - What you expected to happen vs. what actually happened
5. **Turn logging off** afterwards — the log grows over time;
   turning logging off deletes it.

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
  now closed and the status-bar `⁇` counter will drop on the next
  sync. Same outcome if you accepted yours by deleting the
  sibling: counter drops on the next sync, and the next push lifts
  your version to GitHub.
- **`<file>.unresolved-<timestamp>.<ext>` files lying around the
  vault** — leftovers from a `Reset` in an older version, which
  renamed pending conflict copies to this form. Reset no longer
  renames anything. They're safe to delete by hand; the plugin
  doesn't read or manage them.
- **`File "…" is too large for the repo`** — the file is over 40 MB,
  which GitHub's API does not accept, so it stays on this device
  and everything else syncs. Add it (or its pattern) to the root
  `.gitignore` to stop the notice; see
  [What this plugin deliberately doesn't do](#what-this-plugin-deliberately-doesnt-do).

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
