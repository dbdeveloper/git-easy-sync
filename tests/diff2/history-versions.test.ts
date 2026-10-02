import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import BatchWriter from "../../src/sync2/batch-writer";
import BatchHistorySource from "../../src/sync2/batch-history-source";
import SyncStore from "../../src/sync2/sync-store";
import { Vault } from "../../mock-obsidian";
import { FileChange } from "../../src/sync2/types";
import {
  formatSyncMessage,
  parseLocalTimestamp,
} from "../../src/sync2/commit-message";
import {
  mergeVersionList,
  enumeratePushQueueVersions,
  loadHistoryVersions,
  type GithubCommit,
  type HistoryVersion,
} from "../../src/diff2/history-versions";
import { AuthError } from "../../src/errors";

// ⚰️ A FROZEN message from an engine that no longer exists. The verb
// "Resolve conflict" was retired 2026-10-02 with the synthetic batch
// that carried it — but commits saying it sit in real repositories, and
// History lists them like any other version.
//
// A literal, NOT a call to a formatter, and that is the whole point: a
// test built on the formatter would follow the formatter if someone
// changed it, and go on passing while real history stopped parsing.
// This string is what GitHub actually returns; only a literal can
// promise that.
//
// The instant is absolute (the offset is IN the string), so this pins
// identically on a runner in any timezone.
const RETIRED_RESOLVE_MSG =
  "Resolve conflict at 2026-07-02 18:00:00.000+03:00 (dev)";
const RETIRED_RESOLVE_MS = Date.parse("2026-07-02T18:00:00.000+03:00");

// ---------------------------------------------------------------------------
// mergeVersionList — pure. Uniform row { local, date, id, deviceLabel }.
// `date` is the true authoring moment (parsed from the sync2 commit message,
// git committer date as fallback); `deviceLabel` is provenance. NO lossy
// dedup (namespaces differ + [[feedback-preserve-all-commits]]): concat +
// newest-first sort.
// ---------------------------------------------------------------------------
describe("mergeVersionList", () => {
  const loc = (id: string, date: number, deviceLabel = "phone"): HistoryVersion => ({
    local: true,
    date,
    id,
    deviceLabel,
  });
  // A GitHub commit whose message this plugin wrote — date+label parse out.
  const ghSync = (sha: string, ms: number, label: string): GithubCommit => ({
    sha,
    date: new Date(ms + 999_000).toISOString(), // git/push date differs from authoring ms
    message: formatSyncMessage(label, ms),
  });

  it("returns [] for two empty sources", () => {
    expect(mergeVersionList([], [])).toEqual([]);
  });

  it("parses date + deviceLabel from the commit MESSAGE, not the git date", () => {
    const ms = Date.parse("2026-07-01T10:00:00.000Z");
    const out = mergeVersionList([], [ghSync("c1", ms, "laptop")]);
    expect(out).toEqual([
      { local: false, date: ms, id: "c1", deviceLabel: "laptop" },
    ]);
  });

  it("falls back to git date + 'unknown' for a foreign (non-sync2) commit", () => {
    const gitIso = "2026-06-01T08:30:00Z";
    const out = mergeVersionList([], [
      { sha: "web1", date: gitIso, message: "Edited via web UI" },
    ]);
    expect(out[0]).toEqual({
      local: false,
      date: Date.parse(gitIso),
      id: "web1",
      deviceLabel: "unknown",
    });
  });

  it("orders newest-first across both sources", () => {
    const github = [
      ghSync("c-old", Date.parse("2026-06-01T00:00:00Z"), "a"),
      ghSync("c-new", Date.parse("2026-07-01T00:00:00Z"), "a"),
    ];
    const local = [loc("b-mid", Date.parse("2026-06-15T00:00:00Z"))];
    const out = mergeVersionList(local, github);
    expect(out.map((v) => v.id)).toEqual(["c-new", "b-mid", "c-old"]);
  });

  it("places a newer LOCAL (unpushed) version above older GitHub commits", () => {
    const github = [ghSync("c1", Date.parse("2026-07-01T09:00:00Z"), "x")];
    const local = [loc("b1", Date.parse("2026-07-01T12:00:00Z"))];
    const out = mergeVersionList(local, github);
    expect(out[0]).toMatchObject({ local: true, id: "b1" });
    expect(out[1]).toMatchObject({ local: false, id: "c1" });
  });

  it("preserves two distinct-time local versions (no lossy dedup — preserve-all-commits)", () => {
    const local = [
      loc("b-10h", Date.parse("2026-07-01T10:00:00Z")),
      loc("b-11h", Date.parse("2026-07-01T11:00:00Z")),
    ];
    const out = mergeVersionList(local, []);
    expect(out).toHaveLength(2);
    expect(out.map((v) => v.id)).toEqual(["b-11h", "b-10h"]);
  });

  it("parses a verb this engine no longer writes (retired 'Resolve conflict')", () => {
    const out = mergeVersionList([], [
      { sha: "c9", date: "2026-01-01T00:00:00Z", message: RETIRED_RESOLVE_MSG },
    ]);
    expect(out[0]).toMatchObject({
      date: RETIRED_RESOLVE_MS,
      deviceLabel: "dev",
    });
  });

  it("does not mutate its inputs", () => {
    const github = [ghSync("c1", Date.parse("2026-07-01T00:00:00Z"), "d")];
    const local = [loc("b1", 1)];
    const gCopy = JSON.parse(JSON.stringify(github));
    const lCopy = JSON.parse(JSON.stringify(local));
    mergeVersionList(local, github);
    expect(github).toEqual(gCopy);
    expect(local).toEqual(lCopy);
  });
});

// parseLocalTimestamp is the reverse of formatLocalTimestamp — round-trip it
// on the real formatter so the two stay format-locked.
describe("parseLocalTimestamp", () => {
  it("round-trips a LIVE formatX message shape to the authoring ms", () => {
    const ms = Date.parse("2026-07-03T04:05:06.789Z");
    expect(parseLocalTimestamp(formatSyncMessage("d", ms))).toBe(ms);
  });
  // The parser matches `at <date> <time±offset>` and never the word
  // before it — so a retired verb stays readable with no code of its
  // own. This is the test that would fail if someone ever anchored the
  // regex to "Sync".
  it("reads a RETIRED verb just as well — the regex is verb-agnostic", () => {
    expect(parseLocalTimestamp(RETIRED_RESOLVE_MSG)).toBe(RETIRED_RESOLVE_MS);
  });
  it("returns null for a message this plugin didn't write", () => {
    expect(parseLocalTimestamp("Edited via web UI")).toBeNull();
    expect(parseLocalTimestamp("Merge pull request #3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enumeratePushQueueVersions — call-site test against a REAL
// BatchWriter + BatchHistorySource (THE SWITCH: the new queue format,
// meta.json + sync_store). Local unpushed version = { local:true,
// id:batchId, date:createdAt, deviceLabel }. Only batches whose
// content entries include the path contribute a version.
// ---------------------------------------------------------------------------
describe("enumeratePushQueueVersions", () => {
  const CONFIG_DIR = ".obsidian";
  const SELF_PLUGIN_ID = "git-easy-sync";

  let root: string;
  let vault: Vault;
  let writer: BatchWriter;
  let queue: BatchHistorySource;
  let current: number;

  const ADD = (p: string): FileChange => ({
    kind: "added",
    path: p,
    size: 0,
    mtime: 0,
  });

  function writeVaultFile(rel: string, content: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeEach(() => {
    root = path.join(
      os.tmpdir(),
      `history-versions-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
    vault = new Vault(root);
    current = Date.parse("2026-07-01T10:00:00Z");
    const syncStore = new SyncStore({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF_PLUGIN_ID,
    });
    writer = new BatchWriter({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF_PLUGIN_ID,
      syncStore,
      autoCanonicalize: () => false,
      logger: { info: () => {}, warn: () => {} },
      now: () => {
        const d = new Date(current);
        current += 1000;
        return d;
      },
    });
    queue = new BatchHistorySource({
      vault: vault as unknown as import("obsidian").Vault,
      selfPluginId: SELF_PLUGIN_ID,
      syncStore,
    });
  });

  it("returns [] when the queue is empty", async () => {
    expect(await enumeratePushQueueVersions(queue, "Notes/x.md", "phone")).toEqual([]);
  });

  it("lists one version per batch touching the path, with batchId + createdAt + deviceLabel", async () => {
    writeVaultFile("Notes/x.md", "v1\n");
    const id1 = await writer.writeBatch([ADD("Notes/x.md")]);
    writeVaultFile("Notes/x.md", "v2\n");
    const id2 = await writer.writeBatch([ADD("Notes/x.md")]);

    const out = await enumeratePushQueueVersions(queue, "Notes/x.md", "phone");
    expect(out.every((v) => v.local === true)).toBe(true);
    expect(out.every((v) => v.deviceLabel === "phone")).toBe(true);
    expect(out.map((v) => v.id).sort()).toEqual([id1, id2].sort());
    expect(out.find((v) => v.id === id1)!.date).toBeGreaterThan(0);
  });

  it("excludes batches that do not touch the path", async () => {
    writeVaultFile("Notes/x.md", "x\n");
    await writer.writeBatch([ADD("Notes/x.md")]);
    writeVaultFile("Notes/other.md", "o\n");
    await writer.writeBatch([ADD("Notes/other.md")]);

    const out = await enumeratePushQueueVersions(queue, "Notes/x.md", "phone");
    expect(out).toHaveLength(1);
  });

  // loadHistoryVersions — the local-always / caught-github-error contract (7a.2).
  describe("loadHistoryVersions", () => {
    it("merges local + github when both succeed (githubError:false)", async () => {
      writeVaultFile("Notes/x.md", "v1\n");
      const id = await writer.writeBatch([ADD("Notes/x.md")]);
      const client = {
        listCommitsForPath: async (): Promise<GithubCommit[]> => [
          { sha: "c1", date: "2000-01-01T00:00:00Z", message: "old" },
        ],
      };
      const { versions, githubError, tokenExpired } = await loadHistoryVersions(
        queue, client, "Notes/x.md", "main", "phone",
      );
      expect(githubError).toBe(false);
      expect(tokenExpired).toBe(false);
      // newest-first: the local batch (2026 clock) above the ancient github commit.
      expect(versions.map((v) => v.id)).toEqual([id, "c1"]);
    });

    it("GitHub throws → local versions STILL returned, githubError:true", async () => {
      writeVaultFile("Notes/x.md", "v1\n");
      const id = await writer.writeBatch([ADD("Notes/x.md")]);
      const client = {
        listCommitsForPath: async (): Promise<GithubCommit[]> => {
          throw new Error("offline");
        },
      };
      const { versions, githubError, tokenExpired } = await loadHistoryVersions(
        queue, client, "Notes/x.md", "main", "phone",
      );
      expect(githubError).toBe(true);
      expect(tokenExpired).toBe(false); // a plain offline error is NOT token-expired
      expect(versions.map((v) => v.id)).toEqual([id]); // local survived the github failure
    });

    it("§35 latched marker → skips GitHub entirely, tokenExpired:true, local returned", async () => {
      writeVaultFile("Notes/x.md", "v1\n");
      const id = await writer.writeBatch([ADD("Notes/x.md")]);
      let called = false;
      const client = {
        listCommitsForPath: async (): Promise<GithubCommit[]> => {
          called = true; // must NOT be reached — the marker short-circuits
          return [];
        },
      };
      const { versions, githubError, tokenExpired } = await loadHistoryVersions(
        queue, client, "Notes/x.md", "main", "phone",
        () => true, // isTokenExpired
      );
      expect(called).toBe(false); // no network touched
      expect(tokenExpired).toBe(true);
      expect(githubError).toBe(true);
      expect(versions.map((v) => v.id)).toEqual([id]); // local-always
    });

    it("§35 first-time 401 (AuthError) → tokenExpired:true + latches via noteAuthError", async () => {
      writeVaultFile("Notes/x.md", "v1\n");
      await writer.writeBatch([ADD("Notes/x.md")]);
      const client = {
        listCommitsForPath: async (): Promise<GithubCommit[]> => {
          throw new AuthError("Bad credentials", 401);
        },
      };
      let noted: unknown = undefined;
      const { githubError, tokenExpired } = await loadHistoryVersions(
        queue, client, "Notes/x.md", "main", "phone",
        () => false, // marker not yet set
        (err) => { noted = err; }, // noteAuthError
      );
      expect(githubError).toBe(true);
      expect(tokenExpired).toBe(true);
      expect(noted).toBeInstanceOf(AuthError); // latched the marker
    });
  });
});
