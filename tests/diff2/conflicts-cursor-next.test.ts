// @vitest-environment happy-dom
//
// Owner, 2026-10-18: when the conflict under the Diff Panel's cursor leaves
// the list (resolved with [←], removed outside, by the drain), the cursor
// goes to the NEXT conflict after it in the order the user saw; if it was the
// last one, to the new last one. Never back to the top of the list.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/diff2/conflicts-list", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/diff2/conflicts-list")>();
  return {
    ...real,
    // The rows only — the painting is not under test here.
    renderConflictsList: (_body: HTMLElement, entries: Array<{ siblingPath: string }>) =>
      entries.map((entry) => ({ entry, row: document.createElement("div") })),
  };
});

import { nextSurvivingKey } from "../../src/diff2/conflicts-list";
import { DiffPanelView } from "../../src/diff2/diff-panel-view";

describe("nextSurvivingKey", () => {
  it("🔑 the gone key in the middle → the next one after it", () => {
    expect(nextSurvivingKey(["a", "b", "c"], "b", ["a", "c"])).toBe("c");
  });

  it("🔑 the gone key was the last → the new last one", () => {
    expect(nextSurvivingKey(["a", "b", "c"], "c", ["a", "b"])).toBe("b");
  });

  it("the rows right after it went too → the first one after it that is still there", () => {
    expect(nextSurvivingKey(["a", "b", "c", "d"], "b", ["a", "d"])).toBe("d");
  });

  it("rows above it went too → still the next one after it, not the same row number", () => {
    expect(nextSurvivingKey(["a", "b", "c", "d"], "c", ["d"])).toBe("d");
  });

  it("nothing after it survived → the new last one", () => {
    expect(nextSurvivingKey(["a", "b", "c", "d"], "b", ["a", "e"])).toBe("e");
  });

  it("the list is empty now → nothing", () => {
    expect(nextSurvivingKey(["a"], "a", [])).toBeNull();
  });

  it("the key was not in the old order → the new last one", () => {
    expect(nextSurvivingKey(["a", "b"], "x", ["a", "b"])).toBe("b");
  });
});

// The DOM helpers Obsidian adds to HTMLElement.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
if (!proto.createDiv) {
  proto.createDiv = function (this: HTMLElement, info?: { cls?: string }) {
    const el = document.createElement("div");
    if (info?.cls) el.className = info.cls;
    this.appendChild(el);
    return el;
  };
}

const row = (siblingPath: string) => ({
  basePath: siblingPath.replace(/\.conflict-from-.*$/, ".md"),
  siblingPath,
  deviceLabel: "Phone",
  isoTimestamp: "2026-10-18T10-00-00Z",
  kind: "synthetic" as const,
});
const A = row("a.conflict-from-Phone-2026-10-18T10-00-00Z.md");
const B = row("b.conflict-from-Phone-2026-10-18T10-00-00Z.md");
const C = row("c.conflict-from-Phone-2026-10-18T10-00-00Z.md");

interface PanelHandle {
  conflictEntries: unknown[];
  conflictRefs: Array<{ entry: { siblingPath: string } }>;
  conflictSelectedIndex: number;
  conflictSelectedKey: string | null;
  conflictLaunchedKey: string | null;
  conflictListEl: HTMLElement | null;
  renderListBody(parent: HTMLElement, tab: string): void;
  applyConflictSelection(): void;
  focusConflictList(): void;
  forgetCopy(siblingPath: string): void;
  restoreLaunchedConflict(): void;
  render(): void;
  viewState: unknown;
}

function panelShowing(entries: unknown[], selected: string) {
  const panel = Object.create(DiffPanelView.prototype) as PanelHandle;
  panel.conflictEntries = entries;
  panel.conflictRefs = [];
  panel.conflictSelectedIndex = 0;
  panel.conflictSelectedKey = selected;
  panel.conflictLaunchedKey = null;
  panel.viewState = { tab: "conflicts" };
  panel.applyConflictSelection = vi.fn();
  panel.focusConflictList = vi.fn();
  const parent = document.createElement("div");
  panel.render = () => {
    parent.replaceChildren();
    panel.renderListBody(parent, "conflicts");
  };
  panel.render();
  return panel;
}

const selected = (p: PanelHandle) => p.conflictRefs[p.conflictSelectedIndex]?.entry.siblingPath;

describe("Diff Panel — the cursor when its conflict leaves the list", () => {
  it("🔑 the selected row goes → the cursor is on the next one, not on the first", () => {
    const p = panelShowing([A, B, C], B.siblingPath);
    expect(selected(p)).toBe(B.siblingPath);
    p.forgetCopy(B.siblingPath);
    expect(selected(p)).toBe(C.siblingPath);
  });

  it("🔑 the selected row was the last → the cursor is on the new last one", () => {
    const p = panelShowing([A, B, C], C.siblingPath);
    p.forgetCopy(C.siblingPath);
    expect(selected(p)).toBe(B.siblingPath);
  });

  it("🔑 [←] back: the LAUNCHED row is gone → the cursor goes to the next one after it", () => {
    // The user opened B, then moved the panel's cursor to A while the editor
    // was open; [←] resolved B.
    const p = panelShowing([A, B, C], B.siblingPath);
    p.conflictLaunchedKey = B.siblingPath;
    (p as unknown as { conflictLaunchedOrder: string[] }).conflictLaunchedOrder = [A, B, C].map((e) => e.siblingPath);
    p.conflictSelectedIndex = 0;
    p.conflictSelectedKey = A.siblingPath;
    p.forgetCopy(B.siblingPath);
    p.restoreLaunchedConflict();
    expect(selected(p)).toBe(C.siblingPath);
  });
});
