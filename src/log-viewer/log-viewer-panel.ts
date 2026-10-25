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

import { Notice, addIcon, setIcon } from "obsidian";
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
import { LiveFeed, cursorItemLines, openLog, placeExpanded, renderAppend, renderLog, sameItemLine, type LogItem } from "./log-model";
import { makeFilter } from "./log-filter";
import { SEPARATOR, separatorsAsDashes, type FormatOptions, type LevelMark } from "./log-format";
import type { LogFileAdapter } from "./log-load";
import { parseLogLine, type LogEntry, type RecentLine } from "./log-parse";
import { formatLogSize } from "../settings/log-size";
import { appendedLines, pollStep, type PollState } from "./log-poll";
import { loadLogText } from "./log-load";
import { parseLogText } from "./log-parse";

export interface LogViewerDeps {
  adapter: LogFileAdapter;
  logPath: string;
  // true (default): the plugin's CURRENT log — new lines come live from
  // the logger, Settings → Logging (Clean, off) acts on it. false: any
  // other log file — re-read when the once-a-second poll sees it change
  // (§2.23). The poll closes the viewer when the file is gone, either way.
  live?: boolean;
  // A getter: the plugin may replace its logger (RESET).
  logger: () => {
    recentLines(): RecentLine[];
    subscribe(fn: (l: RecentLine) => void): () => void;
    onLifecycle(fn: (e: "cleaned" | "disabled") => void): () => void;
    error?(message: string, data?: unknown): void;
  };
}

// What the panel needs from whoever shows it (the tab or the modal).
export interface LogViewerHost {
  // Close the viewer: logging was turned off in Settings, the file is
  // gone (§2.23), or Esc (§2.24).
  onClose?: () => void;
  // Asked at each Esc press: may Esc close this viewer? (The one tab of
  // its own pop-out window — §2.24.) Absent → Esc never closes it here.
  closeOnEscape?: () => boolean;
}

const POLL_MS = 1000; // §2.23: every open log file, once a second

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

// Compact / expanded (owner, 2026-10-24). Compact — one entry per line —
// is the default. The choice is remembered on THIS device: localStorage,
// not data.json, which travels with sync. Storage can be missing or throw
// (private window, cleared site data): then the default holds.
export const LOG_VIEW_MODE_KEY = "git-easy-sync-log-viewer-mode";

function readCompact(): boolean {
  try {
    return window.localStorage.getItem(LOG_VIEW_MODE_KEY) !== "expanded";
  } catch {
    return true;
  }
}

function saveCompact(compact: boolean): void {
  try {
    window.localStorage.setItem(LOG_VIEW_MODE_KEY, compact ? "compact" : "expanded");
  } catch {
    // not remembered — the view still switches
  }
}

// The button shows the mode a click switches TO (owner): five dense
// lines = "compact", three loose ones = "expanded", both spanning the
// icon box almost edge to edge (owner: no wide empty margins). Drawn here because
// no Lucide icon shows exactly that.
const ICON_COMPACT = "ges-log-compact";
const ICON_EXPANDED = "ges-log-expanded";
let iconsAdded = false;
function addModeIcons(): void {
  if (iconsAdded) return;
  iconsAdded = true;
  const lines = (ys: number[]) =>
    ys.map((y) => `<line x1="10" y1="${y}" x2="90" y2="${y}" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>`).join("");
  addIcon(ICON_COMPACT, lines([10, 30, 50, 70, 90]));
  addIcon(ICON_EXPANDED, lines([12, 50, 88]));
}

export class LogViewerPanel {
  private editor: EditorView | null = null;
  private items: LogItem[] = [];
  private query = "";
  private switches = { caseSensitive: false, wholeWord: false, regexp: false };
  private compact = readCompact();
  private modeBtn: HTMLElement | null = null;
  // The line each shown item starts on in the current text, and the shown
  // items themselves (renderLog) — the layout a mode switch maps from.
  private starts: number[] = [];
  private shownItems: Array<{ kind: string }> = [];
  // A scroll position WE set while placing the anchor of a mode switch:
  // its scroll event must not be judged as the user's (it could turn
  // auto-scroll on and jump to the end).
  private placedScrollTop: number | null = null;
  // §2.23: the poll of the file on disk, and the text last read (a file
  // that is not the live log is re-read when it changes).
  private pollTimer: number | null = null;
  private pollState: PollState = { last: null, misses: 0 };
  private polling = false;
  private fileText = "";
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
    // Reading and preparing a big log takes a while (10 MB: ~0.7 s on a
    // desktop, seconds on a phone — owner, 2026-10-08). The first table
    // drawn, "too large" or a read error replaces this text.
    this.showMessage("Loading the log…");

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
    if (this.isLive()) {
      const logger = this.deps.logger();
      this.feed = new LiveFeed((fn) => logger.subscribe(fn));
      // Settings → Logging (owner, 2026-10-08): every open viewer of OUR
      // log reacts; another file is not ours to clean or close (§2.23).
      this.unLifecycle = logger.onLifecycle((e) => {
        if (e === "cleaned") this.onCleaned();
        else this.host.onClose?.();
      });
    }
    await this.loadLog(false);
    if (this.destroyed) return;
    this.pollState = { last: await this.stamp(), misses: 0 };
    if (this.destroyed) return;
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  private isLive(): boolean {
    return this.deps.live !== false;
  }

  private async stamp(): Promise<{ size: number; mtime: number } | null> {
    try {
      const st = await this.deps.adapter.stat(this.deps.logPath);
      return st === null ? null : { size: st.size, mtime: st.mtime ?? 0 };
    } catch {
      return null;
    }
  }

  // §2.23 (owner, 2026-10-25): once a second. Gone at two polls in a row
  // → close. Changed, and not the live log → re-read: only the new lines
  // when the text just grew, else the whole file anew.
  private async poll(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    try {
      const step = pollStep(this.pollState, await this.stamp());
      if (this.destroyed) return;
      this.pollState = step.state;
      if (step.action === "close") {
        this.stopPoll();
        this.host.onClose?.();
        return;
      }
      if (step.action !== "changed" || this.isLive()) return;
      const loaded = await loadLogText(this.deps.adapter, this.deps.logPath);
      if (this.destroyed) return;
      if (loaded.kind === "too-big") {
        this.showMessage(
          `The log file is too large to open here (${formatLogSize(loaded.size)}). ` +
            `Open it with your operating system's tools: <vault>/${this.deps.logPath}`,
        );
        return;
      }
      if (loaded.kind === "error") return; // the next poll decides (gone → close)
      const added = appendedLines(this.fileText, loaded.text);
      this.fileText = loaded.text;
      if (added !== null && this.editor) {
        for (const line of added) this.onLive({ seq: 0, line });
        return;
      }
      this.items = parseLogText(loaded.text).entries;
      this.render(false);
      if (this.following) this.scrollToBottom();
    } finally {
      this.polling = false;
    }
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
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
    // §2.24: Esc closes the viewer when the host allows it (the one tab of
    // its own pop-out window). CAPTURE, and stopped when it closes us:
    // Obsidian handles keys from pop-outs too, and the Settings dialog in
    // the main window closed on the same Esc (owner, 2026-10-25). With the
    // search panel open the key is left alone — CM6 closes the panel.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (this.editor && searchPanelOpen(this.editor.state)) return;
      if (!this.host.closeOnEscape?.()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.host.onClose?.();
    };
    win.addEventListener("keydown", onKey, { capture: true });
    win.addEventListener("keydown", onEsc, { capture: true });
    this.unbindKeys = () => {
      win.removeEventListener("keydown", onKey, { capture: true });
      win.removeEventListener("keydown", onEsc, { capture: true });
    };
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
    this.stopPoll();
    this.unbindKeys?.();
    this.unbindKeys = null;
    this.unwatchWindow?.();
    this.unwatchWindow = null;
    this.editor?.destroy();
    this.editor = null;
  }

  private format(): FormatOptions {
    return { compact: this.compact };
  }

  private buildToolbar(bar: HTMLElement): void {
    // First, before the filter (owner, 2026-10-24).
    addModeIcons();
    const modeBtn = bar.createEl("button", { cls: "ges-log-action ges-log-mode-toggle" });
    // The editor keeps the focus — and with it the visible cursor.
    modeBtn.addEventListener("mousedown", (e) => e.preventDefault());
    modeBtn.addEventListener("click", () => this.switchMode());
    this.modeBtn = modeBtn;
    this.showMode();

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
        (err) => {
          this.deps.logger().error?.("Log viewer: copy to the clipboard failed", `${err}`);
          new Notice(`Copy failed: ${err}`, 5000);
        },
      );
    });

    this.statusEl = bar.createSpan("ges-log-status");
    this.errorEl = bar.createSpan("ges-log-error");
  }

  private showMode(): void {
    if (!this.modeBtn) return;
    setIcon(this.modeBtn, this.compact ? ICON_EXPANDED : ICON_COMPACT);
    this.modeBtn.setAttr("aria-label", this.compact ? "Switch to expanded mode" : "Switch to compact mode");
  }

  // Compact ⇄ expanded (owner, 2026-10-24), in this order:
  //   1. the cursor (or the start of the selection) is in view → its
  //      entry is the anchor: the entry's FIRST line keeps its height on
  //      screen, the cursor goes to that line (same column, or the line's
  //      end), the selection is dropped. An expanded entry opens
  //      downwards; a compacted one pulls the lines below up to it;
  //   2. following the end → stay at the end;
  //   3. otherwise the entry at the top of the screen stays at the top.
  private switchMode(): void {
    this.compact = !this.compact;
    saveCompact(this.compact);
    this.showMode();
    const ed = this.editor;
    if (!ed) return;
    const sc = ed.scrollDOM;
    const before = { starts: this.starts, compact: !this.compact };
    const items = this.shownItems;
    const doc0 = ed.state.doc;
    const cursorPos = ed.state.selection.main.from;
    const cursorLine = doc0.lineAt(cursorPos);
    const column = cursorPos - cursorLine.from;
    const cb = ed.lineBlockAt(cursorPos);
    const inView = cb.bottom > sc.scrollTop && cb.top < sc.scrollTop + sc.clientHeight;
    const oldHead = inView ? cursorItemLines(before, before, items, cursorLine.number - 1, doc0.lines) : null;
    // The entry's first line may be ABOVE the window (an expanded entry
    // seen only by its last lines, the cursor clicked on one of them):
    // then it becomes the first visible line — the collapsed entry shows
    // whole at the top (owner, 2026-10-24), never above the window.
    const offset = oldHead === null
      ? 0
      : Math.max(0, ed.lineBlockAt(doc0.line(oldHead.oldLine + 1).from).top - sc.scrollTop);
    const oldStarts = this.starts;
    const top = doc0.lineAt(ed.lineBlockAtHeight(sc.scrollTop).from).number - 1;
    this.render(false);
    const anchor = oldHead === null
      ? null
      : cursorItemLines(
          before,
          { starts: this.starts, compact: this.compact },
          items,
          cursorLine.number - 1,
          ed.state.doc.lines,
        );
    if (anchor !== null) {
      const head = ed.state.doc.line(anchor.newLine + 1);
      ed.dispatch({ selection: { anchor: head.from + Math.min(column, head.length) } });
      ed.requestMeasure({
        read: () => null,
        write: () => {
          const headTop = ed.lineBlockAt(head.from).top;
          const last = ed.state.doc.line(Math.min(anchor.newLast + 1, ed.state.doc.lines));
          sc.scrollTop = placeExpanded({
            wanted: headTop - offset,
            headTop,
            entryBottom: ed.lineBlockAt(last.from).bottom,
            viewHeight: sc.clientHeight,
          });
          this.placedScrollTop = sc.scrollTop;
          this.lastScrollTop = sc.scrollTop;
          this.following = isLastLineVisible(sc, ed.defaultLineHeight);
        },
      });
      return;
    }
    if (this.following) {
      this.scrollToBottom();
      return;
    }
    const line = sameItemLine(oldStarts, this.starts, top);
    const doc = ed.state.doc;
    ed.dispatch({
      effects: EditorView.scrollIntoView(doc.line(Math.min(line + 1, doc.lines)).from, { y: "start" }),
    });
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
    this.fileText = r.text;
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
      const add = renderAppend(entry, this.passes, ed.state.doc.length, this.format());
      if (add) {
        const end = ed.state.doc.length;
        ed.dispatch({
          changes: { from: end, insert: add.insert },
          effects: addLevelMarks.of(add.marks),
        });
        this.shownText += add.insert;
        this.shown += 1;
        // The new item starts on the line after the separator-less lead
        // "\n" (compact) or on its separator (expanded).
        this.starts.push(ed.state.doc.lineAt(end).number - (end === 0 ? 1 : 0));
        this.shownItems.push(entry);
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
    const f = makeFilter(this.query, this.switches, this.format());
    this.passes = f.ok ? f.test : () => true;
    const v = renderLog(this.items, this.query, this.switches, this.format());
    this.starts = v.starts;
    this.shownItems = v.items;
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
        if (this.placedScrollTop !== null) {
          const ours = sc.scrollTop === this.placedScrollTop;
          this.placedScrollTop = null;
          if (ours) {
            this.lastScrollLeft = sc.scrollLeft;
            this.lastScrollTop = sc.scrollTop;
            return;
          }
        }
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
