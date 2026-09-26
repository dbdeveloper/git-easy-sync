// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// "Sync plugins data.json" is SUBORDINATE to "Sync configs".
//
// The subordinate toggle does nothing on its own: with the config
// subtree silenced, `<configDir>/.gitignore` ends in `*` and no
// data.json can reach GitHub whatever this says. Leaving it lit while it
// has no effect is the worst state of the three — it reads as "my
// secrets ARE syncing" to a user who is deciding whether they are safe,
// and that is exactly the question this toggle exists to answer.
//
// So the rule is asymmetric on purpose (owner, 2026-09-26): switching
// the parent OFF forces this one off, switching it back ON only makes it
// reachable again. Re-enabling config sync must never silently re-arm
// the publication of credentials the user turned off — that direction is
// a decision, and decisions stay with the user.

export interface ToggleState {
  value: boolean;
  disabled: boolean;
}

export function pluginsDataJsonToggleState(
  syncConfigDir: boolean,
  stored: boolean,
): ToggleState {
  if (!syncConfigDir) return { value: false, disabled: true };
  return { value: stored, disabled: false };
}
