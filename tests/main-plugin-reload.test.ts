// @vitest-environment happy-dom
//
// PLUGIN-UPDATE-COMPAT Фаза 1 (§4.2, §4.3) — the auto-reload tells the
// truth about what happened.
//
// THE INCIDENT (2026-08-02). A phone pushed Templater 2.20.6 → 2.24.3;
// the MacBook was on Obsidian 1.12.x, where the class Templater extends
// does not exist, so the module threw at evaluation. Our reload unloaded
// a WORKING plugin, failed to load the new one, and logged:
//
//   BRAT-style reload done   id="templater-obsidian"     ← untrue
//
// The engine was blameless — every byte arrived correctly. The damage
// was ours twice over: we tore down something that was working, and we
// said it went fine.
//
// WHY THE REPORT CANNOT BE ONE SIGNAL (§2.7, §4.2). Everything here is
// UNDOCUMENTED Obsidian internals — observed in two bundles, not a
// contract. `enablePlugin` returns false today, but that is an internal
// detail that could become `void`; and `plugins[id]` has its own hole,
// because `loadPlugin` assigns it BEFORE awaiting `onload()`, so a
// plugin that throws in onload stays in the map. Neither alone is
// trustworthy, so failure is the DISJUNCTION and success needs both.
//
// ⚠️ NOT `enabledPlugins.has(id)` — the set bare `disablePlugin` /
// `enablePlugin` never touch (§2.5). It reads `true` whatever happened,
// which is why 6.1.2–6.1.4 exist: they go red against that shortcut.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GitHubSyncPlugin from "../src/main";
import {
  recordedNotices,
  clearRecordedNotices,
  setMockApiVersion,
  setMockPlatform,
  App,
  Vault,
} from "../mock-obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// A controllable stand-in for `app.plugins` — the surface §2.3-§2.6
// describes, with every call recorded so a test can assert what we did
// to a user's working plugin, not merely what we concluded.
interface FakePM {
  enabledPlugins: Set<string>;
  plugins: Record<string, unknown>;
  disableCalls: string[];
  disableAndSaveCalls: string[];
  enableCalls: string[];
  // What `enablePlugin` answers, per id. `undefined` models a future
  // Obsidian whose return type changed.
  enableResult: Record<string, boolean | undefined>;
  // Whether `plugins[id]` survives the enable attempt.
  keepInMap: Record<string, boolean>;
}

interface FakePMInit {
  enabledPlugins?: string[];
  plugins?: Record<string, unknown>;
  enableResult?: Record<string, boolean | undefined>;
  keepInMap?: Record<string, boolean>;
}

function makePM(init: FakePMInit = {}): FakePM & {
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<boolean | undefined>;
} {
  const pm: FakePM = {
    enabledPlugins: new Set(init.enabledPlugins ?? []),
    plugins: init.plugins ?? {},
    disableCalls: [],
    disableAndSaveCalls: [],
    enableCalls: [],
    enableResult: init.enableResult ?? {},
    keepInMap: init.keepInMap ?? {},
  };
  return {
    ...pm,
    async disablePlugin(id: string) {
      (this as unknown as FakePM).disableCalls.push(id);
      // Obsidian's bare disable removes the instance but does NOT touch
      // enabledPlugins (§2.5) — the exact asymmetry 6.1.4 leans on.
      delete (this as unknown as FakePM).plugins[id];
    },
    async disablePluginAndSave(id: string) {
      const self = this as unknown as FakePM;
      self.disableAndSaveCalls.push(id);
      delete self.plugins[id];
      self.enabledPlugins.delete(id);
    },
    async enablePlugin(id: string) {
      const self = this as unknown as FakePM;
      self.enableCalls.push(id);
      if (self.keepInMap[id]) self.plugins[id] = { id };
      return self.enableResult[id];
    },
  } as FakePM & {
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<boolean | undefined>;
  };
}

interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  data: unknown;
}

// `ids` get a manifest this Obsidian satisfies, so the §4.1 gate is a
// no-op and the test can be about what comes after it. A test that
// wants the gate to FIRE writes its own manifest instead.
function fixture(pm: ReturnType<typeof makePM>, ids: string[] = []) {
  const root = path.join(
    os.tmpdir(),
    `reload-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  const vault = new Vault(root);
  const app = new App(vault) as unknown as Record<string, unknown>;
  app.plugins = pm;

  for (const id of ids) {
    writeManifest(root, id, { id, minAppVersion: "0.0.1" });
  }

  const lines: LogLine[] = [];
  const plugin = Object.create(GitHubSyncPlugin.prototype) as unknown as {
    handlePluginsAffectedReload(ids: string[]): void;
  };
  Object.assign(plugin, {
    app,
    logger: {
      info: (message: string, data: unknown) =>
        lines.push({ level: "info", message, data }),
      warn: (message: string, data: unknown) =>
        lines.push({ level: "warn", message, data }),
      error: (message: string, data: unknown) =>
        lines.push({ level: "error", message, data }),
    },
  });
  return {
    plugin,
    lines,
    root,
    said: (needle: string) =>
      lines.filter((l) => l.message.toLowerCase().includes(needle)),
    notices: () => recordedNotices.map((n) => n.message),
  };
}

// Drive the scheduled reload (§4.4's 500 ms stack-unwind timer).
async function runScheduled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1000);
}

beforeEach(() => {
  clearRecordedNotices();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setMockApiVersion("1.13.4");
  setMockPlatform("desktop");
});

// Write a plugin's manifest where §4.1 looks for it: ON DISK, which is
// where Obsidian will read it from at load time. NOT
// `app.plugins.manifests`, a cache filled at Obsidian's startup.
function writeManifest(
  root: string,
  id: string,
  manifest: Record<string, unknown> | string,
): void {
  const dir = path.join(root, ".obsidian", "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
}

// ── §4.1 the gate BEFORE the reload ─────────────────────────────────
//
// Phase 1's other half, and the one that prevents the damage rather
// than reporting it. The claim under test is always the same and it is
// deliberately not "the plugin still works": `disablePlugin` must NOT
// have been called. Calling it IS the harm — everything after is
// consequence.
describe("§4.1 — the reload is skipped when this Obsidian is too old", () => {
  it("6.2.1 manifest asks 1.13.0, we are 1.12.7 → the plugin is NOT touched", async () => {
    setMockApiVersion("1.12.7");
    const pm = makePM({
      enabledPlugins: ["templater-obsidian"],
      enableResult: { "templater-obsidian": true },
      keepInMap: { "templater-obsidian": true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "templater-obsidian", {
      id: "templater-obsidian",
      version: "2.24.3",
      minAppVersion: "1.13.0",
    });
    f.plugin.handlePluginsAffectedReload(["templater-obsidian"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
    expect(pm.enableCalls).toEqual([]);
    expect(f.said("skipped")).toHaveLength(1);
  });

  it("6.2.2 a manifest we satisfy reloads as usual", async () => {
    setMockApiVersion("1.12.7");
    const pm = makePM({
      enabledPlugins: ["fine"],
      enableResult: { fine: true },
      keepInMap: { fine: true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "fine", { id: "fine", minAppVersion: "1.12.2" });
    f.plugin.handlePluginsAffectedReload(["fine"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual(["fine"]);
    expect(f.said("reload done")).toHaveLength(1);
  });

  it("6.2.3 🔑 the DISK is read, not app.plugins.manifests", async () => {
    // The cache is filled at Obsidian's startup and says whatever was
    // true then; the file on disk is what `enablePlugin` will actually
    // read. A gate consulting the cache would wave through exactly the
    // update that just landed.
    setMockApiVersion("1.12.7");
    const pm = makePM({
      enabledPlugins: ["stale-cache"],
      enableResult: { "stale-cache": true },
      keepInMap: { "stale-cache": true },
    });
    const f = fixture(pm);
    (pm as unknown as { manifests: Record<string, unknown> }).manifests = {
      "stale-cache": { id: "stale-cache", minAppVersion: "1.7.7" },
    };
    writeManifest(f.root, "stale-cache", {
      id: "stale-cache",
      minAppVersion: "1.13.0",
    });
    f.plugin.handlePluginsAffectedReload(["stale-cache"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
  });

  it("6.2.4 🔑 1.13.4 required against 1.13.0 → skipped (no major.minor folding)", async () => {
    setMockApiVersion("1.13.0");
    const pm = makePM({
      enabledPlugins: ["picky"],
      enableResult: { picky: true },
      keepInMap: { picky: true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "picky", { id: "picky", minAppVersion: "1.13.4" });
    f.plugin.handlePluginsAffectedReload(["picky"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
  });

  it("6.2.5 a corrupt manifest → skip, and say so", async () => {
    // Fail-safe direction: the cost of a wrong SKIP is one restart; the
    // cost of a wrong reload is the incident this phase exists for.
    // (A MISSING manifest is no longer a skip: since 2026-10-05 it means
    // the plugin was removed — see "removed plugins" below.)
    setMockApiVersion("1.13.4");
    const pm = makePM({
      enabledPlugins: ["broken-json"],
      enableResult: { "broken-json": true },
      keepInMap: { "broken-json": true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "broken-json", "{ not json");
    f.plugin.handlePluginsAffectedReload(["broken-json"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
    expect(pm.disableAndSaveCalls).toEqual([]);
    expect(f.said("skipped")).toHaveLength(1);
  });

  it("6.2.6 a manifest with no minAppVersion reloads — the field is optional de facto", async () => {
    setMockApiVersion("1.13.4");
    const pm = makePM({
      enabledPlugins: ["oldschool"],
      enableResult: { oldschool: true },
      keepInMap: { oldschool: true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "oldschool", { id: "oldschool", version: "1.0.0" });
    f.plugin.handlePluginsAffectedReload(["oldschool"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual(["oldschool"]);
  });

  it("6.2.7 🔑 isDesktopOnly ADDED by the new version, on mobile → skipped", async () => {
    // The case the filter above cannot catch: the plugin IS enabled and
    // running, so "skip disabled plugins" does not fire — but
    // `enablePlugin` would refuse it (`!isDesktopApp && isDesktopOnly`,
    // Obsidian's own rule, §2.1), and a working plugin dies mid-session.
    setMockPlatform("mobile");
    const pm = makePM({
      enabledPlugins: ["went-desktop-only"],
      enableResult: { "went-desktop-only": false },
      keepInMap: { "went-desktop-only": false },
    });
    const f = fixture(pm);
    writeManifest(f.root, "went-desktop-only", {
      id: "went-desktop-only",
      isDesktopOnly: true,
    });
    f.plugin.handlePluginsAffectedReload(["went-desktop-only"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
  });

  it("6.2.8 the same plugin on DESKTOP reloads normally", async () => {
    setMockPlatform("desktop");
    const pm = makePM({
      enabledPlugins: ["desktop-only"],
      enableResult: { "desktop-only": true },
      keepInMap: { "desktop-only": true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "desktop-only", {
      id: "desktop-only",
      isDesktopOnly: true,
    });
    f.plugin.handlePluginsAffectedReload(["desktop-only"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual(["desktop-only"]);
  });
});

describe("§4.2 — the reload's postcondition is checked, both halves", () => {
  it("6.1.1 enable true + instance in the map → success, and it says so", async () => {
    const pm = makePM({
      enabledPlugins: ["templater-obsidian"],
      enableResult: { "templater-obsidian": true },
      keepInMap: { "templater-obsidian": true },
    });
    const f = fixture(pm, ["templater-obsidian"]);
    f.plugin.handlePluginsAffectedReload(["templater-obsidian"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual(["templater-obsidian"]);
    expect(f.lines.some((l) => l.level === "error")).toBe(false);
    expect(f.said("reload done")).toHaveLength(1);
  });

  it("6.1.2 enable FALSE while the instance is still in the map → failure", async () => {
    // `loadPlugin` writes plugins[id] BEFORE awaiting onload(), so a
    // plugin that throws in onload leaves the map populated. The map
    // alone would call this a success.
    const pm = makePM({
      enabledPlugins: ["broken"],
      enableResult: { broken: false },
      keepInMap: { broken: true },
    });
    const f = fixture(pm, ["broken"]);
    f.plugin.handlePluginsAffectedReload(["broken"]);
    await runScheduled();

    expect(f.said("reload done")).toHaveLength(0);
    expect(f.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("6.1.3 enable FALSE and no instance → failure (the Templater case)", async () => {
    const pm = makePM({
      enabledPlugins: ["templater-obsidian"],
      enableResult: { "templater-obsidian": false },
      keepInMap: { "templater-obsidian": false },
    });
    const f = fixture(pm, ["templater-obsidian"]);
    f.plugin.handlePluginsAffectedReload(["templater-obsidian"]);
    await runScheduled();

    expect(f.said("reload done")).toHaveLength(0);
    expect(f.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("6.1.4 🔑 enable returns UNDEFINED and no instance → still a failure", async () => {
    // This is the whole reason failure is a disjunction rather than one
    // boolean: a future Obsidian that returns void must not read as
    // success. It is also the anti-regression against
    // `enabledPlugins.has(id)` — that set says `true` here, because
    // bare disable/enable never touch it (§2.5).
    const pm = makePM({
      enabledPlugins: ["futureproof"],
      enableResult: { futureproof: undefined },
      keepInMap: { futureproof: false },
    });
    const f = fixture(pm, ["futureproof"]);
    f.plugin.handlePluginsAffectedReload(["futureproof"]);
    await runScheduled();

    expect(pm.enabledPlugins.has("futureproof")).toBe(true); // the trap
    expect(f.said("reload done")).toHaveLength(0);
    expect(f.lines.some((l) => l.level === "error")).toBe(true);
  });
});

describe("§4.3 — what the user is told", () => {
  it("6.1.5 a failure says what to DO, and never claims the update landed", async () => {
    const pm = makePM({
      enabledPlugins: ["templater-obsidian"],
      enableResult: { "templater-obsidian": false },
      keepInMap: { "templater-obsidian": false },
    });
    const f = fixture(pm, ["templater-obsidian"]);
    f.plugin.handlePluginsAffectedReload(["templater-obsidian"]);
    await runScheduled();

    const notices = f.notices();
    expect(notices.some((n) => /restart/i.test(n))).toBe(true);
    expect(notices.some((n) => /templater-obsidian/.test(n))).toBe(true);
    // The old copy — shown BEFORE the result was known — must be gone.
    expect(notices.some((n) => /updated/i.test(n))).toBe(false);
  });

  it("6.1.6 one failure among several does not hide the successes", async () => {
    const pm = makePM({
      enabledPlugins: ["good-a", "bad", "good-b"],
      enableResult: { "good-a": true, bad: false, "good-b": true },
      keepInMap: { "good-a": true, bad: false, "good-b": true },
    });
    const f = fixture(pm, ["good-a", "bad", "good-b"]);
    f.plugin.handlePluginsAffectedReload(["good-a", "bad", "good-b"]);
    await runScheduled();

    // Every plugin was actually attempted — a failure must not abort the
    // rest of the list.
    expect(pm.enableCalls.sort()).toEqual(["bad", "good-a", "good-b"]);
    expect(f.said("reload done")).toHaveLength(2);
    expect(f.lines.filter((l) => l.level === "error")).toHaveLength(1);

    const notices = f.notices();
    expect(notices.some((n) => /bad/.test(n) && /restart/i.test(n))).toBe(true);
    // ...and the count that IS reported counts only what worked.
    expect(notices.some((n) => /3 plugins/.test(n))).toBe(false);
  });

  it("a disabled plugin is skipped — reloading it would silently enable it", async () => {
    const pm = makePM({
      enabledPlugins: [],
      enableResult: { dormant: true },
      keepInMap: { dormant: true },
    });
    const f = fixture(pm, ["dormant"]);
    f.plugin.handlePluginsAffectedReload(["dormant"]);
    await runScheduled();

    expect(pm.disableCalls).toEqual([]);
    expect(f.notices()).toEqual([]);
  });
});

// ── Owner, 2026-10-05: one toast per plugin, with its version; a removed
//    plugin is unloaded at once; our own reload waits for the summary ──
describe("per-plugin toasts, removals, and our own reload delay", () => {
  const instance = (version: string) => ({ manifest: { version } });

  it("🔑 one toast PER plugin, naming the new version — no aggregated \"N plugins updated\"", async () => {
    const pm = makePM({
      enabledPlugins: ["cmdr", "linter"],
      plugins: { cmdr: instance("0.5.4"), linter: instance("1.31.0") },
      enableResult: { cmdr: true, linter: true },
      keepInMap: { cmdr: true, linter: true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "cmdr", { id: "cmdr", version: "0.5.5", minAppVersion: "0.0.1" });
    writeManifest(f.root, "linter", { id: "linter", version: "1.32.0", minAppVersion: "0.0.1" });
    f.plugin.handlePluginsAffectedReload(["cmdr", "linter"]);
    await runScheduled();

    expect(f.notices().sort()).toEqual([
      'Plugin "cmdr" updated to 0.5.5',
      'Plugin "linter" updated to 1.32.0',
    ]);
    expect(recordedNotices.every((n) => n.duration === 3000)).toBe(true);
  });

  it("same version (a rebuild) or an unreadable old version → no \"to …\"", async () => {
    const pm = makePM({
      enabledPlugins: ["same", "noold"],
      plugins: { same: instance("2.0.2-beta"), noold: {} },
      enableResult: { same: true, noold: true },
      keepInMap: { same: true, noold: true },
    });
    const f = fixture(pm);
    writeManifest(f.root, "same", { id: "same", version: "2.0.2-beta", minAppVersion: "0.0.1" });
    writeManifest(f.root, "noold", { id: "noold", version: "1.0.0", minAppVersion: "0.0.1" });
    f.plugin.handlePluginsAffectedReload(["same", "noold"]);
    await runScheduled();

    expect(f.notices().sort()).toEqual(['Plugin "noold" updated', 'Plugin "same" updated']);
  });

  it("🔑 an enabled plugin whose manifest.json is GONE was removed → unloaded with disablePluginAndSave, never re-enabled", async () => {
    // Owner: "if the user removed a plugin, they knew something" — it
    // leaves the enabled list too; re-enabling is a deliberate act.
    const pm = makePM({
      enabledPlugins: ["gone"],
      plugins: { gone: instance("1.0.0") },
      enableResult: { gone: true },
      keepInMap: { gone: true },
    });
    const f = fixture(pm); // no manifest written for "gone"
    f.plugin.handlePluginsAffectedReload(["gone"]);
    await runScheduled();

    expect(pm.disableAndSaveCalls).toEqual(["gone"]);
    expect(pm.enableCalls).toEqual([]);
    expect(f.notices()).toEqual(['Plugin "gone" removed']);
  });

  it("🔑 OUR OWN reload waits 2.5 s so the summary can be read; others go at 500 ms", async () => {
    const self = "git-easy-sync";
    const pm = makePM({
      enabledPlugins: ["cmdr", self],
      plugins: { cmdr: instance("0.5.5"), [self]: instance("2.0.2-beta") },
      enableResult: { cmdr: true, [self]: true },
      keepInMap: { cmdr: true, [self]: true },
    });
    const f = fixture(pm, ["cmdr", self]);
    f.plugin.handlePluginsAffectedReload(["cmdr", self]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pm.enableCalls).toEqual(["cmdr"]); // ours not yet
    await vi.advanceTimersByTimeAsync(1300); // 2.3 s
    expect(pm.disableCalls).not.toContain(self);
    await vi.advanceTimersByTimeAsync(500); // 2.8 s
    expect(pm.enableCalls).toEqual(["cmdr", self]);
  });
});
