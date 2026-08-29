# Manual / Playwright Test Checklist

This checklist covers behaviour that the automated suites **cannot** verify:

- the real Obsidian UI (ribbons, status bar, settings, modals);
- mobile / Capacitor behaviour (iOS & Android);
- layout-dependent CodeMirror behaviour that needs real geometry (line
  wrapping, Page Up/Down, vertical caret movement, Home/End);
- physical failure modes (low-memory kill, battery death mid-write);
- end-to-end sync flows against a real GitHub repository, exercised the way a
  user would.

Everything else is pinned by the unit suite (`pnpm test`) and the integration
suite (`pnpm test:integration`).

**How to use**

- Run the relevant sections before each release — especially `-beta` builds on
  mobile.
- Tick `[x]` for each item you verify; record the **version, platform, and
  date** in your run notes.
- When you find a bug, file an issue and, where feasible, add a unit or
  integration test so the case is caught automatically next time.

**Legend**  🖥️ desktop · 📱 mobile (iOS/Android) · 🌐 needs a real GitHub repo ·
⏳ feature not yet bundled into `main.js` (test once it ships).

---

## 1. Platform & build

- [ ] 🖥️ `pnpm build` is green; `main.js` loads in Obsidian (desktop) with no console errors.
- [ ] 📱 The plugin **enables** in the community-plugins list on iOS and Android **without crashing**. (Regression guard: no file-scope `require("fs")` / `require("path")` in `main.js` — `grep -E '=require\("fs"\)|=require\("path"\)' main.js` must return zero.)
- [ ] 📱 `styles.css` is applied (check both light and dark themes).
- [ ] 🖥️📱 The same repo synced from both a desktop and a mobile vault stays consistent.

## 2. Sync — end-to-end flows (🌐 real GitHub)

- [ ] 🖥️ **Bare-repo bootstrap:** the first sync into an empty repo creates the structure, `.gitignore`, and the snapshot manifest.
- [ ] 🖥️ **Adoption:** the first sync against a non-empty repo produces no duplicates or losses; conflicts are classified.
- [ ] 🖥️ **Incremental:** edit a file → `[Sync]` → it commits and pushes; delete a file → the deletion reaches the remote.
- [ ] 🖥️ **Pending deletions:** delete a file and sync → it is removed on the remote; on a second device, pull removes it locally.
- [ ] 🖥️ **"Sync starts with commit" = off:** `[Sync]` only pulls/pushes; the `[Commit]` ribbon button (or the *Commit local changes* command) commits separately.
- [ ] 🖥️ **Interval scheduler:** the periodic tick syncs automatically; an initial sync runs shortly after the vault opens.
- [ ] 🖥️ **Ribbon & status bar:** sync/commit icons work; the conflict counter (🔀) updates; the status reads *Syncing… / idle / Last error*.
- [ ] 🖥️ **Push-queue persistence:** start a sync, force-quit Obsidian mid-push, relaunch → the queue is drained to completion by the recovery sweep.
- [ ] 🖥️ **Large vault** (1000+ files): syncing does not freeze the UI (heavy work runs off the main thread).

## 3. Mobile-specific (📱 — Capacitor is not unit-tested)

- [ ] 📱 **Capacitor rename:** conflict resolution and atomic writes never fail with *"Destination file already exists"* (iOS/Android `rename` does not overwrite; the code must remove-then-rename).
- [ ] 📱 **Binary files** (PNG, PDF) sync without corruption (binary read/write path, not the text path).
- [ ] 📱 **Token with trailing whitespace** (pasted from the keyboard suggestion bar) still works — input is trimmed and existing values self-heal on restart.
- [ ] 📱 **Low-memory kill:** while editing or syncing, let the OS kill Obsidian → on relaunch the vault is consistent and the recovery sweep has run.
- [ ] 📱 **Battery death** (let the device power off below 1% mid-sync) → on relaunch, no corruption and no 0-byte files.
- [ ] 📱 **Touch:** ribbon, settings, and the conflict list respond to taps as they do to clicks on desktop.

**Installing a build on a device (BRAT).** There is no public-store build, so use [BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add Beta Plugin* → this repo's URL → BRAT pulls `main.js` + `manifest.json` from the latest release tag. To test an unreleased branch, push an `X.Y.Z-beta` tag (the `release.yml` workflow cuts the artifact BRAT can fetch). Then run the 📱 / 🖥️📱 items here plus sections 2, 4, 6, 7, 8 on the device. "Pass" means the desktop contract holds identically on mobile.

**Known platform limitations (behaviours, not plugin bugs — surface in the README so users know what to expect):**

- **Android background-throttled timer.** Backgrounding Obsidian suspends the JS runtime within seconds; `Window.setInterval` stops firing. Watchdog drain resumes on foreground (the onload hook acts as a manual tick); a push interrupted mid-flight resumes on the next foreground via the `.attempted` marker.
- **Android — no file watcher for external deletions.** Files removed via Android's Files app (not Obsidian) don't fire `vault.on("delete")`. ConflictStore's orphan cleanup at `load()` catches it on the next plugin start, but mid-session deletions stay invisible.
- **Android Storage Access Framework.** Vaults under `/Android/data/md.obsidian/` work; arbitrary external paths may need user-granted access on each launch.
- **Large uploads (>10 MB) on memory-constrained devices.** `createBlob`'s base64 step inflates ~33% in memory → either a slow push or an OOM crash. The push-queue persists the batch on disk; restart + retry usually succeeds (the resume layer skips already-uploaded blobs).
- **iOS background suspension** is more aggressive than Android (~30 s typical). iOS fires `delete` reliably for in-Obsidian operations; external Files.app operations are inconsistent.

## 4. Conflict resolution / pseudo-merge — end-to-end (🌐)

- [ ] 🖥️📱 Two devices edit the same file → a conflict sibling `*.conflict-from-<device>-<timestamp>.*` is created.
- [ ] 🖥️ The conflict counter (🔀) in the status bar updates as siblings appear and clear.
- [ ] 🖥️ **Auto-merge:** non-overlapping edits merge cleanly (3-way); overlapping edits produce a sibling.
- [ ] 🖥️ **Edit while in conflict:** editing the base file while a sibling exists does not lose the edit.
- [ ] 🖥️ The pre-sync conflict dialog shows the count and lets you confirm.
- [ ] 🖥️ When a sibling is reconciled to match the base (identical content), the sibling is cleared on the next sync.
- [ ] 🖥️ **Multi-device rotation:** run a realistic round-trip across 2+ devices.

## 5. Diff-editor widget (⏳ once bundled into `main.js`)

> The editor **model** is fully unit-tested (`tests/diff2/`). This section covers
> what needs real layout/geometry and the end-to-end user experience.

**Layout / geometry (Playwright or a real device):**

- [ ] **Wrapping:** a 200-character line in a narrow editor (~30 columns) wraps; the `↵` glyph appears **only** at real newlines, and wrapped continuation rows have an empty gutter (one line number for the whole logical line).
- [ ] **Vertical arrows** within a wrapped long line move row by row (they do not jump over the line).
- [ ] **Page Up / Page Down** over large change blocks (10+ lines) scroll and position the caret correctly.
- [ ] **Ctrl/Cmd-Home / Ctrl/Cmd-End** jump to the first/last line — verify the case where the first line is a **hidden empty "local" block** and the last is a **hidden empty "remote" block** (they reveal/activate correctly).
- [ ] **Home / End** on a wrapped line behave sensibly (visual vs logical line start/end).
- [ ] **Entering an empty change block:** pressing Down from a normal line above an empty block reveals a temporary blank line; pressing Down again without typing collapses it and moves on. Up from below is the mirror.
- [ ] **Markers:** the `<<<<<` / `=====` / `>>>>>` rows render as block widgets; the action buttons are clickable; the device label shows on the top/bottom markers.
- [ ] **Button labels (TODO §6.3/§6.4):** top (ours) = `[Keep ↓] [Remove ↓]`; middle = `[Apply Both ↓↑] [Remove Both ↓↑] [Join (<remote>)]`; bottom (theirs) = `[Apply ↑] [Remove ↑]` — all Capitalized, Join label in parens.
- [ ] **Focus on open (TODO §6.1):** opening a conflict shows the blinking caret immediately and Ctrl/Cmd+Z works WITHOUT clicking into the text first.
- [ ] **Cursor restore (TODO §6.2):** edit deep in a long conflict, force-quit, reopen → the editor scrolls to roughly where you left off (caret visible, focused).
- [ ] **Gutter glyphs + colour (TODO §6.5/§6.7):** ours lines show `−` and a red-tinted gutter cell; theirs lines show `+` and a green-tinted cell; wrapped continuation rows keep the colour (no repeated number/glyph). The gutter band also covers the `<<<<<` / `=====` / `>>>>>` marker rows.
- [ ] **`↵` only in ver-blocks (TODO §6.8):** the `↵` newline glyph appears ONLY inside ver1/ver2 lines (red/green), NOT on normal/common lines.
- [ ] **Separator colour (TODO §6.6):** the `=====` row is split top-red / bottom-green (not a blank white strip).
- [ ] **Light AND dark themes:** switch Obsidian theme — the ours/theirs backgrounds, gutter, and numbers stay readable in both (light: light bg + dark numbers; dark: dark bg + bright numbers).
- [ ] **Colours:** the local side is red, the remote side green, and intra-line word differences get a yellow overlay (blending to orange / olive).
- [ ] **No-trailing-newline edge:** a whole-file single-line difference (e.g. local `"abc"` vs remote `"XYZ"`) renders without errors and without a marker landing mid-line.

**End-to-end UX:**

- [ ] Opening the editor from each entry point (file menu *Resolve conflict*, the diff ribbon icon, the post-sync summary modal).
- [ ] Resolving via the buttons and via the hotkeys (`Ctrl+Enter` / `Ctrl+Backspace` / `Ctrl+Shift+Enter` / `Ctrl+Shift+Backspace` / `Ctrl+Shift+.`).
- [ ] **Undo/redo after a BUTTON action (TODO §4):** click a marker `[apply]`/`[remove]`/… or a toolbar `[Keep all local]` / `[Apply all remote]` / `[Join all changes]`, then press **Ctrl/Cmd+Z** — it must undo the action (and Ctrl/Cmd+Shift+Z redo it). Previously a button click stole focus and Ctrl+Z did nothing.
- [ ] **Undo shrinks the recovery log (TODO §5):** make 3 changes, press Ctrl/Cmd+Z twice, then force-quit Obsidian and reopen the conflict → the recovery replays **only the 1 surviving change** (not all 3). Make N changes then N undos → reopening offers a *fresh* session (the log is empty, nothing to resume). This needs a force-quit (the log is discarded on a clean `[← back]`).
- [ ] **`[← Back]`** writes the resolved file, removes a now-redundant sibling, and returns to the list.
- [ ] **⚠️ Open editor survives `[← Back]` (bug3):** open the conflict's base file (e.g. `test.md`) in a NORMAL markdown tab FIRST, then resolve that conflict in the diff-editor and press `[← Back]`. The markdown tab must STAY OPEN (not close/reopen), and its cursor + scroll position should be preserved (the write goes through `modifyBinary` in place, not a rename swap). Try with the sibling open too.
- [ ] **Config-dir conflict:** if a conflict ever lands on a `.obsidian/…` file, `[← Back]` still commits it correctly (those files aren't opened in tabs, so they take the rename path — no tab to preserve).
- [ ] **⚠️ Resolve via BUTTONS ONLY (no typing)** — click *Keep all local* / per-chunk `[apply]`, then `[← Back]`: the inputs **are written** (Notice "Saved…", redundant sibling cleaned if converged). They must NOT be silently discarded. *(This is the data-loss-critical seam: a button resolve must count as a recorded edit — §4.1.a `recordCount > 0`.)*
- [ ] **`[×]`** (tab close) **with edits** keeps the session for recovery; **with zero edits** silently discards it. The vault is left as it was before editing in both cases.
- [ ] **One editor at a time:** clicking another conflict during an active edit shows a *"close the current edit first"* notice instead of losing work.
- [ ] **Select all + delete** then `[← Back]` saves a single newline (not a 0-byte file).
- [ ] **Standard editing commands** (delete line, delete word, Home/End, Page Up/Down) behave normally and never corrupt the merged view. (Note: *delete to end of line* / Ctrl+K is not bound yet — verify if/when added.)

**Autosave & recovery (⏳ later milestone):**

- [ ] **Zero-edit invariant (§4.1.a):** open a conflict, change **nothing**, leave (via `[← Back]`, a sub-tab switch, or closing the view). Reopening the SAME conflict must NOT show a *"Resume previous edit session · 0 edits saved"* dialog — it opens fresh. (The `.diff2-autosave/<id>/` dir is wiped on the zero-edit exit; a crash-survivor empty dir is swept on the next plugin load.)
- [ ] **No spurious re-mount:** while editing a conflict, trigger a background sync that adds/removes another conflict → the editor you're in keeps its state (it does NOT re-mount or pop a resume dialog mid-edit).
- [ ] Edit, force-quit Obsidian, reopen the conflict → a recovery dialog offers *Continue editing*, which restores the in-progress state with the caret roughly where it was; Undo steps back through the edits.
- [ ] *Start over* discards the session and starts fresh from the current files.
- [ ] If the underlying files changed during the session (a sync pulled new content), a dialog offers *restore the previous version / discard / cancel*.
- [ ] If the files changed by the time you press `[← Back]`, a dialog offers *save to alternative paths / overwrite / cancel*.

## 6. Settings & lifecycle (🖥️📱)

- [ ] Token / owner / repo / branch fields trim input; invalid values produce a clear error (not a silent 404).
- [ ] The settings connection test works and does not disturb sync state.
- [ ] **Reset** (type the confirmation phrase) wipes the token, repo settings, sync history, pending queue, and conflicts; local vault files are untouched; unresolved siblings are renamed to `.unresolved`.
- [ ] Toggling **"sync config folder"** includes/excludes `.obsidian/*` accordingly.
- [ ] Changing the **device label** makes new commits carry the new `(label)` suffix.
- [ ] Switching repositories resets state correctly.
- [ ] The **max auto-merge size** setting prevents very large files from being auto-merged.
- [ ] **Token expired (§35)** — with a bad token, a manual Sync opens the recovery dialog **every time** (closing `[X]` then Sync re-opens it — not a silent toast); the raw "…status 401" toast does NOT appear.
- [ ] **Token expired — sticky + red UI (§35)** — the marker survives a plugin reload: after reload the **GitHub** status-bar word + **Sync** ribbon icon are red (tooltip "Token expired"), **Sync All** / **Pull from repo…** are greyed, and the **GitHub sync status** box shows the 401 ("invalid or expired") vs 403 ("lacks permissions") message. It clears only on a token/owner/repo edit **or** a successful **Test connection** (a normal successful Sync does NOT clear it).
- [ ] **Token expired — automatic + history (§35)** — an interval/startup sync flashes **"Sync skipped: token expired"** (no modal); opening a file's history shows **"TOKEN EXPIRED! …"** above the local-only versions.
- [ ] 📱 **Token expired — mobile modal (§35)** — the recovery dialog is the shorter mobile layout and its buttons wrap + center (none pushed off-screen).

## 7. Self-update (🖥️📱)

- [ ] Updating the plugin through itself: it completes and restarts after the update.
- [ ] 📱 On mobile the plugin auto-reloads (disable + enable) after a self-update, with no manual step.

## 8. Crash / recovery / edge cases (🖥️📱)

- [ ] A crash between atomic-write steps is completed forward by the recovery sweep on the next launch.
- [ ] **Zero-byte restore guard:** a file that had content but accidentally became 0 bytes is restored to its last good version, and the empty copy never reaches the server.
- [ ] Out-of-band drift (another tool changed the repo) reconciles correctly.
- [ ] Disabling then re-enabling the plugin mid-sync causes no double-run or corruption.

## 9. Performance (📱)

- [ ] **Mobile autosave benchmark** (Settings → *Run mobile autosave benchmark*): run on a mid-tier Android and on iOS; collect the p50/p95/p99 figures and send the log so the autosave timing can be tuned.
- [ ] A large conflict (hundreds of change blocks) in the diff editor stays responsive on mobile.

## Reporting a mobile issue

Open a GitHub issue with: device + Android/iOS version + Obsidian version; the section/item above that failed; expected vs observed result; a snapshot of `<vault>/.obsidian/plugins/git-easy-sync/.push-queue/` (paths only — content may carry private data); and any relevant lines from `<vault>/.obsidian/git-easy-sync.log` (with "Enable logging" on).

---

*Keep this checklist current as features are added that automated tests do not
cover. When a ⏳ feature ships, drop the marker and fold it into the release run.*
