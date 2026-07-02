// E2 — status-bar text + menu pure models (TODO §6–§7 / R2.7.3).

import { describe, it, expect } from "vitest";
import {
  CONFLICT_GLYPH,
  buildStatusMenu,
  diffTooltip,
  statusBarSuffix,
  statusMenuState,
  syncTooltip,
  type StatusMenuItem,
} from "../src/status-bar-model";

const text = (segs: { text: string }[]) => segs.map((s) => s.text).join("");

describe("statusBarSuffix — §6 text assembly", () => {
  it("0 batches, 0 conflicts → no suffix", () => {
    expect(statusBarSuffix(0, 0)).toEqual([]);
  });

  it("N batches, 0 conflicts → ' (↑ N)' with the arrow segment green", () => {
    const s = statusBarSuffix(3, 0);
    expect(text(s)).toBe(" (↑ 3)");
    expect(s.find((x) => x.text === "↑ 3")?.cls).toBe("up");
  });

  it("0 batches, M conflicts → ' (M ⁇)' with the conflict segment red", () => {
    const s = statusBarSuffix(0, 20);
    expect(text(s)).toBe(` (20 ${CONFLICT_GLYPH})`);
    expect(s.find((x) => x.text.includes(CONFLICT_GLYPH))?.cls).toBe("conflict");
  });

  it("N batches, M conflicts → ' (↑ N | M ⁇)' — space after the arrow, glyph", () => {
    const s = statusBarSuffix(3, 20);
    expect(text(s)).toBe(" (↑ 3 | 20 ⁇)");
    expect(s.find((x) => x.text === "↑ 3")?.cls).toBe("up");
    expect(s.find((x) => x.text === "20 ⁇")?.cls).toBe("conflict");
  });
});

describe("statusMenuState — precedence", () => {
  it("not configured → uninitialized (even if 'expired')", () => {
    expect(statusMenuState(false, false)).toBe("uninitialized");
    expect(statusMenuState(false, true)).toBe("uninitialized");
  });
  it("configured + expired → token-expired", () => {
    expect(statusMenuState(true, true)).toBe("token-expired");
  });
  it("configured + ok → normal", () => {
    expect(statusMenuState(true, false)).toBe("normal");
  });
});

describe("buildStatusMenu — §7 three states", () => {
  const keys = (items: StatusMenuItem[]) => items.map((i) => i.key);
  const labelOf = (items: StatusMenuItem[], key: string) =>
    items.find((i) => i.key === key)?.label;

  it("uninitialized → heading + Settings only", () => {
    const m = buildStatusMenu({
      state: "uninitialized",
      pluginName: "GitHub Easy Sync",
      queueDepth: 0,
      conflictCount: 0,
      hasActiveFile: true,
    });
    expect(keys(m)).toEqual([null, "settings"]);
    expect(m[0].label).toBe("GitHub Easy Sync: Uninitialized");
    expect(m[1].separatorBefore).toBe(true);
  });

  it("token-expired → heading + actions + Settings; first action + Settings get separators", () => {
    const m = buildStatusMenu({
      state: "token-expired",
      pluginName: "GitHub Easy Sync",
      queueDepth: 3,
      conflictCount: 2,
      hasActiveFile: true,
    });
    expect(keys(m)).toEqual([
      null,
      "sync-all",
      "commit-all",
      "commit-current",
      "pull-push",
      "open-diff",
      "settings",
    ]);
    expect(m[0].label).toBe("GitHub Easy Sync: Token expired");
    expect(m.find((i) => i.key === "sync-all")?.separatorBefore).toBe(true);
    expect(m.find((i) => i.key === "settings")?.separatorBefore).toBe(true);
  });

  it("normal → actions + Settings, no heading, no leading separator", () => {
    const m = buildStatusMenu({
      state: "normal",
      pluginName: "GitHub Easy Sync",
      queueDepth: 0,
      conflictCount: 0,
      hasActiveFile: true,
    });
    expect(keys(m)).toEqual([
      "sync-all",
      "commit-all",
      "commit-current",
      "pull-push",
      "open-diff",
      "settings",
    ]);
    expect(m.find((i) => i.key === "sync-all")?.separatorBefore).toBeFalsy();
  });

  it("pull-push label shows '(N)' only when N > 0", () => {
    const zero = buildStatusMenu({ state: "normal", pluginName: "x", queueDepth: 0, conflictCount: 0, hasActiveFile: true });
    expect(labelOf(zero, "pull-push")).toBe("Pull from repo and push stored commits");
    const some = buildStatusMenu({ state: "normal", pluginName: "x", queueDepth: 3, conflictCount: 0, hasActiveFile: true });
    expect(labelOf(some, "pull-push")).toBe("Pull from repo and push stored (3) commits");
  });

  it("open-diff label is conflict-count aware (singular/plural/none)", () => {
    const mk = (c: number) =>
      labelOf(buildStatusMenu({ state: "normal", pluginName: "x", queueDepth: 0, conflictCount: c, hasActiveFile: true }), "open-diff");
    expect(mk(0)).toBe("Open diff-panel");
    expect(mk(1)).toBe("Open diff-panel (1 open conflict)");
    expect(mk(5)).toBe("Open diff-panel (5 open conflicts)");
  });

  it("commit-current is greyed (disabled) exactly when there is no active file", () => {
    const item = (hasActiveFile: boolean) =>
      buildStatusMenu({ state: "normal", pluginName: "x", queueDepth: 0, conflictCount: 0, hasActiveFile })
        .find((i) => i.key === "commit-current");
    // present in both cases (never hidden) — only the disabled flag flips.
    expect(item(true)?.disabled).toBeFalsy();
    expect(item(false)?.disabled).toBe(true);
    // no active file also holds in the token-expired state.
    const expired = buildStatusMenu({ state: "token-expired", pluginName: "x", queueDepth: 0, conflictCount: 0, hasActiveFile: false })
      .find((i) => i.key === "commit-current");
    expect(expired?.disabled).toBe(true);
  });
});

describe("ribbon tooltips — §8 sync / §9 diff", () => {
  it("syncTooltip surfaces the commit count (singular/plural/none)", () => {
    expect(syncTooltip(0)).toBe("Sync with GitHub");
    expect(syncTooltip(1)).toBe("Sync (1 commit) with GitHub");
    expect(syncTooltip(3)).toBe("Sync (3 commits) with GitHub");
  });
  it("diffTooltip surfaces the open-conflict count (matches the menu suffix)", () => {
    expect(diffTooltip(0)).toBe("Diff-Panel");
    expect(diffTooltip(1)).toBe("Diff-Panel (1 open conflict)");
    expect(diffTooltip(5)).toBe("Diff-Panel (5 open conflicts)");
  });
});
