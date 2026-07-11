// §2.2.15 — the diff-editor-v2 detail toolbar (REPLACES the interim toolbar-conflicts.ts).
//
// Two conceptual ROWS, each split into a LEFT and a RIGHT flex group that wrap independently
// (right-aligned). Row 2 is a row of 2-LINE COLUMNS (each column a vertical stack of two
// controls), and a column wraps as one atomic unit:
//
//   row1 L: [←] [Keep all] [Apply all] [> Join all]      R: Edit [x]  (tooltip "Editor mode")
//   row2 L: {Conflicts:/NNN} {[↑]/[↓]} {[Undo]/[Redo]}   R: {Auto-focus [x] / Diff-mode ▾}
//
// §2.2.14 — the "Edit" checkbox is the POSITIVE face of the internal read-only facet
// (touchOnlyFacet): checked ⇒ editing ENABLED (touchOnly false). The inversion
// (editorMode = !touchOnly) lives only here at the toolbar boundary and in the controller;
// the facet/owner/settings stay read-only-positive.
//
// The toolbar is LIVE: `update(state)` cheaply patches the count + the disabled states on
// every editor transaction (the caller wires an updateListener) — NOT a full re-render.
// Plain DOM (document.createElement) so it's unit-testable without the Obsidian createEl
// augmentation; icons via Obsidian setIcon (no-op-stubbed in tests).

import { setIcon } from "obsidian";
import type { DiffEditorMode } from "./diff-pane-v2";

export type DiffMode = "characters" | "words";

export interface DiffToolbarCallbacks {
  onBack(): void;
  onSearch(): void; // §2.2.17 — toggle the Mod+F search panel (lens button)
  onKeepAll(): void;
  onApplyAll(): void;
  onJoinAll?(): void; // omitted → no Join button (non-markdown base)
  onPrev(): void;
  onNext(): void;
  onUndo(): void;
  onRedo(): void;
  onToggleEditorMode(editable: boolean): void; // §2.2.14 — checked ⇒ editing enabled
  onToggleAutoFocus(on: boolean): void;
  onSetDiffMode(mode: DiffMode): void;
}

export interface DiffToolbarInitial {
  localLabel: string;
  remoteLabel: string;
  isMarkdown: boolean;
  editorModeOn: boolean; // §2.2.14 — true ⇒ editing enabled (the positive face of touchOnly)
  autoFocusOn: boolean;
  diffMode: DiffMode;
  // TODO §17 — conflict → [Keep all][Apply all][> Join all]; history/deleted →
  // [Restore all][Keep all] (no Join). Default "conflict".
  mode?: DiffEditorMode;
}

// Live state, recomputed from the editor on every transaction.
export interface DiffToolbarState {
  conflictCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface DiffToolbarHandle {
  update(state: DiffToolbarState): void;
}

// mousedown→preventDefault keeps the CM6 editor focused when a toolbar action button is
// clicked: without it, the mousedown moves focus off the editor DOM → the caret vanishes
// and hotkeys die (the selection is untouched, so an empty ver-block doesn't even collapse).
// A DISABLED button then becomes a true no-op (click never fires, focus never leaves); an
// enabled button runs its action with the caret intact. NOT applied to the toggles/select
// (a checkbox/dropdown needs focus to operate).
function keepEditorFocus(b: HTMLElement): void {
  b.addEventListener("mousedown", (e) => e.preventDefault());
}

// VISUAL-only disabled: greys the button + marks it for a11y, but keeps it CLICKABLE so its
// handler still fires (and refocuses the editor). See the update() comment for why the HTML
// `disabled` attribute is the bug.
function setOff(b: HTMLElement, off: boolean): void {
  b.classList.toggle("diff2-tb-off", off);
  b.setAttribute("aria-disabled", String(off));
}

function iconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = parent.appendChild(document.createElement("button"));
  b.className = "diff2-tb-icon";
  b.title = title;
  keepEditorFocus(b);
  b.addEventListener("click", onClick);
  setIcon?.(b, icon); // stubbed in tests
  return b;
}

function textButton(parent: HTMLElement, cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = parent.appendChild(document.createElement("button"));
  b.className = `diff2-btn ${cls}`;
  b.textContent = text;
  b.title = title;
  keepEditorFocus(b);
  b.addEventListener("click", onClick);
  return b;
}

// A 2-line column (row-2 building block): the two children stack vertically; the column wraps
// as one unit.
function column(parent: HTMLElement): HTMLElement {
  const c = parent.appendChild(document.createElement("div"));
  c.className = "diff2-tb-col";
  return c;
}

// A labelled checkbox. `title`, when given, becomes the wrapper's hover/a11y tooltip (a fuller
// hint than the short caption). The control is a real <checkbox> so focus/mousedown behaviour
// is unchanged.
function toggle(
  parent: HTMLElement,
  label: string,
  on: boolean,
  onChange: (on: boolean) => void,
  title?: string,
): HTMLLabelElement {
  const wrap = parent.appendChild(document.createElement("label"));
  wrap.className = "diff2-tb-toggle";
  if (title) wrap.title = title;
  wrap.appendChild(document.createTextNode(label));
  const cb = wrap.appendChild(document.createElement("input"));
  cb.type = "checkbox";
  cb.checked = on;
  cb.addEventListener("change", () => onChange(cb.checked));
  return wrap;
}

export function renderDiffToolbar(
  container: HTMLElement,
  initial: DiffToolbarInitial,
  cb: DiffToolbarCallbacks,
): DiffToolbarHandle {
  container.replaceChildren();
  container.classList.add("diff2-toolbar");

  // ── Row 1 ──────────────────────────────────────────────────────────────────
  // Row 1 is a SINGLE wrap flow (no left/right sub-groups): the buttons and the trailing
  // "Edit" toggle share one flex-wrap context so the toggle rides on the LAST button line
  // (right-aligned via margin-left:auto) instead of wrapping to its own line — saving a row of
  // height when the toolbar narrows. (Row 2 keeps its two-group left/right structure.)
  const row1 = container.appendChild(document.createElement("div"));
  row1.className = "diff2-tb-row diff2-tb-row1";
  iconButton(row1, "arrow-left", "Back to list", cb.onBack);
  iconButton(row1, "search", "Search (Mod+F) — toggle", cb.onSearch);
  // TODO §17 — verbs by mode. Callbacks are identical (onKeepAll = keep ver1, onApplyAll =
  // keep ver2); only labels/tooltips change and Join is conflict-only.
  const restore = initial.mode === "history" || initial.mode === "deleted";
  if (restore) {
    textButton(row1, "diff2-btn-keep-local", "Restore all", `Restore all changes from ${initial.localLabel}`, cb.onKeepAll);
    textButton(row1, "diff2-btn-apply-remote", "Keep all", `Keep all actual (${initial.remoteLabel}) changes`, cb.onApplyAll);
  } else {
    textButton(row1, "diff2-btn-keep-local", "Keep all", `Keep all ${initial.localLabel} changes`, cb.onKeepAll);
    textButton(row1, "diff2-btn-apply-remote", "Apply all", `Apply all remote (${initial.remoteLabel}) changes`, cb.onApplyAll);
    if (cb.onJoinAll) {
      textButton(row1, "diff2-btn-join-all", "> Join all", `Keep local and join changes from "${initial.remoteLabel}"`, cb.onJoinAll);
    }
  }
  // §2.2.14 — the "Edit" checkbox: checked ⇒ editing ENABLED. Short caption + "Editor mode"
  // tooltip. `.diff2-tb-editmode` gives it margin-left:auto so it right-aligns + wraps with the
  // buttons rather than as a separate group.
  toggle(row1, "Edit", initial.editorModeOn, cb.onToggleEditorMode, "Editor mode").classList.add(
    "diff2-tb-editmode",
  );

  // ── Row 2 ──────────────────────────────────────────────────────────────────
  const row2 = container.appendChild(document.createElement("div"));
  row2.className = "diff2-tb-row diff2-tb-row-cols"; // -cols → columns stretch + top/bottom-align (§2.2.15)
  const l2 = row2.appendChild(document.createElement("div"));
  l2.className = "diff2-tb-left";

  // Column 1: Conflicts: / NNN — coloured red while conflicts remain, green at 0 (matches the
  // ver1/ver2 gutter line-number colours). update() toggles `.is-zero`.
  const colCount = column(l2);
  colCount.className = "diff2-tb-col diff2-tb-conflicts";
  colCount.appendChild(document.createElement("span")).textContent = "Conflicts:";
  const countEl = colCount.appendChild(document.createElement("span"));
  countEl.className = "diff2-tb-count";

  // Column 2: [↑] / [↓]
  const colNav = column(l2);
  const prevBtn = iconButton(colNav, "chevron-up", "Previous conflict (Ctrl+[)", cb.onPrev);
  const nextBtn = iconButton(colNav, "chevron-down", "Next conflict (Ctrl+])", cb.onNext);

  // Column 3: [Undo] / [Redo]
  const colHist = column(l2);
  const undoBtn = iconButton(colHist, "undo", "Undo", cb.onUndo);
  const redoBtn = iconButton(colHist, "redo", "Redo", cb.onRedo);

  // Right column: Auto-focus / Diff-mode
  const r2 = row2.appendChild(document.createElement("div"));
  r2.className = "diff2-tb-right";
  const rCol = column(r2);
  toggle(rCol, "Auto-focus", initial.autoFocusOn, cb.onToggleAutoFocus);
  const modeWrap = rCol.appendChild(document.createElement("label"));
  modeWrap.className = "diff2-tb-mode";
  modeWrap.appendChild(document.createTextNode("Diff:"));
  const sel = modeWrap.appendChild(document.createElement("select"));
  for (const [v, t] of [["characters", "Char"], ["words", "Word"]] as const) {
    const o = sel.appendChild(document.createElement("option"));
    o.value = v;
    o.textContent = t;
  }
  sel.value = initial.diffMode;
  sel.addEventListener("change", () => cb.onSetDiffMode(sel.value === "words" ? "words" : "characters"));

  return {
    update(s: DiffToolbarState) {
      countEl.textContent = String(s.conflictCount);
      colCount.classList.toggle("is-zero", s.conflictCount === 0); // green at 0, red otherwise
      // NOT the HTML `disabled` attribute: a disabled <button> fires NO events, so its click
      // can't refocus the editor and the browser shifts focus off it → caret vanishes, hotkeys
      // die. Instead a VISUAL-only "off" state; the button stays clickable and its handler
      // (owner.navPrev/navNext/undo/redo) refocuses the editor + no-ops at the boundary.
      setOff(prevBtn, !s.hasPrev);
      setOff(nextBtn, !s.hasNext);
      setOff(undoBtn, !s.canUndo);
      setOff(redoBtn, !s.canRedo);
    },
  };
}
