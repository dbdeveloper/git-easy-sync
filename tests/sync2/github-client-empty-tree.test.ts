// Authored and tested by Claude Code under the attentive guidance of
// Vladyslav Kozlovskyy <dbdevelop@gmail.com>, 2026.
// AGPL-3.0 — see LICENSE.
//
// A branch whose every file has been deleted points at git's canonical
// EMPTY TREE, and GitHub answers 404 for that object — even asked by its
// own sha, and not transiently (measured for a full 20 s, DOT-FILES §10).
//
// "The remote holds no files" is an ordinary state, and one WE can
// produce: deleting every file in the vault and syncing sends deletion
// entries whose resulting tree is empty. Before this, the sync AFTER
// that died in discovery with a NotFoundError — a dead end the plugin
// walked into by itself, not only something a user could do from the
// GitHub web UI.
//
// Distinct from a BARE repo (no commits at all), which is detected
// elsewhere and takes the bootstrap path. Here there IS history; it
// just currently holds nothing.

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

import GithubClient, { EMPTY_TREE_SHA } from "../../src/github/client";
import Logger from "../../src/logger";
import { DEFAULT_SETTINGS } from "../../src/settings/settings";
import {
  Vault,
  installRequestFaultInjector,
  type FakeResponse,
} from "../../mock-obsidian";
import { NotFoundError } from "../../src/errors";

const COMMIT = "1f9029241daab024d14d78e1f29a8b14e94285da";
const NORMAL_TREE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeClient() {
  const root = path.join(
    os.tmpdir(),
    `empty-tree-${crypto.randomBytes(4).toString("hex")}`,
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
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// GitHub's shape: 404 on every trees read, and the commit resolving to
// whatever tree the case under test wants.
function github(opts: {
  treeStatus?: number;
  commitTree?: string | null;
  commitStatus?: number;
  onCommitRead?: () => void;
}) {
  installRequestFaultInjector({
    intercept(url): FakeResponse | null {
      if (url.includes("/git/trees/")) {
        return {
          status: opts.treeStatus ?? 404,
          body: '{"message":"Not Found"}',
        };
      }
      if (url.includes("/git/commits/")) {
        opts.onCommitRead?.();
        const status = opts.commitStatus ?? 200;
        const payload =
          opts.commitTree === null
            ? {}
            : { sha: COMMIT, tree: { sha: opts.commitTree } };
        return { status, body: JSON.stringify(payload) };
      }
      return null;
    },
  });
}

describe("GithubClient.getRepoTree — git's empty tree is not a missing tree", () => {
  let cleanup: () => void;

  afterEach(() => {
    installRequestFaultInjector(null);
    if (cleanup) cleanup();
  });

  it("asked by the empty tree's OWN sha: returns no files, without asking again", async () => {
    const s = makeClient();
    cleanup = s.cleanup;
    let commitReads = 0;
    github({ onCommitRead: () => commitReads++ });

    expect(await s.client.getRepoTree({ sha: EMPTY_TREE_SHA })).toEqual({
      files: [],
      truncated: false,
    });
    // The constant answers directly — no extra round trip.
    expect(commitReads).toBe(0);
  });

  it("asked by a COMMIT sha whose tree is empty: resolves the commit, returns no files", async () => {
    // The live shape: discovery passes a branch head, not a tree sha.
    const s = makeClient();
    cleanup = s.cleanup;
    let commitReads = 0;
    github({ commitTree: EMPTY_TREE_SHA, onCommitRead: () => commitReads++ });

    expect(await s.client.getRepoTree({ sha: COMMIT })).toEqual({
      files: [],
      truncated: false,
    });
    expect(commitReads).toBe(1);
  });

  it("a genuinely missing object still throws — we did not widen 404 into silence", async () => {
    const s = makeClient();
    cleanup = s.cleanup;
    github({ commitTree: NORMAL_TREE });

    await expect(s.client.getRepoTree({ sha: COMMIT })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("if the commit itself cannot be resolved, we do NOT guess", async () => {
    const s = makeClient();
    cleanup = s.cleanup;
    github({ commitStatus: 404, commitTree: null });

    await expect(s.client.getRepoTree({ sha: COMMIT })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("the happy path never pays for the probe", async () => {
    const s = makeClient();
    cleanup = s.cleanup;
    let commitReads = 0;
    installRequestFaultInjector({
      intercept(url): FakeResponse | null {
        if (url.includes("/git/trees/")) {
          const body = {
            sha: NORMAL_TREE,
            truncated: false,
            tree: [
              { path: "note.md", type: "blob", sha: "b1", size: 3 },
              { path: "dir", type: "tree", sha: "t1" },
            ],
          };
          return { status: 200, body: JSON.stringify(body) };
        }
        if (url.includes("/git/commits/")) {
          commitReads++;
          return { status: 200, body: "{}" };
        }
        return null;
      },
    });

    expect(await s.client.getRepoTree({ sha: COMMIT })).toEqual({
      files: [{ path: "note.md", sha: "b1", size: 3 }],
      truncated: false,
    });
    expect(commitReads).toBe(0);
  });
});
