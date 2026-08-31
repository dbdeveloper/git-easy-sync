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
import { calculateGitBlobSHA } from "../utils";

// Deep-defense fallback only: every conflict birth site (§III STEP1 /
// pull-folding-refresh / Vault-step-born) lazily fetches the device
// label BEFORE calling saveConflictSiblingFile.
export const UNKNOWN_DEVICE_LABEL = "unknown";

// Narrow slice of the drain's FileInfo this module needs. Field names
// are camelCase per project style; the spec's `device_label` is
// `deviceLabel` here.
export interface SiblingFileInfo {
  // Path of the BASE file (P) — see header for the synthetic
  // exception.
  path: string;
  mtime: number;
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
// Phase 5.5 port (v1 dies at THE SWITCH; trash-recovery keeps using
// this).
export function extensionOf(vaultPath: string): string {
  return splitPath(vaultPath).ext;
}

// "YYYY-MM-DDTHH-MM-SSZ" — the PSEUDO-MERGE-MODE.md timestamp shape
// (ISO with colons/dot made filesystem-safe, milliseconds dropped).
// Byte-identical to what v1's buildSiblingPath produces.
export function formatTimestampForFilename(mtime: number): string {
  return new Date(mtime)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
}

// Pure — the single source of truth for the sibling's disk name.
export function buildSiblingFilePath(
  basePath: string,
  mtime: number,
  deviceLabel?: string | null,
): string {
  const { dir, stem, ext } = splitPath(basePath);
  // Filesystem-safe label: parens replaced, same rule as v1.
  const safeLabel = (deviceLabel ?? UNKNOWN_DEVICE_LABEL)
    .replace(/\(/g, "[")
    .replace(/\)/g, "]");
  const ts = formatTimestampForFilename(mtime);
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
    `^${esc(dir)}${esc(stem)}\\.conflict-from-.+-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z${esc(ext)}$`,
  );
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
    fileInfo.mtime,
    fileInfo.deviceLabel,
  );
  // AtomicWrite — the same crash protocol as every vault write
  // (§II.11 relies on it for the STEP3 replace transaction).
  await atomicWriteFile(vault, normalizePath(siblingPath), fileInfo.blob);
}

// Read ONE specific sibling — needs the whole (path, mtime,
// deviceLabel) triple, not just the path: every element of a
// `siblings` list shares the same `.path` (== P), only mtime+label
// distinguish them (the STEP3 fix recorded in the spec).
export async function readSiblingFileFromVault(
  vault: Vault,
  fileInfo: SiblingFileInfo,
): Promise<ArrayBuffer | null> {
  const siblingPath = normalizePath(
    buildSiblingFilePath(fileInfo.path, fileInfo.mtime, fileInfo.deviceLabel),
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
      buildSiblingFilePath(basePath, s.mtime, s.deviceLabel),
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
    if (!regex.test(candidatePath)) continue;
    if (expectedPaths.has(candidatePath)) continue;
    const stat = await vault.adapter.stat(candidatePath);
    if (!stat) continue; // vanished mid-scan — skip-class
    const bytes = await vault.adapter.readBinary(candidatePath);
    synthetic.push({
      path: candidatePath,
      sha: await calculateGitBlobSHA(bytes),
      size: stat.size,
      mtime: stat.mtime,
    });
  }
  return { trackedOnDisk, synthetic };
}
