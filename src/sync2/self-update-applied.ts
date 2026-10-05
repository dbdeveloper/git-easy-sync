// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The baseline learns that a staged self-update was APPLIED.
//
// Our own loadable files (main.js / manifest.json / styles.css) are the
// one place where the disk changes outside the drain: the drain only
// STAGES them and the bootloader applies the stage at the top of the
// next onload. The drain must leave the baseline OLD while the bytes are
// only staged (86c808e — recording the new sha against a disk still
// holding the old bytes would make the next commit push a downgrade).
// But the bootloader runs before any store is open, so nobody ever told
// the baseline that the new bytes HAD landed. The next commit then read
// a freshly received build as a local edit — harmless when the server
// still held that build, a false plugin-core "collision" decided by the
// clock when a newer one was already there (owner's field finding,
// 2026-10-05).
//
// So the bootloader records what it applied (path + sha) in
// `.runtime/.self-update-applied`, and the next onload — stores open —
// writes the baseline for every recorded file whose LIVE bytes still
// hash to that sha. Anything else (a hand-installed main.js, an
// unreadable file) leaves the baseline alone: the commit then sees an
// honest local change.

import type { DataAdapter } from "obsidian";

export const SELF_UPDATE_APPLIED_MARKER = ".self-update-applied";

function markerPath(pluginDir: string): string {
  return `${pluginDir}/.runtime/${SELF_UPDATE_APPLIED_MARKER}`;
}

// Called by the bootloader after an apply. One line per file:
// "<path relative to the vault> <sha>". Best effort — without it the
// next commit merely re-checks the file against the server.
export async function recordSelfUpdateApplied(
  adapter: DataAdapter,
  pluginDir: string,
  entries: Array<{ path: string; sha: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const dir = `${pluginDir}/.runtime`;
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(
      markerPath(pluginDir),
      entries.map((e) => `${e.path} ${e.sha}\n`).join(""),
    );
  } catch {
    // best-effort
  }
}

export async function settleSelfUpdateBaselines(deps: {
  adapter: DataAdapter;
  pluginDir: string;
  computeSha: (bytes: ArrayBuffer) => Promise<string>;
  baselines: {
    setMany(
      entries: Array<{ path: string; baselineSha: string; mtime: number; size: number }>,
    ): Promise<void>;
  };
}): Promise<string[]> {
  const { adapter, pluginDir } = deps;
  const file = markerPath(pluginDir);
  let raw: string;
  try {
    if (!(await adapter.exists(file))) return [];
    raw = await adapter.read(file);
  } catch {
    return [];
  }
  const settled: Array<{ path: string; baselineSha: string; mtime: number; size: number }> = [];
  for (const line of raw.split("\n")) {
    const at = line.lastIndexOf(" ");
    if (at <= 0) continue;
    const path = line.slice(0, at);
    const sha = line.slice(at + 1).trim();
    try {
      const st = await adapter.stat(path);
      if (st === null) continue;
      const live = await deps.computeSha(await adapter.readBinary(path));
      if (live !== sha) continue; // not what was applied — leave it alone
      settled.push({ path, baselineSha: sha, mtime: st.mtime, size: st.size });
    } catch {
      // unreadable → leave the baseline alone
    }
  }
  if (settled.length > 0) await deps.baselines.setMany(settled);
  try {
    await adapter.remove(file);
  } catch {
    // best-effort; a second settle re-checks the same lines harmlessly
  }
  return settled.map((s) => s.path);
}
