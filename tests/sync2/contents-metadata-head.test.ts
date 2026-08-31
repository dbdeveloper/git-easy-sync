import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Vault } from "../../mock-obsidian";
import GithubClient from "../../src/github/client";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import SyncStore from "../../src/sync2/sync-store";
import { calculateGitBlobSHA } from "../../src/utils";

// §VIII P.14-18 — the Layer-2 HEAD transport
// (GithubClient.getContentsMetadataAtRef, NEW-DRAIN §II.13). Unit,
// fake network worker; P.19 (the ETag==sha EQUALITY canary) is the
// integration half in tests/integration/discovery-layer1.test.ts.

const PLUGIN_ID = "git-easy-sync";

type FakeResponse = {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
};
type SeenRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
};

// json access on a HEAD response must never happen — P.14's "the fake
// client fails if the code reads the body".
const explodingJson = new Proxy(
  {},
  {
    get() {
      throw new Error("P.14 violation: code read the HEAD response body");
    },
  },
);

describe("getContentsMetadataAtRef (§VIII P.14-18)", () => {
  let dir: string;
  let vault: Vault;
  let seen: SeenRequest[];
  let queue: FakeResponse[];
  let warnings: string[];

  const makeClient = (): GithubClient =>
    new GithubClient(
      {
        ...DEFAULT_SETTINGS,
        githubToken: "t",
        githubOwner: "o",
        githubRepo: "r",
        githubBranch: "main",
      },
      {
        info: () => {},
        warn: (m: string) => warnings.push(m),
        error: () => {},
      } as never,
      {
        httpRequest: async (req: SeenRequest) => {
          seen.push(req);
          const next = queue.shift();
          if (!next) throw new Error("fake worker: no response queued");
          return next;
        },
      } as never,
    );

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "head-meta-test-"));
    vault = new Vault(dir);
    seen = [];
    queue = [];
    warnings = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const SHA40 = "a".repeat(20) + "b".repeat(20);

  it("P.14: HEAD + raw media type; sha from ETag, size from Content-Length; the body is NEVER read", async () => {
    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { etag: `"${SHA40}"`, "content-length": "31043" },
    });
    const meta = await makeClient().getContentsMetadataAtRef({
      path: "note.md",
      ref: "headsha",
    });
    expect(meta).toEqual({ sha: SHA40, size: 31043, blob: null });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("HEAD");
    expect(seen[0].headers?.Accept).toBe("application/vnd.github.raw+json");
  });

  it("P.15: weak ETag (W/\"…\") and plain-quoted ETag parse identically; header casing is irrelevant", async () => {
    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { ETag: `W/"${SHA40}"`, "Content-Length": "7" },
    });
    const weak = await makeClient().getContentsMetadataAtRef({
      path: "a.md",
      ref: "s",
    });
    expect(weak).toEqual({ sha: SHA40, size: 7, blob: null });

    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { etag: `"${SHA40}"`, "content-length": "7" },
    });
    const plain = await makeClient().getContentsMetadataAtRef({
      path: "a.md",
      ref: "s",
    });
    expect(plain).toEqual(weak);
  });

  it("P.16: ETag not shaped like a blob-SHA → GET fallback, sha/size from DOCUMENTED fields, warning logged", async () => {
    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { etag: `"abc123"`, "content-length": "10" },
    });
    queue.push({
      status: 200,
      text: "{}",
      json: { sha: SHA40, size: 999, content: "" },
      headers: {},
    });
    const meta = await makeClient().getContentsMetadataAtRef({
      path: "note.md",
      ref: "headsha",
    });
    expect(meta).toEqual({ sha: SHA40, size: 999, blob: null });
    expect(seen).toHaveLength(2);
    expect(seen[1].method).toBe("GET");
    expect(warnings.some((w) => w.includes("ETag not a blob-SHA"))).toBe(true);
  });

  it("P.17: the fallback SAVES the inline blob — bytes already travelled, the next read needs no network", async () => {
    const content = "fallback file content\n";
    const bytes = new TextEncoder().encode(content);
    const realSha = await calculateGitBlobSHA(
      bytes.buffer.slice(0) as ArrayBuffer,
    );
    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { etag: `"not-a-sha"` },
    });
    queue.push({
      status: 200,
      text: "{}",
      json: {
        sha: realSha,
        size: bytes.byteLength,
        content: Buffer.from(content).toString("base64"),
      },
      headers: {},
    });

    const syncStore = new SyncStore({
      vault: vault as never,
      selfPluginId: PLUGIN_ID,
    });
    const meta = await makeClient().getContentsMetadataAtRef({
      path: "note.md",
      ref: "headsha",
      blobSink: {
        has: (sha) => syncStore.existInSyncStore(sha),
        save: (sha, b) => syncStore.saveBlobToSyncStore(sha, b),
      },
    });
    expect(meta!.sha).toBe(realSha);
    expect(new TextDecoder().decode(meta!.blob!)).toBe(content);

    // The whole point: the blob is now servable WITHOUT network, and
    // hash-on-load accepts it (name really matches content).
    const fromStore = await syncStore.getBlobFromSyncStore(
      realSha,
      new Set(),
    );
    expect(new TextDecoder().decode(fromStore!)).toBe(content);
  });

  it("P.18: fallback on a >1 MB file — empty inline content → blob null, NOT saved, sha/size still correct", async () => {
    queue.push({
      status: 200,
      text: "",
      json: explodingJson,
      headers: { etag: `"nope"` },
    });
    queue.push({
      status: 200,
      text: "{}",
      json: { sha: SHA40, size: 1_212_647, content: "" },
      headers: {},
    });
    let saved = 0;
    const meta = await makeClient().getContentsMetadataAtRef({
      path: "big.bin",
      ref: "headsha",
      blobSink: {
        has: async () => false,
        save: async () => {
          saved += 1;
        },
      },
    });
    expect(meta).toEqual({ sha: SHA40, size: 1_212_647, blob: null });
    expect(saved).toBe(0);
  });

  it("404 → null: an absent path at the ref is a normal answer, not an error", async () => {
    queue.push({ status: 404, text: "", json: explodingJson, headers: {} });
    expect(
      await makeClient().getContentsMetadataAtRef({
        path: "ghost.md",
        ref: "headsha",
      }),
    ).toBeNull();
  });
});
