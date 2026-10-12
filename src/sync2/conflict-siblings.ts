// Conflict-sibling file helpers — the §III "допоміжні" of the new
// drain (NEW-DRAIN, pseudocode around buildSiblingFilePath). Phase 2
// primitive; consumed by process_conflicts()/STEP1-3 in Phases 4-5.
//
// The on-disk NAME FORMAT is an invariant that predates this module
// (PSEUDO-MERGE-MODE.md §4.3, produced today by conflict-store v1's
// buildSiblingPath and pinned by the root-gitignore invariant block
// and the diff2 strip-conflict-suffix parser):
//
//   <dir>/<stem>.conflict-from-<label>-<YYYY-MM-DDTHH-MM-SSZ><ext>
//
// buildSiblingFilePath is the SINGLE source of truth for that name —
// write (saveConflictSiblingFile), read (readSiblingFileFromVault)
// and scan (findConflictSiblingFilesInVault) all derive it from the
// same (path, mtime, deviceLabel) triple, so the engine never stores
// the sibling's disk name as a separate field.
//
// FileInfo semantics (§III): `.path` is ALWAYS the BASE file's path
// (P), never the sibling's (owner, 2026-08-25) — with ONE deliberate
// exception: SYNTHETIC entries returned by
// findConflictSiblingFilesInVault carry the on-disk sibling path,
// because a synthetic file's identity IS its disk name (there is no
// tracked record to point back to a base).

import { normalizePath, type Vault } from "obsidian";
import { atomicWriteFile } from "./atomic-write";
import { sanitizeFilename } from "./cross-platform";
import { calculateGitBlobSHA } from "../utils";

// Deep-defense fallback only: every conflict birth site (§III STEP1 /
// pull-folding-refresh / Vault-step-born) lazily fetches the device
// label BEFORE calling saveConflictSiblingFile.
export const UNKNOWN_DEVICE_LABEL = "unknown";

// RESERVED label, and the reason it has to be reserved (DOT-FILES §8.1.5a).
//
// The §8.1 migration writes a sibling whose "device" is not a device at
// all — it is a migration PROPOSAL borrowing the sibling naming
// convention (and through it, the diff editor) as transport. That label
// is how the pre-sync gate tells the class apart: a genuine sibling's
// label names a machine, this one names nothing.
//
// `settings.deviceLabel` is user-settable, so a machine carrying this
// exact label would emit REAL siblings the gate would read as migration
// proposals — and the gate refuses to sync while one exists. Hence the
// label is taken out of the user's reach, by amendment rather than
// rejection: an input that equals it gets the suffix below.
export const MIGRATION_DEVICE_LABEL = "Old gitignore files";

// U+2047 DOUBLE QUESTION MARK — one char, not "??", because
// buildSiblingFilePath does NOT run the label through sanitizeFilename
// (it only maps parens), so a raw `?` would land in a filename where
// FORBIDDEN_REGEX lists it as Windows FAT/NTFS-invalid. A Unicode
// stand-in is the same trick sanitizeFilename itself uses (`?` → `？`);
// this is the glyph the status bar already carries for "unresolved".
const RESERVED_LABEL_AMENDMENT = " (What⁇)";

// Keep a user-entered device label clear of the reserved one. Exact
// match only: the gate compares exactly too, so a different casing is
// already a different label and needs no amendment. Idempotent — an
// already-amended label no longer equals the reserved string.
export function deconflictDeviceLabel(label: string): string {
  return label === MIGRATION_DEVICE_LABEL
    ? label + RESERVED_LABEL_AMENDMENT
    : label;
}

// Narrow slice of the drain's FileInfo this module needs. Field names
// are camelCase per project style; the spec's `device_label` is
// `deviceLabel` here.
export interface SiblingFileInfo {
  // Path of the BASE file (P) — see header for the synthetic
  // exception.
  path: string;
  // The timestamp in the copy's FILE NAME (…conflict-from-<deviceLabel>-
  // <timeLabel>…). With deviceLabel it is the copy's identity: the path is
  // built from the pair. NOT the file's modification time — that is
  // `mtime` (owner, 2026-10-11: one word must mean one thing).
  timeLabel: number;
  // The file's modification time on disk (stat). Set for synthetic copies
  // by the scan.
  mtime?: number | null;
  deviceLabel?: string | null;
  blob?: ArrayBuffer | null;
  sha?: string | null;
  size?: number | null;
}

function splitPath(vaultPath: string): {
  dir: string;
  stem: string;
  ext: string;
} {
  const slash = vaultPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : vaultPath.slice(0, slash + 1);
  const basename = slash === -1 ? vaultPath : vaultPath.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  // A leading dot is a hidden-file name, not an extension — same rule
  // as conflict-store v1's extensionOf.
  const ext = dot > 0 ? basename.slice(dot) : "";
  const stem = ext === "" ? basename : basename.slice(0, -ext.length);
  return { dir, stem, ext };
}

// The extension split rule (leading dot = hidden file, not an
// extension) — v1 conflict-store's extensionOf, re-homed here for the
// Phase 5.5 port (v1 died at THE SWITCH; trash-recovery, its other
// consumer, died with the §5.2.1 re-platform).
export function extensionOf(vaultPath: string): string {
  return splitPath(vaultPath).ext;
}

// "YYYY-MM-DDTHH-MM-SSZ" — the PSEUDO-MERGE-MODE.md timestamp shape
// (ISO with colons/dot made filesystem-safe, milliseconds dropped).
// Byte-identical to what v1's buildSiblingPath produces.
export function formatTimestampForFilename(timeLabel: number): string {
  return new Date(timeLabel)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
}

// Pure — the single source of truth for the sibling's disk name.
export function buildSiblingFilePath(
  basePath: string,
  timeLabel: number,
  deviceLabel?: string | null,
): string {
  const { dir, stem, ext } = splitPath(basePath);
  // The label is part of a FILENAME, so it must survive the same
  // character rules every other vault path does — a user is free to type
  // `My PC?` or `A[1]` into the Device-label field, and before this ran
  // through sanitizeFilename those characters reached the filesystem
  // raw. On Windows/Android the write then fails outright; on macOS it
  // succeeds and produces a file the other platforms cannot represent.
  //
  // ⚠️ ORDER IS LOAD-BEARING: sanitize FIRST, replace parens SECOND.
  // The paren rule exists for the commit-message grammar (so
  // parseDeviceSuffix's trailing " (label)" stays unambiguous) and it
  // PRODUCES `[`/`]`, which are themselves in FORBIDDEN_TO_CANONICAL.
  // Sanitizing afterwards would rewrite them to ［］ and change the
  // derived name of every sibling whose label contains parens — i.e. the
  // common "Mac (work)" case — orphaning existing files. This order
  // leaves the paren case byte-identical to what v1 produced and only
  // touches labels that were genuinely unsafe.
  const safeLabel = sanitizeFilename(deviceLabel ?? UNKNOWN_DEVICE_LABEL)
    .replace(/\(/g, "[")
    .replace(/\)/g, "]");
  const ts = formatTimestampForFilename(timeLabel);
  return `${dir}${stem}.conflict-from-${safeLabel}-${ts}${ext}`;
}

// The same naming template with ANY device/timestamp — for the
// synthetic scan. Returned in glob form for spec parity; the scan
// below matches with the anchored regex equivalent.
export function siblingGlobPattern(basePath: string): string {
  const { dir, stem, ext } = splitPath(basePath);
  return `${dir}${stem}.conflict-from-*${ext}`;
}

function siblingNameRegex(basePath: string): RegExp {
  const { dir, stem, ext } = splitPath(basePath);
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // <device> is anything non-empty; the timestamp shape is exact —
  // the same anchor the change-detector's CONFLICT_SIBLING_PATTERN
  // uses, so scan and gitignore agree on what a sibling is.
  return new RegExp(
    `^${esc(dir)}${esc(stem)}\\.conflict-from-.+-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)${esc(ext)}$`,
  );
}

// The inverse of formatTimestampForFilename: "2026-10-11T20-25-53Z" → ms.
// The name carries whole seconds, so this is the timeLabel to the second.
export function timeLabelFromStamp(stamp: string): number {
  const [date, time] = stamp.split("T");
  return Date.parse(`${date}T${time.replace(/-/g, ":")}`);
}

// Reading a copy's name back (moved here from diff2's strip-conflict-suffix,
// owner 2026-10-12, with the synthetic-copy finder: finding conflicts is the
// engine's, not the UI's).
//
//   "<dir>/<stem>.conflict-from-<deviceLabel>-<isoTs><ext>"
//
// `basePath` is the reconstructed base path; `deviceLabel` the label as it
// stands in the name (parens already bracketed); `isoTimestamp` the exact
// 20-character "YYYY-MM-DDTHH-MM-SSZ" substring. null = not a copy's name.
export const SIBLING_PATTERN =
  /^(.+?)\.conflict-from-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(\..+)?$/;

export interface ParsedSibling {
  basePath: string;
  deviceLabel: string;
  isoTimestamp: string;
}

export function parseSiblingFilename(siblingPath: string): ParsedSibling | null {
  const slash = siblingPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : siblingPath.slice(0, slash + 1);
  const basename = slash === -1 ? siblingPath : siblingPath.slice(slash + 1);
  const m = basename.match(SIBLING_PATTERN);
  if (!m) return null;
  const [, stem, deviceLabel, isoTimestamp, ext = ""] = m;
  return { basePath: `${dir}${stem}${ext}`, deviceLabel, isoTimestamp };
}

// Write the sibling's bytes at the derived name. Callers IGNORE the
// return value on purpose (§III): the raw FileInfo (with .path == P)
// goes into the `siblings` list unchanged; the disk name stays
// derived, never stored.
export async function saveConflictSiblingFile(
  vault: Vault,
  fileInfo: SiblingFileInfo,
): Promise<void> {
  if (fileInfo.blob == null) {
    throw new Error(
      `saveConflictSiblingFile: no blob for ${fileInfo.path}`,
    );
  }
  const siblingPath = buildSiblingFilePath(
    fileInfo.path,
    fileInfo.timeLabel,
    fileInfo.deviceLabel,
  );
  // AtomicWrite — the same crash protocol as every vault write
  // (§II.11 relies on it for the STEP3 replace transaction).
  await atomicWriteFile(vault, normalizePath(siblingPath), fileInfo.blob);
}

// Read ONE specific sibling — needs the whole (path, timeLabel,
// deviceLabel) triple, not just the path: every element of a
// `siblings` list shares the same `.path` (== P), only timeLabel+label
// distinguish them (the STEP3 fix recorded in the spec).
export async function readSiblingFileFromVault(
  vault: Vault,
  fileInfo: SiblingFileInfo,
): Promise<ArrayBuffer | null> {
  const siblingPath = normalizePath(
    buildSiblingFilePath(fileInfo.path, fileInfo.timeLabel, fileInfo.deviceLabel),
  );
  if (!(await vault.adapter.exists(siblingPath))) {
    // Same class as LOCAL_FILE_IS_NOT_FOUND downstream — the caller
    // (STEP3) decides what to do.
    return null;
  }
  return vault.adapter.readBinary(siblingPath);
}

export interface SiblingScanResult {
  // Known tracked elements whose derived file is present on disk.
  // Blob is NOT read here — presence only; the SHA checks of
  // process_conflicts() 2.2/2.3 read via readSiblingFileFromVault
  // when actually needed.
  trackedOnDisk: SiblingFileInfo[];
  // Files that LOOK like siblings of this path but aren't among the
  // expected tracked names. `.path` here is the ON-DISK SIBLING path
  // (the documented exception); sha/size/mtime are filled eagerly —
  // synthetic entries are compared by SHA and have no trusted list
  // to check against first.
  synthetic: SiblingFileInfo[];
}

export async function findConflictSiblingFilesInVault(
  vault: Vault,
  basePath: string,
  siblings: SiblingFileInfo[],
): Promise<SiblingScanResult> {
  const trackedOnDisk: SiblingFileInfo[] = [];
  const expectedPaths = new Set<string>();
  for (const s of siblings) {
    const siblingPath = normalizePath(
      buildSiblingFilePath(basePath, s.timeLabel, s.deviceLabel),
    );
    expectedPaths.add(siblingPath);
    if (await vault.adapter.exists(siblingPath)) {
      trackedOnDisk.push(s);
    }
  }

  // Scan the base file's own directory with the anchored pattern.
  const { dir } = splitPath(basePath);
  const listDir = dir === "" ? "" : dir.slice(0, -1);
  const regex = siblingNameRegex(basePath);
  const synthetic: SiblingFileInfo[] = [];
  let listing: { files: string[] };
  try {
    listing = await vault.adapter.list(listDir);
  } catch {
    return { trackedOnDisk, synthetic };
  }
  for (const candidate of listing.files) {
    const candidatePath = normalizePath(candidate);
    const match = regex.exec(candidatePath);
    if (match === null) continue;
    if (expectedPaths.has(candidatePath)) continue;
    const stat = await vault.adapter.stat(candidatePath);
    if (!stat) continue; // vanished mid-scan — skip-class
    const bytes = await vault.adapter.readBinary(candidatePath);
    synthetic.push({
      path: candidatePath,
      timeLabel: timeLabelFromStamp(match[1]),
      sha: await calculateGitBlobSHA(bytes),
      size: stat.size,
      mtime: stat.mtime,
    });
  }
  return { trackedOnDisk, synthetic };
}
