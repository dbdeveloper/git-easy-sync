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
  return entry.kind === "tracked" && entry.record
    ? trackedAutosaveId(entry.record.id)
    : deriveAutosaveId("synthetic", entry.basePath, entry.siblingPath);
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
    const parsed = parseSiblingFilename(file.path);
    if (!parsed) continue; // not a sibling

    // NOTE (2026-06-18): an ABSENT base is NO LONGER skipped. A sibling whose base
    // file is missing is a delete-vs-modify conflict (base deleted, sibling holds
    // the other side) — both TRACKED (R2.5) and SYNTHETIC. It is LISTED so the user
    // can resolve it via the panel (delete the sibling → deletion wins; or keep its
    // content). This reverses the old R3.3-rule-3 "orphan sibling without base has
    // nothing to diff against — skip it"; the diff editor renders the ours side
    // empty (mountDiffPane reads "" when basePath is absent). Genuine leftover
    // siblings now surface too, by design — the user clears them from the panel.
    const record = conflictStore.getBySibling(file.path);
    entries.push({
      basePath: parsed.basePath,
      siblingPath: file.path,
      deviceLabel: parsed.deviceLabel,
      isoTimestamp: parsed.isoTimestamp,
      kind: record ? "tracked" : "synthetic",
      record,
    });
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
