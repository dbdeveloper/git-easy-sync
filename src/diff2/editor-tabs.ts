// S1 of the panel/editor split (docs/tasks/SPLIT-PANEL-EDITOR-FEASIBILITY.md §12).
//
// Pure helpers for the multi-tab `diff2-editor-view`: the origin tag, the
// per-origin write-set derivation, and the open-guard core. NO Obsidian runtime
// here — only `normalizePath` (a pure string helper). The S4 Obsidian adapter
// maps open leaves → `OpenEditorDesc[]` and the `OpenGuardResult` → focus /
// dialog / create-leaf; this module is everything that can be unit-tested
// without a workspace.
//
import { normalizePath } from "obsidian";

// §8 / §10 — where a diff2-editor came from. Routes `[←]` navigation (R-D) and
// selects the write-set (below). Phase 1 only ever constructs `conflict`; the
// other three are forward-design (cost nothing now, no rewrite when they land).
export type DiffEditorOrigin = "conflict" | "compare" | "history" | "deleted";

// The getState/setState shape for a `diff2-editor-view` leaf (S3 — the first
// consumer is `DiffEditorView.setState`). Deliberately MINIMAL: the sibling path
// is the identity key, and the full `ConflictEntry` (deviceLabel / isoTimestamp /
// kind / record) is RE-DERIVED from it via `entryFromSibling` at mount — so it
// never drifts from the live ConflictStore (R-C minimal-state principle).
// `basePath` is the R-D navigation anchor (= base for a conflict; S5 reads it).
// History/Deleted/Compare layer their own fields on later; for Phase 1 every
// state is `origin: "conflict"`.
//
// NB it is `getState`-serialized (so an in-session leaf-move preserves the tab);
// 1B adds restart-restore. Any consumer that rebuilds from this MUST treat
// `siblingPath` as untrusted (Obsidian rebuilds a moved leaf via `setState({})`
// before the real state lands) — guard `typeof siblingPath === "string"` before
// `parseSiblingFilename`, which throws on a non-string.
export interface EditorTabState {
  origin: DiffEditorOrigin;
  basePath: string;
  siblingPath: string;
}

// The vault files a diff2-editor WRITES when its `[←]` commits (§3 / §10 table).
// Paths are normalized so the open-guard's string compare can never miss a real
// overlap on a normalization mismatch (advisor flag #1 — this is the one place a
// bug defeats the whole guard).
//
//   conflict — pair-atomic `commit7Step` writes BOTH base and sibling.
//   history  — base is a read-only historical version; only the current file
//              (sibling) is written.
//   deleted  — sibling is read-only trash content; only the vault path (base =
//              originalPath) is written.
//   compare  — TODO(Compare phase): the real write-set is the single edit-target,
//              not both. Lock-both is the conservative placeholder; it over-locks
//              (never under-locks), so it is safe until Compare is designed.
export function writeSetFor(
  origin: DiffEditorOrigin,
  basePath: string,
  siblingPath: string,
): string[] {
  const base = normalizePath(basePath);
  const sibling = normalizePath(siblingPath);
  switch (origin) {
    case "conflict":
      return [base, sibling];
    case "history":
      return [sibling];
    case "deleted":
      return [base];
    case "compare":
      return [base, sibling]; // provisional — Compare phase revisits (edit-target only)
  }
}

// ── open-guard core (R-B) ───────────────────────────────────────────────────
// Pure over descriptors. `autosaveId` is the SAME-PAIR identity key (it unifies
// tracked / synthetic / history / deleted and folds the swapped `sibling+base`
// case via `deriveAutosaveId`'s sort). The write-set intersection is the SAFETY
// NET behind it: if two opens of the same files ever derive DIFFERENT ids (e.g. a
// tracked→synthetic transition between opens), the same-pair check misses and we
// fall through to the overlap branch → "busy" dialog, NEVER to two editors
// writing the same file. Two-layer by design.

export interface OpenEditorDesc {
  autosaveId: string;
  // Normalized write-set of an already-open editor (produced by `writeSetFor`).
  writeSet: readonly string[];
}

export interface OpenRequest {
  autosaveId: string;
  writeSet: readonly string[];
}

// `which` indexes into the `open[]` array passed to `openGuard` — a wiring
// contract the S4 adapter must honour: build `open[]` from `getLeavesOfType` and
// resolve `which` against THAT SAME array (don't reorder between the two).
export type OpenGuardResult =
  | { action: "open" }
  | { action: "focus"; which: number } // same pair already open → reveal it
  | { action: "dialog"; busyFile: string; which: number }; // partial overlap → [Switch]/[Cancel]

export function openGuard(
  open: readonly OpenEditorDesc[],
  req: OpenRequest,
): OpenGuardResult {
  // (1) Same unordered pair already open (incl. swapped) → focus, no dialog.
  const same = open.findIndex((e) => e.autosaveId === req.autosaveId);
  if (same >= 0) return { action: "focus", which: same };
  // (2) Partial write-set overlap with a DIFFERENT pair → busy dialog. Report the
  // first shared file and the first offending editor (deterministic).
  for (let i = 0; i < open.length; i++) {
    const shared = req.writeSet.find((f) => open[i].writeSet.includes(f));
    if (shared !== undefined) return { action: "dialog", busyFile: shared, which: i };
  }
  // (3) No conflict — open a new editor tab.
  return { action: "open" };
}
