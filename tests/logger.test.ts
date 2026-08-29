// Logger contract tests — the load-bearing invariants are (1) the
// disabled path is a pure sync no-op, (2) the lazy `data: () => ...`
// thunk is NEVER invoked when disabled, (3) the public API returns
// void (caller never has to await), (4) `isEnabled` reflects the
// runtime gate.
//
// File I/O is tested only sparsely — the rest of the test suite
// exercises that incidentally through the integration suite. These
// tests target the perf-sensitive contract.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../mock-obsidian";
import Logger from "../src/logger";

const PLUGIN_ID = "git-easy-sync";

describe("Logger", () => {
  let tmp: string;
  let vault: Vault;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "logger-"));
    vault = new Vault(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── lazy contract ────────────────────────────────────────────────

  it("when disabled: lambda data is NEVER invoked (load-bearing perf invariant)", () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      false, // disabled
    );
    let lambdaInvoked = false;
    logger.info("msg", () => {
      lambdaInvoked = true;
      return { expensive: "computation" };
    });
    expect(lambdaInvoked).toBe(false);
  });

  it("when enabled: lambda data IS invoked", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    await logger.init();
    let lambdaInvoked = false;
    logger.info("msg", () => {
      lambdaInvoked = true;
      return { x: 1 };
    });
    // The lambda runs inside writeAsync which fires synchronously
    // up to its first await. The flag check below survives that
    // microtask boundary.
    await new Promise((r) => setTimeout(r, 10));
    expect(lambdaInvoked).toBe(true);
  });

  it("each level (info/warn/error) honours the lazy contract independently", () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      false,
    );
    const invocations = { info: false, warn: false, error: false };
    logger.info("i", () => {
      invocations.info = true;
      return {};
    });
    logger.warn("w", () => {
      invocations.warn = true;
      return {};
    });
    logger.error("e", () => {
      invocations.error = true;
      return {};
    });
    expect(invocations).toEqual({
      info: false,
      warn: false,
      error: false,
    });
  });

  it("eager data still works (backwards-compat with existing call sites)", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    await logger.init();
    // No throw — eager object literal passes through.
    expect(() => logger.info("msg", { x: 1, y: 2 })).not.toThrow();
  });

  // ── sync API contract ───────────────────────────────────────────

  it("public methods return void (caller never has to await)", () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    // The return type at compile time is `void`. At runtime,
    // calling the methods returns undefined — verified by checking
    // the value is not a thenable.
    const r1 = logger.info("a");
    const r2 = logger.warn("b");
    const r3 = logger.error("c");
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(r3).toBeUndefined();
  });

  // ── isEnabled getter ────────────────────────────────────────────

  it("isEnabled reflects the runtime gate (false when constructed disabled)", () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      false,
    );
    expect(logger.isEnabled).toBe(false);
  });

  it("isEnabled reflects the runtime gate (true when constructed enabled)", () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    expect(logger.isEnabled).toBe(true);
  });

  it("isEnabled flips when enable()/disable() is called", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      false,
    );
    expect(logger.isEnabled).toBe(false);
    await logger.enable();
    expect(logger.isEnabled).toBe(true);
    await logger.disable();
    expect(logger.isEnabled).toBe(false);
  });

  // ── disk side ─────────────────────────────────────────────────

  it("when disabled: no log file is created on disk", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      false,
    );
    await logger.init();
    logger.info("nope");
    await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(tmp, `${PLUGIN_ID}.log`))).toBe(false);
  });

  it("when enabled: log file is appended (async, but lands eventually)", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    await logger.init();
    logger.info("hello world");
    // writeAsync is fire-and-forget; we have to wait for the
    // microtask + adapter.append to complete.
    await new Promise((r) => setTimeout(r, 50));
    const contents = fs.readFileSync(
      path.join(tmp, `${PLUGIN_ID}.log`),
      "utf8",
    );
    expect(contents).toContain("hello world");
    expect(contents).toContain('"level":"INFO"');
  });

  // ── JSONL faithfulness (safeStringify on the disk write) ──────────

  it("Error in additional_data is written faithfully (not {}) and the line stays valid JSON", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    await logger.init();
    logger.error("boom", { err: new Error("kaboom") });
    await new Promise((r) => setTimeout(r, 50));
    const contents = fs.readFileSync(
      path.join(tmp, `${PLUGIN_ID}.log`),
      "utf8",
    );
    const lines = contents.trim().split("\n").filter(Boolean);
    // Every line must parse — the file is JSONL.
    const entry = JSON.parse(lines[lines.length - 1]);
    // Error is preserved (message/stack), NOT flattened to `{}` — plain
    // JSON.stringify would have written `"err":{}`.
    const dumped = JSON.stringify(entry.additional_data);
    expect(dumped).toContain("kaboom");
    expect(entry.additional_data.err).not.toEqual({});
  });

  it("circular ref in additional_data does NOT drop the line; emits [Circular] as valid JSON", async () => {
    const logger = new Logger(
      vault as unknown as import("obsidian").Vault,
      PLUGIN_ID,
      true,
    );
    await logger.init();
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    logger.info("cycle", cyclic);
    await new Promise((r) => setTimeout(r, 50));
    const contents = fs.readFileSync(
      path.join(tmp, `${PLUGIN_ID}.log`),
      "utf8",
    );
    const lines = contents.trim().split("\n").filter(Boolean);
    // Plain JSON.stringify would THROW on the cycle → fire-and-forget
    // rejection → the whole line silently lost. safeStringify keeps it.
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]); // valid JSON
    expect(JSON.stringify(entry.additional_data)).toContain("[Circular]");
  });
});
