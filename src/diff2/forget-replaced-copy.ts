// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The drain REPLACED a conflict copy with a newer server version (§II.6
// STEP3) — the OLD copy's diff2-autosave dir is wiped at once, whether a tab
// was open or not (owner, 2026-10-09).
//
// Its editor TABS are not handled here (owner, 2026-11-04, TODO 59). The
// replace transaction deletes the old copy (step 4) BEFORE the drain calls
// this, and the vanished-copy cleaner (close-vanished-copies.ts) closes the
// copy's tabs on that delete: silently, the focused one to the Diff Panel —
// exactly as for a conflict that vanished any other way. A second closer
// here only ever lost that race (field run 2026-11-04: closedTabs 0 both
// times) and kept a window ("copy was replaced … your changes are
// discarded") that would contradict the cleaner if it ever won.
//
// The cleaner also wipes the autosave of the tabs it closes, so the two can
// meet on the same dir: a dir that is gone by the time we remove it is done,
// not a failure. A dir that is still there after a failed remove is.
//
// Only the "tracked" dir: the drain replaces only tracked copies, so that is
// the kind their editor sessions were opened with.

import { autosaveDir, deriveAutosaveId } from "./autosave-store";

export interface ForgetDeps {
  adapter: {
    exists(path: string): Promise<boolean>;
    rmdir(path: string, recursive: boolean): Promise<void>;
  };
}

export async function forgetReplacedConflictCopy(
  deps: ForgetDeps,
  basePath: string,
  oldSiblingPath: string,
): Promise<{ wipedDirs: number }> {
  const dir = autosaveDir(deriveAutosaveId("tracked", basePath, oldSiblingPath));
  if (!(await deps.adapter.exists(dir))) return { wipedDirs: 0 };
  try {
    await deps.adapter.rmdir(dir, true);
  } catch (err) {
    // Gone under us — the vanished-copy cleaner wiped it first.
    if (!(await deps.adapter.exists(dir))) return { wipedDirs: 0 };
    throw err;
  }
  return { wipedDirs: 1 };
}
