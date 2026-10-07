// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 5 (spec §2.3): read the log WHOLE (the vault adapter
// has no partial read) — but only below a limit, checked with stat
// BEFORE reading. Over it the viewer says "open it with your operating
// system" instead of risking a frozen phone.

export const LOG_VIEW_MAX_BYTES = 10 * 1024 * 1024; // owner, 2026-10-07

export type LoadResult =
  | { kind: "ok"; text: string }
  | { kind: "too-big"; size: number }
  | { kind: "error"; reason: string };

export interface LogFileAdapter {
  stat(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<string>;
}

export async function loadLogText(
  adapter: LogFileAdapter,
  path: string,
): Promise<LoadResult> {
  try {
    const st = await adapter.stat(path);
    // No file: logging just enabled, or the file deleted by hand. The
    // logger recreates it on its next line; until then the log is empty.
    if (st === null) return { kind: "ok", text: "" };
    if (st.size > LOG_VIEW_MAX_BYTES) return { kind: "too-big", size: st.size };
    return { kind: "ok", text: await adapter.read(path) };
  } catch (err) {
    return { kind: "error", reason: String((err as Error)?.message ?? err) };
  }
}
