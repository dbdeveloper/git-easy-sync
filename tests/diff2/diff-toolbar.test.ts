// @vitest-environment happy-dom
//
// §2.2.15 toolbar shell — render structure + the LIVE update(state) (count + disabled).

import { describe, expect, it } from "vitest";
import { type DiffToolbarCallbacks, type DiffToolbarInitial, renderDiffToolbar } from "../../src/diff2/diff-toolbar";

const noop = () => {};
const cbs = (): DiffToolbarCallbacks => ({
  onBack: noop,
  onSearch: noop,
  onKeepAll: noop,
  onApplyAll: noop,
  onJoinAll: noop,
  onPrev: noop,
  onNext: noop,
  onUndo: noop,
  onRedo: noop,
  onToggleEditorMode: noop,
  onToggleAutoFocus: noop,
  onSetDiffMode: noop,
});
const initial: DiffToolbarInitial = {
  localLabel: "L",
  remoteLabel: "R",
  isMarkdown: true,
  editorModeOn: false,
  autoFocusOn: true,
  diffMode: "characters",
};
const btnByTitle = (c: HTMLElement, prefix: string) =>
  Array.from(c.querySelectorAll("button")).find((b) => b.title.startsWith(prefix))!;

describe("diff-toolbar", () => {
  it("update() patches the count + nav/undo/redo VISUAL-off states (NOT html-disabled)", () => {
    const c = document.createElement("div");
    const h = renderDiffToolbar(c, initial, cbs());
    h.update({ conflictCount: 3, hasPrev: false, hasNext: true, canUndo: true, canRedo: false });
    expect(c.querySelector(".diff2-tb-count")!.textContent).toBe("3");
    const off = (t: string) => btnByTitle(c, t).classList.contains("diff2-tb-off");
    expect(off("Previous conflict")).toBe(true);
    expect(off("Next conflict")).toBe(false);
    expect(off("Undo")).toBe(false);
    expect(off("Redo")).toBe(true);
    // CRITICAL: an "off" button is NOT html-disabled — it stays clickable so its handler can
    // refocus the editor (a real `disabled` button fires no events → the caret/hotkey bug).
    expect(btnByTitle(c, "Previous conflict").disabled).toBe(false);
    expect(btnByTitle(c, "Previous conflict").getAttribute("aria-disabled")).toBe("true");
  });

  it("an OFF (visually-disabled) nav button STILL fires its handler (so it can no-op + refocus)", () => {
    const c = document.createElement("div");
    let prevCalls = 0;
    const h = renderDiffToolbar(c, initial, { ...cbs(), onPrev: () => (prevCalls += 1) });
    h.update({ conflictCount: 3, hasPrev: false, hasNext: true, canUndo: true, canRedo: false });
    const prev = btnByTitle(c, "Previous conflict");
    expect(prev.classList.contains("diff2-tb-off")).toBe(true);
    prev.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(prevCalls).toBe(1); // fires → controller no-ops nav at boundary + refocuses editor
  });

  it("action buttons preventDefault mousedown (keep editor focus) — but the toggle does NOT", () => {
    // bug: clicking a toolbar button (even a DISABLED nav button) blurred the CM6 editor →
    // caret vanished + hotkeys died. Fix = mousedown preventDefault on the action buttons, so
    // a disabled button is a true no-op and an enabled one acts with the caret intact.
    const c = document.createElement("div");
    const h = renderDiffToolbar(c, initial, cbs());
    h.update({ conflictCount: 3, hasPrev: false, hasNext: true, canUndo: true, canRedo: false });
    for (const title of ["Previous conflict", "Next conflict", "Undo", "Redo", "Keep"]) {
      const b = btnByTitle(c, title);
      const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      b.dispatchEvent(md);
      expect(md.defaultPrevented).toBe(true);
    }
    // a checkbox toggle needs focus to operate → its mousedown must NOT be prevented.
    const cb = c.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const cbMd = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    cb.dispatchEvent(cbMd);
    expect(cbMd.defaultPrevented).toBe(false);
  });

  it("Editor-mode toggle = an 'Edit' checkbox with an 'Editor mode' title (replaces 'Touch-mode')", () => {
    const c = document.createElement("div");
    renderDiffToolbar(c, initial, cbs());
    // short "Edit" caption + fuller "Editor mode" hint as the label title
    const wrap = c.querySelector('label[title="Editor mode"]');
    expect(wrap).toBeTruthy();
    expect(wrap!.textContent).toContain("Edit");
    expect(wrap!.querySelector('input[type="checkbox"]')).toBeTruthy();
    // the old "Touch-mode" caption is gone entirely
    expect(c.textContent).not.toContain("Touch");
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
    let editorMode: boolean | null = null;
    renderDiffToolbar(c, initial, {
      ...cbs(),
      onBack: () => (back = true),
      onSetDiffMode: (m) => (mode = m),
      onToggleEditorMode: (on) => (editorMode = on),
    });
    const checks = Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    // first checkbox = Editor-mode (off = read-only), the Auto-focus = on
    expect(checks[0].checked).toBe(false); // editor mode off → read-only
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
    expect(editorMode).toBe(true); // checked = editing ENABLED
    expect(mode).toBe("words");
  });
});

// TODO §17 — mode-aware toolbar verbs. Conflict = Keep/Apply/Join; History+Deleted = Restore/Keep
// (no Join, even for markdown). Callbacks are identical (onKeepAll/onApplyAll) — only labels change.
describe("diff-toolbar — TODO §17 mode-aware verbs", () => {
  const byText = (c: HTMLElement, t: string) =>
    Array.from(c.querySelectorAll("button")).find((b) => b.textContent === t);

  it("conflict → [Keep all] [Apply all] [> Join all]", () => {
    const c = document.createElement("div");
    renderDiffToolbar(c, { ...initial, mode: "conflict" }, cbs());
    expect(byText(c, "Keep all")).toBeTruthy();
    expect(byText(c, "Apply all")).toBeTruthy();
    expect(byText(c, "> Join all")).toBeTruthy();
    expect(byText(c, "Restore all")).toBeFalsy();
  });

  it("history → [Restore all] [Keep all], NO Join even for markdown", () => {
    const c = document.createElement("div");
    renderDiffToolbar(c, { ...initial, mode: "history", isMarkdown: true }, cbs());
    expect(byText(c, "Restore all")).toBeTruthy();
    expect(byText(c, "Keep all")).toBeTruthy();
    expect(byText(c, "> Join all")).toBeFalsy();
    expect(byText(c, "Apply all")).toBeFalsy();
  });

  it("deleted → same verbs as history (Restore/Keep, no Join)", () => {
    const c = document.createElement("div");
    renderDiffToolbar(c, { ...initial, mode: "deleted", isMarkdown: true }, cbs());
    expect(byText(c, "Restore all")).toBeTruthy();
    expect(byText(c, "Keep all")).toBeTruthy();
    expect(byText(c, "> Join all")).toBeFalsy();
  });

  it("history 'Restore all'/'Keep all' route to the SAME callbacks as conflict Keep/Apply", () => {
    const c = document.createElement("div");
    let keep = 0;
    let apply = 0;
    renderDiffToolbar(
      c,
      { ...initial, mode: "history" },
      { ...cbs(), onKeepAll: () => (keep += 1), onApplyAll: () => (apply += 1) },
    );
    byText(c, "Restore all")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    byText(c, "Keep all")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(keep).toBe(1); // Restore all = onKeepAll (keep ver1)
    expect(apply).toBe(1); // Keep all (actual) = onApplyAll (keep ver2)
  });
});
