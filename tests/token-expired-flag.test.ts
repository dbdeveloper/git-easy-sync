// E1 — `.token_expired` marker (TODO §5 / DIFF2 R2.7.3.a).
// Tests the two unit-pinnable parts: the pure classifyAuthOutcome mapping and
// the TokenExpiredFlag (in-memory authoritative + best-effort file mirror).
// The CALL SITES (main.ts drain catches/success, settings probe) are untestable
// view/plugin wiring — covered by the manual checklist.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Vault as MockVault } from "../mock-obsidian";
import type { Vault } from "obsidian";
import { AuthError } from "../src/errors";
import {
  TokenExpiredFlag,
  classifyAuthOutcome,
} from "../src/token-expired-flag";

const PLUGIN_DIR = ".obsidian/plugins/github-easy-sync";
const MARKER = `${PLUGIN_DIR}/.runtime/token_expired`;

const tmpdirs: string[] = [];
function fixture(): Vault {
  const root = path.join(os.tmpdir(), `tef-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, PLUGIN_DIR), { recursive: true });
  tmpdirs.push(root);
  return new MockVault(root) as unknown as Vault;
}
afterEach(() => {
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Let the fire-and-forget file write settle before asserting on disk.
const settle = () => new Promise((r) => setTimeout(r, 10));

// Poll until `pred` holds, instead of a fixed sleep — the fire-and-forget
// adapter.remove/write can take >10ms under parallel load, which made the disk
// asserts flaky (race between the 10ms settle and the async file op). Polls every
// 5ms up to 2s, then throws so a genuine never-true surfaces as a clear failure.
async function waitUntil(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil: condition not met within 2s");
}

describe("classifyAuthOutcome — per-drain mapping", () => {
  it("null / undefined (success) → clear", () => {
    expect(classifyAuthOutcome(null)).toBe("clear");
    expect(classifyAuthOutcome(undefined)).toBe("clear");
  });
  it("AuthError (401/403) → set", () => {
    expect(classifyAuthOutcome(new AuthError("nope", 401))).toBe("set");
    expect(classifyAuthOutcome(new AuthError("nope", 403))).toBe("set");
  });
  it("non-auth error → noop (offline ≠ expired)", () => {
    expect(classifyAuthOutcome(new Error("network down"))).toBe("noop");
    expect(classifyAuthOutcome("plain string")).toBe("noop");
  });
});

describe("TokenExpiredFlag — in-memory authoritative + file mirror", () => {
  it("init seeds expired=false when no marker file", async () => {
    const f = new TokenExpiredFlag(fixture(), PLUGIN_DIR);
    await f.init();
    expect(f.isExpiredCached()).toBe(false);
  });

  it("init seeds expired=true when the marker file is present", async () => {
    const vault = fixture();
    await vault.adapter.write(MARKER, "2026-01-01T00:00:00.000Z");
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    expect(f.isExpiredCached()).toBe(true);
  });

  it("set() flips memory synchronously, then writes the marker", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    f.set();
    expect(f.isExpiredCached()).toBe(true); // synchronous, before any await
    await waitUntil(() => vault.adapter.exists(MARKER));
    expect(await vault.adapter.exists(MARKER)).toBe(true);
    expect(await f.isExpired()).toBe(true); // fresh on-disk read agrees
  });

  it("clear() flips memory synchronously, then removes the marker", async () => {
    const vault = fixture();
    await vault.adapter.write(MARKER, "x");
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    expect(f.isExpiredCached()).toBe(true);
    f.clear();
    expect(f.isExpiredCached()).toBe(false); // synchronous
    await waitUntil(async () => !(await vault.adapter.exists(MARKER)));
    expect(await vault.adapter.exists(MARKER)).toBe(false);
  });

  it("set()/clear() are idempotent — no throw when already in state", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    f.clear(); // already clear
    expect(f.isExpiredCached()).toBe(false);
    f.set();
    f.set(); // double-set
    expect(f.isExpiredCached()).toBe(true);
    await waitUntil(() => vault.adapter.exists(MARKER));
    expect(await vault.adapter.exists(MARKER)).toBe(true);
  });

  it("note() applies the outcome: null→clear, AuthError→set, other→leave", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();

    f.note(new AuthError("expired", 401));
    expect(f.isExpiredCached()).toBe(true);

    f.note(new Error("offline")); // non-auth → leave (stays set)
    expect(f.isExpiredCached()).toBe(true);

    f.note(null); // success → clear
    expect(f.isExpiredCached()).toBe(false);

    f.note(new Error("offline")); // non-auth → leave (stays clear)
    expect(f.isExpiredCached()).toBe(false);
    await settle();
  });

  it("in-memory state is authoritative — survives an out-of-band file delete", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    f.set();
    await waitUntil(() => vault.adapter.exists(MARKER));
    await vault.adapter.remove(MARKER); // something deletes the file behind us
    expect(f.isExpiredCached()).toBe(true); // memory wins
  });
});
