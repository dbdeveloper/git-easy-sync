---
paths:
  - "src/sync2/**"
  - "src/github/**"
  - "src/worker/**"
  - "src/errors.ts"
---

# Sync engine rules (sync2)

Loaded automatically when you work on the sync engine. The canonical specs the code
targets:

- **Algorithm** (abstract pseudo-merge model): [`docs/PSEUDO-MERGE-MODE.md`](../../docs/PSEUDO-MERGE-MODE.md)
- **Engine — the CURRENT one** (`drainOnce`, since Phase 5.5 THE SWITCH, 2026-08-31):
  [`docs/tasks/SYNC2-NEW-DRAIN.md`](../../docs/tasks/SYNC2-NEW-DRAIN.md), with
  [`docs/tasks/SYNC2-MASTER-PLAN.md`](../../docs/tasks/SYNC2-MASTER-PLAN.md) as the routing
  map over all six sync2 docs. **Read these first for anything in the drain path.**
- **Module-wide academic reference**: [`docs/SYNC2.md`](../../docs/SYNC2.md) — the "how the
  whole engine works" text for the module, and it stays that. It is **MID-REWRITE, not
  retired**: everything the SWITCH did NOT replace is authoritative there (cross-platform
  contracts, error taxonomy, skip-class, worker orchestra, atomic writes, plugin reload,
  self-update, the §7 field-postmortem catalog), while its drain/pull/push-pipeline
  sections describe DELETED code and read as history until the rewrite. The rewrite is a
  planned step scheduled LAST — after DOT-FILES, PLUGIN-UPDATE-COMPAT and Phase 6, because
  the algorithms are still moving (MASTER-PLAN, post-gate work order). Its own header
  carries the same status map.

Code comments cross-reference these by section number (`SYNC2 §4.1`, `§8 Scenario E`,
etc.). The section-number map lives in [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

---

## Constraints

- **Don't add files to the hardcoded `isSyncable` blocklist** without a real reason. The default for new "should we sync this?" rules is to add patterns to the seeded gitignore (`CONFIG_DIR_SEED` / `ROOT_SEED` in `gitignore-invariants.ts`) — that way users can opt out.
- **Don't hand-edit the canonical block in `<configDir>/.gitignore`** — `GitignoreInvariants.enforce()` will rewrite it on the next plugin load. To customise the truly-required behaviour, edit the constants in `gitignore-invariants.ts` and ship a new build.
- **Polling, not events, for the sync engine.** `findChanges` walks the vault on each sync click; no `vault.on` subscription for sync purposes. Implication: edits made while the plugin was disabled get picked up on the next sync click without any "missed events" failure mode. The conflict layer's `ConflictWatcher` IS event-driven (`vault.on('delete'|'modify'|'rename')`), but **read-only** — it only calls `counter.markDirty()`, never mutates store; all conflict mutations happen through `process-conflicts.ts` (drain start/restarts + the three UI sites: onload, panel open, editor close). See [`docs/SYNC2.md`](../../docs/SYNC2.md) §1 (architecture layers + trigger models).
- **No scheduler logic in `main.ts`.** Periodic-tick decisions (interval enabled vs watchdog vs `syncStartsWithCommit`) and the onload-startup pulse live in `src/sync2/interval-scheduler.ts` so they can be unit-tested in isolation under a fake timer. If you find yourself adding an `setInterval` or `app.workspace.onLayoutReady` callback for sync purposes inside `main.ts`, move it into `IntervalScheduler` instead.
- **Worker orchestra: CPU pool + dedicated network worker.** Stage 4-6 of the 2.0.2-beta rework moved every hot-path CPU operation (3-way merge, base64 decode, SHA computation) and every GitHub HTTP call off the main thread. The orchestra lives in `src/worker/`; esbuild emits each worker entry point as a standalone IIFE and inlines the source as a string constant via `define`, so `main.js` ships a single bundle. Runtime wraps each string in a `Blob` URL and constructs `new Worker(url)` from it — no `importScripts`, no separate file fetch, no Capacitor `app://` URL ambiguity. Workers CANNOT touch any Obsidian API (`vault.adapter.*`, `app.workspace`, settings) — those stay on main. **All HTTP calls from the engine MUST go through `WorkerClient.httpRequest`** (CORS-validated against `api.github.com` on Capacitor Android). The Settings-tab connection probe is the one allowed exception — it uses `requestUrl` directly so a click never touches plugin state.
- **Modify-in-place uses `vault.modifyBinary` + a `.sync-tmp.` marker for crash safety.** When the engine writes to a file that already exists as a TFile, `atomicWriteFile` takes a fast path that preserves any open editor's cursor + scroll position. Protocol: stage new bytes in `<file>.sync-tmp.<ext>` → drop a zero-byte marker at `.<basename>.sync-tmp.` (leading + trailing dot — syntactically distinct from staging files) → `modifyBinary(target, newBytes)` → cleanup. On crash, `AtomicWriteRecovery.sweep` sees the marker, renames sync-tmp over the target (forward-complete), and removes the marker. Recovery runs at plugin onload BEFORE `workspace.onLayoutReady` so the rename's editor-close side effect is moot. The rename strategy still runs for brand-new files (no existing TFile to modify); SHA-based recovery handles its `.sync-bak` orphans, unchanged from 2.0.1.
- **`syncStartsWithCommit` master toggle controls all sync surfaces (default `true`).** Manual `[Sync]` click, interval tick, and startup sync all branch on this single setting. `true` → commit + drain (today's manual-click semantic; preserves backward compat). `false` → drain only; commit becomes the user's separate action via the `[Commit]` ribbon button or the `commit-local` command. The `showCommitRibbonButton` toggle controls the ribbon icon independently — it's a UI affordance, not a semantic.
- **`atomicWriteFile` is invoked from many places. Settings-tab UI text should NOT name engine concepts ("drain", "queue", "batch") — use plain English for users.** Engine identifiers (cancelDrain, DrainStatus, setDrainStatusListener) stay as code-level jargon because they're API names, not user copy. Stage 7 specifically swapped UI copy: "Drain status" → "GitHub sync status", "Stop drain" → "Stop sync", "Drain running" → "Syncing with GitHub".
- **`drainOnce` is the ONLY engine entry point; `Sync2Manager` is a thin shell over it.** Everything the old manager did itself (its own drain, pull, tree building, conflict machinery, bootstrap, `reconcileRemoteIdentity`, `recoverPushInflight`) is deleted; `push-queue.ts`, `tree-builder.ts`, `conflict-store.ts` v1, `conflict-classifier.ts`, `conflict-detection.ts`, `push-inflight.ts` and `pending-deletions-store.ts` no longer exist. Commit is a SINGLETON with a coalescing bell (SYNC2-FIX §6 R3a); commit↔drain is the R3b `.attempted-commit` Peterson protocol, NOT a sleep.
- **`drain()` is re-entrant-safe via a `running` flag** on `Sync2Manager`. Concurrent `syncAll()` calls (e.g. interval tick fires while user click is mid-flight) collapse into one drain — the second call returns immediately. Don't bypass this with a separate code path; the integration suite's H3 test pins the serialisation.
- **Commit messages are hardcoded** in `src/sync2/commit-message.ts` (`formatSyncMessage`, `formatResolveConflictMessage`, etc.) — format `Sync at <local-time+offset> (deviceLabel)`. Don't reintroduce a per-user template field — the design choice was deliberate. The **local-commit timestamp lives in the message body on purpose**: sync2 commits locally (batch `createdAt`) but pushes later, so ⚠️ **UPDATED at THE SWITCH (owner decision, 2026-08-31):** the engine now INJECTS `author`+`committer` with `date = batch.createdAt` on main pushes (`now()` on conflict pushes and the FINALIZE merge), so git's own dates record the local commit moment too. Reason: `getCommitInfoForPath` feeds `committer.date` into `remote.mtime`, so the `.obsidian` mtime tiebreak (§II.1 п.3.b — the ONE place mtimes are compared) then compares EDIT time against EDIT time; with push time a device that edited earlier but pushed later would wrongly win. The in-message timestamp still carries the local moment independently and makes every message unique/greppable. Provenance lives in the trailing `(deviceLabel)`, which `parseDeviceSuffix` recovers — keep the trailing-label contract intact. Rationale + the rejected "set author date" alternative: SYNC2.md §4.4.
- **When working on conflict resolution OR the push pipeline OR cross-cutting infrastructure** (cross-platform contracts in `cross-platform.ts`, typed errors in `errors.ts`, skip-class annotations in any loop), [`docs/SYNC2.md`](../../docs/SYNC2.md) is the canonical engine spec the code targets, and [`docs/PSEUDO-MERGE-MODE.md`](../../docs/PSEUDO-MERGE-MODE.md) is the algorithm it realises. Code comments reference SYNC2.md section numbers (e.g. `SYNC2 §2.4` sibling staging, `SYNC2 §3` cross-platform contracts, `SYNC2 §4.1` pre-flight validation, `SYNC2 §5` error taxonomy, `SYNC2 §6` skip-class) and PSEUDO-MERGE-MODE.md numbers for algorithmic concepts (e.g. `§8 Scenario E`); use those to navigate between code and design rationale. The bug catalog in `SYNC2 §7 Field Postmortems` is the triage index for similar future symptoms.
