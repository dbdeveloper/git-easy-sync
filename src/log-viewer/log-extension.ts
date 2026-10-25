// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER §2.23 (owner, 2026-10-25): the "log" file extension is ours
// while Settings → Logging → "Open any *.log file in the plugin log
// viewer" is on. Obsidian throws when another plugin already holds it
// ("Attempting to register an existing file extension") → "taken".
// Turning it off needs Obsidian's INTERNAL viewRegistry.unregisterExtensions
// (the public API only registers, and unregisters at plugin unload);
// without it the change applies after a restart.

export type LogExtensionResult = "ok" | "taken" | "restart";

export function switchLogExtension(
  on: boolean,
  registered: boolean,
  api: { register: () => void; unregister?: () => void },
): { result: LogExtensionResult; registered: boolean } {
  if (on === registered) return { result: "ok", registered };
  if (on) {
    try {
      api.register();
      return { result: "ok", registered: true };
    } catch {
      return { result: "taken", registered: false };
    }
  }
  if (!api.unregister) return { result: "restart", registered: true };
  api.unregister();
  return { result: "ok", registered: false };
}
