// Public types for src/diff2/. Kept minimal in this PR; expanded as
// later subsystems land (DiffPane chunk-actions, autosave, etc).

// On-disk record under .trash/<id>/meta.json.
//
// Canonical specs: docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.1, §R3.7.
// Field semantics overview:
//

// TrashHooks is defined sync2-side (src/sync2/trash-hooks.ts) so the
// sync engine builds standalone without src/diff2/. diff2 re-exports
// it for callers that already live in diff2 and don't want a longer
// import path. See R9 Phase 9a carve-out.
export type { TrashHooks } from "../sync2/trash-hooks";
