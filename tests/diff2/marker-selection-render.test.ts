// @vitest-environment happy-dom
//
// §2.2.6 п.7 marker-row selection — the WIRING (advisor: test the call site, not
// just the pure selectionAppearance). After a real selection dispatch, the marker
// block-widget DOM must carry the right diff2-marker-sel-* class:
//   - group-atomic selection (drag across a group, reachable TODAY) → all 3 markers
//     fully selected;
//   - normal-line-only selection ending at the group's `from` → NO marker selected
//     (bug-34/33: no class = the opaque row has nothing to bleed through);
//   - caret → no marker selected.
// (Pixels — the opaque-row bleed + the overlay colour — are device/oracle checks.)

import { afterEach, describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { mountDiffPaneV2 } from "../../src/diff2/diff-pane-v2";
import { readStructure } from "../../src/diff2/diff-structure";

const parents: HTMLElement[] = [];
function mount(base: string, sibling: string): { view: EditorView; p: HTMLElement } {
  const p = document.createElement("div");
  p.className = "diff2-edit-view-root";
  document.body.appendChild(p);
  parents.push(p);
  return { view: mountDiffPaneV2(p, base, sibling), p };
}
afterEach(() => {
  for (const p of parents.splice(0)) p.remove();
});

const selClass = (el: Element): "full" | "top" | "bottom" | "none" =>
  el.classList.contains("diff2-marker-sel-full")
    ? "full"
    : el.classList.contains("diff2-marker-sel-top")
      ? "top"
      : el.classList.contains("diff2-marker-sel-bottom")
        ? "bottom"
        : "none";
const markerStates = (p: HTMLElement): Array<"full" | "top" | "bottom" | "none"> =>
  Array.from(p.querySelectorAll(".diff2-marker")).map(selClass);

describe("§2.2.6 п.7 — marker-row selection classes (wiring)", () => {
  it("group-atomic selection → open/mid/close all sel-full", () => {
    const { view, p } = mount("a\nL1\nL2\nb\n", "a\nR1\nb\n");
    const v1 = readStructure(view.state).find((r) => r.ver === 1)!;
    const v2 = readStructure(view.state).find((r) => r.ver === 2)!;
    view.dispatch({ selection: { anchor: v1.from, head: v2.to } });
    expect(markerStates(p)).toEqual(["full", "full", "full"]); // open, mid, close
  });

  it("normal-line-only selection (head at group.from) → no marker selected (bug-34/33)", () => {
    const { view, p } = mount("a\nL1\nb\n", "a\nR1\nb\n");
    const v1 = readStructure(view.state).find((r) => r.ver === 1)!;
    view.dispatch({ selection: { anchor: 0, head: v1.from } });
    expect(markerStates(p)).toEqual(["none", "none", "none"]);
  });

  it("caret → no marker selected", () => {
    const { view, p } = mount("a\nL1\nb\n", "a\nR1\nb\n");
    view.dispatch({ selection: { anchor: 1, head: 1 } });
    expect(markerStates(p)).toEqual(["none", "none", "none"]);
  });

  // COMPOSITION (advisor): legalizer → render end-to-end for the user's actual
  // acceptance criterion — select the WHOLE ver1 (now keyboard-reachable via the
  // strict legalizer) and see <<<<< + ===== top-half light, nothing else (bug-35).
  it("ver1-only selection [v1.from, v2.from] → open=full, mid=top, close=none (bug-35 red-box)", () => {
    const { view, p } = mount("a\nL1\nL2\nb\n", "a\nR1\nb\n");
    const v1 = readStructure(view.state).find((r) => r.ver === 1)!;
    const v2 = readStructure(view.state).find((r) => r.ver === 2)!;
    view.dispatch({ selection: { anchor: v1.from, head: v2.from } }); // legalizer keeps ver1-only
    expect(markerStates(p)).toEqual(["full", "top", "none"]);
  });

  it("ver2-only selection [v2.from, v2.to] → open=none, mid=bottom, close=full (п.7b)", () => {
    const { view, p } = mount("a\nL1\nL2\nb\n", "a\nR1\nb\n");
    const v2 = readStructure(view.state).find((r) => r.ver === 2)!;
    view.dispatch({ selection: { anchor: v2.from, head: v2.to } });
    expect(markerStates(p)).toEqual(["none", "bottom", "full"]);
  });

  it("repaints on a selection-only change (eq() includes the sel flags)", () => {
    const { view, p } = mount("a\nL1\nb\n", "a\nR1\nb\n");
    const v1 = readStructure(view.state).find((r) => r.ver === 1)!;
    const v2 = readStructure(view.state).find((r) => r.ver === 2)!;
    view.dispatch({ selection: { anchor: v1.from, head: v2.to } }); // select group
    expect(markerStates(p)).toEqual(["full", "full", "full"]);
    view.dispatch({ selection: { anchor: 1, head: 1 } }); // deselect (caret)
    expect(markerStates(p)).toEqual(["none", "none", "none"]); // stale DOM would keep "full"
  });
});
