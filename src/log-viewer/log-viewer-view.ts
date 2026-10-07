// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// LOG-VIEWER step 6 — the window. Thin on purpose: opening, merging,
// filtering and formatting live in log-model.ts and are unit-tested;
// this file only draws them.
//
// A read-only CodeMirror 6 document carries the text table: CM6 gives
// virtual scrolling (only visible lines are in the DOM, whatever the log
// size), selection + copy, and its own search panel (highlight, next /
// previous, case, whole word, regexp — spec §2.11). Line wrapping is OFF
// so the columns stay aligned. Opened ONLY from Settings → Logging
// (spec §2.16).

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { LiveFeed, openLog, renderAppend, renderLog, type LogItem } from "./log-model";
import { makeFilter } from "./log-filter";
import type { LevelMark } from "./log-format";
import type { LogFileAdapter } from "./log-load";
import { parseLogLine, type LogEntry, type RecentLine } from "./log-parse";
import { formatLogSize } from "../settings/log-size";

export const LOG_VIEWER_VIEW_TYPE = "git-easy-sync-log-viewer";

export interface LogViewerDeps {
  adapter: LogFileAdapter;
  logPath: string;
  // A getter: the plugin may replace its logger (RESET).
  logger: () => {
    recentLines(): RecentLine[];
    subscribe(fn: (l: RecentLine) => void): () => void;
  };
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

export class LogViewerView extends ItemView {
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

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: LogViewerDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LOG_VIEWER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "git-easy-sync log";
  }

  getIcon(): string {
    return "scroll-text";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ges-log-viewer");
    this.buildToolbar(root.createDiv("ges-log-toolbar"));
    this.bodyEl = root.createDiv("ges-log-body");

    // Obsidian takes Mod+F before a custom view's keymap; a capture-phase
    // listener wins, gated on focus being inside THIS editor (the same
    // fix as diff2's editor). ⚠️ On THIS view's window and document, not
    // the global ones: on desktop the viewer lives in its own pop-out
    // window, which has a window and document of its own.
    const win = this.containerEl.win ?? window;
    const doc = this.containerEl.doc ?? document;
    this.registerDomEvent(
      win,
      "keydown",
      (e) => {
        if (!((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F"))) return;
        if (!this.editor || !this.editor.dom.contains(doc.activeElement)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openSearchPanel(this.editor);
      },
      { capture: true },
    );

    // Subscribe BEFORE the file is read: what is logged during the read
    // waits in the feed and is let through after the merge (spec §2.14).
    const logger = this.deps.logger();
    this.feed = new LiveFeed((fn) => logger.subscribe(fn));
    await this.loadLog(false);
  }

  async onClose(): Promise<void> {
    this.feed?.close(); // spec §3 step 7: the subscription ends with the window
    this.feed = null;
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
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
      key: keyof LogViewerView["switches"],
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

    const searchBtn = bar.createEl("button", { cls: "ges-log-action" });
    setIcon(searchBtn, "search");
    searchBtn.setAttr("aria-label", "Search in the shown entries");
    searchBtn.addEventListener("click", () => {
      if (this.editor) openSearchPanel(this.editor);
    });

    const copyBtn = bar.createEl("button", { cls: "ges-log-action" });
    setIcon(copyBtn, "copy");
    copyBtn.setAttr("aria-label", "Copy the shown entries");
    copyBtn.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.shownText).then(
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
    const r = await openLog(this.deps.adapter, this.deps.logPath, this.deps.logger());
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
      window.setTimeout(() => void this.loadLog(true), GAP_REREAD_MS);
    }
  }

  private showMessage(text: string): void {
    this.editor?.destroy();
    this.editor = null;
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "ges-log-message", text });
    this.statusEl.setText("");
  }

  // A new line from the logger (spec §2.13): always kept; drawn at the
  // end when the current filter accepts it. The view follows it only if
  // the user is already at the bottom — scrolled up, they are left alone.
  private onLive(l: RecentLine): void {
    const entry = parseLogLine(l.line);
    this.items.push(entry);
    this.total += 1;
    const ed = this.editor;
    if (ed) {
      const sc = ed.scrollDOM;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 * ed.defaultLineHeight;
      const add = renderAppend(entry, this.passes, ed.state.doc.length);
      if (add) {
        const end = ed.state.doc.length;
        ed.dispatch({
          changes: { from: end, insert: add.insert },
          effects: addLevelMarks.of(add.marks),
        });
        this.shownText += add.insert;
        this.shown += 1;
        if (atBottom) {
          ed.dispatch({
            effects: EditorView.scrollIntoView(ed.state.doc.length, { y: "end" }),
          });
        }
      }
    }
    this.statusEl.setText(`${this.shown} of ${this.total} entries`);
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
            search({ top: true }),
            keymap.of(searchKeymap),
            EditorView.contentAttributes.of({ spellcheck: "false" }),
          ],
        }),
      });
      this.editor.dispatch({ effects: setLevelMarks.of(v.marks) });
    } else {
      this.editor.dispatch({
        changes: { from: 0, to: this.editor.state.doc.length, insert: v.text },
        effects: setLevelMarks.of(v.marks),
      });
    }
    if (scrollToEnd) {
      // The newest entries are at the bottom.
      this.editor.dispatch({
        effects: EditorView.scrollIntoView(this.editor.state.doc.length, { y: "end" }),
      });
    }
  }
}
