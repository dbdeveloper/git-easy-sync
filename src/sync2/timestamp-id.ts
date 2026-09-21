// 17-digit timestamp IDs used as directory names by .push-queue/,
// .conflicts/, and .trash/. Format: YYYYMMDDhhmmssfff in UTC.
// Lexicographic order equals chronological order, so list-style scans
// can sort cheaply by name (used by push-queue's list() and trash's
// the old bin's layer-2 sweep, removed 2026-09-21).

// Extracted from push-queue.ts so the helpers are reachable from other
// stores (TrashStore in src/diff2/) without crossing module boundaries
// through deep paths. Pure refactor: behavior is identical to the
// previous module-private declarations in push-queue.ts.

export function newBatchId(now: Date = new Date()): string {
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0");
  return (
    `${now.getUTCFullYear()}` +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    pad(now.getUTCMilliseconds(), 3)
  );
}

export function parseTimestampId(id: string): number {
  // "YYYYMMDDhhmmssfff" → ms epoch (UTC).
  const y = parseInt(id.slice(0, 4), 10);
  const mo = parseInt(id.slice(4, 6), 10) - 1;
  const d = parseInt(id.slice(6, 8), 10);
  const h = parseInt(id.slice(8, 10), 10);
  const mi = parseInt(id.slice(10, 12), 10);
  const s = parseInt(id.slice(12, 14), 10);
  const ms = parseInt(id.slice(14, 17), 10);
  return Date.UTC(y, mo, d, h, mi, s, ms);
}
