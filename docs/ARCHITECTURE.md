# Architecture

The map of the codebase and its design docs. Read on demand — this file is not loaded
into every Claude Code session (that's deliberate: it keeps the always-on `CLAUDE.md`
small). For behavioral rules, see the root `CLAUDE.md`. For module-specific constraints,
see `.claude/rules/` (they load automatically by path).

## Layers at a glance

- **`src/sync2/`** — the sync engine: change detection, batching, push pipeline,
  crash-recovery, conflict store/classifier, atomic writes. Canonical spec: `SYNC2.md`.
- **`src/diff2/`** — the conflict-resolution UI on top of pseudo-merge mode. Purely
  additive; depends on `sync2`, never the reverse.
- **`src/worker/`** — the Web Worker orchestra (CPU pool + one dedicated network worker);
  keeps hot-path CPU work and every GitHub HTTP call off the main thread.
- **`src/github/`** — the thin GitHub REST client.
- **`src/errors.ts`** — the `SyncError` class hierarchy.

**`main.js` at repo root is the build output Obsidian loads** (`manifest.json` points at
it) — it is not source.

## Design-doc map (which spec covers what)

- **User-facing overview, installation, settings reference, conflict-resolution UX, migration from other plugins**: [`README.md`](../README.md).
- **Per-release notes — RELEASES ONLY** (Keep-a-Changelog format): [`CHANGELOG.md`](../CHANGELOG.md). Per-shipped-version notes, NOT day-to-day development progress. README links here for "What's new"; do NOT add per-release notes back into README. New release → add a section to `CHANGELOG.md` and bump the version in `package.json` + `manifest.json` + `manifest-beta.json` + `versions.json`.
- **Development-path log** (living, compact milestone summary of the diff2 build): [`docs/BUILDLOG.md`](./BUILDLOG.md). One distilled entry per milestone — the *why*/shape that's hard to get from `git log`. The detailed path IS the commit messages (CLAUDE.md §7); BUILDLOG is their narrative. The live "where are we now" pointer is instead memory `project-diff2-resume-point` + `docs/tasks/DIFF-EDITOR-V2.md`.
- **Canonical spec for the conflict-resolution ALGORITHM** — the abstract pseudo-merge model: sibling files, per-device conflict branches, the three kinds of conflict, auto-merge strategies, editing-while-in-conflict, full scenario walk-throughs (A–E), and what the algorithm deliberately does NOT promise: [`docs/PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md). Read this to understand *what* pseudo-merge does and *why*, independent of implementation. Section numbers: §1–4 (problem + git model + core idea), §5 (three kinds of conflict), §6 (auto-merge strategies), §7 (editing while in conflict), §8 (scenarios A–E), §9 (non-promises), §10 (glossary).
- **Canonical spec for the sync ENGINE** — how the algorithm is realised on top of the GitHub REST API: architecture layers, crash-recovery protocols (three-step / five-step atomic writes, recovery sweep, tail re-check), cross-platform contracts, push pipeline (pre-flight validation, pending-deletions queue, push-queue depth signal — ⚠️ the first two DIED at Phase 5.5 THE SWITCH; Layer 2 subsumes pre-flight, and the vault-step's canonical write plus an honest baseline replace pending-deletions), typed error hierarchy, skip-class discipline, Worker orchestra, SHA-first reconcile, modify-in-place, plugin reload, self-update marker protocol: [`docs/SYNC2.md`](./SYNC2.md). **Read this first** when working on anything under `src/sync2/`, `src/errors.ts`, `src/worker/`, the GitHub client (`src/github/client.ts`), or any test that exercises the engine. Code comments cross-reference its section numbers (`SYNC2 §1` architecture, `§2.4`/`§2.5` staging + recovery, `§2.8` tail re-check, `§3` cross-platform, `§4.1` pre-flight, `§4.2` pending-deletions, `§5` error taxonomy, `§6` skip-class, `§7` field postmortems (incl. `§7.8` plugin-js/adoption HEAD-vs-file-change-date tie-break (⚠️ `getLatestCommitDateForPath` deleted at THE SWITCH; the drain reads dates via `getCommitInfoForPath`), `§7.9` push→record crash marker, `§7.10` eventually-consistent head-read → chaining + monotonic-head guard + 422 reconcile-retry), `§8` worker orchestra, `§9` SHA-first, `§10` modify-in-place, `§11` plugin reload, `§12` self-update marker). When a SYNC2 mechanism realises an algorithmic guarantee, SYNC2.md cites PSEUDO-MERGE-MODE.md back.
- **Diff2 widget design** (the conflict-resolution UI/UX on top of pseudo-merge mode; `src/diff2/`). The canonical specs:
  - [`docs/tasks/DIFF-EDITOR-V2.md`](./tasks/DIFF-EDITOR-V2.md) — **the diff-edit MODEL + interaction**. The model is a CM6 document with a protected terminal `\n` per ver-block (an empty ver is a real `"\n"`, rendered `height:0` off-focus) + an Inclusive RangeSet `{ver,group}` (`diff-structure.ts`). It is a **"text + Ranges"** model: a live `transactionFilter` computes the resolve / merge / auto-resolve cascade ONCE and records `(change, structure, caret)`, so undo/redo + replay just re-APPLY the recorded change and never re-run the diff (this is what keeps undo/redo balanced and replay deterministic).
  - [`docs/tasks/DIFF-EDITOR.md`](./tasks/DIFF-EDITOR.md) — **the representation-independent commit / recovery / autosave layer**: append-log REDO autosave (`history.jsonl` + snapshots + `cursor.json` + `meta.json`), the **7-step pair-atomic `[←]` `commit7Step`** (a `done.json` barrier hashing the staged bytes + the A–K recovery matrix), and the keyboard hotkeys + byte-match rule the model relies on.
  - [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./DIFF2_IMPLEMENTATION_PLAN.md) — the surrounding UX architecture: conflict / history / deleted views (R2.2–R2.4), `TrashStore` (R3), external-tool integration (R6), the R7.11 exit protocol with proactive sibling cleanup, crash resilience (R8).
  - [`docs/tasks/HISTORY-DELETED.md`](tasks/DIFF-EDITOR-HISTORY-DELETED.md) — **the CANONICAL spec for the History mode (Phase 7) and Deleted mode (Phase 9b)** — the two still-unbuilt diff2 modes. Consolidates + SUPERSEDES the scattered sources for these two modes: PLAN R2.3/R2.4 + feasibility §10/§11 (those now carry a one-line pointer here). Covers the data-source model (`.push-queue` / `.trash` / GitHub `listCommitsForPath`), the History↔Deleted mirror (base/sibling roles), shared machinery (one-sided recovery, `resolveOrDeleteUnchangedSide` factoring, write-set open-guard), verified code-state (what's built vs. stub), sequencing, and open decisions. **Read this FIRST when working on History/Deleted.** (R3/`TrashStore` data-layer remains live in the PLAN.)
  - [`docs/tasks/done/DIFF-EDITOR-TODO.md`](./tasks/done/DIFF-EDITOR-TODO.md) — the live bug/improvement backlog (**read FIRST** when fixing a diff-editor bug). [`docs/tasks/DIFF-EDITOR-V2-ANALYSIS.md`](./tasks/DIFF-EDITOR-V2-ANALYSIS.md) — the architecture analysis.

  When working on `src/diff2/`, read these together with [`docs/PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md) (the conflict-resolution algorithm diff2 renders) and [`docs/SYNC2.md`](./SYNC2.md) (the sync engine), which the specs cross-reference for Phase A/B, the byte-match rule, staging protocols, filesystem-authoritative resolution, scenarios, cross-platform contracts, and the push pipeline.

Behaviour described in these two specs is locked in by the unit + integration suites. If you change anything in the engine and a spec disagrees, fix the code OR update the spec — don't let them drift. Algorithm changes land in PSEUDO-MERGE-MODE.md; implementation changes land in SYNC2.md.

## Module layout (`src/`)

```
src/
├── main.ts                          # Plugin entry; commands, ribbons, IntervalScheduler wiring,
│                                    #  resetPluginState (calls renameVaultSiblingsToUnresolved
│                                    #  before clearAll), pushPluginsDataJsonCached
├── gi.ts                            # GI (gitignore matcher) — path-browserify, mobile-safe
├── logger.ts                        # Truncated JSON log file
├── token-expired-flag.ts            # E1 (TODO §5/§35): sticky .token_expired marker
│                                    #  (in-memory authoritative + file mirror; file stores the
│                                    #  401/403 class tag). authErrorKind + tokenExpiredMessage +
│                                    #  onTransition hook (drives the red status-bar/ribbon UI)
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
    │  ⚠️ THE ENGINE WAS REPLACED WHOLESALE at Phase 5.5 THE SWITCH
    │  (2026-08-31, +1317/−15861): the manager's own drain, push-queue,
    │  tree-builder, conflict-store v1, conflict-classifier,
    │  conflict-detection, push-inflight and pending-deletions-store are
    │  DELETED. The live path is: sync2-manager (thin shell) → drainOnce
    │  → buildDrainDeps. Canonical spec: docs/tasks/SYNC2-NEW-DRAIN.md
    │  (+ SYNC2-MASTER-PLAN.md as the routing map over all six docs).
    │
    ├── sync2-manager.ts             # THIN SHELL (~650 lines): syncAll/syncFile/commitOnly/
    │                                #  commitFile/resumeQueue, the R3a commit singleton with its
    │                                #  coalescing bell (SYNC2-FIX §6), the H3 drain-collapse flag,
    │                                #  DrainStatus channel, cancelDrain, MainHeadGuard (§7.10),
    │                                #  zero-byte restore guard, drain-result → UI mapping
    ├── drain.ts                     # THE ENGINE: drainOnce() — rolling base, batch loop, Layer 2,
    │                                #  STEP1/2/3 conflicts, FINALIZE, Vault-step, the epilogue
    │                                #  (baselines/hot anchor/journal.clear), §12.5 sweep at both
    │                                #  boundaries, bare-repo Contents-API seed
    ├── drain-deps.ts                # Production composition: makeDrainClient (GithubClient →
    │                                #  DrainClient; 404/409 → bare-repo null; every method forces
    │                                #  retry), MainHeadGuard, buildDrainDeps
    ├── drain-journal.ts             # §V ping-pong tracked-files-{a,b}.json (crash story of one drain)
    ├── diff3.ts                     # _diff3: §II.1 rules 2-4 + rule 7 size gate; verdicts
    │                                #  file / manual-conflict / plugin-dispatch
    ├── discovery.ts                 # §II.12 Layer 1: compare-first + full-tree fallback,
    │                                #  DELETED_SHA_HASH, getCommitInfoForPath
    ├── tree-accumulator.ts          # §II.15: inline content behind a round-trip PROOF, base_tree
    │                                #  chaining, UploadedBlobs resume, deletion-entry guard
    ├── sync-store.ts                # .runtime/sync_store/{sha} content-addressed blobs;
    │                                #  hash-on-load, sizeOf (stat-only), §12.5 sweep
    ├── batch-writer.ts              # §12.4 batch birth: meta.json BEFORE blobs, .attempted-commit
    ├── get-batch.ts                 # R3b Peterson claim protocol + crash repair + stale-claim sweep
    ├── batch-metafile.ts            # meta.json codec; sha:null IS the deletion sentinel
    ├── queue-sha-index.ts           # findChanges dedup reference over the queue (DELETED sentinel)
    ├── batch-history-source.ts      # History's local versions over the new queue format
    ├── conflict-store-v2.ts         # .runtime/conflicts.json: Map<path,{conflictBase,siblings[]}>
    │                                #  + cached view (hasBase / getBySiblingPath) for the sync UI
    ├── process-conflicts.ts         # §III reconciler: tracked>synthetic dedup, transition-only
    │                                #  prune, confirmResolved seam
    ├── sibling-tx.ts                # §II.11 crash-safe sibling replace (mark transaction)
    ├── conflict-siblings.ts         # buildSiblingFilePath / scan / extensionOf (the ONE naming truth)
    ├── vault-file-reader.ts         # The drain's live vault surface: stat/readBinary/atomicWriteFile
    │                                #  (+ pull-side canonicalize) / trash-capturing remove
    ├── retry-network.ts             # §II.10 bounded backoff + the .sync_network_error mark
    ├── reset.ts                     # RESET-PLUGIN core: drain guard → marker → rmdir .runtime
    ├── hot-metadata.ts              # 2-slot ping-pong metadata-{a,b}.json (monotonic seq)
    ├── file-baselines.ts            # 64 FNV-1a cold buckets + MRU; group ops are the PRIMARY API
    ├── invariant-state.ts           # gitignore-invariants.json freshness marks
    ├── interval-scheduler.ts        # Periodic tick + onload startup (testable in isolation)
    ├── change-detector.ts           # Vault walk + findChanges + the queue-dedup bridge
    ├── cross-platform.ts            # sanitizeFilename (12 forbidden ASCII → Unicode),
    │                                #  encodePathForGithub, safeRename. SYNC2 §3.
    ├── gitignore-invariants.ts      # Invariant .gitignore blocks; always-write enforce
    ├── commit-message.ts            # Hardcoded format* helpers (Sync/Conflict/Merge/Init at …)
    ├── atomic-write.ts              # 5-step atomicWriteFile + stagingPathFor + AtomicWriteRecovery
    │                                #  (modify-in-place fast path preserves editor cursor/scroll)
    ├── conflict-watcher.ts          # vault.on listener; READ-ONLY counter.markDirty()
    ├── conflict-counter.ts          # UI count formula + debounced recompute + subscribe
    ├── conflict-branch.ts           # buildConflictBranchName + CONFLICT_BRANCH_PREFIX
    ├── plugin-js.ts                 # isAtomicPluginFile, compareSemver, readPluginVersion
    ├── three-way-merge.ts           # mergeText (diff3-style, restores local's own EOL)
    ├── text-normalize.ts            # CRLF→LF, BOM strip, trailing-NL; shouldCanonicalize;
    │                                #  utf8RoundTrip + utf8RoundTripKeepBom (canonicalize sites)
    ├── timestamp-id.ts              # 17-digit sortable ids for queue + trash dirs
    ├── trash-hooks.ts               # sync2-owned interface diff2's TrashStore implements
    ├── types.ts                     # FileChange + shared shapes
    └── views/
        ├── pre-sync-conflict-modal.ts     # Pre-Sync confirmation modal
        └── token-expired-modal.ts         # 401/403 recovery dialog (Stage 7/§35): class-aware intro + shorter mobile layout
```

**Keeping it accurate:** this tree drifts every time a file is added, renamed, or its
responsibility changes. Two honest options: (a) keep updating it by hand as part of
your commit ritual, or (b) let it be a *rough* orientation map and trust the code +
`git` as the real source of truth for "what exists now". Don't let it become a fossil
that quietly disagrees with `src/`.
