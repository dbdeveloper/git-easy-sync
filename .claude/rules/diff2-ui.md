---
paths:
  - "src/diff2/**"
---

# Conflict-resolution UI rules (diff2)

Loaded automatically when you work on the diff2 UI layer.

**Current state / resume point:** memory `project-diff2-resume-point` +
[`docs/tasks/DIFF-EDITOR-V2.md`](../../docs/tasks/DIFF-EDITOR-V2.md). That is the live
truth — not any prose here. Historical build detail is archived in
[`docs/BUILDLOG.md`](../../docs/BUILDLOG.md).

Canonical specs for diff2 (the design docs the code targets):

- [`docs/tasks/DIFF-EDITOR-V2.md`](../../docs/tasks/DIFF-EDITOR-V2.md) — the diff-edit model + interaction.
- [`docs/tasks/DIFF-EDITOR.md`](../../docs/tasks/DIFF-EDITOR.md) — the representation-independent commit / recovery / autosave layer.
- [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](../../docs/DIFF2_IMPLEMENTATION_PLAN.md) — the surrounding UX architecture.
- [`docs/tasks/HISTORY-DELETED.md`](../../docs/tasks/HISTORY-DELETED.md) — canonical spec for the still-unbuilt History / Deleted modes.

The algorithm diff2 renders is in [`docs/PSEUDO-MERGE-MODE.md`](../../docs/PSEUDO-MERGE-MODE.md); the engine underneath is in [`docs/SYNC2.md`](../../docs/SYNC2.md).

---

## Constraints

- **When working on `src/diff2/`**, [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](../../docs/DIFF2_IMPLEMENTATION_PLAN.md) is the canonical spec. Diff2 is **purely additive UI/UX on top of pseudo-merge mode**: it must not change conflict-store semantics, never bypass the conflict reconcile at drain start, and never push commits / mutate the conflict branch directly (that's the engine's job). ⚠️ **Store: `ConflictStoreV2` (`conflicts.json`)** — v1 `conflict-store.ts` and the Phase A/B classifier were DELETED at Phase 5.5 THE SWITCH (2026-08-31); the reconciler is now `process-conflicts.ts`, and the UI reads the v2 cached view (`hasBase` / `getBySiblingPath` / `getCachedState`). The two operations diff2 may perform on the vault are (a) write base-file bytes through `atomicWriteFile`, and (b) `adapter.remove(siblingPath)` as the R7.11 proactive-cleanup step when `SHA(base) == SHA(sibling)`. Everything else is a `sync2/` concern that diff2 only observes.
- **Diff2 → sync2 dependency direction.** When `src/diff2/` modules start landing, they may import from `src/sync2/` (read `ConflictStoreV2`, subscribe to `ConflictCounter`, observe `Sync2Manager` events). But **`src/sync2/` must never import from `src/diff2/`**. This keeps the sync engine buildable and testable without the UI layer (e.g., for sync-only regression runs and for the existing integration suite), and preserves the option to ship `src/diff2/` as a separate plugin later. Any new edge in `src/sync2/*.ts` that imports `../diff2/...` is a regression — surface it instead of bridging.
