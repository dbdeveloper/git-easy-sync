import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import NetworkRetry, {
  hasNetworkErrorMark,
  networkErrorMarkPath,
} from "../../src/sync2/retry-network";
import { NetworkError, AuthError, ValidationError } from "../../src/errors";

// §VIII category E п.6-8 — retryOnNetworkError (NEW-DRAIN §II.10).
// The five drain call sites arrive with Phase 4; the helper's own
// contract is pinned here.

const PLUGIN_ID = "git-easy-sync";

describe("NetworkRetry (§VIII E.6-E.8)", () => {
  let dir: string;
  let vault: Vault;
  let sleeps: number[];

  const markAbs = (): string =>
    path.join(
      dir,
      ".obsidian",
      "plugins",
      PLUGIN_ID,
      ".runtime",
      "sync_network_error",
    );

  const makeRetry = (): NetworkRetry =>
    new NetworkRetry({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_234_567,
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "retry-network-test-"));
    vault = new Vault(dir);
    sleeps = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("E.6: persistent NetworkError → exactly MAX_ATTEMPTS tries, exponential backoff, mark written, error returned", async () => {
    const retry = makeRetry();
    let calls = 0;
    const { result, error } = await retry.run(async () => {
      calls += 1;
      throw new NetworkError("socket died");
    });
    expect(result).toBeNull();
    expect(error).toBeInstanceOf(NetworkError);
    expect(calls).toBe(5);
    // Backoff between attempts: 1s, 2s, 4s, 8s — none after the last.
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    // The user-facing mark carries the reason.
    const mark = JSON.parse(fs.readFileSync(markAbs(), "utf8"));
    expect(mark.message).toBe("socket died");
    expect(mark.at).toBe(1_234_567);
    expect(await hasNetworkErrorMark(vault as never, PLUGIN_ID)).toBe(true);
  });

  it("E.7: TOKEN_EXPIRED / 422 are NOT retried — immediate return, no sleep, no mark", async () => {
    for (const err of [
      new AuthError("token expired", 401),
      new ValidationError("not a fast forward"),
    ]) {
      const retry = makeRetry();
      let calls = 0;
      const { result, error } = await retry.run(async () => {
        calls += 1;
        throw err;
      });
      expect(result).toBeNull();
      expect(error).toBe(err);
      expect(calls).toBe(1);
    }
    expect(sleeps).toEqual([]);
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("transient NetworkError that recovers within the budget → result returned, fewer attempts", async () => {
    const retry = makeRetry();
    let calls = 0;
    const { result, error } = await retry.run(async () => {
      calls += 1;
      if (calls < 3) throw new NetworkError("blip");
      return "payload";
    });
    expect(error).toBeNull();
    expect(result).toBe("payload");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("E.8: a pre-existing mark is cleared on the FIRST success of the run — once, not on start, not on every success", async () => {
    // Mark left by a previous run.
    fs.mkdirSync(path.dirname(markAbs()), { recursive: true });
    fs.writeFileSync(markAbs(), '{"message":"old outage","at":1}');

    const retry = makeRetry();
    // Construction alone must NOT clear ("network is fine" would be a
    // lie before the first real attempt).
    expect(fs.existsSync(markAbs())).toBe(true);

    await retry.run(async () => "ok");
    expect(fs.existsSync(markAbs())).toBe(false); // cleared on first success

    // Re-seed and succeed again within the SAME run scope: the
    // clear-once latch must not touch it (no redundant FS writes —
    // and a mark written by a later exhaustion in this run survives).
    fs.writeFileSync(markAbs(), '{"message":"newer","at":2}');
    await retry.run(async () => "ok again");
    expect(fs.existsSync(markAbs())).toBe(true);

    // A FRESH run scope clears it again on its first success.
    await makeRetry().run(async () => "ok");
    expect(fs.existsSync(markAbs())).toBe(false);
  });

  it("failure path preserves the mark for the next run; the next run's first success clears it", async () => {
    const run1 = makeRetry();
    await run1.run(async () => {
      throw new NetworkError("down");
    });
    expect(await hasNetworkErrorMark(vault as never, PLUGIN_ID)).toBe(true);

    const run2 = makeRetry();
    await run2.run(async () => "recovered");
    expect(await hasNetworkErrorMark(vault as never, PLUGIN_ID)).toBe(false);
  });

  it("mark path helper points inside .runtime (never a top-level plugin file)", () => {
    expect(networkErrorMarkPath(vault as never, PLUGIN_ID)).toBe(
      `.obsidian/plugins/${PLUGIN_ID}/.runtime/sync_network_error`,
    );
  });
});
