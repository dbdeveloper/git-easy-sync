// @vitest-environment happy-dom
//
// TODO §14 — the sync ribbon icon spin is togglable. applySyncIconSpin() is the whole
// mechanism: it toggles the -no-spin marker class on the ribbon icon from settings.
// spinSyncIcon (styles.css zeroes the animation when both the -syncing and -no-spin
// classes are present; the accent tint stays). Uses the same Object.create(prototype)
// harness as main-pre-sync-gate.test.ts — no onload, just the one method + a stub icon.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";

// The icon is an Obsidian-augmented HTMLElement (toggleClass). We only need a stub that
// records toggleClass(cls, on) so we can assert the marker decision.
function stubIcon() {
  const classes = new Set<string>();
  return {
    classes,
    toggleClass(cls: string, on: boolean) {
      if (on) classes.add(cls);
      else classes.delete(cls);
    },
  };
}

interface SpinHandle {
  settings: { spinSyncIcon?: boolean };
  syncRibbonIcon: unknown;
  applySyncIconSpin(): void;
}
function makePlugin(spinSyncIcon: boolean | undefined, icon: unknown): SpinHandle {
  const p = Object.create(GitHubSyncPlugin.prototype) as unknown as SpinHandle;
  p.settings = { spinSyncIcon };
  p.syncRibbonIcon = icon;
  return p;
}

const NO_SPIN = "github-easy-sync-no-spin";

describe("applySyncIconSpin (TODO §14 — togglable sync-icon spin)", () => {
  it("spinSyncIcon = true → NO -no-spin marker (icon spins)", () => {
    const icon = stubIcon();
    makePlugin(true, icon).applySyncIconSpin();
    expect(icon.classes.has(NO_SPIN)).toBe(false);
  });

  it("spinSyncIcon = false → adds the -no-spin marker (spin suppressed, tint kept)", () => {
    const icon = stubIcon();
    makePlugin(false, icon).applySyncIconSpin();
    expect(icon.classes.has(NO_SPIN)).toBe(true);
  });

  it("spinSyncIcon undefined → default ON (no marker) — matches DEFAULT_SETTINGS", () => {
    const icon = stubIcon();
    makePlugin(undefined, icon).applySyncIconSpin();
    expect(icon.classes.has(NO_SPIN)).toBe(false);
  });

  it("toggling the setting flips the marker on the SAME icon (settings-tab re-apply)", () => {
    const icon = stubIcon();
    const p = makePlugin(true, icon);
    p.applySyncIconSpin();
    expect(icon.classes.has(NO_SPIN)).toBe(false);
    p.settings.spinSyncIcon = false; // user turns spin off in settings
    p.applySyncIconSpin();
    expect(icon.classes.has(NO_SPIN)).toBe(true);
  });

  it("no ribbon icon (hidden) → no throw", () => {
    expect(() => makePlugin(false, null).applySyncIconSpin()).not.toThrow();
  });
});
