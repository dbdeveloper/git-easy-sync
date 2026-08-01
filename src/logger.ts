// Originally authored by Silvano Cerza (https://silvanocerza.com).
// Modified by Claude Code under the attentive guidance of Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { Vault, normalizePath } from "obsidian";

// Log file lives at the VAULT ROOT, named `<plugin-id>.log` — the
// plugin id from manifest.json is the canonical machine-readable
// name, so the log filename rides with it (rename the plugin →
// rename the log automatically). Locating the file at the vault
// root lets the user see it in Obsidian's file explorer, open it
// directly, and read it without a clipboard round-trip. *.log is
// in the root .gitignore by default so it doesn't accidentally
// sync to GitHub — power users can drop the rule if they want logs
// to travel between devices (with the obvious caveat that multi-
// device writes will collide on the same filename).
export function logFileNameFor(pluginId: string): string {
  return `${pluginId}.log`;
}

// Max serialized size of `data` we'll write per log entry. Anything larger
// is replaced with a small summary (size + preview) so a single chatty
// callsite can't blow the log up to hundreds of MB.
const MAX_DATA_BYTES = 64 * 1024;

// `data` argument shape for log methods. Two forms:
//   - eager: an object/primitive — evaluated by the caller at the call
//     site, passed straight through; cheap when prep is cheap.
//   - lazy: a thunk that returns the data — Logger calls it ONLY when
//     logging is enabled. Use when prep is non-trivial (e.g. memory
//     snapshots, large array maps, describeError walks) so the
//     production "logger disabled" path pays nothing for the prep.
//
// The two forms coexist by design — existing call sites stay readable
// (`logger.info("msg", { x, y })`), new diagnostic-heavy sites opt into
// `logger.info("msg", () => ({ x: walkProto(...), mem: usage() }))`.
type LogData = unknown | (() => unknown);

export default class Logger {
  private logFile: string;

  constructor(
    private vault: Vault,
    pluginId: string,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(logFileNameFor(pluginId));
  }

  // Read-only accessor for code paths that want to GUARD heavy
  // diagnostic prep behind an "is logger on?" check at the call site
  // — e.g. taking a memory-usage snapshot, walking an object graph
  // for a one-off probe. The lazy `data` callback handles the common
  // case; this getter handles the case where the diagnostic logic
  // doesn't fit a single `data` payload (e.g. you want to log TWICE,
  // before + after, with a delta).
  //
  //   if (this.logger.isEnabled) {
  //     const before = process.memoryUsage();
  //     await heavyOp();
  //     const after = process.memoryUsage();
  //     this.logger.info("heavy delta", { before, after });
  //   }
  get isEnabled(): boolean {
    return this.enabled;
  }

  // Sync on-disk presence to the `enabled` flag: when enabled, the
  // log file must exist (touch into existence if it doesn't); when
  // disabled, it must NOT exist (delete if a previous session left
  // one behind). Called once at plugin load before any log writes,
  // and again by enable()/disable() when the user flips the toggle.
  async init(): Promise<void> {
    if (this.enabled) {
      await this.ensureFile();
    } else {
      await this.removeFile();
    }
  }

  // Fire-and-forget asynchronous writer. Only ever invoked from the
  // synchronous `info`/`warn`/`error` entry points AFTER they have
  // confirmed `this.enabled === true`. That gate guarantees:
  //   - The lambda form of `data` (`() => heavyPrep()`) executes
  //     ONLY when logging is on; production "logger disabled" pays
  //     nothing for the prep.
  //   - The caller never awaits log I/O. Disk-append microtasks
  //     happen in the background; nothing on the sync call path
  //     stalls on them.
  private async writeAsync(
    level: string,
    message: string,
    data?: LogData,
  ): Promise<void> {
    let payload =
      typeof data === "function"
        ? (data as () => unknown)()
        : data;
    if (payload !== undefined) {
      // Backstop: if a callsite hands us a giant array/object (e.g. the full
      // sync action list or a remote tree), don't faithfully serialize it.
      // The truncated form keeps just enough to debug without ballooning the
      // log file. Targeted summaries at known-large callsites avoid hitting
      // this in normal operation.
      const json = safeStringify(payload);
      if (json.length > MAX_DATA_BYTES) {
        payload = {
          __truncated: true,
          serializedSize: json.length,
          preview: json.substring(0, 1024),
        };
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      additional_data: payload,
    };

    // Mirror to console with a tag prefix so `adb logcat | grep gh-sync`
    // (Android) and Safari Web Inspector (iOS) give a real-time view of
    // the same lines that land in the log file. The tag lets users
    // filter the noisy logcat stream down to plugin events.
    const mirror = `[gh-sync] [${level}] ${message}${payload !== undefined ? " " + safeStringify(payload) : ""}`;
    if (level === "ERROR") console.error(mirror);
    else if (level === "WARN") console.warn(mirror);
    else console.log(mirror);

    // Use safeStringify (NOT plain JSON.stringify) for the on-disk write:
    // the log file is JSONL, so a torn or lossy line breaks line-by-line
    // parsing. Plain JSON.stringify renders an Error in `additional_data`
    // as `{}` (fields live on the prototype) and THROWS on a circular ref
    // — the throw would silently drop the whole line (fire-and-forget
    // rejection). safeStringify preserves Error fields and emits
    // "[Circular]" instead, matching what the console mirror already shows.
    await this.vault.adapter.append(
      this.logFile,
      safeStringify(logEntry) + "\n",
    );
  }

  async read(): Promise<string> {
    return await this.vault.adapter.read(this.logFile);
  }

  // Truncate the log to 0 bytes. Only meaningful while logging is
  // enabled; the settings tab gates the Clean button behind the
  // toggle so this isn't reachable on a disabled logger.
  async clean(): Promise<void> {
    return await this.vault.adapter.write(this.logFile, "");
  }

  async enable(): Promise<void> {
    this.enabled = true;
    await this.ensureFile();
  }

  async disable(): Promise<void> {
    this.enabled = false;
    await this.removeFile();
  }

  // Touch the log file into existence at 0 bytes if it's not
  // already on disk. No-op when the file exists (preserving any
  // accumulated lines).
  private async ensureFile(): Promise<void> {
    if (await this.vault.adapter.exists(this.logFile)) return;
    await this.vault.adapter.write(this.logFile, "");
  }

  // Remove the log file from disk. No-op when the file is already
  // missing (user deleted it manually, previous disable already ran).
  private async removeFile(): Promise<void> {
    if (!(await this.vault.adapter.exists(this.logFile))) return;
    await this.vault.adapter.remove(this.logFile);
  }

  // PUBLIC SYNC API. Returns void — never blocks the caller. The
  // sync gate `if (!this.enabled) return` is the load-bearing line:
  // when logging is disabled the call is a pure synchronous no-op,
  // and the lambda form of `data` is not invoked. When enabled, the
  // async writer fires in the background; the caller continues
  // without awaiting disk I/O. Log-write failure (full disk, etc.)
  // surfaces as an unhandled rejection in the console — logging is
  // not load-bearing for plugin function, so we don't propagate.
  info(message: string, data?: LogData): void {
    if (!this.enabled) return;
    void this.writeAsync("INFO", message, data);
  }

  warn(message: string, data?: LogData): void {
    if (!this.enabled) return;
    void this.writeAsync("WARN", message, data);
  }

  error(message: string, data?: LogData): void {
    if (!this.enabled) return;
    void this.writeAsync("ERROR", message, data);
  }
}

// JSON.stringify throws on circular refs and silently drops Error fields;
// neither is helpful in a logger. This wraps both cases.
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Error) {
        return errorLikeToPlain(v);
      }
      // Cross-realm Error or Error-like object: doesn't pass
      // `instanceof Error` (different JS context — Capacitor's
      // native-bridge errors on iOS/Android, iframe boundaries) but
      // has Error's shape. Without this branch, JSON.stringify renders
      // such an object as `{}` because `message`/`stack`/`name` live on
      // the prototype, not as own enumerable properties.
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        ("message" in v || "stack" in v || "code" in v) &&
        Object.getOwnPropertyNames(v).every(
          (k) => !["message", "stack", "name"].includes(k),
        )
      ) {
        return errorLikeToPlain(v as Record<string, unknown>);
      }
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

// Pull Error-ish fields out of a value regardless of where they live
// (own enumerable, prototype accessor, non-enumerable own property).
// Used for both real `Error` instances and cross-realm Error-like
// objects (Capacitor `DOMException`/`CapacitorException` instances
// that come back from the native bridge).
function errorLikeToPlain(e: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["name", "message", "stack", "code", "cause"]) {
    if (e[key] !== undefined) out[key] = e[key];
  }
  for (const key of Object.getOwnPropertyNames(e)) {
    if (out[key] === undefined) out[key] = e[key];
  }
  // Final fallback: if we still got nothing extractable, include the
  // default toString so the log carries SOMETHING.
  if (Object.keys(out).length === 0) {
    out.__string = String(e);
  }
  return out;
}
