// Mobile header clamp — UNIFORM across all mobile modes (keyboard on the screen or not). The
// view-root scrolls the whole [toolbar + body] block; this module:
//   1. sizes the editor body so the outer scroll range lands exactly at the header bottom (and so
//      the editor never collapses to 0 — the old blank bug);
//   2. hard-clamps that scroll so the header can never scroll fully out of reach — scrollTop is
//      capped at the ACTIVE tail's top, leaving a 16px "tail" (a real continuation of the header, not
//      a floating element) as a grab handle. Any scroll past the cap is snapped back.
//
// The header is split (toolbar is a view-root child; the CM6 search panel lives inside the editor),
// so there are TWO tails, toggled by whether the search panel is open:
//   mobile + no search panel → tail1 (under the toolbar); clamp at the toolbar bottom.
//   mobile + search panel     → tail2 (bottom of .cm-search); clamp at the panel bottom.
//
// body height = view − TAIL + searchPanelHeight  → the outer scroll range equals the header bottom,
// and the text scroller ends up ≈ (view − TAIL). Editor-tab only; no-op on desktop.

import { Platform } from "obsidian";
import type Logger from "../logger";

const TAIL = 16; // grab-strip height (must match styles.css .diff2-*-kbd-strip)

export function installMobileHeaderClamp(
  root: HTMLElement,
  getScroller: () => HTMLElement | null | undefined,
  logger?: Logger,
): (() => void) | undefined {
  if (!Platform.isMobile) return undefined;
  const scroller = getScroller();
  const tail1 = root.querySelector<HTMLElement>(".diff2-detail-kbd-strip");
  const body = root.querySelector<HTMLElement>(".diff2-detail-body");
  if (!scroller || !tail1 || !body) return undefined;

  const searchPanel = (): HTMLElement | null => root.querySelector<HTMLElement>(".cm-panels-top");
  const tail2 = (): HTMLElement | null => root.querySelector<HTMLElement>(".diff2-search-kbd-strip");
  const activeTail = (): HTMLElement | null => (searchPanel() ? tail2() : tail1);

  // An element's fixed position within the scroll content (independent of the current scroll).
  const contentTop = (el: HTMLElement): number =>
    el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;

  // #5 — how far the text scroller's bottom currently hangs BELOW the visible fold. When the toolbar is
  // open the scroller (height view−TAIL) extends past the viewport by ≈ the toolbar height; when the
  // toolbar is collapsed it's ≈ 0. We publish it as --diff2-offfold so styles.css can add that much
  // padding-bottom to .cm-content — extending the INNER scroll range so the last lines can reach the
  // visible slice with the toolbar open, without any excess overscroll gap when collapsed.
  const updateOffFold = (): void => {
    const off = Math.max(0, scroller.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom);
    root.querySelector<HTMLElement>(".cm-content")?.style.setProperty("--diff2-offfold", `${Math.round(off)}px`);
  };

  // #3 instrumentation — the last scrollTop a real scroll left us at (before any relayout resizes).
  let lastUserScrollTop = 0;

  // Keyboard detection: the Android soft keyboard shrinks the view (visualViewport doesn't fire on the
  // device). Track the tallest view seen at the CURRENT width as the "no-keyboard" height; a view now
  // ≥100px shorter means the keyboard is up. Reset the reference when width changes so a rotation (which
  // also shrinks height) isn't mistaken for the keyboard.
  let maxView = 0;
  let lastWidth = -1;
  const kbdOpen = (view: number): boolean => {
    const w = root.clientWidth;
    if (w !== lastWidth) {
      lastWidth = w;
      maxView = 0;
    }
    maxView = Math.max(maxView, view);
    return view < maxView - 100;
  };

  const onScroll = (): void => {
    const tail = activeTail();
    if (!tail) return;
    const cap = contentTop(tail);
    if (root.scrollTop > cap) root.scrollTop = cap; // hard snap-back at the tail
    lastUserScrollTop = root.scrollTop;
    updateOffFold(); // the toolbar is collapsing/expanding → the off-fold amount changes
  };

  const relayout = (): void => {
    const beforeScroll = root.scrollTop; // #3 — scrollTop at relayout ENTRY (i.e. right after the resize)
    const view = root.clientHeight;
    const sp = searchPanel()?.offsetHeight ?? 0;
    // Size the body so the outer scroll range == the header bottom, and the editor never collapses.
    body.style.flex = "0 0 auto";
    body.style.minHeight = "0";
    body.style.height = `${Math.max(TAIL, view - TAIL + sp)}px`;
    // Visibility: exactly one tail, chosen by whether the search panel is open. No keyboard gate.
    const search = !!searchPanel();
    tail1.classList.toggle("is-visible", !search);
    tail2()?.classList.toggle("is-visible", search);
    // #2b — drop the navbar-clearance padding while the keyboard is up (no navbar there then).
    const kbd = kbdOpen(view);
    root.classList.toggle("diff2-kbd-open", kbd);
    // #3 — closing the keyboard makes Obsidian/CM6 zero scrollTop BEFORE this relayout runs (trace:
    // beforeScroll:0 while lastUserScrollTop survives). Restore the user's chosen header position so it
    // persists across keyboard open/close — clamped to the current tail cap. A normal relayout (no
    // external reset) has scrollTop == lastUserScrollTop already, so this is a no-op there.
    const tail = activeTail();
    const cap = tail ? contentTop(tail) : Infinity;
    const restored = Math.min(lastUserScrollTop, cap);
    if (root.scrollTop !== restored) root.scrollTop = restored;
    updateOffFold(); // resize changed the scroller geometry → recompute the off-fold padding
    logger?.info("diff2 header-clamp", {
      view,
      sp,
      bodyH: body.clientHeight,
      search,
      cap: Number.isFinite(cap) ? Math.round(cap) : null,
      scrollerH: scroller.clientHeight,
      beforeScroll, // #3 — scrollTop at relayout entry (0 after an external keyboard-close reset)
      lastUserScrollTop, // #3 — the last real scroll position, which we restore to
      restored: Math.round(restored),
      offFold: Math.round(Math.max(0, scroller.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom)), // #5
      kbd, // #2b — keyboard up? (navbar padding dropped)
    });
  };

  root.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(() => relayout()); // keyboard open/close, rotation
  ro.observe(root);
  // Search panel is a direct child of .cm-editor — watch it appear/disappear (childList only, so CM6
  // text edits inside .cm-scroller don't trigger it).
  const cmEditor = root.querySelector<HTMLElement>(".cm-editor");
  const mo = new MutationObserver(() => relayout());
  if (cmEditor) mo.observe(cmEditor, { childList: true });
  relayout();

  return () => {
    root.removeEventListener("scroll", onScroll);
    ro.disconnect();
    mo.disconnect();
    body.style.flex = "";
    body.style.minHeight = "";
    body.style.height = "";
    tail1.classList.remove("is-visible");
    tail2()?.classList.remove("is-visible");
    root.classList.remove("diff2-kbd-open");
    root.querySelector<HTMLElement>(".cm-content")?.style.removeProperty("--diff2-offfold");
  };
}
