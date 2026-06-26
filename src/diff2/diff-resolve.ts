// V2 conflict resolution (DIFF-EDITOR-V2.md §2.2.9 ОСНОВНИЙ scenario / scenario-2).
//
// Resolving a diff-group is a single region-replace: swap the WHOLE group span
// [ver1.from, ver2.to) for the chosen plain text, drop the group's two ranges
// from the structure (it is now normal text), and drop the caret at the END of
// the resolved content (§2.2.9 — copy-paste semantics: the caret lands right
// after the inserted text, exactly as a select-then-paste would leave it).
//
// The UNDO landing point is device-dependent and handled by applyResolve, NOT
// here (§2.2.9): a KEYBOARD hotkey leaves the caret where the user pressed it
// (CM6 stores that as the transaction's before-selection); a POINTER/tap click
// has no meaningful caret, so applyResolve first synthesizes one at ver1.from so
// UNDO returns to the group start. Either way FORWARD (resolve/redo) = END.
//
// One transaction ⇒ one undo step (history newGroupDelay:0) and one history.jsonl
// block on replay (scenario-2, validated by v2-resolution-paste-spike). The
// auto-\n and selection filters skip setStructure transactions, so this drives
// the doc + structure together cleanly.
//
// Pure `resolveGroup` (unit-tested) + `applyResolve` (dispatch) + a click handler
// that wires the marker buttons.

import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import type { VerRange } from "./diff-model";
import { readStructure, resolveCaret, setStructure, toRangeSet } from "./diff-structure";
import { groupsOf } from "./diff-selection";

export type ResolveChoice = "keep1" | "keep2" | "both" | "neither" | "join";

export interface ResolveOpts {
  label?: string; // remote deviceLabel (for join)
  date?: string; // formatted date (for join)
}

// Reformat the filesystem-safe conflict timestamp "YYYY-MM-DDTHH-MM-SSZ" into a readable
// "YYYY-MM-DD HH:MM:SS" for the join header (same numbers, just parsed — the colons can't
// live in a filename, hence the dashed source). Anything not matching that exact shape is
// left untouched (defensive — empty string, already-formatted, etc.).
export function formatJoinDate(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z?$/.exec(ts);
  return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : ts;
}

// "> "-quote each ver2 line under a header (§2.2.9(7) / TODO #13). Empty ver2 ⇒
// nothing inserted.
function joinText(ver2content: string, opts: ResolveOpts): string {
  if (ver2content === "") return "";
  const label = opts.label ?? "remote";
  const date = formatJoinDate(opts.date ?? "");
  const header = `> Changes from \`${label}\` at ${date}:\n`;
  const hadTrailingNl = ver2content.endsWith("\n");
  const body = hadTrailingNl ? ver2content.slice(0, -1) : ver2content;
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n") + (hadTrailingNl ? "\n" : "");
  return header + quoted;
}

// The resolved plain text for one group's two contents (terminal \n already dropped).
function resolvedInsert(
  choice: ResolveChoice,
  ver1content: string,
  ver2content: string,
  opts: ResolveOpts,
): string {
  switch (choice) {
    case "keep1":
      return ver1content;
    case "keep2":
      return ver2content;
    case "both":
      return ver1content + ver2content;
    case "neither":
      return "";
    case "join":
      return ver1content + joinText(ver2content, opts);
  }
}

// Build the resolution transaction for one group, or null if the group is absent.
// `before` = the caret to restore on UNDO (§2.2.9 — keyboard: where the hotkey was
// pressed; pointer: the group start). FORWARD/REDO caret = the END of the insert.
// Both ride the transaction as a `resolveCaret` effect; the view-level listener
// applies them across undo/redo (CM6's native mapping can't — see diff-structure).
export function resolveGroup(
  doc: Text,
  ranges: VerRange[],
  group: number,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
  before?: number,
): TransactionSpec | null {
  const v1 = ranges.find((r) => r.group === group && r.ver === 1);
  const v2 = ranges.find((r) => r.group === group && r.ver === 2);
  if (!v1 || !v2) return null;
  const groupFrom = v1.from;
  const groupTo = v2.to;
  const insert = resolvedInsert(
    choice,
    doc.sliceString(v1.from, v1.to - 1), // ver1 content (terminal \n dropped)
    doc.sliceString(v2.from, v2.to - 1), // ver2 content
    opts,
  );

  // structure after the replace: drop this group; ranges after the span shift by
  // delta (groups never overlap, so others are wholly before groupFrom or after
  // groupTo — those before are unchanged, the change starts at groupFrom).
  const delta = insert.length - (groupTo - groupFrom);
  const remaining = ranges
    .filter((r) => r.group !== group)
    .map((r) => (r.from >= groupTo ? { ...r, from: r.from + delta, to: r.to + delta } : r));

  const after = groupFrom + insert.length; // §2.2.9 — END of the resolved content
  return {
    changes: { from: groupFrom, to: groupTo, insert },
    effects: [
      setStructure.of(toRangeSet(remaining)),
      resolveCaret.of({ before: before ?? after, after }),
    ],
    selection: { anchor: after }, // forward (live) caret = END (copy-paste)
    scrollIntoView: true,
  };
}

// Where a resolution origin comes from. `keyboard` (Ctrl+Enter — caret already in
// the group) restores the user's caret on UNDO; `pointer` (button/tap — no
// meaningful caret) restores the group start (§2.2.9).
export type ResolveOrigin = "keyboard" | "pointer";

export function applyResolve(
  view: EditorView,
  group: number,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
  origin: ResolveOrigin = "pointer",
): boolean {
  const ranges = readStructure(view.state);
  const v1 = ranges.find((r) => r.group === group && r.ver === 1);
  if (!v1) return false;
  // §2.2.9 — the UNDO caret (`before`): a KEYBOARD hotkey keeps the user's caret
  // (where it was pressed); a POINTER click has no meaningful caret, so use the
  // group start. The caret is carried as data (resolveCaret) and applied by the
  // listener — NOT a pre-anchor dispatch, which corrupts CM6's redo selection.
  const before = origin === "keyboard" ? view.state.selection.main.head : v1.from;
  const spec = resolveGroup(view.state.doc, ranges, group, choice, opts, before);
  if (!spec) return false;
  view.dispatch(spec); // single transaction — doc + structure + caret-marker together
  view.focus(); // keep keyboard focus after a button click (undo/redo reach CM6)
  return true;
}

// A marker button carries `data-diff2-resolve="<choice>"` + `data-diff2-group`.
// This handler catches the click and applies the resolution. Resolve options
// (deviceLabel/date for join) are supplied by the view config at wiring time
// (Phase 6); a default keeps the editor usable standalone.
export function resolveClickHandler(opts: ResolveOpts = {}): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const btn = target?.closest?.("[data-diff2-resolve]") as HTMLElement | null;
      if (!btn) return false;
      event.preventDefault();
      const group = Number(btn.getAttribute("data-diff2-group"));
      const choice = btn.getAttribute("data-diff2-resolve") as ResolveChoice;
      return applyResolve(view, group, choice, opts, "pointer"); // §2.2.9 mouse/tap → synthesize caret

    },
  });
}

// ── keyboard hotkeys (§1.9) ──────────────────────────────────────────────────
// The group whose span [ver1.from, ver2.to) contains the caret, else null.
// HALF-OPEN: `g.to` is the position AFTER the group (the next normal line's start
// / the trailing EOF line). A caret AT `g.to` is on that next line, NOT in the
// group — so `caret < g.to`, NOT `<= g.to`. The inclusive form made a caret on the
// normal line directly after a group resolve that group (boundary shifted down).
export function currentGroupAt(ranges: VerRange[], caret: number): number | null {
  for (const g of groupsOf(ranges)) {
    if (caret >= g.from && caret < g.to) return g.group;
  }
  return null;
}

// Resolve the group the caret is in (no-op if the caret isn't in a group).
export function resolveCurrentGroup(
  view: EditorView,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): boolean {
  const group = currentGroupAt(readStructure(view.state), view.state.selection.main.head);
  if (group === null) return false;
  return applyResolve(view, group, choice, opts, "keyboard"); // §2.2.9 hotkey → keep the caret
}

// Which ver-block side the caret sits in (1/2), or null if not inside a ver range.
// Drives the §1.9 context-sensitive apply/remove ("this block" = the caret's side).
// HALF-OPEN `[from, to)` — a caret AT `r.to` is at the START of the NEXT range/line,
// NOT in this one, so `head < r.to`, NOT `<= r.to`. The inclusive form misfired at
// BOTH boundaries: (a) a caret on the normal line after a group (head === ver2.to)
// matched that ver2; (b) a caret at ver2.from (=== ver1.to) matched ver1 first
// (loop order) — Ctrl+Delete then hit the wrong side.
function caretVer(view: EditorView): 1 | 2 | null {
  const head = view.state.selection.main.head;
  for (const r of readStructure(view.state)) {
    if (head >= r.from && head < r.to) return r.ver;
  }
  return null;
}

// §1.9 "apply this block" — keep the side the caret is in (ver1→keep1, ver2→keep2).
function resolveApplyCurrent(view: EditorView, opts: ResolveOpts): boolean {
  const ver = caretVer(view);
  return ver === null ? false : resolveCurrentGroup(view, ver === 1 ? "keep1" : "keep2", opts);
}
// §1.9 "remove this block" — drop the side the caret is in (ver1→keep2, ver2→keep1).
function resolveRemoveCurrent(view: EditorView, opts: ResolveOpts): boolean {
  const ver = caretVer(view);
  return ver === null ? false : resolveCurrentGroup(view, ver === 1 ? "keep2" : "keep1", opts);
}

// §1.9 hotkeys. LITERAL `Ctrl` on every platform (NOT `Mod`/Cmd): §1.9 deliberately
// uses Ctrl on Mac too (Cmd+Backspace is OS-reserved). Prec.highest so they win over
// defaultKeymap. apply/remove are context-sensitive on the caret's side.
//
// Fall-through policy OUTSIDE a conflict block (caret on a normal line):
//   - the BACKSPACE combos CONSUME the key (return true) → hard no-op. Otherwise
//     they fell through to defaultKeymap's Ctrl-Backspace = deleteGroupBackward,
//     which deletes a word / jumps the caret on a normal line (unwanted for a
//     resolution shortcut).
//   - the ENTER / join combos still fall through (return false when no block), so
//     e.g. Ctrl+Enter keeps its normal-line behaviour (user-confirmed OK).
export function diffResolveKeymap(opts: ResolveOpts = {}): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Ctrl-Enter", run: (v) => resolveApplyCurrent(v, opts) }, // apply this block (falls through off-block)
      { key: "Ctrl-Shift-Enter", run: (v) => resolveCurrentGroup(v, "both", opts) },
      { key: "Ctrl-Shift-.", run: (v) => resolveCurrentGroup(v, "join", opts) }, // md only (no-op if non-md group)
      // remove this block — CONSUME even off-block (no deleteGroupBackward fall-through)
      {
        key: "Ctrl-Backspace",
        run: (v) => {
          resolveRemoveCurrent(v, opts);
          return true;
        },
      },
      {
        key: "Ctrl-Shift-Backspace",
        run: (v) => {
          resolveCurrentGroup(v, "neither", opts);
          return true;
        },
      },
    ]),
  );
}

// ── bulk resolution (toolbar: Keep all / Apply all / Join all) ────────────────
// Resolve EVERY group toward one choice in a SINGLE transaction (one undo step).
export function resolveAll(
  doc: Text,
  ranges: VerRange[],
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): TransactionSpec | null {
  const groups = groupsOf(ranges);
  if (groups.length === 0) return null;
  const changes = groups.map((g) => {
    const v1 = ranges.find((r) => r.group === g.group && r.ver === 1)!;
    const v2 = ranges.find((r) => r.group === g.group && r.ver === 2)!;
    const insert = resolvedInsert(
      choice,
      doc.sliceString(v1.from, v1.to - 1),
      doc.sliceString(v2.from, v2.to - 1),
      opts,
    );
    return { from: g.from, to: g.to, insert }; // non-overlapping; ChangeSet composes
  });
  return {
    changes,
    effects: [
      setStructure.of(toRangeSet([])), // all groups resolved ⇒ no conflicts left
      resolveCaret.of({ before: groups[0].from, after: groups[0].from }),
    ],
    selection: { anchor: groups[0].from }, // caret at the first resolved group
    scrollIntoView: true,
  };
}

export function applyResolveAll(
  view: EditorView,
  choice: ResolveChoice,
  opts: ResolveOpts = {},
): boolean {
  const ranges = readStructure(view.state);
  const spec = resolveAll(view.state.doc, ranges, choice, opts);
  if (!spec) return false;
  view.dispatch(spec); // single transaction — caret-marker rides it (resolveCaret)
  view.focus();
  return true;
}

// A bulk toolbar element (placed ABOVE the editor by the host view). Buttons map
// to applyResolveAll; disabled when there are no conflicts.
export function createBulkToolbar(view: EditorView, opts: ResolveOpts = {}): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "diff2-toolbar";
  const buttons: { label: string; choice: ResolveChoice }[] = [
    { label: "Keep all (local)", choice: "keep1" },
    { label: "Apply all (remote)", choice: "keep2" },
    { label: "Join all", choice: "join" },
  ];
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.className = `diff2-toolbar-btn diff2-toolbar-${b.choice}`;
    btn.textContent = b.label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      applyResolveAll(view, b.choice, opts);
    });
    bar.appendChild(btn);
  }
  return bar;
}
