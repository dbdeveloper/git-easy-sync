// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The drain REPLACED a conflict copy with a newer server version (§II.6
// STEP3) — the OLD copy is forgotten at once (owner, 2026-10-09):
//   1. its editor tabs close;
//   2. its diff2-autosave dir is wiped, whether a tab was open or not.
// Only in this case. Closing first: a closing tab must not find its dir
// already half gone (it writes nothing on close today; the order keeps it
// that way by construction).
//
// The dir id carries the kind the editor saw at open: normally "tracked",
// but a copy can be opened while it counted as "synthetic" — both go.

import { autosaveDir, deriveAutosaveId } from "./autosave-store";

export interface ForgetDeps {
  // The open diff2 editor tabs, by the conflict copy each one shows.
  editorTabs(): Array<{ siblingPath: string | null; detach(): void }>;
  adapter: {
    exists(path: string): Promise<boolean>;
    rmdir(path: string, recursive: boolean): Promise<void>;
  };
}

export async function forgetReplacedConflictCopy(
  deps: ForgetDeps,
  basePath: string,
  oldSiblingPath: string,
): Promise<{ closedTabs: number; wipedDirs: number }> {
  let closedTabs = 0;
  for (const tab of deps.editorTabs()) {
    if (tab.siblingPath !== oldSiblingPath) continue;
    tab.detach();
    closedTabs++;
  }
  let wipedDirs = 0;
  for (const kind of ["tracked", "synthetic"] as const) {
    const dir = autosaveDir(deriveAutosaveId(kind, basePath, oldSiblingPath));
    if (!(await deps.adapter.exists(dir))) continue;
    await deps.adapter.rmdir(dir, true);
    wipedDirs++;
  }
  return { closedTabs, wipedDirs };
}
