// @vitest-environment happy-dom
//
// FIELD DEFECT, 2026-10-03 — Reset silently kept the OLD credentials.
//
// The owner reset the plugin, entered a new token and a new repository,
// clicked Sync, and nothing reached the new repo. The log showed the
// sync talking to the PREVIOUS repository with the PREVIOUS token —
// `GET tree/<old-head>` answering 200 with a 95 KB payload, from a repo
// the new token cannot even read.
//
// ── THE MECHANISM ────────────────────────────────────────────────────
// `GithubClient` is constructed ONCE in `initSync2()` and keeps the
// settings OBJECT by reference. `resetPluginState()` did
// `this.settings = Object.assign({}, DEFAULT_SETTINGS)` — it REPLACED
// the object rather than clearing it. From that moment the plugin and
// its client held two different objects: everything the user typed
// afterwards went into the new one, and every request kept reading the
// old one. Nothing re-creates the client, so it lasted until a reload.
//
// ⚠️ WHY THIS IS WORSE THAN A WRONG REPO. The common reason to reset is
// to ROTATE A TOKEN. The user enters a new one and the plugin keeps
// using the old — which they may have just revoked, or believe is out
// of circulation. Silently.
//
// ⚠️ AND WITHOUT A RESET IT ALL WORKED, which is why it hid for so
// long: the settings tab MUTATES `plugin.settings`, so a plain
// credential change reaches the client immediately. Only the reset
// broke the link.
//
// ── WHAT IS PINNED, AND WHY NOT OBJECT IDENTITY ─────────────────────
// The obvious assertion is `expect(before).toBe(after)`. It is too
// narrow and too wide at once: it would pass for a reset that kept the
// object but forgot to clear a field, and it names an implementation
// detail instead of the promise. So the test holds a reference the way
// GithubClient does and asserts the BEHAVIOUR — a holder from before
// the reset sees what the user types after it.

import { describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings/settings";

interface ResetHandle {
  settings: Record<string, unknown>;
  logger: unknown;
  intervalScheduler: unknown;
  sync2Manager: unknown;
  tokenExpiredFlag: unknown;
  hotMeta: unknown;
  baselines: unknown;
  deletedStore: unknown;
  conflictStoreV2: unknown;
  conflictCounter: unknown;
  app: unknown;
  saveSettings: () => Promise<void>;
  resetPluginState: () => Promise<void>;
}

// Everything `resetPluginState` touches, and nothing else. The runtime
// wipe is the real `resetRuntimeState` talking to a vault stub, so the
// test exercises the actual order (drain guard → marker → wipe →
// re-init → settings → marker gone) rather than a paraphrase of it.
function pluginAfterReset(): {
  p: ResetHandle;
  saves: ReturnType<typeof vi.fn>;
} {
  const saves = vi.fn(async () => {});
  const p = Object.create(GitHubSyncPlugin.prototype) as ResetHandle;
  p.settings = {
    githubToken: "OLD-TOKEN",
    githubOwner: "dbdeveloper",
    githubRepo: "obsidian2",
    githubBranch: "main",
    deviceLabel: "Macbook",
  };
  p.logger = { info: () => {}, warn: () => {}, error: () => {} };
  p.intervalScheduler = { stop: () => {}, start: () => {} };
  p.sync2Manager = { cancelDrain: () => {}, isDrainRunning: () => false };
  p.tokenExpiredFlag = { clear: () => {} };
  p.hotMeta = { load: async () => {} };
  p.baselines = { clear: async () => {} };
  p.deletedStore = { load: async () => {} };
  p.conflictStoreV2 = { load: async () => {} };
  p.conflictCounter = { markDirty: () => {}, flush: async () => {} };
  const files = new Map<string, string>();
  p.app = {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (x: string) => files.has(x),
        write: async (x: string, c: string) => void files.set(x, c),
        read: async (x: string) => files.get(x) ?? "",
        remove: async (x: string) => void files.delete(x),
        rmdir: async () => {},
        mkdir: async () => {},
        list: async () => ({ files: [], folders: [] }),
      },
    },
  };
  p.saveSettings = saves;
  return { p, saves };
}

describe("resetPluginState keeps every holder of `settings` attached", () => {
  it("🔑 a reference taken BEFORE the reset sees credentials entered AFTER it", async () => {
    const { p } = pluginAfterReset();
    // Exactly what GithubClient does in initSync2: capture the object.
    const clientsView = p.settings;

    await p.resetPluginState();

    // Now the user types the new credentials — the settings TAB mutates
    // `plugin.settings`, so this is the real path, not a shortcut.
    p.settings.githubToken = "NEW-TOKEN";
    p.settings.githubOwner = "dbdeveloper";
    p.settings.githubRepo = "obsidian3";

    // The client reads its captured reference on every request.
    expect(
      clientsView.githubRepo,
      "the client must see the repo the user just entered",
    ).toBe("obsidian3");
    expect(
      clientsView.githubToken,
      "🔑 the client must NOT keep using the token the reset was meant to retire",
    ).toBe("NEW-TOKEN");
  });

  it("the reset still CLEARS — old values do not survive it", async () => {
    // The other half, and the reason identity alone would not do: a
    // reset that preserved the object but skipped the wipe would pass
    // the test above while leaving the user's old token in place.
    const { p, saves } = pluginAfterReset();
    const clientsView = p.settings;

    await p.resetPluginState();

    expect(clientsView.githubToken).toBe(DEFAULT_SETTINGS.githubToken);
    expect(clientsView.githubRepo).toBe(DEFAULT_SETTINGS.githubRepo);
    expect(clientsView.githubOwner).toBe(DEFAULT_SETTINGS.githubOwner);
    // And it is persisted, or the next load would resurrect them.
    expect(saves).toHaveBeenCalled();
  });

  it("no stale key survives: a field absent from the defaults is removed", async () => {
    // `Object.assign` onto a live object merges — it does not reset.
    // Without an explicit clear, any key the defaults do not mention
    // (a removed setting, a hand-added one) would outlive the reset.
    const { p } = pluginAfterReset();
    const clientsView = p.settings;
    p.settings.someRetiredField = "leftover";

    await p.resetPluginState();

    expect(Object.keys(clientsView)).not.toContain("someRetiredField");
  });
});
