// E1 — `.token_expired` marker (TODO §5 / DIFF2 R2.7.3.a).
// Tests the unit-pinnable parts: the pure authErrorKind mapping, the
// tokenExpiredMessage copy, and
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
  authErrorKind,
  tokenExpiredMessage,
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

describe("authErrorKind — 401/403 classification", () => {
  // §35 sticky latch: success returns null (does NOT clear) — only an AuthError
  // latches, and its status picks the class.
  it("null / undefined (success) → null (does NOT clear the latch)", () => {
    expect(authErrorKind(null)).toBeNull();
    expect(authErrorKind(undefined)).toBeNull();
  });
  it("AuthError 401 → invalid (bad credentials / expired / wrong token)", () => {
    expect(authErrorKind(new AuthError("nope", 401))).toBe("invalid");
  });
  it("AuthError 403 → scope (valid token, missing permissions)", () => {
    expect(authErrorKind(new AuthError("nope", 403))).toBe("scope");
  });
  it("non-auth error → null (offline ≠ expired)", () => {
    expect(authErrorKind(new Error("network down"))).toBeNull();
    expect(authErrorKind("plain string")).toBeNull();
  });
});

describe("tokenExpiredMessage — user-facing copy", () => {
  it("invalid mentions setting a new token", () => {
    expect(tokenExpiredMessage("invalid")).toMatch(/invalid or expired/i);
    expect(tokenExpiredMessage("invalid")).toMatch(/new token/i);
  });
  it("scope mentions the required permissions", () => {
    expect(tokenExpiredMessage("scope")).toMatch(/permissions|scope/i);
    expect(tokenExpiredMessage("scope")).toMatch(/Contents/i);
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

  it("note() only latches: AuthError→set, everything else (incl. success)→leave", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();

    f.note(new AuthError("expired", 401));
    expect(f.isExpiredCached()).toBe(true);
    expect(f.getKind()).toBe("invalid"); // 401 → invalid

    f.note(new Error("offline")); // non-auth → leave (stays set)
    expect(f.isExpiredCached()).toBe(true);

    // A 403 while already latched re-classifies to "scope".
    f.note(new AuthError("forbidden", 403));
    expect(f.isExpiredCached()).toBe(true);
    expect(f.getKind()).toBe("scope");

    // §35: a SUCCESS must NOT clear the sticky latch — that regression is the
    // whole point of §35. Only a Remote-Repository settings edit (→ clear())
    // unlatches it.
    f.note(null);
    expect(f.isExpiredCached()).toBe(true);
    f.note(undefined);
    expect(f.isExpiredCached()).toBe(true);

    // The explicit clear() (the settings-edit path) still unlatches.
    f.clear();
    expect(f.isExpiredCached()).toBe(false);

    f.note(null); // a later success on a clear latch is still a no-op
    expect(f.isExpiredCached()).toBe(false);
    await settle();
  });

  it("persists the kind tag to the file and restores it on init (§35)", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    f.set("scope");
    expect(f.getKind()).toBe("scope");
    await waitUntil(async () =>
      (await vault.adapter.exists(MARKER)) &&
      (await vault.adapter.read(MARKER)).trim() === "scope",
    );
    // A fresh flag over the same vault restores the class from the file.
    const f2 = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f2.init();
    expect(f2.isExpiredCached()).toBe(true);
    expect(f2.getKind()).toBe("scope");
  });

  it("a legacy marker (ISO-timestamp content) restores as 'invalid'", async () => {
    const vault = fixture();
    await vault.adapter.write(MARKER, "2026-01-01T00:00:00.000Z");
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    expect(f.isExpiredCached()).toBe(true);
    expect(f.getKind()).toBe("invalid"); // unknown content → common case
  });

  it("set() re-writes when the class changes, even while already latched", async () => {
    const vault = fixture();
    const f = new TokenExpiredFlag(vault, PLUGIN_DIR);
    await f.init();
    f.set("invalid");
    await waitUntil(async () =>
      (await vault.adapter.exists(MARKER)) &&
      (await vault.adapter.read(MARKER)).trim() === "invalid",
    );
    f.set("scope"); // class change → re-write
    await waitUntil(async () =>
      (await vault.adapter.read(MARKER)).trim() === "scope",
    );
    expect(f.getKind()).toBe("scope");
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
