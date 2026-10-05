// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Commit-pass statistics — what step 3 of COMMIT-PASS-PERF forecasts
// from (spec §3.2). Per device, in `.runtime/commit-stats.json`; RESET
// wipes `.runtime/` and with it this file, which is exactly what makes
// the first commit after a RESET say "Checking all files…".
//
// For each timed action — READ a candidate, its SHA-1 (HASH), WRITE a
// blob into sync_store — TWO records: the largest file it ever handled
// ({bytes, ms}) and the smallest. A line through the two points gives
// both the per-byte cost and the per-call overhead:
//
//     time ≈ overhead + bytes × perByte
//
// The overhead matters: on mobile every file is a bridge round trip, and
// a per-byte rate alone would forecast twenty thousand tiny files as
// instant. A record is only replaced by a larger (resp. smaller) file,
// so there is no averaging and no history — owner's design.
//
// The dot-space enumeration has no bytes: the last scan's entry count
// and time.
//
// ⚠️ WHY A CACHE OF MEASUREMENTS IS ACCEPTABLE HERE. This project once
// deleted one — invariant-state.ts — because a stale entry LIED about
// correctness. This one cannot: a stale or outlying record makes a
// progress line show when it need not, or stay away when it might have
// shown. It can neither lose a file nor corrupt any state. The failure
// mode is COSMETIC — do not "fix" this by analogy. Same reason the file
// is written with a plain write, not atomicWriteFile: a torn file is
// read as "no statistics yet".

import { normalizePath, type Vault } from "obsidian";

export type TimedAction = "read" | "hash" | "write";

export interface SizeTime {
  bytes: number;
  ms: number;
}

export interface ActionRecords {
  largest: SizeTime | null;
  smallest: SizeTime | null;
}

export interface CommitStatsData {
  v: 1;
  read: ActionRecords;
  hash: ActionRecords;
  write: ActionRecords;
  dot: { entries: number; ms: number } | null;
}

export interface CostLine {
  overheadMs: number;
  msPerByte: number;
}

const FILE = "commit-stats.json";
// The dot-space record is rewritten only when it drifts this far.
const DOT_DRIFT = 0.2;

const emptyData = (): CommitStatsData => ({
  v: 1,
  read: { largest: null, smallest: null },
  hash: { largest: null, smallest: null },
  write: { largest: null, smallest: null },
  dot: null,
});

// The line through the two records. One record (or two of the same
// size) gives no overhead — all of the time is charged per byte, which
// over- rather than under-forecasts large files. A noisy pair whose
// larger file was the FASTER one gives no per-byte cost — all of it is
// overhead. Neither case can go negative.
export function costLine(r: ActionRecords): CostLine | null {
  const L = r.largest;
  const S = r.smallest;
  if (L === null) return null;
  if (S === null || L.bytes <= S.bytes) {
    return { overheadMs: 0, msPerByte: L.bytes > 0 ? L.ms / L.bytes : 0 };
  }
  const msPerByte = Math.max(0, (L.ms - S.ms) / (L.bytes - S.bytes));
  const overheadMs = Math.max(0, S.ms - S.bytes * msPerByte);
  return { overheadMs, msPerByte };
}

// Stages 2 + 3 of a commit (§3.1): every planned file is read, hashed
// and — as an upper bound — written. null when any of the three has no
// measurement yet: the caller then shows the counter anyway, because
// "unknown" is not "fast".
export function forecastCheckMs(
  lines: { read: CostLine | null; hash: CostLine | null; write: CostLine | null },
  files: number,
  bytes: number,
): number | null {
  if (lines.read === null || lines.hash === null || lines.write === null) {
    return null;
  }
  return (
    forecastMs(lines.read, files, bytes) +
    forecastMs(lines.hash, files, bytes) +
    forecastMs(lines.write, files, bytes)
  );
}

export function forecastMs(
  line: CostLine,
  files: number,
  bytes: number,
): number {
  return files * line.overheadMs + bytes * line.msPerByte;
}

function isSizeTime(x: unknown): x is SizeTime {
  const o = x as SizeTime;
  return (
    typeof o === "object" &&
    o !== null &&
    Number.isFinite(o.bytes) &&
    Number.isFinite(o.ms) &&
    o.bytes >= 0 &&
    o.ms >= 0
  );
}

function parseRecords(x: unknown): ActionRecords {
  const o = (x ?? {}) as Partial<ActionRecords>;
  return {
    largest: isSizeTime(o.largest) ? o.largest : null,
    smallest: isSizeTime(o.smallest) ? o.smallest : null,
  };
}

// Anything unreadable is "no statistics yet" — never an error.
export function parseCommitStats(raw: string): CommitStatsData {
  try {
    const o = JSON.parse(raw) as Partial<CommitStatsData>;
    if (o?.v !== 1) return emptyData();
    const dot =
      o.dot &&
      Number.isFinite(o.dot.entries) &&
      Number.isFinite(o.dot.ms) &&
      o.dot.entries >= 0 &&
      o.dot.ms >= 0
        ? { entries: o.dot.entries, ms: o.dot.ms }
        : null;
    return {
      v: 1,
      read: parseRecords(o.read),
      hash: parseRecords(o.hash),
      write: parseRecords(o.write),
      dot,
    };
  } catch {
    return emptyData();
  }
}

export default class CommitStats {
  private readonly vault: Vault;
  private readonly selfPluginId: string;
  private data: CommitStatsData = emptyData();
  private dirty = false;

  constructor(deps: { vault: Vault; selfPluginId: string }) {
    this.vault = deps.vault;
    this.selfPluginId = deps.selfPluginId;
  }

  private path(): string {
    return normalizePath(
      `${this.vault.configDir}/plugins/${this.selfPluginId}/.runtime/${FILE}`,
    );
  }

  async load(): Promise<void> {
    this.dirty = false;
    try {
      const p = this.path();
      this.data = (await this.vault.adapter.exists(p))
        ? parseCommitStats(await this.vault.adapter.read(p))
        : emptyData();
    } catch {
      this.data = emptyData();
    }
  }

  // RESET wiped the file; forget what is in memory too, or the next
  // flush would write the pre-reset numbers back.
  reset(): void {
    this.data = emptyData();
    this.dirty = false;
  }

  // True once anything at all has been measured: before that the
  // honest line is "Checking all files…".
  hasAny(): boolean {
    const d = this.data;
    return (
      d.read.largest !== null ||
      d.hash.largest !== null ||
      d.write.largest !== null ||
      d.dot !== null
    );
  }

  record(action: TimedAction, bytes: number, ms: number): void {
    if (!Number.isFinite(bytes) || !Number.isFinite(ms) || bytes < 0 || ms < 0) {
      return;
    }
    const r = this.data[action];
    if (r.largest === null || bytes > r.largest.bytes) {
      r.largest = { bytes, ms };
      this.dirty = true;
    }
    if (r.smallest === null || bytes < r.smallest.bytes) {
      r.smallest = { bytes, ms };
      this.dirty = true;
    }
  }

  recordDot(entries: number, ms: number): void {
    if (!Number.isFinite(entries) || !Number.isFinite(ms) || entries < 0 || ms < 0) {
      return;
    }
    const prev = this.data.dot;
    const drifted = (a: number, b: number): boolean =>
      b === 0 ? a !== 0 : Math.abs(a - b) / b > DOT_DRIFT;
    if (prev === null || drifted(ms, prev.ms) || drifted(entries, prev.entries)) {
      this.data.dot = { entries, ms };
      this.dirty = true;
    }
  }

  line(action: TimedAction): CostLine | null {
    return costLine(this.data[action]);
  }

  forecast(action: TimedAction, files: number, bytes: number): number | null {
    const l = this.line(action);
    return l === null ? null : forecastMs(l, files, bytes);
  }

  // The forecast for stages 2 + 3 (see forecastCheckMs).
  forecastCheck(files: number, bytes: number): number | null {
    return forecastCheckMs(
      { read: this.line("read"), hash: this.line("hash"), write: this.line("write") },
      files,
      bytes,
    );
  }

  // The last dot-space enumeration time: its own forecast for the next.
  dotMs(): number | null {
    return this.data.dot?.ms ?? null;
  }

  // For the commit-timing log line: what the forecasts would be built
  // from right now.
  summary(): Record<string, unknown> {
    const fmt = (a: TimedAction): unknown => {
      const l = this.line(a);
      return l === null
        ? null
        : {
            overheadMs: Math.round(l.overheadMs * 100) / 100,
            mbPerSec:
              l.msPerByte > 0
                ? Math.round(1000 / (l.msPerByte * 1024 * 1024) * 10) / 10
                : null,
          };
    };
    return {
      read: fmt("read"),
      hash: fmt("hash"),
      write: fmt("write"),
      dot: this.data.dot,
    };
  }

  snapshot(): CommitStatsData {
    return JSON.parse(JSON.stringify(this.data)) as CommitStatsData;
  }

  // Written only when a record changed. Best effort: a failed write
  // keeps the numbers in memory and tries again on the next flush.
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const p = this.path();
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (!(await this.vault.adapter.exists(dir))) {
      await this.vault.adapter.mkdir(dir);
    }
    await this.vault.adapter.write(p, JSON.stringify(this.data));
    this.dirty = false;
  }
}
