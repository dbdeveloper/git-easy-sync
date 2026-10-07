// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// The "Clean logs" row shows the LIVE size of the log file (TODO.md п.36,
// owner 2026-10-07): after [Clean] the user SEES 0 instead of trusting a
// promise. Format (в): human units, plus the exact byte count so a
// growing log visibly ticks.

const UNITS = ["KB", "MB", "GB", "TB"];

// "1 234 567" — grouped by thousands with a plain space, the same in
// every locale (toLocaleString would differ between devices).
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

export function formatLogSize(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const exact = `${groupThousands(n)} ${n === 1 ? "byte" : "bytes"}`;
  if (n < 1024) return exact;
  let value = n / 1024;
  let unit = 0;
  // Promote while the ROUNDED value would read 1024.0 or more, so a size
  // just under a boundary says "1.0 MB", never "1024.0 KB".
  while (Math.round(value * 10) / 10 >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]} (${exact})`;
}

export function cleanLogsDescription(bytes: number): string {
  return `Truncate the log. Current log size is ${formatLogSize(bytes)}.`;
}
