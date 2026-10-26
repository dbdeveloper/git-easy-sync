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

⚠️ **Some items cannot be done on one device, and that is not a formality.** Everything
in §5b (the managed `.gitignore` blocks) and §5c (plugin updates across Obsidian
versions) exists to govern what a SECOND device does with what the first one wrote —
the version stamp in a `.gitignore` marker and the whole `heldPluginUpdates` mechanism
are answers to problems a single device cannot even express. §5c additionally needs the
two devices on **different Obsidian versions**. Ticking those from one machine is worse
than leaving them blank: it records a pass for a question that was never asked.

For §5c there is a scripted fixture — `tests/fixtures/reload-probe/README.md`, runs 1-5
— which stages the version skew deliberately so you do not have to wait for a real one.
Use it, and note which runs you did.

---

## 1. Platform & build

- [x] 🖥️ `pnpm build` is green; `main.js` loads in Obsidian (desktop) with no console errors.
- [x] ⚠️ **AFTER EVERY REBUILD, RELOAD THE PLUGIN before testing.** Writing `main.js`
      does not change the code Obsidian is RUNNING — it keeps the old module in memory
      until the plugin is disabled and re-enabled. This cost two debugging rounds on
      2026-10-03 alone (once for `data.json`, once for `main.js`), and both times the
      symptom was "the fix did nothing". The one-second check before you trust a run:
      `grep -c "<a string from the new code>" <vault>/.obsidian/plugins/git-easy-sync/main.js`
      proves the FILE is new — only a reload proves the INSTANCE is.
- [x] 📱 The plugin **enables** in the community-plugins list on iOS and Android **without crashing**. (Regression guard: no file-scope `require("fs")` / `require("path")` in `main.js` — `grep -E '=require\("fs"\)|=require\("path"\)' main.js` must return zero.)
- [x] 📱 `styles.css` is applied (check both light and dark themes).
- [x] 🖥️📱 The same repo synced from both a desktop and a mobile vault stays consistent.

## 2. Sync — end-to-end flows (🌐 real GitHub)

- [x] 🖥️ **Bare-repo bootstrap:** the first sync into an empty repo creates the structure and the managed `.gitignore` files. (⚠️ There is no "snapshot manifest" since THE SWITCH — local state lives in `.runtime/` as the hot metadata pair + `file-baselines`, and none of it is pushed.)
- [x] 🖥️ **Adoption:** the first sync against a non-empty repo produces no duplicates or losses; conflicts are classified.
- [x] 🖥️ **Incremental:** edit a file → `[Sync]` → it commits and pushes; delete a file → the deletion reaches the remote.
- [x] 🖥️ **Deletions propagate:** delete a file and sync → it is removed on the remote; on a second device, pull removes it locally. (Formerly "pending deletions" — that store no longer exists; a deletion is an ordinary batch entry now. The behaviour is still worth a pass.)
- [x] 🖥️ **"Sync starts with commit" = off:** `[Sync]` only pulls/pushes; the `[Commit]` ribbon button (or the *Commit local changes* command) commits separately.
- [x] 🖥️ **Interval scheduler:** the periodic tick syncs automatically; an initial sync runs shortly after the vault opens.
- [x] 🖥️ **Ribbon & status bar:** sync/commit icons work; the conflict counter (🔀) updates; the status reads *Syncing… / idle / Last error*.
- [x] 🖥️ **Push-queue persistence:** start a sync, force-quit Obsidian mid-push, relaunch → the queue is drained to completion by the recovery sweep.
- [x] 🖥️ **Large vault** (1000+ files): syncing does not freeze the UI (heavy work runs off the main thread).

## 3. Mobile-specific (📱 — Capacitor is not unit-tested)

- [x] 📱 **Capacitor rename:** conflict resolution and atomic writes never fail with *"Destination file already exists"* (iOS/Android `rename` does not overwrite; the code must remove-then-rename).
- [x] 📱 **Capacitor rename of a DIRECTORY (new 2026-10-04):** every commit now creates its batch in `.runtime/push-queue-staging/<id>/` and moves it into `.runtime/push-queue/` with ONE `adapter.rename` of the folder — the first folder rename anywhere in the plugin. Commit a few times on the phone: each commit must land a batch under `push-queue/`, `push-queue-staging/` must be empty (or absent) afterwards, and the log must show no rename error. Obsidian's API documents `rename` for "a file or folder", but it was never exercised on Capacitor for a folder.
- [x] 📱🖥️ **WASM SHA-1 in the CPU worker (new 2026-10-05):** hashing of files ≥ 100 KB now runs `hash-wasm` inside the worker. Commit a vault with several large files (images, PDFs) on desktop AND on the phone: every file must commit and push with no error, and a second Commit right after must say "Nothing to commit" (a wrong SHA would show up as files that keep re-committing). If WebAssembly is blocked the worker silently falls back to `crypto.subtle` — same result, more memory.
- [x] 📱 **Binary files** (PNG, PDF) sync without corruption (binary read/write path, not the text path).
- [x] 📱🌐 **A big file just under GitHub's limit (new 2026-10-11).** A ~35 MiB binary syncs end-to-end
      phone → GitHub → desktop, and the desktop copy is byte-identical (compare SHA-1). The limit is
      **40 MiB, MEASURED** on the REST API (39.96 MiB → 201, 40 MiB → 422 "input was too large") —
      not the documented 100 MB. The log line `SHA-1 engine for files ≥ 100 KB {"engine": "wasm"}`
      at plugin start says which hasher ran (`crypto.subtle` = the silent fallback).
- [x] 📱🖥️ **A file over the limit (> 40 MB) never breaks the sync (new 2026-10-11).** Put a file of
      ~95 MB where `.gitignore` lets it through (e.g. the vault root):
      - **manual Commit**, **manual Sync**, and the **sync at plugin start** each show ONE pop-up per such
        file, ~8 s: *File "…" is too large for the repo (N MB, max 40 MB). Add it to .gitignore (Settings).*
        — every time, not once;
      - the **periodic** automatic sync skips it **silently** (interval on, "Sync starts with commit" on);
      - everything else still syncs; the file stays in the vault and never reaches the queue;
      - the pop-up stops by itself once the file is deleted, moved into a dot-folder or an ignored folder,
        or its name/extension is added to `.gitignore`;
      - the log has `file over GitHub's size limit — not synced` once per file per session (not per pass).
- [x] 📱 **No orphan workers after a plugin reload (new 2026-10-11).** Developer check via Chrome DevTools
      (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `http://localhost:9333/json`):
      the WebView's worker count right after a fresh Obsidian start stays the SAME after several plugin
      disable+enable cycles (measured: 7 → 7 → 7 → 7; before the fix +5 per reload, from a second pool
      `BatchWriter` built and nobody terminated).
- [x] 📱 **Token with trailing whitespace** (pasted from the keyboard suggestion bar) still works — input is trimmed and existing values self-heal on restart.
- [x] 📱 **Low-memory kill:** while editing or syncing, let the OS kill Obsidian → on relaunch the vault is consistent and the recovery sweep has run.
      Done 2026-10-10/11 by force-stopping Obsidian mid-sync: on the phone (twice during a first pull, once in an
      upload loop; the sweep reported `cleaned: 1`), and on two desktop vaults killed repeatedly during commits and
      pulls (the resume replayed the progress log — `lines: 4` — and fetched the rest). End state checked on the
      files themselves: the synced content of both vaults byte-identical, no 0-byte files, no `.ges-tmp`/`.ges-bak`
      leftovers, queues empty, no conflicts.
- [x] 📱 **Battery death** (let the device power off below 1% mid-sync) → on relaunch, no corruption, and no 0-byte files.
      Closed without a literal battery run (owner, 2026-10-11): on a phone whose battery cannot be pulled, hitting
      the milliseconds of an actual write is practically impossible, and the outcome a power cut can add over a
      process kill (unflushed OS writes) lands in the same two states the design already handles — a half-written
      staging file, or a rename that did not happen — both repaired by AtomicWriteRecovery at the next start.
      Covered by: the kill runs above, the atomic-write recovery unit suites, and the drain's "POWER LOSS"
      before/after-write tests. A precise kill-during-write on the phone is possible via DevTools (a breakpoint in
      `atomicWriteFile`, then force-stop) if it is ever needed.
- [x] 📱 **Touch:** ribbon, settings and the conflict list respond to taps as they do to clicks on desktop.

**Installing a build on a device (BRAT).** There is no public-store build, so use [BRAT](https://github.com/TfTHacker/obsidian42-brat): *Add Beta Plugin* → this repo's URL → BRAT pulls `main.js` + `manifest.json` from the latest release tag. To test an unreleased branch, push an `X.Y.Z-beta` tag (the `release.yml` workflow cuts the artifact BRAT can fetch). Then run the 📱 / 🖥️📱 items here plus sections 2, 4, 6, 7, 8 on the device. "Pass" means the desktop contract holds identically on mobile.

**Known platform limitations (behaviours, not plugin bugs — surface in the README so users know what to expect):**

- **Android background-throttled timer.** Backgrounding Obsidian suspends the JS runtime within seconds; `Window.setInterval` stops firing, and a dozing phone also cuts the app's network. The interval / watchdog tick resumes on foreground; a sync interrupted mid-flight resumes on the next one from what is on disk — the queued batch, the drain journal, the per-file progress log (`.runtime/vault-step-progress.jsonl`) and the record of already-uploaded blobs (field-verified 2026-10-11: kills on both desktops and a phone — the Low-memory kill / Battery death items above).
- **Android — no file watcher for external deletions.** Files removed via Android's Files app (not Obsidian) don't fire `vault.on("delete")`, so the conflict counter can lag mid-session. The conflict reconcile that runs at plugin start, at every drain start, and when the panel opens catches it. The same holds for files pushed in over adb: Obsidian indexes them only after a restart.
- **Android Storage Access Framework.** Vaults under `/Android/data/md.obsidian/` work; arbitrary external paths may need user-granted access on each launch.
- **Files of 40 MB and more never sync** — GitHub's REST API refuses a blob of 40 MiB (measured 2026-10-11; the documented 100 MB is not the real limit). The commit keeps such files out (`MAX_SYNC_FILE_BYTES` = 40 000 000) and says so: a notice per file on a manual Commit/Sync and on the startup sync, silence on the periodic sync, one log WARN per session. Below the limit, size is no longer a memory problem: base64 uses the WebView's native `Uint8Array.toBase64` (100 MB in 0.06 s on a Pixel 6 Pro; Obsidian's own encoder failed above 128 MiB), and a crash or Cancel mid-upload resumes without re-sending blobs that already reached GitHub.
- **iOS background suspension** is more aggressive than Android (~30 s typical). iOS fires `delete` reliably for in-Obsidian operations; external Files.app operations are inconsistent.

## 4. Conflict resolution / pseudo-merge — end-to-end (🌐)

- [x] 🖥️📱 Two devices edit the same file → a conflict sibling `*.conflict-from-<device>-<timestamp>.*` is created.
- [x] 🖥️ The conflict counter (🔀) in the status bar updates as siblings appear and clear.
- [x] 🖥️ **File tree click while our tab is active (new 2026-10-10).** Open a note in a tab, then make
      the Diff Panel (or a History / conflict editor / log viewer tab) active, and click that note in
      the file tree: the tab that already shows it comes to the front. A note open nowhere opens as
      usual; Ctrl/Cmd+click still opens a new tab; with an ordinary tab active nothing changes.
- [x] 🖥️ **Files in conflict, everywhere (new 2026-10-09).** One file with TWO conflict copies: the
      diff badge says 1, its tooltip "(1 file in conflict)", the pre-sync window "1 file…", "Sync
      done … 1 in conflict". In the Diff Panel that file's name is RED (light AND dark theme) and
      listed first; its tracked copies come first under it, then synthetic ones, each newest first;
      a file with only synthetic copies is listed after the red ones in the normal colour.
- [x] 🖥️ **Auto-merge:** non-overlapping edits merge cleanly (3-way); overlapping edits produce a sibling.
- [x] 🖥️ **One Sync at a time (new 2026-10-09).** Double-click Sync (or click + hotkey): only ONE
      sync runs; a second click (commit part or drain) shows the Cancel/Keep window. [Cancel sync]
      during the COMMIT part: the commit finishes, nothing is pulled/pushed, the box says "Sync
      canceled"; during the drain: the drain stops. "Pull from repo and push stored commits" during a Sync
      does nothing (log line). A standalone Commit during a Sync is NOT refused.
- [x] 🖥️ **Edit while in conflict:** editing the base file while a sibling exists does not lose the edit.
- [x] 🖥️ **A newer server version REPLACES the conflict copy (new 2026-10-09).** Device A and B both
      change the same line → B gets a conflict copy. Leave it unresolved; A changes that line AGAIN and
      syncs; B changes its file again and syncs: B still has ONE conflict copy, now with A's newest
      value (the old copy is gone), and the log says "Conflict copy updated to the newer server
      version". Edit a DIFFERENT line inside B's conflict copy first → the edit survives the update.
      Edit the SAME line inside the copy first → a second copy appears instead, and the log has a
      WARN "…a second conflict copy is added".
      If the OLD copy was open in an editor tab (or had unsaved editor work), that tab closes during
      the sync and its autosave is gone (no "resume" offer for it later).
      With the Diff Panel OPEN during that second sync: its row switches to the new copy's name
      by itself (the count stayed 1), and clicking it opens the editor on the new copy.
- [x] 🖥️ The pre-sync conflict dialog shows the count and lets you confirm.
- [x] 🖥️ When a sibling is reconciled to match the base (identical content), the sibling is cleared on the next sync.
      (Fixed 2026-10-11, `9f134fa`: the copy's bytes on disk decide — editing the copy by hand until it
      matches the base closes the conflict; the old code compared the copy as it first arrived.)
- [x] 🖥️ **Copy renamed onto the base (new 2026-10-11).** With the copy's diff-editor tab open (and some
      unsaved edits in it), delete the base and rename the copy onto it in the file tree. The editor tab
      closes by itself; the base holds the copy's content (NOT the editor's half-done merge); no
      "Saved files changed" window. Same if `[←]` is pressed before the tab closes.
- [x] 🖥️ **Copy deleted while its editor has unsaved edits (new 2026-10-11).** Make a few resolutions in
      the diff editor without `[←]`, then delete the copy from the file tree: the tab closes silently, no
      notice, the base is untouched, and the Diff Panel comes to the front without the conflict (2026-10-18:
      the editor was the tab you worked in, even though the file tree was the active pane).
- [x] 🖥️ **Two conflict copies made identical (new 2026-10-11).** One note with TWO copies (from two
      devices or two rounds). Edit the copies until both hold the same text → after the next Sync (or on
      opening the Diff Panel) only the NEWER copy (later time in its name) remains. Then the guard: two
      copies that arrived IDENTICAL — edit only the OLDER one → both copies stay, your edit intact.
- [x] 🖥️ **A conflict in a dot-folder — its tab closes when you turn to it (new 2026-10-11).** Use a
      synced dot-folder OUTSIDE the config folder (e.g. `.test/`; Obsidian sends no file-tree events
      there). NOT a settings file in `.obsidian/`: there — at any depth — a collision is resolved
      automatically and no conflict copy is made. (Exception since 2026-10-24: `.obsidian/.gitignore` and a
      plugin's `.gitignore` DO conflict like ordinary files, and such a conflict pauses Sync.) Open the diff
      editor of the conflict,
      resolve it outside the editor (delete or rename the copy from a terminal / file manager), switch
      to another tab and back: the editor tab closes without a window and the Diff Panel shows.
- [x] 🖥️ **Multi-device rotation:** run a realistic round-trip across 2+ devices.

## 5. Diff-editor widget

> The editor **model** is fully unit-tested (`tests/diff2/`). This section covers
> what needs real layout/geometry and the end-to-end user experience.

**Layout / geometry (Playwright or a real device):**

- [x] **Wrapping:** a 200-character line in a narrow editor (~30 columns) wraps; the `↵` glyph appears **only** at real newlines, and wrapped continuation rows have an empty gutter (one line number for the whole logical line).
- [x] **Vertical arrows** within a wrapped long line move row by row (they do not jump over the line).
- [x] **Page Up / Page Down** over large change blocks (10+ lines) scroll and position the caret correctly.
- [x] **Ctrl/Cmd-Home / Ctrl/Cmd-End** jump to the first/last line — verify the case where the first line is a **hidden empty "local" block** and the last is a **hidden empty "remote" block** (they reveal/activate correctly).
- [x] **Home / End** on a wrapped line behave sensibly (visual vs logical line start/end).
- [x] **Entering an empty change block:** pressing Down from a normal line above an empty block reveals a temporary blank line; pressing Down again without typing collapses it and moves on. Up from below is the mirror.
- [x] **Markers:** the `<<<<<` / `=====` / `>>>>>` rows render as block widgets; the action buttons are clickable; the device label shows on the top/bottom markers.
- [x] **Button labels (TODO §6.3/§6.4):** top (ours) = `[Keep ↓] [Remove ↓]`; middle = `[Apply Both ↓↑] [Remove Both ↓↑] [Join (<remote>)]`; bottom (theirs) = `[Apply ↑] [Remove ↑]` — all Capitalized, Join label in parens.
- [x] **Focus on open (TODO §6.1):** opening a conflict shows the blinking caret immediately and Ctrl/Cmd+Z works WITHOUT clicking into the text first.
- [x] **Cursor restore (TODO §6.2):** edit deep in a long conflict, force-quit, reopen → the editor scrolls to roughly where you left off (caret visible, focused).
- [x] **Gutter glyphs + colour (TODO §6.5/§6.7):** ours lines show `−` and a red-tinted gutter cell; theirs lines show `+` and a green-tinted cell; wrapped continuation rows keep the colour (no repeated number/glyph). The gutter band also covers the `<<<<<` / `=====` / `>>>>>` marker rows.
- [x] **`↵` only in ver-blocks (TODO §6.8):** the `↵` newline glyph appears ONLY inside ver1/ver2 lines (red/green), NOT on normal/common lines.
- [x] **Separator colour (TODO §6.6):** the `=====` row is split top-red / bottom-green (not a blank white strip).
- [x] **Light AND dark themes:** switch Obsidian theme — the ours/theirs backgrounds, gutter, and numbers stay readable in both (light: light bg + dark numbers; dark: dark bg + bright numbers).
- [x] **Colours:** the local side is red, the remote side green, and intra-line word differences get a yellow overlay (blending to orange / olive).
- [x] **No-trailing-newline edge:** a whole-file single-line difference (e.g. local `"abc"` vs remote `"XYZ"`) renders without errors and without a marker landing mid-line.

**End-to-end UX:**

- [x] Opening the editor from each entry point (file menu *Resolve conflict*, the diff ribbon icon, the post-sync summary modal).
- [x] Resolving via the buttons and via the hotkeys (`Ctrl+Enter` / `Ctrl+Backspace` / `Ctrl+Shift+Enter` / `Ctrl+Shift+Backspace` / `Ctrl+Shift+.`).
- [x] **Undo/redo after a BUTTON action (TODO §4):** click a marker `[apply]`/`[remove]`/… or a toolbar `[Keep all local]` / `[Apply all remote]` / `[Join all changes]`, then press **Ctrl/Cmd+Z** — it must undo the action (and Ctrl/Cmd+Shift+Z redo it). Previously a button click stole focus and Ctrl+Z did nothing.
- [x] **Undo shrinks the recovery log (TODO §5):** make 3 changes, press Ctrl/Cmd+Z twice, then force-quit Obsidian, and reopen the conflict → the recovery replays **only the 1 surviving change** (not all 3). Make N changes then N undos → reopening offers a *fresh* session (the log is empty, nothing to resume). This needs a force-quit (the log is discarded on a clean `[← back]`).
- [x] **`[← Back]`** writes the resolved file, removes a now-redundant sibling, and returns to the list.
- [x] **⚠️ Open editor survives `[← Back]` (bug3):** open the conflict's base file (e.g. `test.md`) in a NORMAL markdown tab FIRST, then resolve that conflict in the diff-editor, and press `[← Back]`. The markdown tab must STAY OPEN (not close/reopen), and its cursor + scroll position should be preserved (the write goes through `modifyBinary` in place, not a rename swap). Try with the sibling open too.
- [x] **⚠️ Resolve via BUTTONS ONLY (no typing)** — click *Keep all local* / per-chunk `[apply]`, then `[← Back]`: the inputs **are written** (Notice "Saved…", redundant sibling cleaned if converged). They must NOT be silently discarded. *(This is the data-loss-critical seam: a button resolve must count as a recorded edit — §4.1.a `recordCount > 0`.)*
- [x] **`[×]`** (tab close) **with edits** keeps the session for recovery; **with zero edits** silently discards it. The vault is left as it was before editing in both cases.
- [x] **One editor at a time:** clicking another conflict during an active edit shows a *"close the current edit first"* notice instead of losing work.
- [x] **Select all + delete** then `[← Back]` saves a single newline (not a 0-byte file). Tester: Now the modal window is shown: "File is empty: You emptied <filename>. Delete the file, or keep it as an empty file? [Delete] [Keep empty] [Cancel]"
- [x] **Standard editing commands** (delete line, delete word, Home/End, Page Up/Down) behave normally and never corrupt the merged view. (Note: *delete to end of line* / Ctrl+K is not bound yet — verify if/when added.)

**Autosave & recovery:**

- [x] **Zero-edit invariant (§4.1.a):** open a conflict, change **nothing**, leave (via `[← Back]`, a sub-tab switch, 
      or closing the view). Reopening the SAME conflict must NOT show a *"Resume previous edit session · 0 edits saved"* 
      dialog — it opens fresh. (The `.diff2-autosave/<id>/` dir is wiped on the zero-edit exit; a crash-survivor empty 
      dir is swept on the next plugin load.)
- [x] **No spurious re-mount:** while editing a conflict, trigger a background sync that adds/removes another conflict → 
      the editor you're in keeps its state (it does NOT re-mount or pop a resume dialog mid-edit).
- [x] **Edit, then force-quit Obsidian** → on relaunch the restored diff-editor tab resumes the in-progress state 
      **silently** (no dialog), caret roughly where it was; Undo steps back through the edits. **Edit, then close the 
      tab (×) and reopen the same conflict from the Diff Panel** → the recovery dialog offers *Continue editing* 
      (same restored state) / *Start over*. (Owner, 2026-10-20: a restored tab resumes silently, a reopen by the user 
      asks.)
- [x] *Start over* discards the session and starts fresh from the current files.
- [x] **Files changed under a saved session:** edit in the diff editor, close the tab (×), change the base or the 
      copy on disk (a sync pulls new content, or edit it), then reopen the conflict from the Diff Panel → the resume 
      dialog lists *base* / *sibling* with a **red `*`** before each file that changed and a **red footnote** 
      "* this file changed in the vault since the last editing session!"; buttons *Continue editing* / *Start over* / 
      *Cancel*.
- [x] **Files changed while the editor is open (new 2026-10-18):** open a conflict, then change the base or the copy
      outside the editor (another program, or a Sync pulling a new version). Checked only while the editor has the
      focus — the tab is active AND Obsidian's window has the OS focus: on returning to the tab or to Obsidian, on
      Ctrl/Cmd+R, and on a file event while focused. **With your edits** → the window "Files changed outside the
      editor": *Reload and start over* (your edits gone, the editor shows the files as they are now; a deleted base
      = an empty left side) / *Continue* (nothing changes; asked again only when the disk changes again). **Without
      edits** → no window, the editor quietly shows the new version — at once, even in the background. While you work
      in another program nothing pops up in Obsidian.
- [x] **`[← Back]` when the files changed since the session started:** reach it either by answering *Continue* above,
      or with a conflict in a dot-folder (e.g. `.test/`, no file events there) where a Sync pulls a new version while
      you stay in the editor. Then `[← Back]`: **one file changed** → no window; only the UNCHANGED file gets your
      result, the changed one keeps its new content, the conflict stays in the Diff Panel. **Both changed** → the
      window "Saved files changed — keep your resolution?": *Save* under another name (a new conflict to resolve
      later) / *Discard* / *Cancel* (stay in the editor).

## 5b. Managed `.gitignore` — the dot-space rules (🖥️📱🌐 · DOT-FILES)

> Nothing automated can check these end to end: the point is what a SECOND device
> does with a block the first one wrote, and the whole mechanism exists to stop two
> plugin versions fighting over it.

- [x] **The blocks appear and carry a version** (format since 2026-10-24). (`<configDir>` = `.obsidian` unless renamed.)
      After a **Sync**, in `<vault>/.gitignore` AND `<configDir>/.gitignore`: a block at the top and one at the bottom,
      each opening with a CONSTANT line and the version right under it:
      `# ===== git-easy-sync invariants - DO NOT EDIT =====` / `# ===== plugin version: X =====` (the `=====` aligned),
      and the same for `final`. `<configDir>/plugins/git-easy-sync/.gitignore` starts with
      `# ===== git-easy-sync vX - managed file, DO NOT EDIT =====`. X = the installed build's version.
      *(Field 2026-10-24: seen on three vaults through 2.0.3 → 2.0.7-beta.)*
- [x] **The version comes from the BUILD, not from the file on disk.** In `<configDir>/plugins/git-easy-sync/manifest.json`
      change `"version"` to `"9.9.9"`, press **Sync** → the version lines still show the build's version. Put the old
      value back afterwards. (`<configDir>/plugins/.gitignore` is the unversioned "Sync plugins data.json" switch.)
      *(Field 2026-10-24: `"version": "9.9.9-beta"` in the installed manifest on three vaults — the version lines
      stayed `2.0.7-beta`. A slip into `minAppVersion` instead froze our own plugin on one vault — fixed in
      5649928: a hold now lifts once the repo's CURRENT manifest no longer needs a newer Obsidian.)*
- [x] **⚠️ Two devices, two versions — the ping-pong guard.** An OLDER build never rewrites blocks a NEWER build
      wrote: its log has `gitignore section anomaly` / `yielded-to-newer`, the file keeps the newer version lines, and a
      second Sync makes NO `.gitignore` commit. *(Field 2026-10-24: verified with REAL builds — T3 below, and again
      2.0.4/2.0.5/2.0.6. On one device it can still be simulated by changing `plugin version:` lines to `9.9.9`.)*
#### Three vaults, one repo — the version bump to `2.0.3-beta` and the two-block `<configDir>/.gitignore` (new 2026-10-24)

Vaults (all connected to repo `obsidian8`):
**A** = `~/Obsidian-test` — the NEW build (`pnpm dev` puts it there), **Sync configs ON**;
**B** = `~/obsidian-test2` — the OLD build `2.0.2-beta`, **Sync configs OFF**;
**C** = Android `/sdcard/Documents/Obsidian-test/` — the OLD build `2.0.2-beta`, **Sync configs OFF**.
With Sync configs OFF, B and C do not receive the new `main.js` (the whole `.obsidian/` is cut off, our plugin
folder included) — that is what keeps them "old". Each vault's log: `<vault>/git-easy-sync.log` (phone:
`adb pull /sdcard/Documents/Obsidian-test/git-easy-sync.log`). **Keep the order T0 → T7.**
If `.gitignore` commits keep coming, a conflict copy appears, or a line is lost: stop and collect all three logs.

- [x] **T0. Preparation.** A shows `2.0.3-beta` in Settings → Community plugins; B and C show `2.0.2-beta`.
      In B and C turn **Sync configs OFF** and press **Sync** → on GitHub nothing under `.obsidian/` changes (no
      deletions, no new files). Then, in **C only**, add the line `*.phone-test` to the user zone (between the two
      blocks) of `<vault>/.gitignore` — and do **NOT** sync C yet (it is used in T4).
- [x] **T0b. What the Sync configs switch changes in `.obsidian/` (watch it in B and C when you turn it OFF in
      T0, and again when you turn it ON in T7).** Before flipping, copy the folder aside
      (`cp -R .obsidian /tmp/obsidian-before`), flip, press **Sync**, then `diff -r /tmp/obsidian-before .obsidian`.
      Expected — and NOTHING else in `.obsidian/` changes, nothing is deleted locally or on GitHub:
      - `.obsidian/.gitignore`: only the bottom `final` block changes — **OFF**: `/.gitignore` and `*`;
        **ON**: the `!/.gitignore`, `!/plugins/*/.gitignore` and per-device lines (`workspace.json`, …). The top
        allowlist block and your own lines between the blocks stay as they are.
      - `.obsidian/plugins/git-easy-sync/.gitignore`: **OFF** adds a `final` block at the end with
        `# syncConfigDir is OFF on this device (git-easy-sync…)` and `*`; **ON** removes it.
      - another plugin's folder that HAS its own `.gitignore`: **OFF** appends the same two lines (that comment +
        `*`) at the very end; **ON** removes exactly those two lines. A plugin folder WITHOUT a `.gitignore` gets
        none (nothing is created).
      - `.obsidian/plugins/.gitignore` (the per-device "Sync plugins data.json" switch): turning Sync configs OFF
        also turns that switch OFF (greyed out); turning Sync configs back ON does NOT turn it back on.
      - `<vault>/.gitignore`: unchanged (`!/.obsidian/` there does not depend on the switch).
      *(Field 2026-10-25/26, B: OFF then ON, each followed by Sync, `diff -r` against snapshots — OFF changed exactly
      the three files above (the foreign one got a blank line + comment + `*`), ON brought all four back byte for
      byte to the first snapshot; "Sync plugins data.json" stayed off; no commit, nothing deleted on GitHub. Since
      1623793/6ce709e the plugin's own file is two plain constants (OFF = header, one comment, `*`, no markers) and
      the comment in a foreign file carries no version.)*
      While OFF, Sync neither sends nor receives anything under `.obsidian/` (the GitHub copies stay as they were).
      *(Field 2026-10-24: the ON direction verified on B and on the phone — exactly these files changed, the
      data.json switch stayed off. The OFF direction was NOT observed: both were already OFF. Still to do.)*
- [x] **T1. The new build's first Sync (A).** Press **Sync** in A → exactly ONE commit with the three `.gitignore`
      files (`<vault>/.gitignore`, `.obsidian/.gitignore`, `.obsidian/plugins/git-easy-sync/.gitignore`, all now
      `v2.0.3-beta`) plus the new `main.js` / `manifest.json`. A's `.obsidian/.gitignore`: the allowlist block on top,
      `final` at the bottom.
- [x] **T2. An old-style `.obsidian/.gitignore` moves to the new layout (A).** Paste into A's `.obsidian/.gitignore`
      the OLD content (`# Recommended defaults…` + the five `plugins/*/…` lines + a `final v2.0.2-beta` block), add
      your own line `*.mytest`, and an exact copy of the line
      `# Write your own rules BELOW this block to override it.` somewhere in your zone. Press **Sync** →
      the five rules are inside the top block, the old comments are still there, `*.mytest` sits between the blocks,
      the copied comment line exists only ONCE (inside the block), the markers say `v2.0.3-beta`; one commit.
      *(Field: done on A's real old file; the "exact copy of our comment line" step was not tried — unit-tested.)*
- [x] **T3. The old build yields to the newer one (B, desktop).** Press **Sync** in B → B downloads
      `<vault>/.gitignore` with `v2.0.3-beta`, and sends nothing. **Sync** B again — the `.gitignore` check runs at
      the START of a Sync (before the download), so only now does the old build meet the newer marker → B's log has
      `gitignore section anomaly` with `yielded-to-newer` and `"version":"2.0.3-beta"` for `.gitignore`; the file
      keeps `v2.0.3-beta`; NO commit from B touches a `.gitignore`.
- [x] **T4. A clean merge of `<vault>/.gitignore` on an old, yielding build (C, phone).** ⚠️ The ROOT file —
      `/sdcard/Documents/Obsidian-test/.gitignore` — NOT `.obsidian/.gitignore` (that one is local while Sync
      configs is OFF and takes no part; field 2026-10-24: the line landed there by mistake and T4 tested nothing).
      1. **C:** add `*.phone-test` at the very BOTTOM of the user zone of the ROOT file (right above
         `# ===== git-easy-sync final …`). Do NOT sync C.
      2. **A:** add `*.desk-test` at the very TOP of the user zone of A's ROOT file (right under
         `# ===== end of git-easy-sync invariants =====`). **Sync** A.
      3. **Sync** C → C's file has BOTH lines; NO `.gitignore.conflict-from-*` anywhere; C sends ONE commit; C's log
         has `yielded-to-newer` (it does not rewrite the newer blocks).
      4. **Sync** A, then B → both lines everywhere, no further `.gitignore` commits.
      (The two lines are far apart on purpose, so the line merge does not see them as one region.)
      *(Field: first runs made a conflict copy — the version was inside BEGIN, adjacent to the user's line; fixed by
      the two-line marker format (1e220db); re-run with 2.0.4: clean. Two DIFFERENT rules inserted at the SAME spot
      stay a conflict — owner's decision.)*
- [x] **T5. An edit INSIDE our block on an old build converges in one round (C → A).** In C add a line INSIDE the
      `invariants` block of `<vault>/.gitignore`, press **Sync** in C → C (old, yielding) does not repair it, the line
      goes to GitHub. **Sync** A → A repairs the block (the line is gone), one commit. **Sync** C → C gets the clean
      file, no commit from C. No back-and-forth. *(Field: done with B instead of C; A repaired on its SECOND Sync.)*
- [x] **T6. (Optional) A brand-new vault meets the repo.** Make an empty folder (e.g. `~/obsidian-test3`), copy A's
      `.obsidian/plugins/git-easy-sync/` into it, set the same repo and token, Sync configs ON, first **Sync** →
      its `.obsidian/.gitignore` equals the repo's, no conflict copy, at most one `.gitignore` commit.
      *(Field: ~/obsidian-test3 — passed; the only conflict was Obsidian's own default `Welcome.md`, expected.)*
- [x] **T7. The old devices move to the new build (B, then C).** In B turn **Sync configs ON**, press **Sync** → B
      downloads the new `main.js` and the plugin reloads itself to `2.0.3-beta`. ⚠️ Not certain how many commits:
      before the reload the old build may first send its own old-style `.obsidian/.gitignore` (files in `.obsidian/`
      resolve by the newer modification time), so one or two extra `.gitignore` commits are possible. What MUST
      hold: within two Syncs everything settles — the file is the same in all vaults, `v2.0.3-beta`, no conflict
      copies, and no further commits. Repeat on C (the phone) — this also checks the self-update on mobile.
      ⚠️ **Watch whose `.obsidian/.gitignore` survives.** Files under `.obsidian/` are NOT merged line by line: the
      file with the newer modification time wins WHOLE. Turning the switch ON rewrites the device's file, so it is
      probably the newer one. Expected risk, to be observed and written down: either A's own lines
      (`!plugins/*/mynewfiles.txt`, `*.ab`) or C's `*.phone-test` (it sits in C's `.obsidian/.gitignore`) disappear.
      Record which. This is the long-standing "newest wins in `.obsidian/`" rule, not this change — but for a
      `.gitignore` it means user rules can vanish silently; the owner decides afterwards whether
      `.obsidian/.gitignore` should be merged like the root file.
      *(Field: self-update fine on B and the phone. The repo's file won on the phone and `*.phone-test` vanished
      silently → owner's decision: `.gitignore` files under `.obsidian/` now merge like ordinary files (616d2c4) —
      see the item below.)*
- [x] **Our blocks are ours; your rules go BETWEEN them.** A line added INSIDE either block is removed on the next
      Sync (the block is rewritten); a rule written between the blocks stays. *(Field: T5.)*
- [x] **`final` is absolute.** Between the blocks of `.obsidian/.gitignore` write `!workspace.json`, **Sync** →
      `workspace.json` still does NOT go to GitHub. Between the blocks of `<vault>/.gitignore` write
      `!*.conflict-from-*` → conflict copies still never travel. *(Field 2026-10-24: `!workspace.json` between the
      blocks and `!workspace*.json` written AFTER `final` — the plugin moved that line up above the block (WARN
      "Managed .gitignore written by the plugin"), `workspace.json` never reached GitHub; the conflict copies in B's
      `.test/` never travelled either. The root `!*.conflict-from-*` line itself was not tried.)*
- [x] **`.obsidian/.gitignore` and a plugin's `.gitignore` conflict like ordinary files (new 2026-10-24).** Two vaults
      add DIFFERENT rules at the same spot of `.obsidian/.gitignore` → a conflict copy
      `.obsidian/.gitignore.conflict-from-…`, every Sync shows "Sync paused — .gitignore is in conflict" until it is
      resolved; the diff editor shows ONLY the rule lines — never our `plugin version` lines, even when the two vaults
      run different versions (161d98e). Rules at DIFFERENT spots merge cleanly. *(Field: three desktop vaults,
      2.0.5–2.0.7-beta.)*
- [ ] **A difference only in version lines is never a conflict (new 2026-10-24).** A vault on an OLDER build with
      Sync configs OFF, whose `.obsidian/.gitignore` rules are identical to the repo's, switches Sync configs ON →
      no conflict copy; the newer version lines are taken (1c29476). *(Unit-tested.)* ⏳ **Run it at the NEXT REAL
      version bump** (e.g. `2.0.8-beta`): A on the new build pushes; B still on the old build with Sync configs OFF
      switches it ON. ⚠️ It CANNOT be simulated by writing a higher version into B's own file (tried 2026-10-25,
      `9.9.9` in the repo, `9.9.8` on B): a file whose version lines are NEWER than the build makes the plugin keep its
      hands off the blocks (`yielded-to-newer`), so B's `final` block was never switched to the ON rules — the guard
      for real version skew, not the case under test. A real older build never has a newer version in its own file.
- [x] **A plugin's own `.gitignore` conflicts too.** Edit `.obsidian/plugins/<some plugin>/.gitignore` differently on
      two vaults (Sync configs ON on both) → a conflict copy next to it, Sync paused, the resolution syncs.
      *(Field 2026-10-24, `github-gitless-sync`: B pushed `*.b-plugin-rule`, A's `*.a-plugin-rule` got the copy
      (WARN "the server's version is saved as a conflict copy"); Sync stayed blocked while it was unresolved; the
      both-lines resolution reached B.)*
- [x] **Per-device `data.json` switch.** `<configDir>/plugins/.gitignore` is the
      per-device control; toggling the setting changes what it holds, and the file is
      NOT the same on both devices (that is the feature, not drift). *(Field 2026-10-24: B switched ON →
      `!*/data.json`, the phone stayed `*/data.json`; the file never travels.)*
- [x] **Nested-gitignore migration (§8.1).** Settings → `.gitignore` → **Check now** (or the first run): every
      `.gitignore` outside the root that git would READ is renamed to `.bak`, its rules are offered as a proposal to
      the root `.gitignore` (`.gitignore.conflict-from-Old gitignore files-…`, a `# rules from <dir>/.gitignore`
      comment per group); a `.gitignore` in a folder already excluded above (shadowed) is left alone; Sync is
      refused until the proposal is resolved; after it, the first sync makes its own commit `Remove N nested
      .gitignore file(s) consolidated into the root …` deleting them from GitHub. *(Field 2026-10-25, A:
      `nested-test/.gitignore` (+ on GitHub) and a shadowed `nested-test/old/.gitignore` — the shadowed one was
      skipped, the sync was blocked, `add9bd3` removed the nested file from GitHub. Note: once the first proposal's
      rules were dropped from the root, the shadow was gone and a second Check now correctly collected
      `old/.gitignore` — the check always works on the rules in force at that moment.)*
- [x] 🌐 **One release = one `.gitignore` commit.** The first sync after a version bump
      rewrites three files and produces exactly ONE commit. Expected, not a defect. *(Field: 76b6069 (2.0.3), 0401b17
      (2.0.4) — the version lines only, plus main.js/manifest.json.)*
- [x] **Root `.gitignore` editor (GITIGNORE-EDITOR, new 2026-10-08)** *(Field 2026-10-25: owner checked it —
      works; Esc / focus return to Settings since 4021c36.)* — Settings → `.gitignore`
      → *Edit the root .gitignore*:
      - **[Open]** shows the warning EVERY time: "Edit .gitignore?", two short sentences,
        [Cancel] / [I know .gitignore rules] (red); 📱 it fits a small screen even with a
        large font; the ".gitignore rules" link opens git's docs in the browser; [Cancel]
        (or Esc) opens nothing;
      - after the confirm: 🖥️ the editor opens in its OWN window above Settings; 📱 a
        full-screen modal above Settings; the [Cancel]/[Save] row is always visible, long
        lines scroll sideways (no wrap);
      - with the editor open, **[Open]** again brings it to the front WITHOUT the warning
        (🖥️ also when its window is behind another app or minimized; and when its tab was
        dragged into the main window — Settings close);
      - **[Cancel]** / closing the window: nothing written (the file's mtime unchanged);
      - **[Save]** without a change: nothing written; with a change: "Root .gitignore saved.",
        the editor closes, the next Sync sends the change;
      - change the file on ANOTHER device, Sync here while the editor is open with your edit,
        then **[Save]**: refused with "changed on disk…", your text still in the editor;
      - **[History]** closes Settings and shows the History list of `.gitignore`; opening a
        version works; a row whose commit DELETED the file (e.g. "Delete .gitignore" made on
        github.com) opens like a deleted file in a conflict — an EMPTY side against the current
        file, no error; after that its row shows a small trash icon after the device name,
        whose hint reads "Deleted in this version"; take the EMPTY (deleted) side whole and save:
        the notice says "Deleted .gitignore", and the plugin re-creates the file AT ONCE as in a
        new vault — the recommended defaults included; the old content is in the Deleted bin.
        The same with an ordinary note: saving the deleted side whole DELETES the note (it is in
        the Deleted bin); erasing a non-deleted version's text instead leaves an empty note;
      - **History follows Sync** (any Sync file → its open History tab): edit a note whose
        History is open, Sync — the new row appears at once, no "Loading…" flash, the list
        keeps its scroll and selected row, and typing in another note is NOT interrupted (the
        cursor stays there, also on an interval/background sync);
        the log has a WARN line for it.

## 5c. Plugin updates across Obsidian versions (📱🖥️🌐 · PLUGIN-UPDATE-COMPAT)

> **Needs two devices on DIFFERENT Obsidian versions.** There is a scripted fixture for
> most of it — `tests/fixtures/reload-probe/README.md`, runs 1-5 — use it rather than
> improvising, and record which run you did.

- [ ] **Фаза 1, the gate:** an incoming plugin whose `manifest.json` demands a newer
      Obsidian than this one is NOT reloaded — the log says `reload skipped … needs
      Obsidian <v>` and the running plugin **keeps working**. (Fixture run 2.)
- [ ] **Фаза 1, the honest report:** a plugin that genuinely fails to load after an
      update produces `reload FAILED` plus a Notice naming it and asking for a restart —
      never a silent "updated" toast. (Fixture run 1.)
- [ ] **⚠️ Фаза 2, the hold:** an update meant for a newer Obsidian must **never reach
      the disk**. The log says `plugin update HELD for this Obsidian`, `main.js` on disk
      is unchanged, the plugin keeps running, and **the repo is untouched by this
      device**. (Fixture run 3.)
- [ ] **Фаза 2, symmetry:** while a hold is on, editing that plugin's files locally does
      NOT push them — the log says `batch entry skipped: plugin update held`. Letting an
      older copy travel would roll the update back on every healthy device. (Run 4.)
- [ ] **Фаза 2, the lift:** when the condition clears, the files land, the baselines are
      restored, and **the next sync is quiet** — no commit, no re-download. A commit here
      means the baselines were not restored. (Run 5.)
- [ ] **§28 — plugin collisions are decided by SEMVER, not mtime.** Two devices update
      the same third-party plugin: the HIGHER `manifest.json` version wins regardless of
      which was written later.
- [ ] 📱 **`isDesktopOnly` on a phone — the ONE Фаза 1 branch never run on real
      hardware.** A plugin that is RUNNING on mobile because an older version had no
      such flag sits in `enabledPlugins`, so the "skip disabled" filter never fires and
      a reload would kill it. Our gate is supposed to skip it instead. Recorded as
      outstanding in BUILDLOG; it had no checklist line until 2026-10-03.
- [ ] **Self-update writes through the bootloader.** Updating THIS plugin stages the new
      bytes beside the live `main.js` and applies them at the next load — the file
      Obsidian is running is never overwritten underneath it. Verify on mobile too
      (Capacitor refuses a rename onto an existing file).

## 5d. Sync progress, cancel, and what the engine tells you (🖥️📱)

- [ ] **Progress notice (§II.16):** a long sync shows progress that actually moves, and
      the counts do not jump backwards on a retry.
- [ ] **Commit lines by forecast (COMMIT-PASS-PERF §3.1, new 2026-10-05) — no timers.**
      Each line appears at the START of its phase and only if the phase is forecast over
      ~1.5 s (statistics in `.runtime/commit-stats.json`):
      - no statistics yet — the first commit after a RESET, **and the first commit after
        installing this build** — shows **"Checking all files…"** at once; it turns into
        **"Checking N of M files"** only for a big commit (more than 500 files, or more
        than 100 MB), otherwise it stays until the result;
      - …except in a practically EMPTY vault (fewer than 50 visible files — e.g. a fresh
        vault pulling a repo for the first time): no "Checking all files…" at all, not even
        a blink; the first thing shown is the drain's progress if the sync takes > 2 s;
      - a commit with nothing to do on a vault with statistics shows **no line**, then
        "Nothing to commit";
      - the self-heal pass after a large pull shows "Checking N of M files" and ends with
        "Nothing to commit" (measured 2026-10-05: the forecast runs ~1.7× low on read and write,
        which is why the threshold is 1.5 s, not 2 s);
      - "Committing…" appears only when listing dot-space files is forecast over 1.5 s;
      - a single-file commit shows no line; inside a Sync there is no "Committed L files".
- [ ] **"Pulling / Pushing N of M" (new 2026-10-05).** The progress lines say **Pulling** and
      **Pushing**, never "Downloading" / "Uploading". The counters advance when the drain
      TAKES a file, so a file identical on both sides is counted too — on a first pull into
      an almost-empty vault "Pushing 18 of 18" is expected even if only one file changes.
- [ ] 🌐 **"Sync done — N sent, M received" counts REAL changes (new 2026-10-05).** On a fresh
      device whose few local files are already on the server, the summary says **"1 sent"**
      (or "0") — not the number of files queued. Check against the repo: `sent` = files the
      sync's commit actually changed on GitHub, `received` = files actually written to or
      removed from the vault. An auto-merged file counts in both; a conflict counts in
      neither (it has its own clause, which shows ALL tracked conflicts). Deletions count.
- [ ] **Split mode: "Commit" then "Sync" (new 2026-10-06).** With commit and sync separated,
      press **Commit**, wait a few seconds, then **Sync** on a quiet vault: only "Sync done"
      appears — no "Syncing with GitHub" flash first (same as pressing Sync twice).
- [ ] **Summary linger (new 2026-10-05):** the summary **with numbers** stays ~**2 s**, the bare
      "Sync done" ~1 s, and a summary with a **plugin line** (§7) ~**2.5 s**.
- [ ] **Stop sync (§II.17):** Settings → **Stop sync** during a long run stops it at the
      next checkpoint, says so, and **loses nothing** — the next sync finishes the job.
- [x] 📱🌐 **Cancel interrupts an upload IN FLIGHT (new 2026-10-11).** Start a sync that uploads a big file
      (~35 MiB), then press **Sync → Cancel sync** or **Settings → Stop sync** while "Syncing with GitHub"
      shows: the upload stops within a fraction of a second (measured on the phone: the request aborted
      43 ms after Cancel, the drain stopped 0.3 s after) and **"Sync canceled"** appears — for both ways of
      cancelling. The next sync uploads the file normally. (Before: Cancel waited out six ~47 s retries.)
- [x] 📱🌐 **GitHub's "input was too large" is not retried (new 2026-10-11).** If GitHub answers a blob with
      422 "Sorry, your input was too large to process", the log shows ONE attempt, the file is skipped with
      a WARN, and the rest of the batch is pushed — no loop re-uploading the same blob.
- [ ] **⚠️ A cancelled conflict is announced.** If a conflict's remote content vanishes
      from the repo, its conflict mode is cancelled and a Notice says so, naming the file
      and stating the local copy is unchanged. This is the ONE vault-step failure the
      user is told about — everything else is retried silently on the next sync, which is
      the point: a notice here must stay rare enough to be believed.
- [ ] **Skipped paths are re-asked.** After a sync that logged a skipped path, the NEXT
      sync asks about that path again even though no commit mentions it (the
      `.runtime/.recheck-paths` note). Easiest check: the file catches up on sync #2
      without you touching it.

## 5e. Deleted bin (🖥️📱 · HISTORY-DELETED)

- [ ] The conflicts panel's **Deleted** sub-tab opens even when there are zero conflicts.
- [ ] A file deleted locally appears there and can be restored before its deletion
      reaches a commit; after a successful sync, older records are pruned.

## 6. Settings & lifecycle (🖥️📱)

- [ ] Token / owner / repo / branch fields trim input; invalid values produce a clear error (not a silent 404).
- [ ] The settings connection test works and does not disturb sync state.
- [x] **Reset** (type the confirmation phrase) wipes the token, repo settings, sync history, pending local commits, conflicts, unsaved conflict-editor edits, and the plugin trash (the whole `.runtime/`); vault files are NOT touched — conflict-copy files stay in place and are re-detected as conflicts on re-enable. A `.reset-in-progress` marker in the plugin dir makes an interrupted reset finish on the next load.
- [ ] Toggling **"sync config folder"** includes/excludes `.obsidian/*` accordingly.
- [x] **"Clean logs" shows the live log size (new 2026-10-07, TODO п.36).** With logging on,
      the row reads `Truncate the log. Current log size is 1.2 MB (1 234 567 bytes).`; the
      number grows while the plugin logs (run a Sync with the page open), and right after
      **[Clean]** it shows `0 bytes`. Deleting the log file by hand also shows `0 bytes`.
- [x] **Log viewer (LOG-VIEWER, new 2026-10-08)** — Settings → Logging → **View log** → **Open**
      (the row exists only while logging is on; there is NO command for it):
      - 🖥️ it opens in its OWN window, in front of Settings; closing it leaves Settings open;
        its tab can be dragged into the main window's tab bar and stays there; pressing
        **Open** again brings the existing viewer (and its window) forward — never a second one;
        put the viewer's window BEHIND another app's window, and once MINIMIZED: **Open** raises
        it to the front (restored); with the viewer as a tab in the MAIN window, **Open** closes
        Settings and shows that tab (new 2026-10-08);
      - 🖥️ drag the viewer's tab into the main window, move it between splits, then drag it OUT
        into a new window again: the columns stay aligned (no `|||text`), scrolling works, and
        Ctrl/Cmd+F opens the search in the new window;
        scrolled to an entry in the MIDDLE (and sideways), each such move keeps the view on that
        same entry and column; while following, it stays at the end;
      - 📱 it opens as a FULL-SCREEN modal above Settings; closing it returns to Settings; with
        the on-screen keyboard up (typing a filter) the filter field stays visible and the
        log is still scrollable;
      - the log appears as a table `date | time | level | message`, data pretty-printed
        under the message, a separator between entries, the view scrolled to the newest
        entry at the bottom; INFO / WARN / ERROR in different colours (light AND dark theme);
      - long lines scroll sideways, the columns never break;
      - the line between entries reaches the RIGHT EDGE in a wide window and runs under the
        longest message too; copying (button or Ctrl/Cmd+C) gives dashes there, not spaces;
      - **filter**: `error` keeps only matching entries; `info | drain done` matches level
        then message; `drain done | info` matches nothing (order); the counter shows
        `N of M entries`; the **Aa / W / .\*** switches work; an invalid regexp shows
        "invalid expression" and keeps everything;
      - **search** (🔍 button, or Ctrl/Cmd+F with the cursor in the log) highlights and
        steps next/previous only inside the filtered entries;
        the search panel, its fields and buttons, the match highlight and the selection
        follow the THEME (dark theme → dark panel); there is no **[all]** button; its switches read **Aa · W · .\*** in that order and LOOK like the
        filter's toggle buttons (lit while on); **next / previous** are as readable as they are; clicking one toggles it and the matches update; Tab
        reaches them and Space toggles; the 🔍 button is a TOGGLE (second click closes the panel) and
        stays lit while the panel is open, going dark when the panel is closed by its × or Esc;
      - **copy** button puts the shown entries on the clipboard; normal selection + copy
        works too;
      - **live**: with the viewer open at the bottom, run a Sync — new entries appear at the
        end and the view follows them ALL the way, through the whole burst of a sync;
        while following, each new entry also puts the view back at column 0; scroll sideways
        to read a long line — following stops and new entries no longer move the view; scroll
        back DOWN to the end (sideways position does not matter) — following resumes AT ONCE (the
        view jumps to the end and column 0); with a TRACKPAD: a sideways swipe at the bottom
        stops following for good (no new entry moves the view afterwards), and one downward
        swipe at the bottom is enough to resume — never a second one; scroll up first and run another Sync — new entries
        are added but the view stays where you are; an entry the current filter rejects
        is counted in `M` but not drawn; nothing ever appears twice;
      - with a big log (a few MB; 📱 especially), "Loading the log…" shows until the table
        appears — the window never sits empty;
      - a log over **10 MB** shows "too large — open it with your operating system" and
        nothing else;
      - 📱 the same on a phone: opens, scrolls smoothly, filter and copy work;
      - **Settings acts on EVERY open viewer** (new 2026-10-08): open two viewers (drag the first
        tab into the main window, then press **Open** again… or one tab + scroll it up); press
        **[Clean]** — every viewer empties (`0 of 0 entries`), scrolled to the top and column 0,
        following ON; run a Sync — the new entries appear in all of them. A viewer that showed
        "too large" becomes an empty live log the same way. Turn **Enable logging** off — every
        viewer (tab, window, 📱 modal) closes.
- [ ] **Changing a switch never scrolls the page (new 2026-10-07).** Scroll down to *Logging* and toggle **Enable logging** on and off: the page stays where it is, and the *Clean logs* row appears/disappears in place. (Tab/Shift-Tab between fields is not expected to work — Obsidian's settings behave that way for every plugin.)
- [x] Changing the **device label** makes new commits carry the new `(label)` suffix.
- [ ] Switching repositories resets state correctly. ⚠️ **Change it in the SETTINGS UI,
      not by editing `data.json`.** A hand edit while Obsidian runs does nothing: the
      plugin holds its settings in memory and never re-reads that file, so the sync goes
      to the OLD repo with the OLD token and reports a perfectly healthy "0 pushed" —
      and the next `saveSettings()` silently overwrites your edit back. Hit in the field
      2026-10-03; the only tell was the repo-sized payload in the log
      (`GET tree/<old-head>` answering 200 against a repo the new token cannot even
      reach). If you must hand-edit, disable+enable the plugin before syncing.
      (A switch made through the UI is handled as the force-push class — §6.4: the stale
      anchor stops being an ancestor, `compare` 404s, and discovery falls back to a
      full-tree diff.)
- [ ] The **max auto-merge size** setting prevents very large files from being auto-merged.
- [ ] **Token expired (§35)** — with a bad token, a manual Sync opens the recovery dialog **every time** (closing `[X]` then Sync re-opens it — not a silent toast); the raw "…status 401" toast does NOT appear.
- [ ] **Token expired — sticky + red UI (§35)** — the marker survives a plugin reload: after reload the **GitHub** status-bar word + **Sync** ribbon icon are red (tooltip "Token expired"), **Sync All** / **Pull from repo…** are greyed, and the **GitHub sync status** box shows the 401 ("invalid or expired") vs 403 ("lacks permissions") message. It clears only on a token/owner/repo edit **or** a successful **Test connection** (a normal successful Sync does NOT clear it).
- [ ] **Token expired — automatic + history (§35)** — an interval/startup sync flashes **"Sync skipped: token expired"** (no modal); opening a file's history shows **"TOKEN EXPIRED! …"** above the local-only versions.
- [ ] 📱 **Token expired — mobile modal (§35)** — the recovery dialog is the shorter mobile layout and its buttons wrap + center (none pushed off-screen).

## 7. Self-update and plugin updates (🖥️📱🌐)

- [ ] Updating the plugin through itself: it completes and restarts after the update.
- [ ] 📱 On mobile the plugin auto-reloads (disable + enable) after a self-update, with no manual step.
- [ ] 🌐 **Our plugin updates ITSELF on the receiving device — no restart (regression fixed
      2026-10-05).** Device A pushes a new build; on device B press Sync and do nothing else.
      The log shows `self-update staged`, then `BRAT-style reload scheduled ["git-easy-sync"]`
      and `BRAT-style reload done`; afterwards `main.js` on B is the new build, no
      `main.ges-tmp.js` is left, and open diff2 tabs come back. The reload starts ~**2.75 s**
      after the sync ends, so the summary can be read first.
- [ ] **Exactly ONE toast for our own update**, `Plugin "git-easy-sync" updated` — with
      ` to <version>` when the version changed. (A build that still has the old reload loop
      may show two on the update that replaces it; judge from the NEXT update.)
- [ ] **No redundant re-ask after a self-update (new 2026-10-06):** the drain on the
      receiving device logs no `re-asking about a previously skipped path … main.js` after
      the update was applied.
- [ ] **No false local edit after a self-update.** On B, the first sync after the update
      must NOT queue "modified …/git-easy-sync/main.js"; the log at the reload shows
      `initSync2: applied self-update settled in the baseline`. ⚠️ Needs an update applied
      by a build that already has this (2026-10-05 `a74b0b1` or later) — the first update
      onto that build cannot show it.
- [ ] **Click-enabling the plugin while an update waits staged** raises no `TypeError` in the
      dev console (the instance that applies the stage exits early; a new one takes over).
- [ ] 🌐 **Other plugins: one toast each, with the version.** An ENABLED plugin updated by a
      sync is reloaded and gets its own 3 s toast, `Plugin "cmdr" updated to 0.5.5` (no
      "to …" for a rebuild of the same version). No aggregated "N plugins updated" toast.
      A DISABLED plugin gets no toast.
- [ ] 🌐 **Summary plugin lines.** Under "Sync done — …": `N plugins updated` and/or
      `N plugins removed`, counting ALL plugins whose files changed, enabled or not — a first
      pull into an empty vault shows e.g. "9 plugins updated".
- [ ] 🌐 **A plugin removed from the repo is unloaded at once.** Delete an ENABLED plugin's
      folder on device A and sync; on B, sync: a toast `Plugin "<id>" removed`, the plugin
      stops working immediately (not only after a restart), and it is OFF in Settings →
      Community plugins (`disablePluginAndSave` — re-enabling is a deliberate act).
- [ ] 🌐 **A plugin that exists only on the server is simply installed** — on a first pull the
      log has NO `plugin-core collision … (local=?)` lines for plugins the device never had.

## 8. Crash / recovery / edge cases (🖥️📱)

- [ ] A crash between atomic-write steps is completed forward by the recovery sweep on the next launch.
- [ ] A commit killed between creating its staged batch folder and moving it into the queue leaves `.runtime/push-queue-staging/<id>/` (holding only `.attempted-commit`); the next plugin start removes it with a `staged batch dir(s) left by a crashed commit — removed` warning in the log, and the changes are picked up by the next commit.
- [ ] **Zero-byte restore guard:** a file that had content but accidentally became 0 bytes is restored to its last good version, and the empty copy never reaches the server.
- [ ] Out-of-band drift (another tool changed the repo) reconciles correctly.
- [ ] Disabling then re-enabling the plugin mid-sync causes no double-run or corruption.

## 9. Performance (📱)

- [ ] **Mobile autosave benchmark** (Settings → *Run mobile autosave benchmark*): run on a mid-tier Android and on iOS; collect the p50/p95/p99 figures and send the log so the autosave timing can be tuned.
- [ ] A large conflict (hundreds of change blocks) in the diff editor stays responsive on mobile.
- [ ] 📱🖥️ **The FIRST sync after a large pull — the self-heal pass.** Pull several
      hundred files from another device, then sync again, and time the commit phase (the
      "Checking N of M files" line; exact numbers in the log's `Sync2 commit pass timing`). ⚠️ It is EXPECTED to be slow once, and the second sync after it must be
      fast again — that pair is the pass condition, not any single number.

      Why it happens, so a tester does not file it as a hang: the epilogue writes
      `mtime: 0` into the baseline of every path the drain TOUCHED. That is deliberate
      (D.15) — a real mtime there could hide an edit the user made DURING the drain
      behind the change detector's stat short-circuit, permanently. The cost is that
      those paths cannot short-circuit on the next scan, so each is re-read and
      re-hashed exactly once (D.14, "self-healing"), after which the real mtime is
      written back.

      ⚠️ The cost is proportional to what the sync TOUCHED, never to the vault: a sync
      of three files re-hashes three. Measured on the owner's 264-file / 64 MB vault
      2026-10-03: bootstrap commit 7.3 s → self-heal pass 2.75 s → steady state 0.19 s.
      Mobile is where this matters — a full walk there was measured at 10-22 s (`p6`),
      so a 500-file pull is the case worth timing on a phone rather than a laptop.

## Reporting a mobile issue

Open a GitHub issue with: device + Android/iOS version + Obsidian version; the section/item above that failed; expected vs observed result; a listing of `<vault>/.obsidian/plugins/git-easy-sync/.runtime/push-queue/` (paths only — content may carry private data); and any relevant lines from `<vault>/git-easy-sync.log` (⚠️ the VAULT ROOT, not inside `.obsidian/` — `logger.ts` names it `<plugin-id>.log` and puts it there so you can open it as a note) (with "Enable logging" on).

---

*Keep this checklist current as features are added that automated tests do not
cover. When a ⏳ feature ships, drop the marker and fold it into the release run.*
