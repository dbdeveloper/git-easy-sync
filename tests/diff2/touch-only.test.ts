// @vitest-environment happy-dom
//
// §2.2.14 touch-only / read-only mode. The mode is a boolean facet (touchOnlyFacet); a
// changeFilter blocks USER edits (input/delete userEvents) while letting undo/redo (their
// own userEvents) and resolve (no userEvent) through. This pins the state-level gate; the
// integrated behavior (keymaps no-op, marker-click disabled, inputmode=none, mobile
// keyboard) is harness/device-verified.

import { describe, expect, it } from "vitest";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { createDiffPaneState, DEFAULT_VIEW_CONFIG } from "../../src/diff2/diff-pane-v2";
import { isTouchOnly } from "../../src/diff2/diff-structure";

const touch = (base: string, sibling: string) =>
  createDiffPaneState(base, sibling, { config: { ...DEFAULT_VIEW_CONFIG, touchOnly: true } });
const edited = (s: EditorState, spec: TransactionSpec) =>
  s.update(spec).state.doc.toString() !== s.doc.toString();

describe("§2.2.14 touch-only — facet + changeFilter", () => {
  it("isTouchOnly reflects the config", () => {
    expect(isTouchOnly(touch("a\nL\nc\n", "a\nR\nc\n"))).toBe(true);
    expect(isTouchOnly(createDiffPaneState("a\nL\nc\n", "a\nR\nc\n"))).toBe(false);
  });

  it("blocks user typing (input userEvent)", () => {
    expect(edited(touch("a\nL\nc\n", "a\nR\nc\n"), { changes: { from: 0, insert: "x" }, userEvent: "input.type" })).toBe(false);
  });

  it("blocks user delete (delete userEvent)", () => {
    expect(edited(touch("a\nL\nc\n", "a\nR\nc\n"), { changes: { from: 0, to: 1 }, userEvent: "delete.backward" })).toBe(false);
  });

  it("ALLOWS a no-userEvent change (resolve dispatches with no userEvent)", () => {
    expect(edited(touch("a\nL\nc\n", "a\nR\nc\n"), { changes: { from: 0, insert: "x" } })).toBe(true);
  });

  it("ALLOWS an undo-tagged change", () => {
    expect(edited(touch("a\nL\nc\n", "a\nR\nc\n"), { changes: { from: 0, insert: "x" }, userEvent: "undo" })).toBe(true);
  });

  it("a non-touch view edits normally (input applied)", () => {
    const s = createDiffPaneState("a\nL\nc\n", "a\nR\nc\n");
    expect(s.update({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }).state.doc.toString()).not.toBe(
      s.doc.toString(),
    );
  });
});
