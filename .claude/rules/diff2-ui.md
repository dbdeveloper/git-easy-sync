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

- **When working on `src/diff2/`**, [`docs/DIFF2_IMPLEMENTATION_PLAN.md`](../../docs/DIFF2_IMPLEMENTATION_PLAN.md) is the canonical spec. Diff2 is **purely additive UI/UX on top of pseudo-merge mode**: it must not change `ConflictStore` semantics, never bypass Phase A/B at drain start, and never push commits / mutate the conflict branch directly (that's `sync2-manager`'s job). The two operations diff2 may perform on the vault are (a) write base-file bytes through `atomicWriteFile`, and (b) `adapter.remove(siblingPath)` as the R7.11 proactive-cleanup step when `SHA(base) == SHA(sibling)`. Everything else is a `sync2/` concern that diff2 only observes.
- **Diff2 → sync2 dependency direction.** When `src/diff2/` modules start landing, they may import from `src/sync2/` (read `ConflictStore`, subscribe to `ConflictCounter`, observe `Sync2Manager` events). But **`src/sync2/` must never import from `src/diff2/`**. This keeps the sync engine buildable and testable without the UI layer (e.g., for sync-only regression runs and for the existing integration suite), and preserves the option to ship `src/diff2/` as a separate plugin later. Any new edge in `src/sync2/*.ts` that imports `../diff2/...` is a regression — surface it instead of bridging.
