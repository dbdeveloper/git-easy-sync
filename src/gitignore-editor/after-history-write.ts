// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// A version saved from History over the ROOT .gitignore (e.g. its empty
// "deleted" side) gets the plugin's managed blocks back AT ONCE (owner,
// 2026-10-08) — not at the next Sync, which with manual sync may be far
// away. Only the root one: it is the only .gitignore the plugin reads.

export async function enforceIfRootGitignore(
  path: string,
  enforce: () => Promise<void>,
): Promise<boolean> {
  if (path !== ".gitignore") return false;
  await enforce();
  return true;
}
