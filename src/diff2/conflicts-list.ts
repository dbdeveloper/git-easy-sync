// Conflicts list — UI rendering for R2.2 "Conflicts list view".
//
// Phase 1 ships the list view shell:
//   - Section heading.
//   - Group-by-path expandable rows (one row per base file; nested
//     list of sibling versions for multi-sibling case — Scenario C
//     of PSEUDO-MERGE-MODE §8).
//   - Per-sibling row: device label, timestamp, tracked/synthetic
//     badge, click handler.
//
// Group-toolbar buttons ([Keep all local] / [Apply all remote] /
// [Join all]) land in Phase 3 with the chunk-action wiring — Phase 1
// only renders the list, click opens the detail-view placeholder.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R9.1 Phase 1 acceptance

import type { ConflictEntry } from "./synthetic-detector";
import { formatConflictTimestamp } from "./strip-conflict-suffix";

export interface ConflictsListCallbacks {
  // Fires when user clicks a sibling row. Receives base + sibling paths so the caller
  // (DiffPanelView) can open a diff2-editor tab for the pair. toRight (Ctrl/⌘ + click) → open
  // to the right of the panel window.
  onEntryClick: (entry: ConflictEntry, toRight?: boolean) => void;
}

// A rendered conflict row paired with its entry, in VISUAL (grouped) order — the list the
// panel's keyboard nav walks. File-name group HEADERS are not refs, so arrows/Home/End/PgUp/
// PgDn skip them automatically (they land only on date + deviceLabel entry rows).
export interface ConflictRowRef {
  entry: ConflictEntry;
  row: HTMLElement;
}

// Stable per-conflict identity (the sibling path is unique) for persisting the panel selection.
export function conflictKey(e: ConflictEntry): string {
  return e.siblingPath;
}

// Render the conflicts list into the supplied container. Idempotent:
// clears the container first so this can be called on every refresh
// (e.g. after a ConflictCounter notify) without leaking stale DOM.
export function renderConflictsList(
  container: HTMLElement,
  entries: ConflictEntry[],
  callbacks: ConflictsListCallbacks,
  selectedKey?: string | null,
): ConflictRowRef[] {
  container.empty();
  container.addClass("diff2-conflicts-list");

  if (entries.length === 0) {
    container.createDiv({
      cls: "diff2-conflicts-empty",
      text: "No pending conflicts.",
    });
    return [];
  }

  // Group by basePath, preserving newest-first order. Map insertion
  // order corresponds to the input order, which findAllConflicts
  // already sorts newest-first → group iteration also newest-first.
  const grouped = new Map<string, ConflictEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.basePath);
    if (bucket) bucket.push(entry);
    else grouped.set(entry.basePath, [entry]);
  }

  const refs: ConflictRowRef[] = [];
  for (const [basePath, group] of grouped.entries()) {
    renderBaseGroup(container, basePath, group, callbacks, refs);
  }
  if (selectedKey) {
    for (const r of refs) {
      r.row.classList.toggle(
        "diff2-conflicts-row-selected",
        conflictKey(r.entry) === selectedKey,
      );
    }
  }
  return refs;
}

function renderBaseGroup(
  container: HTMLElement,
  basePath: string,
  group: ConflictEntry[],
  callbacks: ConflictsListCallbacks,
  refs: ConflictRowRef[],
): void {
  const groupEl = container.createDiv({ cls: "diff2-conflicts-group" });

  // Header line: <basePath> · (N versions). When N === 1, omit the
  // count — single-sibling case shouldn't read as "1 version".
  const header = groupEl.createDiv({ cls: "diff2-conflicts-group-header" });
  header.createSpan({ cls: "diff2-conflicts-base-path", text: basePath });
  if (group.length > 1) {
    header.createSpan({
      cls: "diff2-conflicts-version-count",
      text: ` · ${group.length} versions`,
    });
  }

  // List of sibling rows. Phase 1 renders ALL siblings flat (no
  // collapse/expand) — that's a tiny additional iteration in Phase 6
  // when entry-point + accordion work lands. R2.2 calls for
  // "expandable rows"; v1 is "always expanded".
  const rows = groupEl.createDiv({ cls: "diff2-conflicts-rows" });
  for (const entry of group) {
    refs.push({ entry, row: renderEntryRow(rows, entry, callbacks) });
  }
}

function renderEntryRow(
  parent: HTMLElement,
  entry: ConflictEntry,
  callbacks: ConflictsListCallbacks,
): HTMLElement {
  const row = parent.createDiv({
    cls: `diff2-conflicts-row diff2-conflicts-row-${entry.kind}`,
  });
  row.setAttribute("data-base-path", entry.basePath);
  row.setAttribute("data-sibling-path", entry.siblingPath);
  row.style.cursor = "pointer";

  // Device + timestamp inline; both come straight from the parsed
  // sibling filename (display-friendly bracket form for parens, and
  // the 20-char ISO-shape timestamp as-is).
  const meta = row.createSpan({ cls: "diff2-conflicts-row-meta" });
  meta.createSpan({
    cls: "diff2-conflicts-device-label",
    text: entry.deviceLabel,
  });
  meta.createSpan({
    cls: "diff2-conflicts-timestamp",
    text: ` · ${formatConflictTimestamp(entry.isoTimestamp)}`,
  });

  // Badge distinguishes tracked (registered conflict) from synthetic
  // (vault-only, no ConflictStore record — R3.3 rule 3).
  row.createSpan({
    cls: `diff2-conflicts-badge diff2-conflicts-badge-${entry.kind}`,
    text: entry.kind === "tracked" ? "tracked" : "synthetic",
  });

  row.addEventListener("click", (e) => {
    callbacks.onEntryClick(entry, e.ctrlKey); // Ctrl+Click → open to the right
  });
  // macOS turns Ctrl+Click into a system secondary-click → it arrives as `contextmenu`. Treat a
  // Ctrl one as open-to-the-right so Ctrl+Click works on Mac too; a plain right-click is untouched.
  row.addEventListener("contextmenu", (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      callbacks.onEntryClick(entry, true);
    }
  });
  return row;
}
