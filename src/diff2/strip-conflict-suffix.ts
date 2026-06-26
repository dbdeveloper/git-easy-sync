// Helpers for parsing the sibling-file naming scheme produced by
// `src/sync2/conflict-store.ts::buildSiblingPath`:
//
//   "<dir>/<stem>.conflict-from-<deviceLabel>-<isoTs>.<ext>"
//
// where <isoTs> is "YYYY-MM-DDTHH-MM-SSZ" (the canonical shape
// buildSiblingPath emits). Both helpers below share the same anchor
// regex; they differ only in what they reconstruct/return.
//
// Two helpers, two use cases:
//   - stripConflictSuffix(path) → base path "<dir>/<stem>.<ext>" only.
//     Used by TrashStore.confirmResolved (layer 1b of R3.5) to match
//     sibling-trash entries by base path.
//   - parseSiblingFilename(path) → full structured tuple
//     { basePath, deviceLabel, isoTimestamp }. Used by the conflicts
//     list (Phase 1) to render device label + timestamp in each row.

const SIBLING_PATTERN =
  /^(.+?)\.conflict-from-(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(\..+)?$/;

// Returns the base path corresponding to a sibling file. Returns null
// when the input does not match the sibling-naming convention; the
// caller treats null as "this is not a sibling I should reverse".
//
// Canonical specs: docs/DIFF2_IMPLEMENTATION_PLAN.md §R3.5, §R3.10.
export function stripConflictSuffix(siblingPath: string): string | null {
  const slash = siblingPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : siblingPath.slice(0, slash + 1);
  const basename = slash === -1 ? siblingPath : siblingPath.slice(slash + 1);

  const m = basename.match(SIBLING_PATTERN);
  if (!m) return null;

  const [, stem, , , ext = ""] = m;
  return `${dir}${stem}${ext}`;
}

// Parsed components of a sibling filename. `basePath` is the
// reconstructed base file path (same value stripConflictSuffix
// returns). `deviceLabel` is the bracket-sanitized device segment
// (parens replaced with brackets by buildSiblingPath — caller must
// reverse if they want the original label, but for display the
// bracket form is fine). `isoTimestamp` is the exact 20-character
// "YYYY-MM-DDTHH-MM-SSZ" substring; convert to Date via
// `new Date(isoTimestamp.replace(/-/g, ":").replace(/T(\d\d):(\d\d):/, "T$1:$2:").replace("Z", ".000Z"))`
// — actually it's simpler to use the raw string for display since
// it's already ISO-like.
export interface ParsedSibling {
  basePath: string;
  deviceLabel: string;
  isoTimestamp: string;
}

export function parseSiblingFilename(
  siblingPath: string,
): ParsedSibling | null {
  const slash = siblingPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : siblingPath.slice(0, slash + 1);
  const basename = slash === -1 ? siblingPath : siblingPath.slice(slash + 1);

  const m = basename.match(SIBLING_PATTERN);
  if (!m) return null;

  const [, stem, deviceLabel, isoTimestamp, ext = ""] = m;
  return {
    basePath: `${dir}${stem}${ext}`,
    deviceLabel,
    isoTimestamp,
  };
}

// Reformat the 20-char filesystem-safe `isoTimestamp` ("YYYY-MM-DDTHH-MM-SSZ" — colons
// can't live in a filename, hence the dashes) into a readable "YYYY-MM-DD HH:MM:SS" for
// DISPLAY (the conflicts list, the detail-view title, the [join] header). Same numbers —
// just T→space and the time dashes→colons, drop Z. Anything not matching that exact shape
// (already-formatted, empty, unexpected) passes through untouched.
export function formatConflictTimestamp(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z?$/.exec(ts);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : ts;
}
