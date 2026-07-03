import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import PushQueue from "../../src/sync2/push-queue";
import { Vault } from "../../mock-obsidian";
import { FileChange } from "../../src/sync2/types";
import {
  formatSyncMessage,
  formatResolveConflictMessage,
  parseLocalTimestamp,
} from "../../src/sync2/commit-message";
import {
  mergeVersionList,
  enumeratePushQueueVersions,
  type GithubCommit,
  type HistoryVersion,
} from "../../src/diff2/history-versions";

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

  it("parses non-'Sync' verbs too (resolve-conflict message)", () => {
    const ms = Date.parse("2026-07-02T15:00:00.000Z");
    const out = mergeVersionList([], [
      { sha: "c9", date: "2026-01-01T00:00:00Z", message: formatResolveConflictMessage("dev", ms) },
    ]);
    expect(out[0]).toMatchObject({ date: ms, deviceLabel: "dev" });
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
  it("round-trips every formatX message shape to the authoring ms", () => {
    const ms = Date.parse("2026-07-03T04:05:06.789Z");
    expect(parseLocalTimestamp(formatSyncMessage("d", ms))).toBe(ms);
    expect(parseLocalTimestamp(formatResolveConflictMessage("d", ms))).toBe(ms);
  });
  it("returns null for a message this plugin didn't write", () => {
    expect(parseLocalTimestamp("Edited via web UI")).toBeNull();
    expect(parseLocalTimestamp("Merge pull request #3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enumeratePushQueueVersions — call-site test against a REAL PushQueue on a
// mock (fs-backed) Vault. Local unpushed version = { local:true, id:batchId,
// date:createdAt, deviceLabel }. Only batches whose `files` include the path
// contribute a version.
// ---------------------------------------------------------------------------
describe("enumeratePushQueueVersions", () => {
  const CONFIG_DIR = ".obsidian";
  const SELF_PLUGIN_ID = "github-easy-sync";

  let root: string;
  let vault: Vault;
  let queue: PushQueue;
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
    queue = new PushQueue({
      vault: vault as unknown as import("obsidian").Vault,
      configDir: CONFIG_DIR,
      selfPluginId: SELF_PLUGIN_ID,
      now: () => {
        const d = new Date(current);
        current += 1000;
        return d;
      },
    });
  });

  it("returns [] when the queue is empty", async () => {
    expect(await enumeratePushQueueVersions(queue, "Notes/x.md", "phone")).toEqual([]);
  });

  it("lists one version per batch touching the path, with batchId + createdAt + deviceLabel", async () => {
    writeVaultFile("Notes/x.md", "v1\n");
    const id1 = await queue.enqueue([ADD("Notes/x.md")], {
      parentCommitSha: "p", parentTreeSha: "t",
    });
    writeVaultFile("Notes/x.md", "v2\n");
    const id2 = await queue.enqueue([ADD("Notes/x.md")], {
      parentCommitSha: "p", parentTreeSha: "t",
    });

    const out = await enumeratePushQueueVersions(queue, "Notes/x.md", "phone");
    expect(out.every((v) => v.local === true)).toBe(true);
    expect(out.every((v) => v.deviceLabel === "phone")).toBe(true);
    expect(out.map((v) => v.id).sort()).toEqual([id1, id2].sort());
    expect(out.find((v) => v.id === id1)!.date).toBeGreaterThan(0);
  });

  it("excludes batches that do not touch the path", async () => {
    writeVaultFile("Notes/x.md", "x\n");
    await queue.enqueue([ADD("Notes/x.md")], {
      parentCommitSha: "p", parentTreeSha: "t",
    });
    writeVaultFile("Notes/other.md", "o\n");
    await queue.enqueue([ADD("Notes/other.md")], {
      parentCommitSha: "p", parentTreeSha: "t",
    });

    const out = await enumeratePushQueueVersions(queue, "Notes/x.md", "phone");
    expect(out).toHaveLength(1);
  });
});
