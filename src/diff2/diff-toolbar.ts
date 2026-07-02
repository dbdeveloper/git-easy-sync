// §2.2.15 — the diff-editor-v2 detail toolbar (REPLACES the interim toolbar-conflicts.ts).
//
// Two conceptual ROWS, each split into a LEFT and a RIGHT flex group that wrap independently
// (right-aligned). Row 2 is a row of 2-LINE COLUMNS (each column a vertical stack of two
// controls), and a column wraps as one atomic unit:
//
//   row1 L: [←] [Keep all] [Apply all] [> Join all]      R: Touch-mode [x]
//   row2 L: {Conflicts:/NNN} {[↑]/[↓]} {[Undo]/[Redo]}   R: {Auto-focus [x] / Diff-mode ▾}
//
// The toolbar is LIVE: `update(state)` cheaply patches the count + the disabled states on
// every editor transaction (the caller wires an updateListener) — NOT a full re-render.
// Plain DOM (document.createElement) so it's unit-testable without the Obsidian createEl
// augmentation; icons via Obsidian setIcon (no-op-stubbed in tests).

import { setIcon } from "obsidian";

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
  onToggleTouch(on: boolean): void;
  onToggleAutoFocus(on: boolean): void;
  onSetDiffMode(mode: DiffMode): void;
}

export interface DiffToolbarInitial {
  localLabel: string;
  remoteLabel: string;
  isMarkdown: boolean;
  touchOn: boolean;
  autoFocusOn: boolean;
  diffMode: DiffMode;
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

function toggle(parent: HTMLElement, label: string, on: boolean, onChange: (on: boolean) => void): void {
  const wrap = parent.appendChild(document.createElement("label"));
  wrap.className = "diff2-tb-toggle";
  wrap.appendChild(document.createTextNode(label));
  const cb = wrap.appendChild(document.createElement("input"));
  cb.type = "checkbox";
  cb.checked = on;
  cb.addEventListener("change", () => onChange(cb.checked));
}

export function renderDiffToolbar(
  container: HTMLElement,
  initial: DiffToolbarInitial,
  cb: DiffToolbarCallbacks,
): DiffToolbarHandle {
  container.replaceChildren();
  container.classList.add("diff2-toolbar");

  // ── Row 1 ──────────────────────────────────────────────────────────────────
  const row1 = container.appendChild(document.createElement("div"));
  row1.className = "diff2-tb-row";
  const l1 = row1.appendChild(document.createElement("div"));
  l1.className = "diff2-tb-left";
  iconButton(l1, "arrow-left", "Back to list", cb.onBack);
  iconButton(l1, "search", "Search (Mod+F) — toggle", cb.onSearch);
  textButton(l1, "diff2-btn-keep-local", "Keep all", `Keep all local (${initial.localLabel}) changes`, cb.onKeepAll);
  textButton(l1, "diff2-btn-apply-remote", "Apply all", `Apply all remote (${initial.remoteLabel}) changes`, cb.onApplyAll);
  if (cb.onJoinAll) {
    textButton(l1, "diff2-btn-join-all", "> Join all", `Keep local and join changes from "${initial.remoteLabel}"`, cb.onJoinAll);
  }
  const r1 = row1.appendChild(document.createElement("div"));
  r1.className = "diff2-tb-right";
  toggle(r1, "Touch-mode", initial.touchOn, cb.onToggleTouch);

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
  modeWrap.appendChild(document.createTextNode("Diff-mode:"));
  const sel = modeWrap.appendChild(document.createElement("select"));
  for (const [v, t] of [["characters", "Character"], ["words", "Word"]] as const) {
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
      prevBtn.disabled = !s.hasPrev;
      nextBtn.disabled = !s.hasNext;
      undoBtn.disabled = !s.canUndo;
      redoBtn.disabled = !s.canRedo;
    },
  };
}
