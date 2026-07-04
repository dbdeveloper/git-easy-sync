import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  appendFileSync,
  promises as fs,
} from "fs";
import * as path from "path";

// ── MOCK_PLATFORM mode ───────────────────────────────────────────────────────
// Tests can set the simulated platform to expose Capacitor-vs-POSIX
// divergences that would otherwise be invisible under Node fs.
//
// Real Obsidian on iOS / Android wraps Capacitor's Filesystem plugin,
// whose `rename(from, to)` THROWS `"Destination file already exists!"`
// when `to` already exists. POSIX `fs.rename` (Node, desktop Obsidian)
// silently overwrites.
//
// 2026-05-21 mobile incident: production code that worked on desktop
// crashed on mobile because of this exact assumption. Pairing tests
// under both platforms catches that class of bug at unit-test time.
//
// Usage:
//   setMockPlatform("mobile")   // adapter.rename throws if to exists
//   setMockPlatform("desktop")  // POSIX behavior (default)
//
// Tests should reset to "desktop" in afterEach to avoid cross-test
// leak. A test that exercises both should use describe.each with the
// two values.

export type MockPlatform = "desktop" | "mobile";

let currentPlatform: MockPlatform = "desktop";

export function setMockPlatform(mode: MockPlatform): void {
  currentPlatform = mode;
}

export function getMockPlatform(): MockPlatform {
  return currentPlatform;
}

// Obsidian patches Array.prototype with `.contains()` (an alias for
// `.includes()`). Production source code uses it, so polyfill here so
// the same code runs under Node during unit + integration tests.
// Done idempotently and non-enumerably to avoid surprising for-in
// loops in unrelated test code.
if (!(Array.prototype as unknown as { contains?: unknown }).contains) {
  Object.defineProperty(Array.prototype, "contains", {
    value: function <T>(this: T[], item: T): boolean {
      return this.indexOf(item) !== -1;
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// Mock Obsidian's Vault class.
//
// Backed by the real filesystem so SyncManager / GitignoreCache /
// MetadataStore / Logger can run end-to-end against a temp directory.
// Used by both unit tests (via vitest alias) and integration tests
// (which point it at an isolated tmpdir per test).
export class Vault {
  configDir: string;
  private rootPath: string;
  private listeners: { event: string; cb: (...args: unknown[]) => void }[] = [];

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.configDir = ".obsidian";

    if (!existsSync(this.rootPath)) {
      mkdirSync(this.rootPath, { recursive: true });
    }

    if (!existsSync(path.join(this.rootPath, this.configDir))) {
      mkdirSync(path.join(this.rootPath, this.configDir), { recursive: true });
    }
  }

  getRoot() {
    // Real Obsidian's TFolder for root has path "" — paths returned by
    // adapter.list are vault-root-relative. Returning the absolute
    // tempdir here would corrupt downstream walks (analyzeLocalState,
    // compareForAdoption, helpers.listVaultFiles) because they push
    // this back into adapter.list and end up with absolute paths that
    // isSyncable then rejects.
    return { path: "" };
  }

  // Mirrors Obsidian's vault.getFiles(): a flat list of every file
  // (TFile, never TFolder) under the vault, with `stat` pre-populated
  // from disk so callers can filter by mtime/size without doing their
  // own syscalls. Real Obsidian keeps an in-memory index updated by
  // its FS-watcher; the mock recomputes from disk each call.
  //
  // CRITICAL: production Obsidian does NOT index files under
  // <configDir>/ — getFiles() in a real vault skips the entire
  // .obsidian/ tree. We mirror that here so tests catch any sync2
  // code path that wrongly assumes getFiles() returns configDir
  // content. (Earlier the walk also descended into configDir, which
  // masked a real bug where findChanges silently skipped
  // .obsidian/.gitignore in production. The fix lives in
  // change-detector's walkConfigDir helper.)
  getFiles(): TFile[] {
    const out: TFile[] = [];
    const walk = (relDir: string) => {
      const absDir = relDir === "" ? this.rootPath : path.join(this.rootPath, relDir);
      if (!existsSync(absDir)) return;
      const entries = require("fs").readdirSync(absDir, {
        withFileTypes: true,
      });
      for (const entry of entries as Array<{ isFile: () => boolean; isDirectory: () => boolean; name: string }>) {
        const childRel =
          relDir === "" ? entry.name : `${relDir}/${entry.name}`.replace(/\\/g, "/");
        // Skip configDir to match real Obsidian's index behaviour.
        if (childRel === this.configDir) continue;
        // Skip ROOT-level dotfiles — production Obsidian's file
        // indexer omits anything whose name starts with `.` at the
        // vault root (<vault>/.gitignore, .gitattributes, etc.).
        // change-detector's walkRootDotfiles is the production
        // codepath that picks them up; mirroring the gap here
        // ensures unit tests catch any code path that wrongly
        // assumes getFiles() returns root dotfiles.
        if (relDir === "" && entry.name.startsWith(".")) continue;
        if (entry.isFile()) {
          const fullPath = path.join(this.rootPath, childRel);
          const s = statSync(fullPath);
          const file = new TFile(childRel);
          file.stat = { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
          file.name = entry.name;
          const dot = entry.name.lastIndexOf(".");
          file.basename = dot > 0 ? entry.name.slice(0, dot) : entry.name;
          file.extension = dot > 0 ? entry.name.slice(dot + 1) : "";
          out.push(file);
        } else if (entry.isDirectory()) {
          walk(childRel);
        }
      }
    };
    walk("");
    return out;
  }

  // Subscribe to vault events. ConflictWatcher relies on this for
  // its delete/modify/rename triggers — tests fire events
  // synchronously via the test helper `fireEvent` below.
  on(event: string, cb: (...args: unknown[]) => void): EventRef {
    const ref = { event, cb };
    this.listeners.push(ref);
    return ref;
  }

  off(_event: string, _cb: (...args: unknown[]) => void): void {
    // no-op — kept for legacy callers; offref is the modern API.
  }

  // Remove a previously-registered listener via its EventRef.
  // Mirrors Obsidian's vault.offref(ref). ConflictWatcher.stop()
  // calls this for every listener it registered.
  offref(ref: EventRef): void {
    const i = this.listeners.indexOf(ref as { event: string; cb: (...args: unknown[]) => void });
    if (i !== -1) this.listeners.splice(i, 1);
  }

  // Test-only helper: fire a vault event synchronously to every
  // registered listener for that event. Production Obsidian fires
  // these from native code; in tests we drive them manually.
  // Returns the number of listeners that received the event.
  fireEvent(event: string, ...args: unknown[]): number {
    let n = 0;
    // Snapshot to avoid mutation-during-iteration if a listener
    // unsubscribes itself in response.
    const snapshot = [...this.listeners];
    for (const ref of snapshot) {
      if (ref.event === event) {
        ref.cb(...args);
        n++;
      }
    }
    return n;
  }

  get adapter() {
    return {
      read: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath, "utf8");
      },

      write: async (filePath: string, data: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, data);
      },

      readBinary: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath);
      },

      writeBinary: async (filePath: string, data: ArrayBuffer) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, Buffer.from(data));
      },

      append: async (filePath: string, data: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        appendFileSync(fullPath, data);
      },

      exists: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return existsSync(fullPath);
      },

      mkdir: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      },

      remove: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        if (existsSync(fullPath)) {
          await fs.unlink(fullPath);
        }
      },

      // Mirrors Obsidian's adapter.rename(oldPath, newPath). On
      // POSIX (desktop), fs.rename is atomic when both paths live
      // on the same filesystem — which they do here (both under
      // rootPath) — so the 3-step ConflictStore protocol gets a
      // real OS-level atomic transition between `meta.json.tmp`
      // and `meta.json`.
      //
      // Under MOCK_PLATFORM="mobile" we simulate Capacitor's
      // Filesystem.rename: throws "Destination file already exists!"
      // if `newPath` already exists. Mobile code must explicitly
      // remove(newPath) before rename() when overwriting. Without
      // this divergence, mock tests pass on CI but production breaks
      // on user phones (2026-05-21 incident).
      rename: async (oldPath: string, newPath: string) => {
        const fromAbs = path.join(this.rootPath, oldPath);
        const toAbs = path.join(this.rootPath, newPath);
        if (currentPlatform === "mobile" && existsSync(toAbs)) {
          throw new Error("Destination file already exists!");
        }
        await fs.rename(fromAbs, toAbs);
      },

      // Mirrors Obsidian's adapter.rmdir(path, recursive). Recursive
      // mode (the only mode sync2 uses) removes the directory and
      // everything beneath it.
      rmdir: async (dirPath: string, recursive?: boolean) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) return;
        await fs.rm(fullPath, { recursive: !!recursive, force: true });
      },

      // Returns an object shaped like Obsidian's Stat. We populate the
      // fields GitignoreCache.fileChanged actually reads (mtime); the
      // others are mostly cosmetic.
      stat: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        if (!existsSync(fullPath)) {
          return null;
        }
        const s = statSync(fullPath);
        return {
          type: s.isDirectory() ? "folder" : "file",
          ctime: s.ctimeMs,
          mtime: s.mtimeMs,
          size: s.size,
        };
      },

      list: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          return { files: [], folders: [] };
        }

        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        // Match Obsidian's behaviour: paths returned are relative to
        // vault root, with forward slashes regardless of OS.
        const join = (name: string) =>
          dirPath === "" || dirPath === "/"
            ? name
            : `${dirPath.replace(/\\/g, "/")}/${name}`.replace(/^\/+/, "");
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.name));
        const folders = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(entry.name));
        return { files, folders };
      },
    };
  }
}

// Mock Notice
//
// Tests can inspect `recordedNotices` to verify what messages the
// plugin showed. Useful because SyncManager.sync() catches errors and
// surfaces them only via Notice — without capturing, integration
// tests would silently treat failed syncs as successful.
export const recordedNotices: { message: string; timestamp: number }[] = [];

export function clearRecordedNotices(): void {
  recordedNotices.length = 0;
}

export class Notice {
  constructor(message: string, _timeout?: number) {
    recordedNotices.push({ message, timestamp: Date.now() });
    if (process.env.MOCK_OBSIDIAN_NOTICE_LOG === "1") {
      console.log(`NOTICE: ${message}`);
    }
  }

  setMessage(message: string): void {
    recordedNotices.push({ message, timestamp: Date.now() });
  }

  hide() {
    // no-op
  }
}

// Stub TAbstractFile / TFile / TFolder used by EventsListener's
// instanceof checks. Integration tests don't use real Obsidian events
// so these only need to be constructible classes.
export class TAbstractFile {
  path: string;
  constructor(p: string) {
    this.path = p;
  }
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export class TFile extends TAbstractFile {
  // Real Obsidian populates this from its FS index and keeps it in
  // memory — `stat` reads are O(1) without syscalls. The mock fills
  // these from a one-shot fs.statSync at the time getFiles() is
  // called, which is "close enough" for tests: production code that
  // filters by stat.mtime sees plausible values either way.
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
  name = "";
  basename = "";
  extension = "";
}
export class TFolder extends TAbstractFile {}

// Plugin stub. main.ts extends the real one; integration tests don't
// instantiate it, but the file is imported transitively, so the symbol
// must exist at least as a class.
export class Plugin {
  app: unknown;
  registerEvent(_ref: EventRef): void {
    // no-op
  }
  registerInterval(_id: number): void {
    // no-op
  }
  addStatusBarItem(): HTMLElement {
    // jsdom is not loaded; return a thin stub.
    return { setText: () => {}, remove: () => {} } as unknown as HTMLElement;
  }
  addRibbonIcon(_icon: string, _title: string, _cb: () => void): HTMLElement {
    return { remove: () => {} } as unknown as HTMLElement;
  }
  addCommand(_cfg: unknown): void {
    // no-op
  }
  addSettingTab(_tab: unknown): void {
    // no-op
  }
  registerView(_type: string, _factory: unknown): void {
    // no-op
  }
}

// ItemView stub: the diff2 view classes (DiffPanelView / DiffEditorView /
// DiffHistoryView) extend it. Only needs to be a constructable base so those
// modules load under vitest; tests that actually exercise a view construct it
// explicitly. containerEl is created lazily so this is safe in the node env
// (no document) as well as happy-dom.
export class ItemView {
  app: unknown;
  leaf: unknown;
  containerEl: unknown;
  constructor(leaf?: unknown) {
    this.leaf = leaf;
    this.containerEl =
      typeof document !== "undefined"
        ? document.createElement("div")
        : { empty: () => {} };
  }
  registerEvent(_ref: EventRef): void {}
  registerInterval(_id: number): void {}
  addAction(_icon: string, _title: string, _cb: () => void): HTMLElement {
    return { remove: () => {} } as unknown as HTMLElement;
  }
  addChild<T>(child: T): T {
    return child;
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
}

// PluginSettingTab stub: the settings/tab.ts class extends it.
export class PluginSettingTab {
  app: unknown;
  containerEl: { empty: () => void };
  constructor(app: unknown, _plugin: unknown) {
    this.app = app;
    this.containerEl = { empty: () => {} };
  }
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  setHeading() { return this; }
  setDisabled(_b: boolean) { return this; }
  addText(_cb: (t: unknown) => void) { return this; }
  addToggle(_cb: (t: unknown) => void) { return this; }
  addDropdown(_cb: (t: unknown) => void) { return this; }
  addButton(_cb: (t: unknown) => void) { return this; }
}

export class Modal {
  app: unknown;
  contentEl: { empty: () => void };
  constructor(app: unknown) {
    this.app = app;
    this.contentEl = { empty: () => {} };
  }
  setTitle(_t: string) {}
  setContent(_c: string) {}
  open() {}
  close() {}
}

interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

// Fault injection for integration tests that need to simulate crashes
// or transient failures mid-sync. Tests install an injector that
// inspects every requestUrl call. Three return shapes:
//   - `null` — pass through to the real fetch
//   - an `Error` — throw instead of fetching (network drop, killed
//     mid-flight). C-series resume tests use this.
//   - a `FakeResponse` — short-circuit the request and return the
//     given status/body to the caller as if GitHub had responded.
//     Used by J-series to feed deterministic 429/5xx responses
//     into retryUntil's loop without actually rate-limiting our PAT.
//
// The injector is global because mock-obsidian itself is loaded
// once per vitest worker, but tests must always reset it in
// afterEach (helpers.installFaultInjector(null)) — otherwise a
// stale injector leaks into subsequent tests.
export interface FakeResponse {
  status: number;
  /** Response headers; defaults to empty. */
  headers?: Record<string, string>;
  /** Response body as a UTF-8 string. JSON-shaped bodies should be JSON.stringify'd. */
  body?: string;
}

export interface RequestFaultInjector {
  /**
   * Decide what to do with this request.
   * Return null to pass through, an Error to throw, or a FakeResponse
   * to short-circuit with a synthesized HTTP response. callIndex is
   * monotonically increasing across the lifetime of the injector
   * (1-based).
   */
  intercept(
    url: string,
    method: string,
    callIndex: number,
  ): Error | FakeResponse | null;
}

let activeInjector: RequestFaultInjector | null = null;
let interceptorCallIndex = 0;

export function installRequestFaultInjector(
  injector: RequestFaultInjector | null,
): void {
  activeInjector = injector;
  interceptorCallIndex = 0;
}

export async function requestUrl(options: RequestUrlParam) {
  // Fault injection hook — runs BEFORE the real fetch so tests can
  // simulate "Obsidian killed mid-sync" or transient HTTP failures
  // without burning API quota. Three branches mirror the injector
  // contract: pass-through (null), throw (Error), or short-circuit
  // with a fake HTTP response.
  if (activeInjector) {
    interceptorCallIndex += 1;
    const decision = activeInjector.intercept(
      options.url,
      options.method || "GET",
      interceptorCallIndex,
    );
    if (decision instanceof Error) throw decision;
    if (decision !== null && decision !== undefined) {
      const fake = decision;
      const bodyStr = fake.body ?? "";
      const buffer = new TextEncoder().encode(bodyStr).buffer;
      let json: unknown = undefined;
      try {
        json = bodyStr ? JSON.parse(bodyStr) : undefined;
      } catch {
        // not JSON, leave undefined
      }
      return {
        status: fake.status,
        headers: fake.headers ?? {},
        arrayBuffer: buffer,
        text: bodyStr,
        json,
      };
    }
  }

  // Mirror Obsidian's requestUrl behaviour: when there's a body and
  // the caller didn't set Content-Type, default to application/json.
  // Without this default, GitHub PUT /contents/{path} returns 404 on
  // bare repos because it can't parse the body to find the `branch`
  // parameter that tells it which branch to create.
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (
    options.body !== undefined &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = options.contentType || "application/json";
  }

  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  // Always read body into both buffer + text + json (best-effort) so
  // callers can pick whichever shape they need without re-issuing the
  // request. Mirrors Obsidian's requestUrl behaviour.
  const buffer = await response.arrayBuffer();
  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(buffer);
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON, leave undefined
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    arrayBuffer: buffer,
    text,
    json,
  };
}

// Mock utility functions
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return Buffer.from(base64, "base64");
}

// Event ref shape for vault.on() — kept intentionally loose so we can
// pass it back in unregister calls without type friction.
export type EventRef = { event: string; cb: (...args: unknown[]) => void };

// Workspace / WorkspaceLeaf stubs — main.ts imports them, but they
// aren't used in integration paths.
export class WorkspaceLeaf {
  view: unknown;
}

export class App {
  vault: Vault;
  workspace: unknown;
  constructor(vault: Vault) {
    this.vault = vault;
    this.workspace = {
      getLeavesOfType: () => [],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: () => {},
      onLayoutReady: (_cb: () => void) => {},
      on: () => ({} as EventRef),
    };
  }
}
