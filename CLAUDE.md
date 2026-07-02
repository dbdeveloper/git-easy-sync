# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.
5. Follow Occam's Razor. Keep your project simple — but don't overcomplicate it. Not sure how? Just ask!

## What this plugin is

An Obsidian plugin that syncs a local vault with a GitHub repository using **only the GitHub REST API** — no `git` binary, no `isomorphic-git`. This constraint is deliberate so the plugin works identically on desktop and on Obsidian Mobile. Branching, rebasing, non-GitHub hosts are out of scope.

## Where to read what

- **User-facing overview, installation, settings reference, conflict-resolution UX, migration from other plugins**: [`README.md`](./README.md).
- **Per-release notes** (Keep-a-Changelog format): [`CHANGELOG.md`](./CHANGELOG.md). README links here for "What's new"; do NOT add per-release notes back into README. New release → add a section to `CHANGELOG.md` and bump the version in `package.json` + `manifest.json` + `manifest-beta.json` + `versions.json`.
- **Canonical spec for the conflict-resolution ALGORITHM** — the abstract pseudo-merge model: sibling files, per-device conflict branches, the three kinds of conflict, auto-merge strategies, editing-while-in-conflict, full scenario walk-throughs (A–E), and what the algorithm deliberately does NOT promise: [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md). Read this to understand *what* pseudo-merge does and *why*, independent of implementation. Section numbers: §1–4 (problem + git model + core idea), §5 (three kinds of conflict), §6 (auto-merge strategies), §7 (editing while in conflict), §8 (scenarios A–E), §9 (non-promises), §10 (glossary).
- **Canonical spec for the sync ENGINE** — how the algorithm is realised on top of the GitHub REST API: architecture layers, crash-recovery protocols (three-step / five-step atomic writes, recovery sweep, tail re-check), cross-platform contracts, push pipeline (pre-flight validation, pending-deletions queue, push-queue depth signal), typed error hierarchy, skip-class discipline, Worker orchestra, SHA-first reconcile, modify-in-place, plugin reload, self-update marker protocol: [`docs/SYNC2.md`](./docs/SYNC2.md). **Read this first** when working on anything under `src/sync2/`, `src/errors.ts`, `src/worker/`, the GitHub client (`src/github/client.ts`), or any test that exercises the engine. Code comments cross-reference its section numbers (`SYNC2 §1` architecture, `§2.4`/`§2.5` staging + recovery, `§2.8` tail re-check, `§3` cross-platform, `§4.1` pre-flight, `§4.2` pending-deletions, `§5` error taxonomy, `§6` skip-class, `§7` field postmortems (incl. `§7.8` plugin-js/adoption HEAD-vs-file-change-date tie-break → `client.getLatestCommitDateForPath`, `§7.9` push→record crash marker), `§8` worker orchestra, `§9` SHA-first, `§10` modify-in-place, `§11` plugin reload, `§12` self-update marker). When a SYNC2 mechanism realises an algorithmic guarantee, SYNC2.md cites PSEUDO-MERGE-MODE.md back.
- **Diff2 widget design** (the conflict-resolution UI/UX on top of pseudo-merge mode; `src/diff2/`). The canonical specs:
  - [`docs/tasks/DIFF-EDITOR-V2.md`](./docs/tasks/DIFF-EDITOR-V2.md) — **the diff-edit MODEL + interaction**. The model is a CM6 document with a protected terminal `\n` per ver-block (an empty ver is a real `"\n"`, rendered `height:0` off-focus) + an Inclusive RangeSet `{ver,group}` (`diff-structure.ts`). It is a **"text + Ranges"** model: a live `transactionFilter` computes the resolve / merge / auto-resolve cascade ONCE and records `(change, structure, caret)`, so undo/redo + replay just re-APPLY the recorded change and never re-run the diff (this is what keeps undo/redo balanced and replay deterministic).
  - [`docs/tasks/DIFF-EDITOR.md`](./docs/tasks/DIFF-EDITOR.md) — **the representation-independent commit / recovery / autosave layer**: append-log REDO autosave (`history.jsonl` + snapshots + `cursor.json` + `meta.json`), the **7-step pair-atomic `[←]` `commit7Step`** (a `done.json` barrier hashing the staged bytes + the A–K recovery matrix), and the keyboard hotkeys + byte-match rule the model relies on.
  - [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) — the surrounding UX architecture: conflict / history / deleted views (R2.2–R2.4), `TrashStore` (R3), external-tool integration (R6), the R7.11 exit protocol with proactive sibling cleanup, crash resilience (R8).
  - [`docs/tasks/HISTORY-DELETED.md`](./docs/tasks/HISTORY-DELETED.md) — **the CANONICAL spec for the History mode (Phase 7) and Deleted mode (Phase 9b)** — the two still-unbuilt diff2 modes. Consolidates + SUPERSEDES the scattered sources for these two modes: PLAN R2.3/R2.4 + feasibility §10/§11 (those now carry a one-line pointer here). Covers the data-source model (`.push-queue` / `.trash` / GitHub `listCommitsForPath`), the History↔Deleted mirror (base/sibling roles), shared machinery (one-sided recovery, `resolveOrDeleteUnchangedSide` factoring, write-set open-guard), verified code-state (what's built vs. stub), sequencing, and open decisions. **Read this FIRST when working on History/Deleted.** (R3/`TrashStore` data-layer remains live in the PLAN.)
  - [`docs/tasks/DIFF-EDITOR-TODO.md`](docs/tasks/done/DIFF-EDITOR-TODO.md) — the live bug/improvement backlog (**read FIRST** when fixing a diff-editor bug). [`docs/tasks/DIFF-EDITOR-V2-ANALYSIS.md`](./docs/tasks/DIFF-EDITOR-V2-ANALYSIS.md) — the architecture analysis.

  When working on `src/diff2/`, read these together with [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) (the conflict-resolution algorithm diff2 renders) and [`docs/SYNC2.md`](./docs/SYNC2.md) (the sync engine), which the specs cross-reference for Phase A/B, the byte-match rule, staging protocols, filesystem-authoritative resolution, scenarios, cross-platform contracts, and the push pipeline.

Behaviour described in these two specs is locked in by the unit + integration suites. If you change anything in the engine and a spec disagrees, fix the code OR update the spec — don't let them drift. Algorithm changes land in PSEUDO-MERGE-MODE.md; implementation changes land in SYNC2.md.

## Commands

Package manager is **pnpm** (CI uses `pnpm@latest-10`).

- `pnpm dev` — esbuild watch mode, emits `main.js` with inline sourcemaps. Set `OBSIDIAN_PLUGIN_DIR` env var to also mirror `main.js` / `manifest.json` / `styles.css` into a vault's plugin folder on every successful build (paths starting with `~/` are expanded). On macOS, IDE-set env vars don't pass through shell expansion — the config does that itself.
- `pnpm build` — typecheck (`tsc -noEmit`) then production bundle. Run before committing; CI runs the same on tag pushes.
- `pnpm test` — vitest unit suite, runs once and exits (~5 s).
- `pnpm test:watch` — vitest watch mode.
- `pnpm test:integration` — full integration suite against real GitHub (~20 min). Bootstrap suite included.
- `pnpm test:integration:bootstrap` — bootstrap suite only (~3 min).
- `pnpm test:integration:nonbootstrap` — everything except bootstrap (~17 min).
- `pnpm test:perf` — opt-in performance baselines under `tests/perf/`. Not in CI; emits `PERF_BASELINE {…}` lines.
- `pnpm benchmark` — predates the integration suite; requires SSH-accessible remote. Rarely needed; `test:integration` is preferred.

### Releases

Triggered by a pushed tag matching `[0-9].[0-9]+.[0-9]+*`; a `-beta` suffix cuts a prerelease. `npm version <ver>` runs `version-bump.mjs`, which syncs `manifest.json` and `versions.json` from `package.json`.

**`manifest-beta.json` is NOT auto-synced.** When bumping to a `-beta` version, edit it manually to match.

## Module layout (`src/`)

```
src/
├── main.ts                          # Plugin entry; commands, ribbons, IntervalScheduler wiring,
│                                    #  resetPluginState (calls renameVaultSiblingsToUnresolved
│                                    #  before clearAll), pushPluginsDataJsonCached
├── gi.ts                            # GI (gitignore matcher) — path-browserify, mobile-safe
├── logger.ts                        # Truncated JSON log file
├── token-expired-flag.ts            # E1 (TODO §5): persistent .token_expired marker
│                                    #  (in-memory authoritative + file mirror) + classifyAuthOutcome
├── status-bar-model.ts              # E2 (TODO §6-7): pure statusBarSuffix +
│                                    #  statusMenuState + buildStatusMenu (status-bar text + menu)
├── utils.ts                         # hasTextExtension, retry helpers, calculateGitBlobSHA,
│                                    #  isRetriableStatus / isWriteRetriableStatus / isRetriableError,
│                                    #  describeError (typed-error extractor used by safeStringify)
├── errors.ts                        # SyncError class hierarchy: NetworkError, GithubAPIError +
│                                    #  4 status subclasses, PlatformError, StaleStateError, makeGithubAPIError
│                                    #  dispatcher. SYNC2 §5.
├── github/client.ts                 # Thin requestUrl wrapper, retryUntil; throws via makeGithubAPIError;
│                                    #  getContentsAtRef does Blobs-API fallback for >1MB files (SYNC2 §7.6);
│                                    #  every HTTP call routes through WorkerClient.httpRequest when one is wired
├── settings/
│   ├── settings.ts                  # GitHubSyncSettings + DEFAULT_SETTINGS (syncStartsWithCommit,
│   │                                #  showCommitRibbonButton, consolidateCommits, maxAutoMergeSizeBytes)
│   └── tab.ts                       # Settings UI (trim onChange, Reset modal, GitHub sync status section,
│                                    #  Performance group with max-auto-merge KB input)
├── worker/                          # Web Worker orchestra (SYNC2 §8). esbuild emits each entry
│   ├── types.ts                     #  point as an IIFE, inlines as string via `define`, runtime wraps in Blob URL.
│   ├── cpu-worker.ts                # CPU pool: decode-base64, compute-git-blob-sha, merge-text (bundles node-diff3)
│   ├── network-worker.ts            # Single dedicated thread; native fetch executor for every GitHub HTTP call
│   └── worker-client.ts             # Main-thread controller; pool dispatch, request-id multiplex, terminate, fallback
└── sync2/
    ├── sync2-manager.ts             # Orchestrator: syncAll, syncFile, drain, processBatch,
    │                                #  validateDeletionsAgainstHead (pre-flight, SYNC2 §4.1),
    │                                #  finalizeConflictBranchIfReady, synthesizeResolutionSideBatches,
    │                                #  registerConflictAndDropPath, pushConflictPathsToBranch
    ├── interval-scheduler.ts        # Periodic tick + onload startup (testable in isolation)
    ├── change-detector.ts           # Vault walk + findChanges + queue bridge
    ├── push-queue.ts                # .push-queue/ persistence + markers + meta serdes + enqueueSynthetic
    ├── tree-builder.ts              # Batch → tree entries (with uploadedBlobs skip)
    ├── snapshot-store.ts            # github-easy-sync-metadata.json (file name is historic)
    ├── push-inflight.ts             # SYNC2 §7.9 push→record crash marker (MANDATORY;
    │                                #  recoverPushInflight heals a landed-but-unrecorded push)
    ├── pending-deletions-store.ts   # .pending-deletions/<id>/meta.json — pull-sanitize delete-intents
    │                                #  (SYNC2 §4.2)
    ├── cross-platform.ts            # Centralized contracts: sanitizeFilename (12 forbidden ASCII →
    │                                #  Unicode), encodePathForGithub, safeRename. SYNC2 §3.
    ├── gitignore-invariants.ts      # Invariant .gitignore blocks; always-write enforce
    ├── commit-message.ts            # Hardcoded format* helpers; commitMessageForBatch
    ├── atomic-write.ts              # 5-step atomicWriteFile + stagingPathFor + AtomicWriteRecovery.sweep;
    │                                #  fast-path uses vault.modifyBinary for open TFiles (preserves editor cursor/scroll)
    │                                #  via a .sync-tmp + .<basename>.sync-tmp. marker forward-recovery protocol
    ├── conflict-store.ts            # ConflictRecord + 3-step create + renameVaultSiblingsToUnresolved
    ├── conflict-classifier.ts       # Pure classify() + evaluateConflictState (Phase A + Phase B)
    ├── conflict-watcher.ts          # vault.on listener; READ-ONLY counter.markDirty()
    ├── conflict-counter.ts          # UI count formula + debounced recompute + subscribe
    ├── conflict-branch.ts           # buildConflictBranchName + CONFLICT_BRANCH_PREFIX
    ├── conflict-detection.ts        # attemptAutoMerge dispatch + classifyConflictKind
    ├── plugin-js.ts                 # isAtomicPluginFile, compareSemver, readPluginVersion
    ├── three-way-merge.ts           # mergeText (diff3-style)
    ├── text-normalize.ts            # CRLF→LF, BOM strip, trailing-NL; shouldCanonicalize
    │                                #  (excludes <configDir>/** — vault content only)
    ├── types.ts                     # QueueBatch, FileChange, EnqueueMeta
    └── views/
        ├── pre-sync-conflict-modal.ts     # Pre-Sync confirmation modal
        └── token-expired-modal.ts         # 401 / 403 recovery dialog (Stage 7)
```

**The diff2 code is the V2 representation rewrite — the SOLE diff-editor implementation.** The early §1/V1 model (`editor-model`/`joined-doc`/`diff-pane`/`decorations`/`markers`/`chunk-actions`/`exit-protocol`/§1 `history-log`/`history-replay` — flat CM6 doc + `Segment[]` + `\0/\1` sentinels) was a **discarded branch, removed from `src/` + `tests/`** (and from the specs — see the V1-purge line below). Model + interaction (CM6 doc + terminal-`\n` per ver-block + Inclusive RangeSet): `diff-model.ts`/`diff-structure.ts`/`diff-pane-v2.ts`/`diff-decorations.ts`/`diff-edits.ts`/`diff-selection.ts`/`diff-resolve.ts`/`diff-line-numbers.ts`/`diff-nav.ts`/`diff-toolbar.ts`/`word-level-diff.ts`/`diff-auto-resolve.ts`/`diff-clipboard.ts` + `diff-pane-owner.ts` (owner) + `history-log-v2.ts`/`history-replay-v2.ts`/`history-feed.ts` + `eol.ts` (bug-59); the panel/editor split adds `diff-detail-controller.ts`/`diff-editor-view.ts`/`editor-tabs.ts`. Commit/recovery/autosave (`exit-commit.ts` `commit7Step`/`recoverCommit`, `autosave-store.ts`, `cursor-*`, `onload-recovery.ts`, `recovery-dialog.ts`) + trash (`trash-*.ts`) are representation-independent. **Current live-state pointer = memory `project-diff2-resume-point` + the V2 spec [`docs/tasks/DIFF-EDITOR-V2.md`] (user-authored).** **Milestone (2026-06-19, branch `fix-diff-editor`, pushed @ `9ed0f6f`): absent-base conflicts (delete-vs-modify) + empty-resolution shipped** — synthetic-detector lists absent-base siblings; `commit7Step.baseCommitAction` does empty-base semantics (absent-at-start→delete / 0-byte-at-start→write 0 / had-content-emptied→`EmptyDeleteModal` Delete/Keep("\n")/Cancel); `done.json.deleteBase` + `Commit7Result.baseDeleted` (notice "Deleted" vs "Saved"); recovery delete-aware. Canonical detail: DIFF-EDITOR.md §5.0.g + §0.3.4, PLAN R3.3. **✅ MILESTONE — V2 interaction layer COMPLETE (2026-06-20, pushed @ `2c698a9`, device-verified):** the whole DIFF-EDITOR-V2.md interaction roadmap shipped — §2.2.13 auto-resolve (VANISH `ver1==ver2`) + split/shrink (scoped re-diff, `diff-auto-resolve.ts`), §2.2.12+§2.2.5 п.3 merge (Delete/Backspace separator, Ctrl+Y/Shift+Mod+K `diffDeleteLine`, select+delete, 2/3/4-group, multi-run cascade) with §6.1 caret (join-point / ver2-when-ver1-empty), §2.2.4 p5c Ctrl+A/group-spanning selection-delete (=§2.2.9 "neither"), §2.2.7 clipboard COPY/PASTE (`diff-clipboard.ts`: serialize/parse/materialize) + CUT (single shared `selectionSpansTerminal`), boundary bug-fixes + Ctrl+K. Architecture = "text + Ranges" (live filter computes the cascade once → records `(change, structure, caret)` → undo/redo+replay APPLY, never re-run diff2); recorded in DIFF-EDITOR-V2-ANALYSIS.md (§2.1 context-dispatch, §6.1 caret, §5 gate). diff2 988 unit-tests green. **✅ §0.5.5 CAROUSEL (history-log compaction) COMPLETE (2026-06-20, pushed @ `f967bba`, device-verified) — fixes bug-31/32:** (a) metric-fix — `assessHistoryV2.edits` counts only `newGroup` edits (= live undo depth; was counting every keystroke-block → "edits saved" grew to 162 vs real ~20); (b) `compactHistoryV2` (history-replay-v2.ts) — CONSERVATIVE (drops only dead groups: undone + redo-branch-truncated-by-a-later-edit, per the user's "10 edits→undo 7→+1→exactly 4"), pure, lockstep-proven on the real bug-31 log (428→68 blocks); `seq` now in the block checksum + `reseal`; (c) `rewriteHistoryAtomic`/`recoverHistoryRewrite` (history-rewrite.ts) — adapter-level bak-based atomic swap + onload recovery (in `recoverAutosaveDirs`); (d) REOPEN-trigger `compactSessionLog` runs before the Resume modal; (e) THRESHOLD-trigger {100 undo / 200KB cancelled} — `HistoryWriterV2` runs an injected `compactRunner` on its tail (race-free with appends) + resets seq; `cancelledBytes` was dead-wired (feed never passed `undoneBytes`) → `historyFeedListener` now measures an undo's full reverted span. diff2 1013 green. Canonical: DIFF-EDITOR.md §0.5.5. **✅ §2.2.6 п.7e KEYBOARD SELECTION COMPLETE (2026-06-22, branch `fix-diff-editor`, browser-verified) — fixes a large class of selection bugs that 4 rounds of green happy-dom suites MISSED:** the bugs all lived in keyboard Shift-motion (where the caret LANDS), which happy-dom cannot simulate — so "clipboard copies the whole group" etc. were Shift-motion-overshoot in disguise (native moveVertically preserved the column → overshot the collapsed diff-group → legalizer (correctly) made it whole-group → clipboard (correctly) fenced it). Fixed across three layers: (1) STRICT anchor-relative `legalizeSelection` (diff-selection.ts) — whole-group only when ≥1 char of the OTHER region is captured via half-open `[lo,hi)` (boundary `head==v2.from` = ver1-only, not whole; user-confirmed "start≠end at boundary"); (2) `selectionVertTarget` (diff-structure.ts) + `Shift-ArrowDown/Up` in `diffNavKeymap` — snap the head to the FIRST region boundary (v1.from/v2.from/v2.to), + §7e.ii.d/iii.c anchor re-base (start on an EMPTY ver → select nothing, caret re-bases to the next region); (3) single-ver clipboard/CUT/delete (`copyClipboardText`/`selectionDeleteSpec` via shared `singleVerSpan`) — a single-ver selection copies PLAIN `verContent` (protected terminal dropped, line `\n` kept) + deletes content-only (ver→empty), NOT the whole group. Forward + backward stadiality (ver1-only/ver2-only stepping → whole group) all browser-verified. **The observation tool: `harness/diff-pane-harness.{ts,html}` + `obsidian-stub.ts` — a browser-MCP Chromium harness (esbuild IIFE, `--alias:obsidian=`, served `python3 -m http.server 8731` from repo root, opened `http://host.docker.internal:8731/...`; `window.H`={mount,setCaret,setSel,sel,struct,copy,peek}); the `.js` bundle is gitignored.** This is the canonical oracle for ALL diff2 render/motion/caret bugs going forward (happy-dom = model-only). diff2 1055 green. Detail: memory `project-diff2-selection-model`. **Next (NOT a milestone): pixel-verify bug-34/33 bleed + bug-35 marker tint (harness screenshots / device); toolbar redesign ([[project-diff2-toolbar-redesign]]), Phase 7 History / Phase 8 Compare / Phase 9b Deleted modes, entry-points E4/E5/E6.**

**✅✅ DIFF-EDITOR V2 FEATURE-COMPLETE — feature set FROZEN (2026-06-27, `fix-diff-editor` PUSHED @ `1a928e3`). The CLAUDE.md diff2 paragraphs ABOVE are HISTORICAL build-log; THIS line is the current truth.** The whole DIFF-EDITOR-V2.md interaction roadmap + the surrounding UX shipped + device-verified; the user has declared the features complete (bugs will still be found/fixed; no NEW features except the one agreed below). Done since the milestone above: **§2.2.14 touch-only/read-only** (`editable=true`+`readOnly=false`+`changeFilter` rejecting input/delete userEvents — readOnly kills undo, editable=false kills shortcuts; `touchOnlyFacet`; Settings "Diff Editor" group, platform default mobile=true via `Platform.isMobile`); **§2.2.15 toolbar redesign** (`diff-toolbar.ts` — 2-row layout, back/Keep-Apply-Join-all, ↑/↓ conflict-nav + `Ctrl+[`/`Ctrl+]`, Undo/Redo, live `Conflicts:NNN` red>0/green=0, 3 per-session Compartment toggles Touch/Auto-focus/Diff-mode; interim `toolbar-conflicts.ts` DELETED; auto-focus default-true, focus-on-open rAF-deferred); **bug-8 char-level intra-chunk diff** (`computeWordDiff` diffChars + `CHAR_DIFF_BUDGET` word-fallback + Settings "Diff highlight mode" dropdown); **bug-50/51 trailing-`↵` diff** (`glyphDiffLine`, last EOL-less group only); **conflict file title → VIEW HEADER** (`getDisplayText` dynamic + direct `.view-header-title` DOM set; in-body title-row dropped, +1 editor row); **🔴 bug-56 fault-tolerant RECOVERY** — `autoResolveFilter` re-cascaded on REPLAY → doc divergence → `RangeError` → `mountReplayed` threw before `this.owner` set → dead toolbar/auto-focus; fixed by (1) `autoResolveFilter` skips `replayDispatch` (undo/redo-userEvent guard tried + REMOVED as inert — debit=credit proven WITHOUT it by `recovery-forward.test.ts`), (2) `replayHistoryV2` STOPS at the first un-appliable block (returns `stoppedAtError`, never throws → resume never bricks; base+sibling = ground truth, user re-resolves the safe-prefix tail), (3) pre-flight dry-run before the Resume modal → "NNN edits saved" = REAL recoverable count, 0 → silent fresh (drops broken `history.jsonl`); permanent monitoring logs `diff2 undo/redo` (debit=credit watch) + `diff2 replay STOPPED` + `diff2 dry-run/recovered/fresh-mount {docBytes,ms}` (perf). Tests: `tests/diff2/fixtures/bug56/` + `bug56-replay.test.ts` + `recovery-forward.test.ts`; full unit suite ~1893 green. **Live pointer = memory `project-diff2-resume-point`.** **OPEN ITEMS (not new features): (1) recovery-replay PERF** — replay = O(N×doc) decoration rebuilds, done twice; see `docs/tasks/TODO.md` perf chapter (options A skip-decorations-during-replay / B stripped in-memory dry-run / C reorder + round-trip-compaction missed-opportunity). **(2) entry-points** E4 file-menu / E5 deep-link / E6 post-sync-modal. **(3) History/Compare/Deleted** modes (type-defined in `events.ts`, not rendered). **THE ONE AGREED NEW FEATURE: a search panel** (`Ctrl+F`) — reuse the `@codemirror/search` engine (find/next/prev/highlight); a simple query language = space-separated words + quoted/bracketed phrases → regexp SearchQuery; **integration caveat the user flagged: `selectionLegalizeFilter` must NOT mangle a search-driven match selection** (gate it on the search userEvent). User to spec; not yet built.

**✅✅ SUPERSEDES the FROZEN line above as the LIVE POINTER — panel/editor SPLIT + Phase-1B persistence + device/engine fixes (2026-07-01, `fix-diff-editor` PUSHED @ `e60a695`).** The single diff2 view was split into a SINGLETON `DiffPanelView` (view-type `diff2-edit-view`, list-only) + a MULTI-TAB `DiffEditorView` (view-type `diff2-editor-view`, one per `base:sibling`), sharing ONE `DiffDetailController` (the detail engine — byte-identical through S2–S6, proving the seam). New files: `src/diff2/{diff-detail-controller, diff-editor-view, editor-tabs}.ts` + `recovery-dialog.ts` `EditorBusyModal` (inventory in the spec, not re-listed above). Row-click → open-guard (`openGuard`/`writeSetFor`, same-pair focus / partial-overlap dialog) → editor tab; `[←]` → `planBackNav` → reveal panel + scroll. **Phase-1B:** both view-types survive an Obsidian restart (`getState` strips a transient `openMode` → silent resume vs user-reopen modal); a restored editor whose conflict resolved between sessions detaches cleanly. **Device UI fixes:** diff-editor tab title (1B async-mount regression), `TokenExpiredModal` auto-dismiss, GitHub-token field select-all-on-focus, "Sync interval" hidden under "Manually", conflict-count badge on cold restart (#7 findAllConflicts recompute at layout-ready). **ENGINE (SYNC2 §7.8/§7.9):** adoption tie-break by the file's last-change date (not HEAD), canonicalize excludes `<configDir>/**`, and a MANDATORY `push-inflight` crash marker that ELIMINATES the one-device "conflict with yourself" (push→record gap). **Canonical detail:** `docs/tasks/done/SPLIT-PANEL-EDITOR-FEASIBILITY.md` (split/1B) + SYNC2.md §7.8/§7.9 (engine) + memory `project-diff2-resume-point` / `project-device-bugs-2026-06-30`. **✅ 1B + UI fixes DEVICE-VERIFIED (2026-07-01: restart content-survival [the edit survives a cold restart — silent resume, bytes checked], multi-editor restore, close-x→reopen modal, resolved-between-sessions detach, + all 5 UI fixes).** Only `TokenExpiredModal` auto-dismiss pends a real token expiry (~1wk, time-blocked not code); engine §7.8/§7.9/canonicalize are deterministic-unit-guaranteed (device is an optional spot-check). **✅ bug-59 CRLF/CR support DEVICE-VERIFIED (2026-07-01, PUSHED @ `5ce92ae`):** a Windows-CRLF (or old-Mac-CR) conflict used to throw `RangeError: Invalid position …` — the model hardcodes `\n` and CM6 strips `\r`. Fix `src/diff2/eol.ts` (`detectEol`/`toLf`/`restoreEol`/`commonEol`, priority LF>CR>CRLF): normalize to `\n` at EVERY model-entry (fresh mount, `readResumeSession`, `startSession` joinedDocSha, `classifyReopen` replay-gate); restore the session EOL (`meta.eol`) on EVERY vault write (`baseCommitAction` + `commit7Step` sibling + §5.0.e `commitUnchangedSide`/`commitToAlt`). Snapshots + all git-blob SHAs stay byte-exact/raw (Option B — no SHA-layer change). CRLF preserved byte-exact on write only when BOTH sides were CRLF (any LF side → LF). Compare mode (two write targets) deferred.

**✅ V1 PURGED FROM DOCS + panel-move + editor popout-move (2026-07-02).** DIFF-EDITOR-V2 is the SOLE diff-editor impl — the §1/V1 model was already gone from `src/`+`tests/`, and is now purged from the three specs: **DIFF-EDITOR.md** (−1541 lines — §1 «R7.7 core» model + §0.1–§0.4 §1→V2 migration contract + §7 V1-test-plan removed; §2.5 joinedDocSha / §2.6 history-format / §3.3 replay rewritten to V2 terms `serializeModel(buildModel)`/`VerRange[]`, no sentinels; §7 → pointer to the real `tests/diff2/` suite), **DIFF-EDITOR-V2-ANALYSIS.md**, **DIFF2_IMPLEMENTATION_PLAN.md** (R9.1 rollout banner-marked historical). Acceptance grep across all three → only deliberate «removed» banner statements remain. **Window arrangement (SPLIT-PANEL topic CLOSED, feasibility doc → `docs/tasks/done/`):** diff-panel MOVES to a split/window, staying singleton (onOpen guard inverted — keep `this.leaf`, detach older); editor popout-move = native Obsidian `moveLeafToPopout` reparent (SAME object, undo intact, log-proven); editor in-window split correctly REFUSED (duplicate-guard — would be a write-race).

## Testing

Three independent suites — each in its own directory, own vitest config, own `pnpm` script. All run against the same `mock-obsidian.ts` alias (fs-backed vault stand-in); integration + perf hit the real GitHub API on top of that.

| Suite | Scope | Network | Command | Wall-clock |
|---|---|---|---|---|
| Unit | Pure helpers, store/queue/classifier invariants, orchestrator under a fake client | No | `pnpm test` | ~5 s |
| Integration | `Sync2Manager` end-to-end against real GitHub | Yes | `pnpm test:integration` | ~20 min full |
| Perf baselines | Wall-clock signal on real GitHub upload paths | Yes | `pnpm test:perf` | ~1 min |

`pnpm build` runs `tsc -noEmit` before bundling — keep it green.

### Integration env (`.env.test` at repo root)

- `GITHUB_TOKEN` — fine-grained PAT on the persistent int-test repo. Permissions: Contents R/W, Metadata R. Cannot create or delete repos — leak blast radius is one repo's contents.
- `INT_TEST_OWNER` / `INT_TEST_REPO` — that private int-test repo. Tests use branch-per-test (`int-test-<scenario>-<timestamp>-<n>`), deleted in `afterEach`. Default branch is bootstrapped lazily on first run via `ensureRepoNotBare`.
- `GITHUB_BOOTSTRAP_TOKEN` — classic PAT with `public_repo` + `delete_repo`. Only for the bootstrap suite, which must delete+recreate to regain bare state. The two-token split exists because fine-grained PATs can't create repos.
- `INT_BOOTSTRAP_TEST_REPO` — public ephemeral repo the bootstrap suite recreates. Dropped at end of run via `tests/integration/teardown.ts`.
- `INT_TEST_BRANCH_PREFIX` — defaults to `int-test`; override if multiple users share the same int-test repo.

### Test layout (`tests/integration/scenarios/sync2/`)

```
sync2/
├── bootstrap/             # A-series: bare-repo bootstrap (uses BOOTSTRAP_TOKEN)
├── adoption/              # B-series: first sync against non-bare remote
├── normalization/         # C-series: CRLF/BOM round-trips, resume strategies
├── incremental/           # D-series: post-adoption incremental flows
├── conflicts-misc/        # E-series: reconcile-onload, binary, plugin-js semver/mtime
├── edges/                 # F: special chars in paths + content edge cases
├── multi-device/          # G-series: rotation, multi-device conflicts
├── drift/                 # H-series: out-of-band drift, transient PATCH retry
├── settings-lifecycle/    # I-series: reset, syncConfigDir toggle, deviceLabel change, repo switch
├── api-failures/          # J-series: 401/429/404/network drop
├── manifest-corruption/   # K-series: corrupted snapshot manifest scenarios
├── accumulate/            # L-series: accumulate semantics + .attempted marker
├── conflicts/             # Pseudo-merge end-to-end (branch lifecycle, edit-while-in-conflict, etc.)
├── rename/                # gitignore + rename interaction
└── empty-progression.test.ts
```

Tests use **branch-per-test** on the persistent private int-test repo. Bootstrap is the exception — it needs delete+recreate, so uses the public ephemeral repo.

On the `diff2` branch, additional buckets exist: `tests/diff2/` (unit + crash-resilience for the trash subsystem) and `tests/integration/scenarios/diff2/n-series-trash/` (end-to-end against real GitHub). They run automatically under `pnpm test` / `pnpm test:integration`.

### Single-spec runs

```
pnpm vitest run tests/sync2/conflict-store.test.ts
pnpm vitest run --config vitest.integration.config.ts tests/integration/scenarios/sync2/conflicts
```

The bucket form takes a glob — `tests/integration/scenarios/sync2/conflicts*` matches both `conflicts/` and `conflicts-misc/`.

### Sync2-specific test helpers

`tests/integration/scenarios/sync2/helpers.ts`: `createSync2Client`, `Sync2TestClient`, `sync2AllAndAssertNoErrors`, `sync2FileAndAssertNoErrors`. The client owns its vault temp dir by default; pass `ownsVaultPath: false` (first instance) + `ownsVaultPath: true` (second) to share a vault across two test "sessions". Pass `autoCanonicalize: true` to opt into canonicalize for tests that exercise that codepath (helper default is `true` for back-compat with the C-series; production default is `false`).

### Fault injection

`tests/integration/helpers.ts` exports the test-side wrappers; `mock-obsidian.ts` carries the `RequestFaultInjector` itself:

- `failOnNthMatch(matcher, n, message)` — throws on the Nth matching request.
- `respondForFirstN(matcher, n, fakeResponse)` — short-circuits the first N matching requests with a synthesized HTTP response (exercises retry logic without rate-limiting the live PAT).

**Always reset in `afterEach`** via `installRequestFaultInjector(null)` — the injector is global to the vitest worker and would leak between tests otherwise.

### MOCK_PLATFORM-paired tests

`tests/mock-obsidian-platform.test.ts` parametrises a `describe.each([{platform: "desktop"}, {platform: "mobile"}])` so the same body runs under both POSIX rename semantics (overwrites silently) and Capacitor rename semantics (throws on existing destination). Use this pattern for any new test touching `adapter.rename` so a Capacitor-only regression cannot slip through.

## Constraints to respect

- **Paths** always through `normalizePath` from `obsidian` before touching the adapter.
- **`main.js` at repo root** is the build output Obsidian loads (`manifest.json` points at it). It's not source.
- **Mobile support** — `isDesktopOnly: false` in `manifest.json`. Don't introduce Node-only APIs in `src/`; `benchmark.ts` and `mock-obsidian.ts` are the only Node-side files and aren't bundled. A top-level `import * as fs from "fs"` (or `path`, `os`, `crypto`, etc.) leaves a `require("fs")` at the top of the bundle (esbuild marks these external by default) and **throws on Obsidian Mobile at module load** — there is no Node runtime in the Capacitor WebView — silently crashing the plugin during "Enable" in the community-plugins list. Two valid patterns:
  - (a) use a pure-JS polyfill (`src/gi.ts` uses `path-browserify`; remove the polyfill's name from the esbuild `external` list so it gets bundled instead of `require`'d);
  - (b) wrap the `require` inside a function body with `try/catch` so it's never evaluated at module load — see `defaultReadFile` in `src/gi.ts` for the fs case (only test-time code path; production injects a vault-adapter reader instead).

  To verify, grep the production bundle: `grep -E "=require\\(\\\"fs\\\"\\)|=require\\(\\\"path\\\"\\)" main.js` must return zero matches at file scope.
- **Capacitor `rename` does not overwrite.** On iOS / Android the vault adapter's `rename` throws "Destination file already exists" when the target is occupied. POSIX `rename` overwrites silently. The portable pattern is `if (exists(dst)) await remove(dst); await rename(src, dst);`. `src/sync2/atomic-write.ts` and `src/sync2/conflict-store.ts` already follow it. Any new write-then-rename path must too — pair it with a `MOCK_PLATFORM=mobile` test.
- **Settings-tab text inputs must trim user input.** Android keyboards (and several third-party iOS ones) reliably append trailing whitespace to paste operations from the suggestion bar. A token like `ghp_abc123 ` (one trailing space) makes every GitHub REST call return 404 with valid permission headers — GitHub masks "valid token, repo outside scope" as 404 to avoid leaking private-repo existence, and a whitespaced token never matches the configured repo's scope. `src/settings/tab.ts` calls `.trim()` in every `onChange` for token/owner/repo/branch, and `src/main.ts:loadSettings` runs a one-pass sanitize on read so existing installs with whitespace-poisoned values self-heal on plugin restart.
- **`vault.adapter.read` is for text only.** Use `readBinary` for anything `hasTextExtension` says false. Especially important on iOS, where the text path silently corrupts binary content.
- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-invariants.ts`) — that way users can opt out.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreInvariants.enforce()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-invariants.ts` and ship a new build.
- **Polling, not events, for the sync engine.** `findChanges` walks the vault on each sync click; no `vault.on` subscription for sync purposes. Implication: edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode. The conflict layer's `ConflictWatcher` IS event-driven (`vault.on('delete'|'modify'|'rename')`), but **read-only** — it only calls `counter.markDirty()`, never mutates store; all conflict mutations happen at drain-start. See [`docs/SYNC2.md`](./docs/SYNC2.md) §1 (architecture layers + trigger models).
- **No scheduler logic in `main.ts`.** Periodic-tick decisions (interval enabled vs watchdog vs `syncStartsWithCommit`) and the onload-startup pulse live in `src/sync2/interval-scheduler.ts` so they can be unit-tested in isolation under a fake timer. If you find yourself adding an `setInterval` or `app.workspace.onLayoutReady` callback for sync purposes inside `main.ts`, move it into `IntervalScheduler` instead.
- **Worker orchestra: CPU pool + dedicated network worker.** Stage 4-6 of the 2.0.2-beta rework moved every hot-path CPU operation (3-way merge, base64 decode, SHA computation) and every GitHub HTTP call off the main thread. The orchestra lives in `src/worker/`; esbuild emits each worker entry point as a standalone IIFE and inlines the source as a string constant via `define`, so `main.js` ships a single bundle. Runtime wraps each string in a `Blob` URL and constructs `new Worker(url)` from it — no `importScripts`, no separate file fetch, no Capacitor `app://` URL ambiguity. Workers CANNOT touch any Obsidian API (`vault.adapter.*`, `app.workspace`, settings) — those stay on main. **All HTTP calls from the engine MUST go through `WorkerClient.httpRequest`** (CORS-validated against `api.github.com` on Capacitor Android). The Settings-tab connection probe is the one allowed exception — it uses `requestUrl` directly so a click never touches plugin state.
- **Modify-in-place uses `vault.modifyBinary` + a `.sync-tmp.` marker for crash safety.** When the engine writes to a file that already exists as a TFile, `atomicWriteFile` takes a fast path that preserves any open editor's cursor + scroll position. Protocol: stage new bytes in `<file>.sync-tmp.<ext>` → drop a zero-byte marker at `.<basename>.sync-tmp.` (leading + trailing dot — syntactically distinct from staging files) → `modifyBinary(target, newBytes)` → cleanup. On crash, `AtomicWriteRecovery.sweep` sees the marker, renames sync-tmp over the target (forward-complete), and removes the marker. Recovery runs at plugin onload BEFORE `workspace.onLayoutReady` so the rename's editor-close side effect is moot. The rename strategy still runs for brand-new files (no existing TFile to modify); SHA-based recovery handles its `.sync-bak` orphans, unchanged from 2.0.1.
- **`syncStartsWithCommit` master toggle controls all sync surfaces (default `true`).** Manual `[Sync]` click, interval tick, and startup sync all branch on this single setting. `true` → commit + drain (today's manual-click semantic; preserves backward compat). `false` → drain only; commit becomes the user's separate action via the `[Commit]` ribbon button or the `commit-local` command. The `showCommitRibbonButton` toggle controls the ribbon icon independently — it's a UI affordance, not a semantic.
- **`atomicWriteFile` is invoked from many places. Settings-tab UI text should NOT name engine concepts ("drain", "queue", "batch") — use plain English for users.** Engine identifiers (cancelDrain, DrainStatus, setDrainStatusListener) stay as code-level jargon because they're API names, not user copy. Stage 7 specifically swapped UI copy: "Drain status" → "GitHub sync status", "Stop drain" → "Stop sync", "Drain running" → "Syncing with GitHub".
- **`drain()` is re-entrant-safe via a `running` flag** on `Sync2Manager`. Concurrent `syncAll()` calls (e.g. interval tick fires while user click is mid-flight) collapse into one drain — the second call returns immediately. Don't bypass this with a separate code path; the integration suite's H3 test pins the serialisation.
- **Commit messages are hardcoded** in `src/sync2/commit-message.ts` (`formatSyncMessage`, `formatResolveConflictMessage`, etc.) — format `Sync at <local-time+offset> (deviceLabel)`. Don't reintroduce a per-user template field — the design choice was deliberate. The **local-commit timestamp lives in the message body on purpose**: sync2 commits locally (batch `createdAt`) but pushes later, so git's author/committer date records *push* time, not when the user committed. The in-message timestamp (rendered from `batch.createdAt` via `formatLocalTimestamp`) restores the true commit moment and makes every message unique/greppable. Provenance lives in the trailing `(deviceLabel)`, which `parseDeviceSuffix` recovers — keep the trailing-label contract intact. Rationale + the rejected "set author date" alternative: SYNC2.md §4.4.
- **When working on conflict resolution OR the push pipeline OR cross-cutting infrastructure** (cross-platform contracts in `cross-platform.ts`, typed errors in `errors.ts`, pending-deletions in `pending-deletions-store.ts`, skip-class annotations in any loop), [`docs/SYNC2.md`](./docs/SYNC2.md) is the canonical engine spec the code targets, and [`docs/PSEUDO-MERGE-MODE.md`](./docs/PSEUDO-MERGE-MODE.md) is the algorithm it realises. Code comments reference SYNC2.md section numbers (e.g. `SYNC2 §2.4` sibling staging, `SYNC2 §3` cross-platform contracts, `SYNC2 §4.1` pre-flight validation, `SYNC2 §5` error taxonomy, `SYNC2 §6` skip-class) and PSEUDO-MERGE-MODE.md numbers for algorithmic concepts (e.g. `§8 Scenario E`); use those to navigate between code and design rationale. The bug catalog in `SYNC2 §7 Field Postmortems` is the triage index for similar future symptoms.
- **When working on `src/diff2/`**, [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./docs/DIFF2_IMPLEMENTATION_PLAN.md) is the canonical spec. Diff2 is **purely additive UI/UX on top of pseudo-merge mode**: it must not change `ConflictStore` semantics, never bypass Phase A/B at drain start, and never push commits / mutate the conflict branch directly (that's `sync2-manager`'s job). The two operations diff2 may perform on the vault are (a) write base-file bytes through `atomicWriteFile`, and (b) `adapter.remove(siblingPath)` as the R7.11 proactive-cleanup step when `SHA(base) == SHA(sibling)`. Everything else is a `sync2/` concern that diff2 only observes.
- **Diff2 → sync2 dependency direction.** When `src/diff2/` modules start landing, they may import from `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, observe `Sync2Manager` events). But **`src/sync2/` must never import from `src/diff2/`**. This keeps the sync engine buildable and testable without the UI layer (e.g., for sync-only regression runs and for the existing integration suite), and preserves the option to ship `src/diff2/` as a separate plugin later. Any new edge in `src/sync2/*.ts` that imports `../diff2/...` is a regression — surface it instead of bridging.
