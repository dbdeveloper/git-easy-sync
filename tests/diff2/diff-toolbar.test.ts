// @vitest-environment happy-dom
//
// §2.2.15 toolbar shell — render structure + the LIVE update(state) (count + disabled).

import { describe, expect, it } from "vitest";
import { type DiffToolbarCallbacks, type DiffToolbarInitial, renderDiffToolbar } from "../../src/diff2/diff-toolbar";

const noop = () => {};
const cbs = (): DiffToolbarCallbacks => ({
  onBack: noop,
  onKeepAll: noop,
  onApplyAll: noop,
  onJoinAll: noop,
  onPrev: noop,
  onNext: noop,
  onUndo: noop,
  onRedo: noop,
  onToggleTouch: noop,
  onToggleAutoFocus: noop,
  onSetDiffMode: noop,
});
const initial: DiffToolbarInitial = {
  localLabel: "L",
  remoteLabel: "R",
  isMarkdown: true,
  touchOn: false,
  autoFocusOn: true,
  diffMode: "characters",
};
const btnByTitle = (c: HTMLElement, prefix: string) =>
  Array.from(c.querySelectorAll("button")).find((b) => b.title.startsWith(prefix))!;

describe("diff-toolbar", () => {
  it("update() patches the count + nav/undo/redo disabled states", () => {
    const c = document.createElement("div");
    const h = renderDiffToolbar(c, initial, cbs());
    h.update({ conflictCount: 3, hasPrev: false, hasNext: true, canUndo: true, canRedo: false });
    expect(c.querySelector(".diff2-tb-count")!.textContent).toBe("3");
    expect(btnByTitle(c, "Previous conflict").disabled).toBe(true);
    expect(btnByTitle(c, "Next conflict").disabled).toBe(false);
    expect(btnByTitle(c, "Undo").disabled).toBe(false);
    expect(btnByTitle(c, "Redo").disabled).toBe(true);
  });

  it("markdown → Join button present; non-markdown (onJoinAll omitted) → absent", () => {
    const md = document.createElement("div");
    renderDiffToolbar(md, initial, cbs());
    expect(md.textContent).toContain("Join all");
    const nonMd = document.createElement("div");
    renderDiffToolbar(nonMd, initial, { ...cbs(), onJoinAll: undefined });
    expect(nonMd.textContent).not.toContain("Join all");
  });

  it("toggles reflect initial state; callbacks fire on change", () => {
    const c = document.createElement("div");
    let back = false;
    let mode = "";
    let touch: boolean | null = null;
    renderDiffToolbar(c, initial, {
      ...cbs(),
      onBack: () => (back = true),
      onSetDiffMode: (m) => (mode = m),
      onToggleTouch: (on) => (touch = on),
    });
    const checks = Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    // first checkbox = Touch-mode (off), the Auto-focus = on
    expect(checks[0].checked).toBe(false); // touch off
    expect(checks.some((x) => x.checked)).toBe(true); // auto-focus on
    const sel = c.querySelector("select")!;
    expect(sel.value).toBe("characters");
    // fire
    btnByTitle(c, "Back").click();
    checks[0].checked = true;
    checks[0].dispatchEvent(new Event("change"));
    sel.value = "words";
    sel.dispatchEvent(new Event("change"));
    expect(back).toBe(true);
    expect(touch).toBe(true);
    expect(mode).toBe("words");
  });
});
