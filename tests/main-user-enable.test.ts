// @vitest-environment happy-dom
//
// FIELD BUG 2026-10-05 (owner's ~/Obsidian-test, dev console):
//
//   [git-easy-sync bootloader] apply complete, reload scheduled
//   Uncaught (in promise) TypeError: Cannot read properties of undefined
//     (reading 'githubToken') at isConfigured … at onUserEnable
//
// The user enabled the plugin by click while a staged self-update was
// waiting. The bootloader applied it and onload RETURNED EARLY, before
// loadSettings, by design: the scheduled reload replaces this instance.
// Obsidian then still calls onUserEnable() on that half-loaded instance,
// which read this.settings. Nothing was lost (the reload went fine), but
// an uncaught error on every such enable is noise that looks like a
// failure.

import { afterEach, describe, expect, it } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { recordedNotices, clearRecordedNotices } from "../mock-obsidian";

describe("onUserEnable on an instance whose onload stopped at the bootloader", () => {
  afterEach(() => clearRecordedNotices());

  it("🔑 settings never loaded → no throw, no \"configure\" notice", async () => {
    const p = Object.create(GitHubSyncPlugin.prototype) as GitHubSyncPlugin;
    await expect(p.onUserEnable()).resolves.toBeUndefined();
    expect(recordedNotices).toHaveLength(0);
  });

  it("settings loaded but not configured → the notice still appears", async () => {
    const p = Object.create(GitHubSyncPlugin.prototype) as GitHubSyncPlugin;
    (p as unknown as { settings: object }).settings = {
      githubToken: "",
      githubOwner: "",
      githubRepo: "",
      githubBranch: "",
    };
    await p.onUserEnable();
    expect(recordedNotices.map((n) => n.message)).toEqual([
      "Go to settings to configure syncing",
    ]);
  });
});
