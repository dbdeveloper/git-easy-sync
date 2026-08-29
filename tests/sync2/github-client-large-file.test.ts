// Unit tests for GithubClient.getContentsAtRef: the Contents API
// truncates inline content for files >1 MB, returning status 200 with
// `content: ""` and `encoding: "none"`. Before the 2.0.1-beta5 fix,
// sync2 silently decoded the empty content as a 0-byte ArrayBuffer
// and concluded "remote=∅" in 3-way merge, pushing local content over
// the legitimate >1 MB remote file. See client.ts:getContentsAtRef
// docstring + docs/PSEUDO-MERGE-MODE.md §16 Field Postmortems.
//
// Verifies three branches of the fix:
//   1. Inline content present (<1 MB) → use directly, no Blobs fallback.
//   2. Empty content + size 0 → treat as legitimately-empty file, no
//      Blobs fallback.
//   3. Empty content + size > 0 → fall back to Blobs API, return
//      content from blob response.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import GithubClient from "../../src/github/client";
import Logger from "../../src/logger";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import {
  Vault,
  installRequestFaultInjector,
  type FakeResponse,
} from "../../mock-obsidian";

// Build a deterministic large base64 string. Real GitHub Contents API
// for a >1 MB file returns `content: ""`, but the BLOB API returns the
// actual base64-encoded bytes. We don't need real megabyte payloads to
// test the dispatch logic — what matters is the size field on the
// metadata response and what the Blobs API returns when called back.
function b64(bytes: Uint8Array): string {
  // Browser-compatible base64; tests run in node, so use Buffer.
  return Buffer.from(bytes).toString("base64");
}

function makeClient(): {
  client: GithubClient;
  vault: Vault;
  cleanup: () => void;
} {
  const root = path.join(
    os.tmpdir(),
    `github-client-test-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  const vault = new Vault(root);
  const settings = {
    ...DEFAULT_SETTINGS,
    githubToken: "test-token",
    githubOwner: "test-owner",
    githubRepo: "test-repo",
    githubBranch: "main",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logger = new Logger(vault as any, "git-easy-sync", false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new GithubClient(settings, logger as any);
  return {
    client,
    vault,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("GithubClient.getContentsAtRef — large-file fallback", () => {
  let cleanup: () => void;

  afterEach(() => {
    installRequestFaultInjector(null);
    if (cleanup) cleanup();
  });

  it("returns inline content directly for small file (<1 MB)", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    const { client } = setup;

    const inlineBytes = new TextEncoder().encode("hello world\n");
    const inlineBase64 = b64(inlineBytes);
    const sha = "abc123def456abc123def456abc123def456abc1";

    let getContentsCalls = 0;
    let getBlobCalls = 0;
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (
          url.includes(
            "/repos/test-owner/test-repo/contents/notes/small.md?ref=main",
          )
        ) {
          getContentsCalls += 1;
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: inlineBytes.byteLength,
              content: inlineBase64,
              encoding: "base64",
            }),
          };
        }
        if (url.includes("/git/blobs/")) {
          getBlobCalls += 1;
          // Should never be hit in the small-file path.
          return { status: 500, body: "should not be called" };
        }
        return null;
      },
    });

    const result = await client.getContentsAtRef({
      path: "notes/small.md",
      ref: "main",
    });

    expect(result).not.toBeNull();
    expect(result?.sha).toBe(sha);
    expect(result?.content).toBe(inlineBase64);
    expect(getContentsCalls).toBe(1);
    expect(getBlobCalls).toBe(0); // no Blobs API roundtrip for small files
  });

  it("returns empty content directly for legitimately-empty file (size=0)", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    const { client } = setup;

    const sha = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"; // git's empty-blob SHA

    let getContentsCalls = 0;
    let getBlobCalls = 0;
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (
          url.includes(
            "/repos/test-owner/test-repo/contents/notes/empty.md?ref=main",
          )
        ) {
          getContentsCalls += 1;
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: 0,
              content: "",
              encoding: "base64",
            }),
          };
        }
        if (url.includes("/git/blobs/")) {
          getBlobCalls += 1;
          return { status: 500, body: "should not be called" };
        }
        return null;
      },
    });

    const result = await client.getContentsAtRef({
      path: "notes/empty.md",
      ref: "main",
    });

    expect(result).not.toBeNull();
    expect(result?.sha).toBe(sha);
    expect(result?.content).toBe("");
    expect(getContentsCalls).toBe(1);
    expect(getBlobCalls).toBe(0); // size=0 → no Blobs fallback needed
  });

  it("falls back to Blobs API when Contents API returns empty content for >1 MB file", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    const { client } = setup;

    // Simulate a 1.5 MB file. Real bytes don't matter for the test —
    // only that Contents API reports size > 0 with empty content, and
    // Blobs API responds with the actual base64 content.
    const largeSize = 1_500_000;
    const blobBytes = new TextEncoder().encode(
      "# Big File\n\n" + "x".repeat(1000),
    );
    const blobBase64 = b64(blobBytes);
    const sha = "1234567890abcdef1234567890abcdef12345678";

    let getContentsCalls = 0;
    let getBlobCalls = 0;
    let observedBlobSha = "";
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (
          url.includes(
            "/repos/test-owner/test-repo/contents/notes/big.md?ref=main",
          )
        ) {
          getContentsCalls += 1;
          // GitHub's documented behavior for files >1 MB:
          // 200 status, `content: ""`, `encoding: "none"`.
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: largeSize,
              content: "",
              encoding: "none",
            }),
          };
        }
        const blobMatch = url.match(/\/git\/blobs\/([a-f0-9]+)$/);
        if (blobMatch) {
          observedBlobSha = blobMatch[1];
          getBlobCalls += 1;
          // Blobs API returns base64-encoded content for any size up
          // to ~100 MB. We hand back the real payload here.
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: largeSize,
              content: blobBase64,
              encoding: "base64",
              node_id: "nid",
              url: `https://api.github.com/repos/test-owner/test-repo/git/blobs/${sha}`,
            }),
          };
        }
        return null;
      },
    });

    const result = await client.getContentsAtRef({
      path: "notes/big.md",
      ref: "main",
    });

    expect(result).not.toBeNull();
    expect(result?.sha).toBe(sha);
    // The crux: we got back the BLOB's content, not the empty Contents
    // API content. Without the fix this would be "" (causing the data-
    // loss incident).
    expect(result?.content).toBe(blobBase64);
    expect(getContentsCalls).toBe(1);
    expect(getBlobCalls).toBe(1); // fallback fired exactly once
    expect(observedBlobSha).toBe(sha); // Blobs API called with the SHA from Contents response
  });

  it("returns null on 404 without invoking Blobs API", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    const { client } = setup;

    let getBlobCalls = 0;
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (url.includes("/contents/")) {
          return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
        }
        if (url.includes("/git/blobs/")) {
          getBlobCalls += 1;
          return { status: 500, body: "should not be called" };
        }
        return null;
      },
    });

    const result = await client.getContentsAtRef({
      path: "notes/missing.md",
      ref: "main",
    });

    expect(result).toBeNull();
    expect(getBlobCalls).toBe(0);
  });

  it("falls back to Blobs API even when content field is null (defensive)", async () => {
    // Defensive coverage for any future API change where GitHub
    // returns `content: null` instead of `content: ""`. Our coercion
    // (?? "") + size>0 check still triggers the fallback correctly.
    const setup = makeClient();
    cleanup = setup.cleanup;
    const { client } = setup;

    const blobBase64 = b64(new TextEncoder().encode("recovered\n"));
    const sha = "deadbeef" + "0".repeat(32);

    let getBlobCalls = 0;
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (url.includes("/contents/")) {
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: 2_000_000,
              content: null,
              encoding: "none",
            }),
          };
        }
        if (url.includes("/git/blobs/")) {
          getBlobCalls += 1;
          return {
            status: 200,
            body: JSON.stringify({
              sha,
              size: 2_000_000,
              content: blobBase64,
              encoding: "base64",
              node_id: "nid",
              url: `x`,
            }),
          };
        }
        return null;
      },
    });

    const result = await client.getContentsAtRef({
      path: "notes/huge.md",
      ref: "main",
    });

    expect(result?.content).toBe(blobBase64);
    expect(getBlobCalls).toBe(1);
  });
});

describe("GithubClient.getLatestCommitDateForPath — plugin-js mtime source (SYNC2 §7)", () => {
  let cleanup: () => void;
  afterEach(() => {
    installRequestFaultInjector(null);
    if (cleanup) cleanup();
  });

  const mainJs = ".obsidian/plugins/foo/main.js";

  it("returns the committer date (ms) of the FIRST (latest) commit touching the path", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    let url = "";
    installRequestFaultInjector({
      intercept(u): FakeResponse | null {
        if (u.includes("/repos/test-owner/test-repo/commits?")) {
          url = u;
          // GitHub returns matching commits newest-first; per_page=1 → one entry.
          return {
            status: 200,
            body: JSON.stringify([
              { commit: { committer: { date: "2026-06-30T11:00:00Z" } } },
            ]),
          };
        }
        return null;
      },
    });

    const ms = await setup.client.getLatestCommitDateForPath({ path: mainJs, ref: "abc123" });
    expect(ms).toBe(Date.parse("2026-06-30T11:00:00Z"));
    // The query carries the path + ref + per_page=1 (path is URL-encoded).
    expect(url).toContain(`path=${encodeURIComponent(mainJs)}`);
    expect(url).toContain("sha=abc123");
    expect(url).toContain("per_page=1");
  });

  it("falls back to the author date when committer date is absent", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    installRequestFaultInjector({
      intercept(u): FakeResponse | null {
        if (u.includes("/commits?")) {
          return {
            status: 200,
            body: JSON.stringify([{ commit: { author: { date: "2026-01-02T03:04:05Z" } } }]),
          };
        }
        return null;
      },
    });
    expect(await setup.client.getLatestCommitDateForPath({ path: mainJs, ref: "r" })).toBe(
      Date.parse("2026-01-02T03:04:05Z"),
    );
  });

  it("returns null on an empty array (path never committed) → caller falls back to epoch (ours wins)", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    installRequestFaultInjector({
      intercept(u): FakeResponse | null {
        if (u.includes("/commits?")) return { status: 200, body: "[]" };
        return null;
      },
    });
    expect(await setup.client.getLatestCommitDateForPath({ path: mainJs, ref: "r" })).toBeNull();
  });

  it("returns null on a non-2xx response (best-effort, never throws)", async () => {
    const setup = makeClient();
    cleanup = setup.cleanup;
    installRequestFaultInjector({
      intercept(u): FakeResponse | null {
        if (u.includes("/commits?")) return { status: 404, body: "Not Found" };
        return null;
      },
    });
    await expect(
      setup.client.getLatestCommitDateForPath({ path: mainJs, ref: "r" }),
    ).resolves.toBeNull();
  });
});
