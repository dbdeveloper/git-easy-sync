// PLUGIN-UPDATE-COMPAT §6.0 — the MOCK's own test.
//
// Written because the thing under test in §6.2 is a gate that asks
// `requireApiVersion`, and a broken mock would turn that whole table
// green while checking nothing. The two rows below are the pair that
// catches the rejected shortcut (truncating to major.minor), so they
// are the two that must never be deleted.

import { describe, it, expect, afterEach } from "vitest";
import {
  apiVersion,
  requireApiVersion,
  setMockApiVersion,
  Platform,
  setMockPlatform,
} from "../mock-obsidian";

afterEach(() => {
  setMockApiVersion("1.13.4");
  setMockPlatform("desktop");
});

describe("mock requireApiVersion", () => {
  it("🔑 does not fold 1.13.4 and 1.13.0 together", () => {
    setMockApiVersion("1.13.0");
    expect(requireApiVersion("1.13.4")).toBe(false);
    setMockApiVersion("1.13.4");
    expect(requireApiVersion("1.13.0")).toBe(true);
  });

  it("🔑 an older minor is not enough", () => {
    setMockApiVersion("1.12.9");
    expect(requireApiVersion("1.13.0")).toBe(false);
  });

  it("equal is enough — the field is a MINIMUM", () => {
    setMockApiVersion("1.13.0");
    expect(requireApiVersion("1.13.0")).toBe(true);
  });

  it("unreadable input is not 'new enough' — fail-safe", () => {
    expect(requireApiVersion("")).toBe(false);
    expect(requireApiVersion("soon")).toBe(false);
  });

  it("the setter moves the exported value too", () => {
    setMockApiVersion("1.9.0");
    // Live binding: production reads `apiVersion` as a value.
    expect(apiVersion).toBe("1.9.0");
  });
});

describe("mock Platform", () => {
  it("follows the SAME switch as the rename semantics — one knob", () => {
    setMockPlatform("mobile");
    expect(Platform.isDesktopApp).toBe(false);
    expect(Platform.isMobile).toBe(true);
    setMockPlatform("desktop");
    expect(Platform.isDesktopApp).toBe(true);
    expect(Platform.isMobile).toBe(false);
  });
});
