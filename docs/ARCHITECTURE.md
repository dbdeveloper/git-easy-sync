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
- **Per-release notes** (Keep-a-Changelog format): [`CHANGELOG.md`](../CHANGELOG.md). README links here for "What's new"; do NOT add per-release notes back into README. New release → add a section to `CHANGELOG.md` and bump the version in `package.json` + `manifest.json` + `manifest-beta.json` + `versions.json`.
- **Canonical spec for the conflict-resolution ALGORITHM** — the abstract pseudo-merge model: sibling files, per-device conflict branches, the three kinds of conflict, auto-merge strategies, editing-while-in-conflict, full scenario walk-throughs (A–E), and what the algorithm deliberately does NOT promise: [`docs/PSEUDO-MERGE-MODE.md`](./PSEUDO-MERGE-MODE.md). Read this to understand *what* pseudo-merge does and *why*, independent of implementation. Section numbers: §1–4 (problem + git model + core idea), §5 (three kinds of conflict), §6 (auto-merge strategies), §7 (editing while in conflict), §8 (scenarios A–E), §9 (non-promises), §10 (glossary).
- **Canonical spec for the sync ENGINE** — how the algorithm is realised on top of the GitHub REST API: architecture layers, crash-recovery protocols (three-step / five-step atomic writes, recovery sweep, tail re-check), cross-platform contracts, push pipeline (pre-flight validation, pending-deletions queue, push-queue depth signal), typed error hierarchy, skip-class discipline, Worker orchestra, SHA-first reconcile, modify-in-place, plugin reload, self-update marker protocol: [`docs/SYNC2.md`](./SYNC2.md). **Read this first** when working on anything under `src/sync2/`, `src/errors.ts`, `src/worker/`, the GitHub client (`src/github/client.ts`), or any test that exercises the engine. Code comments cross-reference its section numbers (`SYNC2 §1` architecture, `§2.4`/`§2.5` staging + recovery, `§2.8` tail re-check, `§3` cross-platform, `§4.1` pre-flight, `§4.2` pending-deletions, `§5` error taxonomy, `§6` skip-class, `§7` field postmortems (incl. `§7.8` plugin-js/adoption HEAD-vs-file-change-date tie-break → `client.getLatestCommitDateForPath`, `§7.9` push→record crash marker, `§7.10` eventually-consistent head-read → chaining + monotonic-head guard + 422 reconcile-retry), `§8` worker orchestra, `§9` SHA-first, `§10` modify-in-place, `§11` plugin reload, `§12` self-update marker). When a SYNC2 mechanism realises an algorithmic guarantee, SYNC2.md cites PSEUDO-MERGE-MODE.md back.
- **Diff2 widget design** (the conflict-resolution UI/UX on top of pseudo-merge mode; `src/diff2/`). The canonical specs:
  - [`docs/tasks/DIFF-EDITOR-V2.md`](./tasks/DIFF-EDITOR-V2.md) — **the diff-edit MODEL + interaction**. The model is a CM6 document with a protected terminal `\n` per ver-block (an empty ver is a real `"\n"`, rendered `height:0` off-focus) + an Inclusive RangeSet `{ver,group}` (`diff-structure.ts`). It is a **"text + Ranges"** model: a live `transactionFilter` computes the resolve / merge / auto-resolve cascade ONCE and records `(change, structure, caret)`, so undo/redo + replay just re-APPLY the recorded change and never re-run the diff (this is what keeps undo/redo balanced and replay deterministic).
  - [`docs/tasks/DIFF-EDITOR.md`](./tasks/DIFF-EDITOR.md) — **the representation-independent commit / recovery / autosave layer**: append-log REDO autosave (`history.jsonl` + snapshots + `cursor.json` + `meta.json`), the **7-step pair-atomic `[←]` `commit7Step`** (a `done.json` barrier hashing the staged bytes + the A–K recovery matrix), and the keyboard hotkeys + byte-match rule the model relies on.
  - [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](./DIFF2_IMPLEMENTATION_PLAN.md) — the surrounding UX architecture: conflict / history / deleted views (R2.2–R2.4), `TrashStore` (R3), external-tool integration (R6), the R7.11 exit protocol with proactive sibling cleanup, crash resilience (R8).
  - [`docs/tasks/HISTORY-DELETED.md`](./tasks/HISTORY-DELETED.md) — **the CANONICAL spec for the History mode (Phase 7) and Deleted mode (Phase 9b)** — the two still-unbuilt diff2 modes. Consolidates + SUPERSEDES the scattered sources for these two modes: PLAN R2.3/R2.4 + feasibility §10/§11 (those now carry a one-line pointer here). Covers the data-source model (`.push-queue` / `.trash` / GitHub `listCommitsForPath`), the History↔Deleted mirror (base/sibling roles), shared machinery (one-sided recovery, `resolveOrDeleteUnchangedSide` factoring, write-set open-guard), verified code-state (what's built vs. stub), sequencing, and open decisions. **Read this FIRST when working on History/Deleted.** (R3/`TrashStore` data-layer remains live in the PLAN.)
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

**Keeping it accurate:** this tree drifts every time a file is added, renamed, or its
responsibility changes. Two honest options: (a) keep updating it by hand as part of
your commit ritual, or (b) let it be a *rough* orientation map and trust the code +
`git` as the real source of truth for "what exists now". Don't let it become a fossil
that quietly disagrees with `src/`.
