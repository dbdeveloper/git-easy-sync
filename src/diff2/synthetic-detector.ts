// Synthetic-conflict detection.
//
// Walks the vault for `*.conflict-from-*` sibling files and
// categorises each as tracked vs synthetic per R2.2 / R3.3:
//
//   - Tracked   — sibling that is registered in the ConflictStore
//     (matching record found via getBySibling). These siblings arose
//     normally during a drain's Phase A/B conflict registration.
//   - Synthetic — sibling whose ConflictStore record is missing,
//     usually because the user moved the (base, sibling) pair into a
//     new folder. Phase A's "drop record if sibling missing" rule
//     fires on the old path, leaving a vault-level pair without any
//     record at the new path (R3.3 rule 3).
//
// Orphan siblings (no base file in vault) are NOT returned — there's
// nothing to diff against. The R3.3 "edge cases" closing bullet is
// explicit about this; existing ConflictStore orphan cleanup handles
// the case from a different angle.
//
// Canonical specs:
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R2.2 (conflicts list)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.3 (three rules + edge cases)
//   - docs/DIFF2_IMPLEMENTATION_PLAN.md §R9.1 Phase 1 acceptance
//
// Pure module — no side effects. Inputs: vault (for getFiles +
// exists checks), conflictStore (for record lookup). Outputs:
// categorised list of conflict entries.

import type { Vault } from "obsidian";
import type ConflictStore from "../sync2/conflict-store";
import type { ConflictRecord } from "../sync2/conflict-store";
import { parseSiblingFilename } from "./strip-conflict-suffix";
import { deriveAutosaveId, trackedAutosaveId } from "./autosave-store";

export type ConflictEntryKind = "tracked" | "synthetic";

export interface ConflictEntry {
  // Vault-relative path of the base file (e.g. "Notes/idea.md").
  basePath: string;
  // Vault-relative path of the sibling file
  // (e.g. "Notes/idea.conflict-from-Phone-2026-05-26T10-30-00Z.md").
  siblingPath: string;
  // Remote-device label as encoded into the sibling filename
  // (bracket-sanitized form; "Phone (1)" → "Phone [1]" per
  // buildSiblingPath).
  deviceLabel: string;
  // 20-char ISO-shape timestamp from the sibling filename
  // ("YYYY-MM-DDTHH-MM-SSZ"). Display-only string; convert to Date
  // separately if needed.
  isoTimestamp: string;
  // Whether this sibling has a matching ConflictStore record.
  kind: ConflictEntryKind;
  // Present only when kind === "tracked".
  record?: ConflictRecord;
  // 7a.3 (History) — the version's identity (commit-sha or push-queue batchId).
  // Present ONLY for a history entry (base===sibling===currentFile); it is the
  // discriminator that gives each VERSION of one file its own autosave dir (two
  // versions must not share a session — the 7a.1 GATE). Absent for conflicts.
  historyVersionSha?: string;
}

// The autosave id for a conflict entry — the key for its
// `.diff2-autosave/<id>/` session dir. MUST be derived identically at mount
// (startSession) and at reopen (classifyReopen), so it is a pure, ordered,
// side-effect-free function of the entry: tracked conflicts key off their
// stable ConflictStore record id; synthetic conflicts off the (sorted)
// base+sibling path pair. The reopen path keys off the on-disk dir name (not
// this), but a view that re-derives the id for the SAME entry must land on the
// same dir. DIFF-EDITOR.md §2.4 / §2.4.1.
export function autosaveIdForEntry(entry: ConflictEntry): string {
  // §4.5.2 (A1) — a History session is keyed PER-FILE, NOT per-version: one session
  // per currentFile, so opening a different version of the same file lands on the
  // same session (→ the "file already being edited" open-guard, §4.5.5). The version
  // does NOT discriminate the dir. `historyVersionSha` stays on the entry only as the
  // "this is a History entry" marker (set solely for History) + to fetch bytes; it is
  // NOT part of the id. Checked BEFORE the path-pair branch. The "history" kind-prefix
  // keeps it distinct from a same-file synthetic conflict.
  if (entry.historyVersionSha !== undefined) {
    return deriveAutosaveId("history", entry.basePath, entry.basePath);
  }
  return entry.kind === "tracked" && entry.record
    ? trackedAutosaveId(entry.record.id)
    : deriveAutosaveId("synthetic", entry.basePath, entry.siblingPath);
}

// Reconstruct a single `ConflictEntry` from a sibling path — the loop body of
// `findAllConflicts`, lifted so callers that already KNOW the sibling path (the
// split's S4 row-click → `openEditorForPair`, and the Phase-1B `setState`
// restore) rebuild the entry without re-walking the vault. Returns null when the
// path is not a `*.conflict-from-*` sibling. An ABSENT base is NOT rejected (it
// is a delete-vs-modify conflict — see the NOTE in `findAllConflicts`).
export function entryFromSibling(
  conflictStore: ConflictStore,
  siblingPath: string,
): ConflictEntry | null {
  const parsed = parseSiblingFilename(siblingPath);
  if (!parsed) return null;
  const record = conflictStore.getBySibling(siblingPath);
  return {
    basePath: parsed.basePath,
    siblingPath,
    deviceLabel: parsed.deviceLabel,
    isoTimestamp: parsed.isoTimestamp,
    kind: record ? "tracked" : "synthetic",
    record,
  };
}

export interface DetectionResult {
  // All entries, sorted newest-first by isoTimestamp.
  entries: ConflictEntry[];
  // Convenience grouping for R2.2 "group-by-path expandable rows".
  // basePath → entries[] (sorted newest-first within each group).
  byBasePath: Map<string, ConflictEntry[]>;
}

// Find every (base, sibling) pair currently in the vault and classify
// it. Empty result is a valid outcome (vault has no conflicts).
export function findAllConflicts(
  vault: Vault,
  conflictStore: ConflictStore,
): DetectionResult {
  const entries: ConflictEntry[] = [];
  const files = vault.getFiles();

  for (const file of files) {
    // NOTE (2026-06-18): an ABSENT base is NO LONGER skipped. A sibling whose base
    // file is missing is a delete-vs-modify conflict (base deleted, sibling holds
    // the other side) — both TRACKED (R2.5) and SYNTHETIC. It is LISTED so the user
    // can resolve it via the panel (delete the sibling → deletion wins; or keep its
    // content). This reverses the old R3.3-rule-3 "orphan sibling without base has
    // nothing to diff against — skip it"; the diff editor renders the ours side
    // empty (mountDiffPane reads "" when basePath is absent). Genuine leftover
    // siblings now surface too, by design — the user clears them from the panel.
    const entry = entryFromSibling(conflictStore, file.path);
    if (!entry) continue; // not a sibling
    entries.push(entry);
  }

  // Newest-first by isoTimestamp. The string itself is lex-sortable
  // (YYYY-MM-DDTHH-MM-SSZ); reverse for descending order.
  entries.sort((a, b) => b.isoTimestamp.localeCompare(a.isoTimestamp));

  // Group-by-base index for R2.2 multi-sibling expandable rows.
  // Entries inside each group preserve the newest-first ordering
  // from the global sort.
  const byBasePath = new Map<string, ConflictEntry[]>();
  for (const entry of entries) {
    const bucket = byBasePath.get(entry.basePath);
    if (bucket) bucket.push(entry);
    else byBasePath.set(entry.basePath, [entry]);
  }

  return { entries, byBasePath };
}

// The pre-sync conflict gate's summary (main.ts confirmPendingConflictsBeforeSync).
// SOURCED FROM findAllConflicts — the live vault siblings — NOT the raw ConflictStore
// records. A conflict the user already resolved in diff2 (sibling deleted, base rewritten
// to the merge) keeps its ConflictStore record until the NEXT drain's evaluateConflictState
// drops it (Phase A: !siblingExists → accept-ours); reading the raw records in the gate
// re-surfaced that already-resolved conflict in the "you still have conflicts" modal even
// though the diff-panel no longer showed it. Going through findAllConflicts makes the gate
// list EXACTLY what the panel / badge / status bar list.
//
// TODO §24 — the gate/modal is about TRACKED conflicts ONLY. Only a tracked conflict (a
// real git conflict registered in ConflictStore) is invisible on other devices until
// resolved; a SYNTHETIC conflict is a purely-local leftover (an echo of an already-resolved
// conflict — GitHub knows nothing about it), so it carries no cross-device consequence and
// must NOT block a sync or trigger the "not visible on other devices" warning. So:
//   - `trackedPaths` = base paths that have ≥1 tracked sibling (a base with both tracked +
//     synthetic siblings counts as tracked — resolving it matters).
//   - Returns null when there are NO tracked conflicts (no conflicts at all, OR only
//     synthetic leftovers) → the gate lets the sync proceed with no modal.
// The modal's "Resolve" opens the diff CONFLICTS PANEL (the full list), so no specific
// sibling path is needed here. The badge / status bar / menu still count tracked + synthetic
// (TODO #7) — unchanged; §24 is only the pre-sync modal, so the count surfaces keep total.
//
// `trackedConflictCount` = total number of tracked SIBLINGS across the tracked base(s). One
// base file can carry MORE THAN ONE tracked conflict (multiple `conflict-from-<device>-…`
// siblings — one per remote device). It only matters for the modal's intro copy when there
// is exactly ONE tracked file: 1 file + 1 conflict → "…a tracked conflict…resolve it"; 1
// file + N conflicts → "…tracked conflicts…resolve them" (else the user is told "1 conflict"
// but the panel shows several). With >1 files the copy is uniformly plural, so the exact
// count is not consulted there.
export function pendingConflictSummary(
  vault: Vault,
  conflictStore: ConflictStore,
): { trackedPaths: string[]; trackedConflictCount: number } | null {
  const { byBasePath } = findAllConflicts(vault, conflictStore);
  const trackedPaths: string[] = [];
  let trackedConflictCount = 0;
  for (const [base, siblings] of byBasePath) {
    const tracked = siblings.filter((s) => s.kind === "tracked").length;
    if (tracked > 0) {
      trackedPaths.push(base);
      trackedConflictCount += tracked;
    }
  }
  if (trackedPaths.length === 0) return null; // synthetic-only (or none) → no gate
  return { trackedPaths: trackedPaths.sort(), trackedConflictCount };
}

// Convenience: shape that excludes the file-iteration / vault-walking
// concern, useful in tests where the caller hand-constructs entries
// for assertions on grouping logic.
export function groupByBasePath(
  entries: ConflictEntry[],
): Map<string, ConflictEntry[]> {
  const out = new Map<string, ConflictEntry[]>();
  for (const entry of entries) {
    const bucket = out.get(entry.basePath);
    if (bucket) bucket.push(entry);
    else out.set(entry.basePath, [entry]);
  }
  return out;
}

// Implementation note: TFile-vs-vault.getFiles type — Obsidian's
// vault.getFiles() returns TFile[], not TAbstractFile[]. We treat
// every match as a regular file because conflict-from-* names cannot
// be folders by construction.
