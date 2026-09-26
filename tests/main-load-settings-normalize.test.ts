// @vitest-environment happy-dom
//
// Coverage for the self-heal pass at the end of
// GitHubSyncPlugin.loadSettings — the one place persisted settings are
// repaired on the way in. It had no test at all, including the shipped
// token-trim heal, so the new toggle-subordination repair arrives with
// the harness its neighbours should have had.
//
// Harness strategy is the one main-pre-sync-gate.test.ts established:
// the class is huge and its constructor drags the whole onload graph, so
// `Object.create(prototype)` gives a real instance with real prototype
// methods and zero construction side effects. Only what loadSettings
// actually reads is assigned — `loadData` and `saveSettings`, the latter
// shadowed by an own property so persistence is observable without
// touching disk.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";

interface LoadHandle {
  loadData: () => Promise<unknown>;
  saveSettings: () => Promise<void>;
  settings: Record<string, unknown>;
  loadSettings: () => Promise<void>;
}

function pluginWith(stored: Record<string, unknown>) {
  const saves = vi.fn(async () => {});
  const p = Object.create(GitHubSyncPlugin.prototype) as LoadHandle;
  // `diffEditorTouchMode` is defaulted here so its platform-dependent
  // first-run branch never fires: it would save for its OWN reason (and
  // needs `Platform`, which the obsidian stub does not export), making
  // every "was it persisted?" assertion below ambiguous.
  p.loadData = async () => ({ diffEditorTouchMode: false, ...stored });
  p.saveSettings = saves;
  return { p, saves };
}

describe("loadSettings normalises persisted state it cannot trust", () => {
  it("🔑 a legacy (configs off, data.json on) pair is repaired and PERSISTED", async () => {
    // The violation an older build could write: the UI enforces the
    // subordination only on transitions it witnessed, so this pair
    // survives on disk. Left alone, the first flip of "Sync configs"
    // back ON would honour the stored `true` and silently resume
    // publishing credentials — the one thing the rule exists to stop.
    const { p, saves } = pluginWith({
      syncConfigDir: false,
      pushPluginsDataJson: true,
    });
    await p.loadSettings();

    expect(p.settings.pushPluginsDataJson).toBe(false);
    // Repairing in memory only would re-run this every load and, worse,
    // leave the violating value on disk for any other reader.
    expect(saves).toHaveBeenCalled();
  });

  it("a legal pair is left alone and nothing is written", async () => {
    // The negative half: without it, a test asserting `false` would also
    // pass against code that simply forced the field off always.
    const { p, saves } = pluginWith({
      syncConfigDir: true,
      pushPluginsDataJson: true,
      githubToken: "t",
      githubOwner: "o",
      githubRepo: "r",
      githubBranch: "main",
    });
    await p.loadSettings();

    expect(p.settings.pushPluginsDataJson).toBe(true);
    expect(saves).not.toHaveBeenCalled();
  });

  it("still trims whitespace-poisoned identity fields (the shipped heal)", async () => {
    // Untested since it shipped; asserted here because this pass now has
    // a second reason to run and a regression would be silent —
    // a trailing space makes every REST call 404.
    const { p } = pluginWith({
      githubToken: "ghp_abc ",
      githubOwner: " acme",
      githubRepo: "vault ",
      githubBranch: "  ",
    });
    await p.loadSettings();

    expect(p.settings.githubToken).toBe("ghp_abc");
    expect(p.settings.githubOwner).toBe("acme");
    expect(p.settings.githubRepo).toBe("vault");
    // An empty branch defaults to `main` (bug-60), not to "".
    expect(p.settings.githubBranch).toBe("main");
  });
});
