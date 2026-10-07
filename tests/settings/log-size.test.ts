// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

import { describe, it, expect } from "vitest";
import { formatLogSize, cleanLogsDescription } from "../../src/settings/log-size";

// TODO.md п.36 (owner, 2026-10-07): "Clean logs" shows the live log size,
// so a click on [Clean] is SEEN to work ("better than 1000 words").
// Format (в): human units plus the exact byte count.
describe("formatLogSize", () => {
  it("bytes below 1 KB are shown as bytes only", () => {
    expect(formatLogSize(0)).toBe("0 bytes");
    expect(formatLogSize(1)).toBe("1 byte");
    expect(formatLogSize(1023)).toBe("1 023 bytes");
  });

  it("KB / MB / GB with one decimal, and the exact count grouped by thousands", () => {
    expect(formatLogSize(1024)).toBe("1.0 KB (1 024 bytes)");
    expect(formatLogSize(1536)).toBe("1.5 KB (1 536 bytes)");
    expect(formatLogSize(1048576)).toBe("1.0 MB (1 048 576 bytes)");
    expect(formatLogSize(1234567)).toBe("1.2 MB (1 234 567 bytes)");
    expect(formatLogSize(5 * 1024 ** 3)).toBe("5.0 GB (5 368 709 120 bytes)");
  });

  it("a unit boundary rounds up into the next unit, never \"1024.0 KB\"", () => {
    expect(formatLogSize(1048575)).toBe("1.0 MB (1 048 575 bytes)");
  });

  it("nonsense input reads as 0 — never NaN on the settings page", () => {
    expect(formatLogSize(-5)).toBe("0 bytes");
    expect(formatLogSize(Number.NaN)).toBe("0 bytes");
  });
});

describe("cleanLogsDescription", () => {
  it("says what the button does and how big the log is now", () => {
    expect(cleanLogsDescription(1234567)).toBe(
      "Truncate the log. Current log size is 1.2 MB (1 234 567 bytes).",
    );
    expect(cleanLogsDescription(0)).toBe("Truncate the log. Current log size is 0 bytes.");
  });
});
