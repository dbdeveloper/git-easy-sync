// Navigation / state-tag types for the Diff-Edit widget.
//
// Phase 0 ships the minimal type surface needed for DiffEditView to
// have a stable state shape. Later phases will populate this module
// with concrete event types as features land:
//   - Phase 3 — DiffPaneAction events (apply/remove/join per chunk)
//   - Phase 5 — RecoveryCompleted event (autosave restored)
//   - Phase 6 — DetailViewOpen/DetailViewClose events (consumed by
//     Phase 9b's last-tab-close hook that triggers
//     trashStore.resetLifts() — see R3.7 invariant)
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.0 (single-pane shell)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.7 (entry-points + sub-tabs)

// Sub-tabs shown in the view-tab header when the view is opened in
// its "global" mode (Conflicts / Deleted lists). Compare and History
// are file-bound and open as one-shot detail sessions WITHOUT
// sub-tabs (R2.7 asymmetry).
export type DiffEditSubTab = "conflicts" | "deleted";

