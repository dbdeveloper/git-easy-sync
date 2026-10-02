import { describe, it, expect } from "vitest";
import {
  formatLocalTimestamp,
  formatSyncMessage,
  formatInitMessage,
  parseDeviceSuffix,
  UNKNOWN_DEVICE_LABEL,
} from "../../src/sync2/commit-message";

describe("commit-message — local timestamp format (2.0.2-beta2)", () => {
  // Local time + offset, so the rendered string depends on the test
  // runner's timezone. Assert on the SHAPE rather than an exact value
  // so the test is timezone-independent.
  const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

  it("formatLocalTimestamp renders YYYY-MM-DD HH:mm:ss.SSS±HH:MM", () => {
    expect(formatLocalTimestamp(0)).toMatch(TS);
    expect(formatLocalTimestamp(1_747_549_144_352)).toMatch(TS);
    expect(formatLocalTimestamp(Date.now())).toMatch(TS);
  });

  it("zero-pads every field", () => {
    // 2026-01-02 03:04:05.006 local — exact digits depend on TZ, but
    // each component must be padded to its width.
    const s = formatLocalTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    // date dd / time fields are 2 digits, millis 3, offset 2:2.
    expect(s).toMatch(TS);
  });
});

describe("commit-message — message formats carry timestamp + label", () => {
  const TS_INNER = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/
    .source;

  it("formatSyncMessage: 'Sync at <ts> (label)'", () => {
    const m = formatSyncMessage("Pixel6Pro", 1_747_549_144_352);
    expect(m).toMatch(new RegExp(`^Sync at ${TS_INNER} \\(Pixel6Pro\\)$`));
  });


  it("formatInitMessage: 'Init at <ts> (label)'", () => {
    const m = formatInitMessage("Laptop", 0);
    expect(m).toMatch(new RegExp(`^Init at ${TS_INNER} \\(Laptop\\)$`));
  });

  // ⚰️ The `commitMessageForBatch` case lived here until 2026-10-02.
  // It pinned the OLD engine's "synthetic batch → Resolve conflict at
  // …" rule; the new engine tells that story with separate conflict
  // and merge commits instead (the open question is recorded at the
  // deletion site in commit-message.ts).

  it("empty device label collapses to the unknown sentinel", () => {
    const m = formatSyncMessage("", 0);
    expect(m).toMatch(new RegExp(`\\(${UNKNOWN_DEVICE_LABEL}\\)$`));
  });

  it("parens in the label are escaped to brackets", () => {
    const m = formatSyncMessage("Phone (work)", 0);
    expect(m).toContain("(Phone [work])");
  });
});

describe("commit-message — parseDeviceSuffix round-trips the dated format", () => {
  it("extracts the label from a full 'Sync at <ts> (label)' message", () => {
    const m = formatSyncMessage("Pixel6Pro", 1_747_549_144_352);
    expect(parseDeviceSuffix(m)).toBe("Pixel6Pro");
  });


  it("falls back to the sentinel for a message with no trailing label", () => {
    expect(parseDeviceSuffix("some hand-edited commit")).toBe(
      UNKNOWN_DEVICE_LABEL,
    );
  });
});
