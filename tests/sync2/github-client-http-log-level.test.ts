// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.

// Owner, 2026-10-08: the "HTTP …" line's LEVEL follows what the status
// means. A status that changes the normal course (not found, conflict,
// stale ref, rate limit) is unexpected INFORMATION → WARN; a token that is
// gone, missing permissions or a server failure → ERROR; no network /
// a timeout → WARN (common on a phone). Before, every line was INFO.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import GithubClient, { httpLogLevel } from "../../src/github/client";
import Logger from "../../src/logger";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import { Vault, installRequestFaultInjector, type FakeResponse } from "../../mock-obsidian";

describe("httpLogLevel", () => {
  it("2xx / 3xx → info", () => {
    expect(httpLogLevel(200)).toBe("info");
    expect(httpLogLevel(204)).toBe("info");
    expect(httpLogLevel(304)).toBe("info");
  });
  it("🔑 not found / conflict / stale / other 4xx → warn", () => {
    for (const s of [400, 404, 409, 410, 422]) expect(httpLogLevel(s)).toBe("warn");
  });
  it("🔑 rate limit → warn (429; 403 with the limit used up or a Retry-After)", () => {
    expect(httpLogLevel(429)).toBe("warn");
    expect(httpLogLevel(403, { "X-RateLimit-Remaining": "0" })).toBe("warn");
    expect(httpLogLevel(403, { "retry-after": "60" })).toBe("warn");
  });
  it("🔑 token gone / no permission / server failure → error", () => {
    expect(httpLogLevel(401)).toBe("error");
    expect(httpLogLevel(403, { "x-ratelimit-remaining": "4999" })).toBe("error");
    expect(httpLogLevel(500)).toBe("error");
    expect(httpLogLevel(502)).toBe("error");
  });
});

function makeClient() {
  const root = path.join(os.tmpdir(), `http-level-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const settings = {
    ...DEFAULT_SETTINGS,
    githubToken: "t",
    githubOwner: "o",
    githubRepo: "r",
    githubBranch: "main",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = new Logger(vault as any, "git-easy-sync", false);
  const calls: { level: string; message: string }[] = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation(async (message: string) => {
      calls.push({ level, message });
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new GithubClient(settings, logger as any);
  return { client, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function reply(r: FakeResponse | Error) {
  installRequestFaultInjector({ intercept: () => r });
}

describe("GithubClient — the HTTP line's level", () => {
  let cleanup = () => {};
  afterEach(() => {
    installRequestFaultInjector(null);
    cleanup();
  });

  it("🔑 404 on a version's contents → the HTTP line is a WARN", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    reply({ status: 404, body: JSON.stringify({ message: "Not Found" }) });
    await f.client.getContentsAtRef({ path: ".gitignore", ref: "ac4d3de0", retry: false }).catch(() => null);
    const line = f.calls.find((c) => c.message.startsWith("HTTP GET"));
    expect(line?.level).toBe("warn");
    expect(line?.message).toContain("status=404");
  });

  it("🔑 401 → the HTTP line is an ERROR", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    reply({ status: 401, body: JSON.stringify({ message: "Bad credentials" }) });
    await f.client.getContentsAtRef({ path: "a.md", ref: "ac4d3de0", retry: false }).catch(() => null);
    expect(f.calls.find((c) => c.message.startsWith("HTTP GET"))?.level).toBe("error");
  });

  it("🔑 no response at all (network down / timeout) → a WARN line that says why", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    reply(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await f.client.getContentsAtRef({ path: "a.md", ref: "ac4d3de0", retry: false }).catch(() => null);
    const line = f.calls.find((c) => c.message.startsWith("HTTP GET"));
    expect(line?.level).toBe("warn");
    expect(line?.message).toContain("failed");
    expect(line?.message).toContain("ERR_INTERNET_DISCONNECTED");
  });

  it("200 stays INFO", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    reply({ status: 200, body: JSON.stringify({ content: "", encoding: "base64", sha: "x", size: 0 }) });
    await f.client.getContentsAtRef({ path: "a.md", ref: "ac4d3de0", retry: false }).catch(() => null);
    expect(f.calls.find((c) => c.message.startsWith("HTTP GET"))?.level).toBe("info");
  });
});

// Owner's field report (2026-10-08): a History tab did not show the commit a
// Sync had just pushed — for up to 60 s. GitHub answers API GETs with
// "Cache-Control: private, max-age=60", and native fetch honoured it (a 17 ms
// "list-commits-for-path"). The commit list of a BRANCH NAME changes with
// every push, so it must never come from the cache; the same list at a fixed
// SHA (the engine's getCommitInfoForPath) and every @sha-addressed read
// never change, so they stay cacheable (owner: only what changes skips it).
describe("listCommitsForPath — the cache-buster only where the answer can change", () => {
  let cleanup = () => {};
  afterEach(() => {
    installRequestFaultInjector(null);
    cleanup();
  });
  const urls: string[] = [];
  const capture = () => {
    urls.length = 0;
    installRequestFaultInjector({
      intercept: (url: string) => {
        urls.push(url);
        return { status: 200, body: "[]" };
      },
    });
  };

  it("🔑 a branch NAME → a unique ?ts= (never a cache hit)", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    capture();
    await f.client.listCommitsForPath({ path: ".gitignore", branch: "main" });
    await f.client.listCommitsForPath({ path: ".gitignore", branch: "main" });
    expect(urls[0]).toMatch(/[?&]ts=\d+/);
    expect(urls[0]).not.toBe(urls[1]); // two reads, two different URLs
  });

  it("a fixed commit SHA → no buster (the answer can never change)", async () => {
    const f = makeClient();
    cleanup = f.cleanup;
    capture();
    await f.client.listCommitsForPath({ path: "a.md", branch: "4220dbf0a1b2c3d4e5f60718293a4b5c6d7e8f90" });
    expect(urls[0]).not.toMatch(/[?&]ts=/);
  });
});
