// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The diff editor's per-situation settings (owner, 2026-10-31): Editor mode,
// Diff highlight mode and Auto-focus each hold one value per situation the
// editor is opened in. A situation with no value in data.json takes the
// owner's default for the platform below; once a value is stored, it wins.
// The old single-value keys (diffEditorTouchMode, diffEditorDiffMode) are not
// read — no migration (owner). Pure, because tab.ts has no render harness.

// Why the editor was opened — a SETTINGS notion. The editor's own rendering
// mode (DiffEditorMode: marker verbs, labels) is separate: "other" (comparing
// two ordinary files) is not built yet and renders as a conflict for now.
export type DiffEditorSituation = "conflict" | "history" | "deleted" | "other";

export const DIFF_EDITOR_SITUATIONS: readonly DiffEditorSituation[] = [
  "conflict",
  "history",
  "deleted",
  "other",
];

// The situations Settings show. Deleted is not one of them (owner,
// 2026-10-31): a deleted version is always an empty side against a full one —
// nothing to jump to, nothing to edit, nothing to highlight finely — so it
// has FIXED values (below), whatever data.json holds, on every platform.
export const SETTINGS_SITUATIONS: readonly DiffEditorSituation[] = ["conflict", "history", "other"];

export type DiffHighlight = "characters" | "words";

export interface DiffEditorSituationSettings {
  diffEditorEditing?: Partial<Record<DiffEditorSituation, boolean>>;
  diffEditorHighlight?: Partial<Record<DiffEditorSituation, DiffHighlight>>;
  diffEditorAutoFocus?: Partial<Record<DiffEditorSituation, boolean>>;
}

// The owner's defaults (2026-10-31) — and Deleted's fixed values.
const EDITING_DESKTOP: Record<DiffEditorSituation, boolean> = {
  conflict: true,
  history: false,
  deleted: false, // fixed
  other: true,
};
const EDITING_MOBILE: Record<DiffEditorSituation, boolean> = {
  conflict: false,
  history: false,
  deleted: false, // fixed
  other: false,
};

// Editing enabled (false = read-only "touch" mode: resolve with the buttons,
// no soft keyboard).
export function editingFor(
  settings: DiffEditorSituationSettings,
  situation: DiffEditorSituation,
  isMobile: boolean,
): boolean {
  if (situation === "deleted") return false;
  return (
    settings.diffEditorEditing?.[situation] ??
    (isMobile ? EDITING_MOBILE : EDITING_DESKTOP)[situation]
  );
}

export function highlightFor(
  settings: DiffEditorSituationSettings,
  situation: DiffEditorSituation,
): DiffHighlight {
  if (situation === "deleted") return "words";
  return settings.diffEditorHighlight?.[situation] ?? "words";
}

export function autoFocusFor(
  settings: DiffEditorSituationSettings,
  situation: DiffEditorSituation,
): boolean {
  if (situation === "deleted") return false;
  return settings.diffEditorAutoFocus?.[situation] ?? true;
}
