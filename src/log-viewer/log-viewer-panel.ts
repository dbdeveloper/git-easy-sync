// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER — the viewer itself, as a component that mounts into ANY
// container: the desktop pop-out tab (log-viewer-view.ts) or the
// full-screen modal on a phone (log-viewer-modal.ts). Thin on purpose:
// opening, merging, filtering and formatting live in log-model.ts and
// are unit-tested; this file only draws them.
//
// A read-only CodeMirror 6 document carries the text table: CM6 gives
// virtual scrolling (only visible lines are in the DOM, whatever the log
// size), selection + copy, and its own search panel (highlight, next /
// previous, case, whole word, regexp — spec §2.11). Line wrapping is OFF
// so the columns stay aligned. Opened ONLY from Settings → Logging
// (spec §2.16).

import { Notice, setIcon } from "obsidian";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  closeSearchPanel,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import { LiveFeed, openLog, renderAppend, renderLog, type LogItem } from "./log-model";
import { makeFilter } from "./log-filter";
import { SEPARATOR, separatorsAsDashes, type LevelMark } from "./log-format";
import type { LogFileAdapter } from "./log-load";
import { parseLogLine, type LogEntry, type RecentLine } from "./log-parse";
import { formatLogSize } from "../settings/log-size";

export interface LogViewerDeps {
  adapter: LogFileAdapter;
  logPath: string;
  // A getter: the plugin may replace its logger (RESET).
  logger: () => {
    recentLines(): RecentLine[];
    subscribe(fn: (l: RecentLine) => void): () => void;
    onLifecycle(fn: (e: "cleaned" | "disabled") => void): () => void;
  };
}

// What the panel needs from whoever shows it (the tab or the modal).
export interface LogViewerHost {
  // Logging was turned off in Settings: close the viewer.
  onClose?: () => void;
}

const FILTER_DEBOUNCE_MS = 150; // spec §2.12
const GAP_REREAD_MS = 1000; // spec §2.14: one background re-read

// Level colouring: marks from log-format, drawn as decorations.
const setLevelMarks = StateEffect.define<LevelMark[]>();
const addLevelMarks = StateEffect.define<LevelMark[]>(); // live tail
const markDeco = (m: LevelMark) =>
  Decoration.mark({
    class: `ges-log-level ges-log-level-${m.level.toLowerCase()}`,
  }).range(m.from, m.to);
const levelMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLevelMarks)) return Decoration.set(e.value.map(markDeco), true);
    }
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addLevelMarks)) deco = deco.update({ add: e.value.map(markDeco) });
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// "The last line is in view" — the auto-scroll switch (owner,
// 2026-10-08). Within one line of the end counts: sub-pixel rounding and
// a horizontal scrollbar must not read as "the user scrolled up".
export function isLastLineVisible(
  g: { scrollTop: number; clientHeight: number; scrollHeight: number },
  lineHeight: number,
): boolean {
  return g.scrollTop + g.clientHeight >= g.scrollHeight - lineHeight;
}

// CM6 builds the search panel's switches as case, regexp, word; the
// filter's order is Aa, W, .* (owner, 2026-10-08). Re-ordered in place,
// once per panel: the labels move to just before CM6's own close button.
function orderSearchSwitches(editorDom: HTMLElement): void {
  const panel = editorDom.querySelector<HTMLElement>(".cm-search");
  if (!panel || panel.dataset.gesOrdered === "1") return;
  const label = (name: string) =>
    panel.querySelector<HTMLInputElement>(`label input[name="${name}"]`)?.parentElement ?? null;
  const wanted = [label("case"), label("word"), label("re")];
  if (wanted.some((l) => l === null)) return;
  const anchor = panel.querySelector('[name="close"]');
  for (const l of wanted) panel.insertBefore(l!, anchor);
  panel.dataset.gesOrdered = "1";
}

// Separator lines get a class; CSS draws the rule across the whole line,
// which CM6 stretches to the widest content or the viewport, whichever is
// wider. Visible lines only — cheap at any log size.
const separatorRule = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const deco = Decoration.line({ class: "ges-log-sep" });
      const out = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (line.text === SEPARATOR) out.push(deco.range(line.from));
          pos = line.to + 1;
        }
      }
      return Decoration.set(out);
    }
  },
  { decorations: (v) => v.decorations },
);

// Copy / cut from the editor: separators become dashes (owner) so the
// table reads in plain text elsewhere.
const copyWithDashes = EditorView.domEventHandlers({
  copy(e, view) {
    const text = view.state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => view.state.sliceDoc(r.from, r.to))
      .join("\n");
    if (!text || !e.clipboardData) return false;
    e.clipboardData.setData("text/plain", separatorsAsDashes(text));
    e.preventDefault();
    return true;
  },
});

export class LogViewerPanel {
  private editor: EditorView | null = null;
  private items: LogItem[] = [];
  private query = "";
  private switches = { caseSensitive: false, wholeWord: false, regexp: false };
  private statusEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private filterTimer: number | null = null;
  private shownText = "";
  private shown = 0;
  private total = 0;
  // The compiled current filter, reused for every live entry.
  private passes: (e: LogEntry) => boolean = () => true;
  private feed: LiveFeed | null = null;
  private gapTimer: number | null = null;
  private unbindKeys: (() => void) | null = null;
  private unwatchWindow: (() => void) | null = null;
  // Set by destroy(): a read still in flight must not draw into a closed
  // modal or tab.
  private destroyed = false;
  private searchBtn: HTMLElement | null = null;
  // Auto-scroll: follow new entries while the last line is in view. Set
  // ONLY by scrolling (the user's or our own scroll to the end) — never
  // measured per entry: CM6 inserts at once but scrolls on the next
  // frame, so a per-entry check broke on the second entry of a burst.
  private following = true;
  // The scroller's last position, to tell a horizontal scroll from a
  // vertical one in the scroll event.
  private lastScrollLeft = 0;
  private lastScrollTop = 0;

  private unLifecycle: (() => void) | null = null;
  // Bumped by [Clean]: a file read started before it is stale and must
  // not draw the cleaned lines back.
  private generation = 0;

  constructor(
    private readonly deps: LogViewerDeps,
    private readonly host: LogViewerHost = {},
  ) {}

  async mount(root: HTMLElement): Promise<void> {
    root.empty();
    root.addClass("ges-log-viewer");
    this.buildToolbar(root.createDiv("ges-log-toolbar"));
    this.bodyEl = root.createDiv("ges-log-body");

    // Obsidian takes Mod+F before a custom view's keymap; a capture-phase
    // listener wins, gated on focus being inside THIS editor (the same
    // fix as diff2's editor). ⚠️ On THIS view's window and document, not
    // the global ones: on desktop the viewer lives in its own pop-out
    // window, which has a window and document of its own.
    this.bindKeys(root.win ?? window);

    // Dragged into ANOTHER window (owner's field report, 2026-10-08: a tab
    // pulled out into a new pop-out showed "|||text" and would not
    // scroll). CM6 mounts its base styles — white-space: pre, the
    // scroller — into the document the editor was created in; a new
    // window's document has none of them. setRoot() is CM6's API for this
    // exact move; the Mod+F listener moves to the new window as well.
    this.unwatchWindow = root.onWindowMigrated?.((win) => {
      this.editor?.setRoot(win.document);
      this.bindKeys(win);
      // The move also reset the scroll to 0 — silently, no scroll event
      // (owner, 2026-10-08: a user reading an entry in the middle lost
      // it). Put it back from the last known position.
      this.restoreScroll();
    }) ?? null;

    // Subscribe BEFORE the file is read: what is logged during the read
    // waits in the feed and is let through after the merge (spec §2.14).
    const logger = this.deps.logger();
    this.feed = new LiveFeed((fn) => logger.subscribe(fn));
    // Settings → Logging (owner, 2026-10-08): every open viewer reacts.
    this.unLifecycle = logger.onLifecycle((e) => {
      if (e === "cleaned") this.onCleaned();
      else this.host.onClose?.();
    });
    await this.loadLog(false);
  }

  // The capture-phase Mod+F listener, on the window the panel lives in
  // (re-bound when it moves to another one).
  private bindKeys(win: Window): void {
    this.unbindKeys?.();
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F"))) return;
      if (!this.editor || !this.editor.dom.contains(win.document.activeElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openSearchPanel(this.editor);
    };
    win.addEventListener("keydown", onKey, { capture: true });
    this.unbindKeys = () => win.removeEventListener("keydown", onKey, { capture: true });
  }

  // Everything the panel started ends here: the logger subscription
  // (spec §3 step 7), timers, the key listener, the editor.
  destroy(): void {
    this.destroyed = true;
    this.feed?.close();
    this.feed = null;
    this.unLifecycle?.();
    this.unLifecycle = null;
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    if (this.gapTimer !== null) window.clearTimeout(this.gapTimer);
    this.unbindKeys?.();
    this.unbindKeys = null;
    this.unwatchWindow?.();
    this.unwatchWindow = null;
    this.editor?.destroy();
    this.editor = null;
  }

  private buildToolbar(bar: HTMLElement): void {
    const input = bar.createEl("input", {
      cls: "ges-log-filter",
      attr: {
        type: "text",
        placeholder: "Filter — use | for columns: date | time | level | message",
        spellcheck: "false",
      },
    });
    input.addEventListener("input", () => {
      this.query = input.value;
      if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
      this.filterTimer = window.setTimeout(() => {
        this.filterTimer = null;
        this.render(false);
      }, FILTER_DEBOUNCE_MS);
    });

    const toggle = (
      label: string,
      tooltip: string,
      key: keyof LogViewerPanel["switches"],
    ) => {
      const b = bar.createEl("button", { cls: "ges-log-switch", text: label });
      b.setAttr("aria-label", tooltip);
      b.addEventListener("click", () => {
        this.switches[key] = !this.switches[key];
        b.toggleClass("is-active", this.switches[key]);
        this.render(false);
      });
    };
    toggle("Aa", "Match case", "caseSensitive");
    toggle("W", "Whole word", "wholeWord");
    toggle(".*", "Regular expression", "regexp");

    // A TOGGLE (owner, 2026-10-08): a second click closes the panel. Its
    // lit state follows the panel however it was opened or closed (×,
    // Esc, Ctrl/Cmd+F) — see the editor's update listener.
    const searchBtn = bar.createEl("button", { cls: "ges-log-action ges-log-search-toggle" });
    setIcon(searchBtn, "search");
    searchBtn.setAttr("aria-label", "Search in the shown entries");
    searchBtn.addEventListener("click", () => {
      if (!this.editor) return;
      if (searchPanelOpen(this.editor.state)) closeSearchPanel(this.editor);
      else openSearchPanel(this.editor);
    });
    this.searchBtn = searchBtn;

    const copyBtn = bar.createEl("button", { cls: "ges-log-action" });
    setIcon(copyBtn, "copy");
    copyBtn.setAttr("aria-label", "Copy the shown entries");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(separatorsAsDashes(this.shownText)).then(
        () => new Notice("Log entries copied", 2000),
        (err) => new Notice(`Copy failed: ${err}`, 5000),
      );
    });

    this.statusEl = bar.createSpan("ges-log-status");
    this.errorEl = bar.createSpan("ges-log-error");
  }

  // Open (or re-open after a gap). A gap triggers ONE background re-read:
  // if the second read overlaps the ring, the content is replaced quietly
  // and the "…" goes away (spec §2.14).
  private async loadLog(isGapReread: boolean): Promise<void> {
    const gen = this.generation;
    const r = await openLog(this.deps.adapter, this.deps.logPath, this.deps.logger());
    if (this.destroyed || gen !== this.generation) return;
    if (r.kind === "too-big") {
      this.feed?.close();
      this.feed = null;
      this.showMessage(
        `The log file is too large to open here (${formatLogSize(r.size)}). ` +
          `Open it with your operating system's tools: <vault>/${this.deps.logPath}`,
      );
      return;
    }
    if (r.kind === "error") {
      this.showMessage(`Could not read the log: ${r.reason}`);
      return;
    }
    if (isGapReread && r.gap) return; // still no overlap — keep what we show
    this.items = r.items;
    this.render(true);
    if (isGapReread) this.feed?.advanceTo(r.lastSeq);
    else this.feed?.start(r.lastSeq, (l) => this.onLive(l));
    if (r.gap && !isGapReread) {
      this.gapTimer = window.setTimeout(() => {
        this.gapTimer = null;
        void this.loadLog(true);
      }, GAP_REREAD_MS);
    }
  }

  // [Clean] in Settings: the file and the logger's ring are empty now.
  // The viewer becomes an empty, live log — whatever it showed before
  // ("too large" and read errors included): auto-scroll on, both scrolls
  // at 0, and the next entry appears at once (owner, 2026-10-08).
  private onCleaned(): void {
    this.generation += 1;
    if (this.gapTimer !== null) window.clearTimeout(this.gapTimer);
    this.gapTimer = null;
    // A fresh feed: the old one may be closed ("too large") or still
    // waiting for a read that will now never finish. Every line from
    // here on is new — sequence numbers keep rising, the ring is empty.
    this.feed?.close();
    const logger = this.deps.logger();
    this.feed = new LiveFeed((fn) => logger.subscribe(fn));
    this.feed.start(null, (l) => this.onLive(l));
    this.items = [];
    this.lastScrollLeft = 0;
    this.lastScrollTop = 0;
    this.render(true); // with no editor yet, this also removes the "too large" / error text
  }

  private showMessage(text: string): void {
    this.editor?.destroy();
    this.editor = null;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "ges-log-message", text });
    this.statusEl.setText("");
  }

  // A new line from the logger (spec §2.13): always kept; drawn at the
  // end when the current filter accepts it. The view follows it only
  // while `following` — the last line was in view at the user's last
  // scroll; scrolled up, they are left alone.
  private onLive(l: RecentLine): void {
    const entry = parseLogLine(l.line);
    this.items.push(entry);
    this.total += 1;
    const ed = this.editor;
    if (ed) {
      const add = renderAppend(entry, this.passes, ed.state.doc.length);
      if (add) {
        const end = ed.state.doc.length;
        ed.dispatch({
          changes: { from: end, insert: add.insert },
          effects: addLevelMarks.of(add.marks),
        });
        this.shownText += add.insert;
        this.shown += 1;
        if (this.following) this.scrollToBottom();
      }
    }
    this.statusEl.setText(`${this.shown} of ${this.total} entries`);
  }

  // The auto-scroll step (owner, 2026-10-08): to the END vertically and
  // to column 0 horizontally — the start of every line in view. Written
  // after CM6 measured the new height, so scrollHeight includes the insert.
  private scrollToBottom(): void {
    const ed = this.editor;
    if (!ed) return;
    ed.requestMeasure({
      read: () => null,
      write: () => {
        // Decided when it RUNS, not when it was scheduled: the user may
        // have swiped sideways in between (field report, 2026-10-08).
        if (!this.following) return;
        ed.scrollDOM.scrollTop = ed.scrollDOM.scrollHeight;
        ed.scrollDOM.scrollLeft = 0;
      },
    });
  }

  // After a move to another window: following → the end and column 0 as
  // usual; otherwise exactly where the user was, both axes.
  private restoreScroll(): void {
    const ed = this.editor;
    if (!ed) return;
    if (this.following) {
      this.scrollToBottom();
      return;
    }
    const top = this.lastScrollTop;
    const left = this.lastScrollLeft;
    ed.requestMeasure({
      read: () => null,
      write: () => {
        ed.scrollDOM.scrollTop = top;
        ed.scrollDOM.scrollLeft = left;
      },
    });
  }

  // On, and at once to the end and column 0 (owner, 2026-10-08).
  private turnFollowingOn(): void {
    this.following = true;
    this.scrollToBottom();
  }

  private render(scrollToEnd: boolean): void {
    const f = makeFilter(this.query, this.switches);
    this.passes = f.ok ? f.test : () => true;
    const v = renderLog(this.items, this.query, this.switches);
    this.shownText = v.text;
    this.shown = v.shown;
    this.total = v.total;
    this.statusEl.setText(`${v.shown} of ${v.total} entries`);
    this.errorEl.setText(v.error ?? "");
    if (!this.editor) {
      this.bodyEl.empty();
      this.editor = new EditorView({
        parent: this.bodyEl,
        state: EditorState.create({
          doc: v.text,
          extensions: [
            EditorState.readOnly.of(true),
            levelMarks,
            separatorRule,
            copyWithDashes,
            search({ top: true }),
            keymap.of(searchKeymap),
            EditorView.contentAttributes.of({ spellcheck: "false" }),
            // The search panel's switches read like the filter's (owner,
            // 2026-10-08). Phrases are CM6's own UI-text hook — this
            // editor only, diff2's panel keeps its words.
            EditorState.phrases.of({ "match case": "Aa", "by word": "W", regexp: ".*" }),
            EditorView.updateListener.of((u) => {
              const open = searchPanelOpen(u.state);
              this.searchBtn?.toggleClass("is-active", open);
              if (open) orderSearchSwitches(u.view.dom);
            }),
          ],
        }),
      });
      this.editor.dispatch({ effects: setLevelMarks.of(v.marks) });
      const ed = this.editor;
      // Auto-scroll on/off from the user's scrolling (owner, 2026-10-08,
      // incl. the field report on trackpads). A gesture is never pure:
      // each event is judged by its DOMINANT axis, so the jitter on the
      // other one does not count.
      //   sideways, ending NOT at column 0  → off (reading a long line);
      //   sideways TO 0                     → nothing (our own reset, or the
      //                                       browser clamping after a filter);
      //   up, last line gone from view      → off;  up, still in view → nothing;
      //   down, ending with the last line   → ON (and jump to the end + col 0).
      const sc = ed.scrollDOM;
      sc.addEventListener("scroll", () => {
        // Detached (mid-move between windows): nothing measurable, and a
        // reset to 0 here must not overwrite the position to restore.
        if (sc.clientHeight === 0) return;
        const dx = sc.scrollLeft - this.lastScrollLeft;
        const dy = sc.scrollTop - this.lastScrollTop;
        this.lastScrollLeft = sc.scrollLeft;
        this.lastScrollTop = sc.scrollTop;
        if (dx === 0 && dy === 0) return;
        const atEnd = isLastLineVisible(sc, ed.defaultLineHeight);
        if (Math.abs(dx) > Math.abs(dy)) {
          if (sc.scrollLeft > 0) this.following = false;
        } else if (dy < 0) {
          if (!atEnd) this.following = false;
        } else if (atEnd && !this.following) {
          this.turnFollowingOn();
        }
      });
      // At the very bottom a wheel down moves nothing, so no scroll event
      // fires — the wheel itself is the deliberate "down to the end".
      sc.addEventListener(
        "wheel",
        (e: WheelEvent) => {
          if (this.following) return;
          if (e.deltaY > 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX) &&
              isLastLineVisible(sc, ed.defaultLineHeight)) {
            this.turnFollowingOn();
          }
        },
        { passive: true },
      );
    } else {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: v.text },
        effects: setLevelMarks.of(v.marks),
      });
    }
    if (scrollToEnd) {
      this.following = true;
      this.scrollToBottom(); // the newest entries are at the bottom
    }
  }
}
