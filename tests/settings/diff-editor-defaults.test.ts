// Owner, 2026-10-31: the diff editor's three per-situation settings — Editor
// mode, Diff highlight mode, Auto-focus — each have a value per situation
// (Conflicts / History / Deleted / Other). A situation with no value in
// data.json takes the owner's default for the platform; once stored, the
// stored value wins. No migration of the old single-value keys.

import { describe, expect, it } from "vitest";
import {
  DIFF_EDITOR_SITUATIONS,
  autoFocusFor,
  editingFor,
  highlightFor,
} from "../../src/settings/diff-editor-defaults";

describe("diff editor per-situation defaults (nothing stored)", () => {
  it("🔑 desktop: editing on for Conflicts and Other, off for History and Deleted", () => {
    const got = DIFF_EDITOR_SITUATIONS.map((s) => editingFor({}, s, false));
    expect(DIFF_EDITOR_SITUATIONS).toEqual(["conflict", "history", "deleted", "other"]);
    expect(got).toEqual([true, false, false, true]);
  });

  it("🔑 mobile: editing off everywhere", () => {
    expect(DIFF_EDITOR_SITUATIONS.map((s) => editingFor({}, s, true))).toEqual([false, false, false, false]);
  });

  it("🔑 highlight: Words everywhere, on both platforms", () => {
    expect(DIFF_EDITOR_SITUATIONS.map((s) => highlightFor({}, s))).toEqual(["words", "words", "words", "words"]);
  });

  it("🔑 auto-focus: on everywhere, on both platforms", () => {
    expect(DIFF_EDITOR_SITUATIONS.map((s) => autoFocusFor({}, s))).toEqual([true, true, true, true]);
  });
});

describe("a stored value wins, per situation", () => {
  it("each situation reads its own key; a missing key falls back to the default", () => {
    const settings = {
      diffEditorEditing: { history: true },
      diffEditorHighlight: { conflict: "characters" as const },
      diffEditorAutoFocus: { deleted: false },
    };
    expect(editingFor(settings, "history", true)).toBe(true); // stored beats the mobile default
    expect(editingFor(settings, "conflict", true)).toBe(false); // not stored → mobile default
    expect(highlightFor(settings, "conflict")).toBe("characters");
    expect(highlightFor(settings, "other")).toBe("words");
    expect(autoFocusFor(settings, "deleted")).toBe(false);
    expect(autoFocusFor(settings, "history")).toBe(true);
  });

  it("the old single-value keys are not read (no migration — owner)", () => {
    const old = { diffEditorTouchMode: true, diffEditorDiffMode: "characters" } as Record<string, unknown>;
    expect(editingFor(old, "conflict", false)).toBe(true);
    expect(highlightFor(old, "conflict")).toBe("words");
  });
});
