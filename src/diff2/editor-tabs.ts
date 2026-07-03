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
import type { DiffEditSubTab } from "./events";

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
  // 1B (R-C2) — TRANSIENT, never persisted (see persistedEditorState). `openEditorForPair`
  // sets it on a user-initiated open so the editor shows the ResumeRecoveryModal; a RESTORED
  // leaf (Obsidian re-serializing getState) never carries it → its resume is SILENT.
  openMode?: "user";
}

// The persisted shape of an editor leaf (1B getState). STRIPS the transient `openMode`, so
// a restore is always a silent continuation — if openMode leaked into getState, every
// restart would pop the resume modal. The single chokepoint for "what survives to disk".
export function persistedEditorState(s: EditorTabState): EditorTabState {
  return { origin: s.origin, basePath: s.basePath, siblingPath: s.siblingPath };
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

// ── `[←]` back-navigation (R-D, S5) ─────────────────────────────────────────
// Where the editor's `[←]` lands after a commit, by origin. Pure — main.ts computes
// `baseHasConflicts` (impure, via findAllConflicts) and EXECUTES the result (reveal
// the panel leaf + sub-tab + scroll).

export type BackNav =
  // The singleton diff-panel (conflict / deleted origins).
  | {
      kind: "panel";
      tab: DiffEditSubTab;
      // The base group to scroll to (conflict origin, base still has siblings), or
      // null → just focus the list (the last sibling was resolved, the row is gone).
      scrollToBase: string | null;
    }
  // 7a.1 — the per-file `diff2-history` view (history origin). `[←]` reveals/opens
  // the history list for `anchorPath` (= currentFile). NOT the panel: History is a
  // separate view-type, and its target tab is per-file (may be closed). The executor
  // wiring lands in 7a.3; compare → a normal file tab will add its own kind later.
  | { kind: "history"; anchorPath: string };

export function planBackNav(
  origin: DiffEditorOrigin,
  anchorPath: string,
  baseHasConflicts: boolean,
): BackNav {
  if (origin === "history") return { kind: "history", anchorPath };
  if (origin === "deleted") return { kind: "panel", tab: "deleted", scrollToBase: null };
  // conflict (Phase 1) → panel:Conflicts, scroll to the base group if it still has
  // siblings (R-D), else just focus. compare still falls through here (over-general,
  // but Phase 1 never constructs it — it gets its own file-tab kind when it lands).
  return {
    kind: "panel",
    tab: "conflicts",
    scrollToBase: baseHasConflicts ? anchorPath : null,
  };
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

// ── S4 adapter helpers (pure — the Obsidian leaf glue around them is not) ─────

// Build the OpenEditorDesc / OpenRequest for a pair. The SINGLE chokepoint that
// produces a write-set, so BOTH call sites (the request being opened AND every
// already-open editor's descriptor) route through `writeSetFor` — the open-guard's
// overlap compare can then never be fed raw, un-normalized paths (S1 forward-flag).
// `autosaveId` is threaded in: its derivation (`autosaveIdForEntry`) lives in
// synthetic-detector, which depends on the ConflictStore — kept out of this pure module.
export function openDescFor(
  origin: DiffEditorOrigin,
  basePath: string,
  siblingPath: string,
  autosaveId: string,
): OpenEditorDesc {
  return { autosaveId, writeSet: writeSetFor(origin, basePath, siblingPath) };
}

// An "inert" descriptor for a leaf whose pair can't be resolved (mid-open, or a
// stale/hand-edited state): the empty autosaveId never equals a real one and the
// empty write-set shares no file, so openGuard treats it as no-match — while KEEPING
// the slot so the array stays index-aligned with getLeavesOfType.
const INERT_DESC: OpenEditorDesc = { autosaveId: "", writeSet: [] };

// Map per-leaf descriptors (null = unresolvable) to an index-ALIGNED OpenEditorDesc[].
// 🔴 NEVER `.filter(Boolean)` this: openGuard's `which` indexes back into the SAME
// getLeavesOfType array, so dropping a slot would focus / "switch to" the WRONG tab.
// The inert placeholder keeps indices honest.
export function alignOpenDescs(
  perLeaf: readonly (OpenEditorDesc | null)[],
): OpenEditorDesc[] {
  return perLeaf.map((d) => d ?? INERT_DESC);
}

// 7a.2 — per-file open-guard for the diff2-history view. main.ts maps
// getLeavesOfType("diff2-history") → each leaf's path (null while a leaf is
// mid-rebuild — the transient empty getState on a split), and resolves the
// returned index against THAT SAME array to reveal the existing tab. A null slot
// never matches, so a split's empty phase can't alias a live tab. Pure sibling of
// openGuard — kept here (not in the ItemView module) so it is unit-testable
// without an Obsidian runtime.
export function findExistingHistoryLeaf(
  paths: readonly (string | null)[],
  path: string,
): number {
  return paths.findIndex((p) => p === path);
}

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
